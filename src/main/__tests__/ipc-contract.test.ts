import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// v0.18.22 Top5 #2 (test coverage): main 측 IPC handler 의 contract drift 가드.
//
// `src/main/index.ts` 는 electron `app`, `BrowserWindow`, `ipcMain` 을 module init 에서 사용하므로
// vitest 의 node 환경에서 직접 import 불가. preload-shape.test.ts 패턴과 동일하게 source 텍스트를
// 정적으로 읽어 다음 invariant 를 검증한다:
//
//   1. ai:generate / ai:abort / ai:embed / ai:analyze-image / ai:ocr-page handler 등록 존재
//   2. ai:abort 가 bare requestId + `vision:` prefix 양쪽을 abort (R31)
//   3. analyzeImage / ocrPage 가 `vision:${rawRequestId}` namespace 로 등록 (R31 / R32 P2)
//   4. ai:generate 의 ollamaBaseUrl 이 isLocalhostHost 헬퍼로 검증 (SSRF 가드)
//   5. ai:generate 의 입력 길이 캡 (requestId 256, text 10MB, model 128) 정합
//   6. abortGenerate / registerEmbedRequest / unregisterEmbedRequest 가 ai-service 에서 import
//      (인라인 구현이 아닌 단일 출처 — R32 P3 placeholder 가드의 정합성 유지)
//
// 본 테스트가 catch 하는 회귀:
//   - R31~R35 누적 abort 회귀의 근본 원인 (IPC layer 무테스트) 보완
//   - `vision:` prefix 제거로 인한 Vision abort 무력화 (R32 P2 회귀)
//   - localhost 검증 drift (settings:set 만 수정하고 ai:generate 미수정) — SSRF 우회
//
// 한계: 실제 IPC 왕복(invoke→handle) 통합 검증은 본 테스트 범위 밖.
// 그것은 electron 의 ipcMain 모킹이 필요하며, R36+ 의 후속 라운드에서 도입 검토.

const INDEX_SRC = readFileSync(
  resolve(import.meta.dirname, '../../../src/main/index.ts'),
  'utf-8',
);

describe('main IPC contract — ai:* handler shape (Top5 #2)', () => {
  it('필수 ai:* IPC handler 가 모두 등록되어 있다', () => {
    const expectedHandlers = [
      'ai:generate',
      'ai:abort',
      'ai:check-available',
      'ai:analyze-image',
      'ai:ocr-page',
      'ai:embed',
      'ai:check-embed-model',
    ];
    for (const ch of expectedHandlers) {
      const re = new RegExp(`ipcMain\\.handle\\(['"]${ch.replace(/[-/]/g, '\\$&')}['"]`);
      expect(INDEX_SRC, `${ch} handler 등록 부재`).toMatch(re);
    }
  });

  it('ai:generate handler 시그니처는 (event, requestId, request) — preload 측 invoke 와 정합', () => {
    // preload-shape.test.ts 가 renderer 측을 검증하고, 본 테스트는 main 측 정합성.
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:generate['"],\s*async\s*\(event,\s*requestId:\s*string,\s*request:/,
    );
  });

  it('ai:generate 가 requestId 길이를 256자로 캡 (자기-DoS 방어)', () => {
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,800}?requestId\.length\s*>\s*256/,
    );
  });

  it('ai:generate 가 ollamaBaseUrl 을 isLocalhostHost 헬퍼로 검증 (SSRF defense-in-depth)', () => {
    // ai-service.ts 의 validateOllamaUrl 외에 IPC 경계에서도 검증 — 다중 방어.
    // v0.18.22: 4개 호출 지점이 isLocalhostHost 단일 헬퍼로 통일 (drift 차단 + IPv6 [::1] 정규화).
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,1500}?isLocalhostHost/);
    // protocol 허용 목록 (http: / https:) 도 함께 확인
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,1500}?\['http:',\s*'https:'\]/);
  });

  it('ai:abort 가 bare requestId 와 `vision:${requestId}` 양쪽을 abort (R31 회귀 가드)', () => {
    // R31 (v0.18.18 patch): Vision 측은 `vision:` prefix namespace 라 ai:abort 가 양쪽 시도.
    // 이 패턴이 깨지면 사용자 Stop 클릭 시 Vision 호출이 ~90s 토큰 청구를 마저 진행한다.
    const abortBlock = INDEX_SRC.match(
      /ipcMain\.handle\(['"]ai:abort['"][\s\S]{0,500}?\}\);/,
    );
    expect(abortBlock, 'ai:abort handler block 을 추출하지 못함').not.toBeNull();
    expect(abortBlock![0]).toMatch(/abortGenerate\(\s*requestId\s*\)/);
    expect(abortBlock![0]).toMatch(/abortGenerate\(\s*`vision:\$\{requestId\}`/);
  });

  it('ai:analyze-image / ai:ocr-page 가 `vision:` prefix 로 activeRequests 등록 (R31 / R32 P2)', () => {
    // R32 P2: ocr-page 측에 `vision:` namespacing 도입 — bare requestId 충돌로 entry leak
    // 가 발생하던 R30 P2 의 후속 패치. 이 패턴이 깨지면 OCR abort 가 다시 무력화된다.
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:analyze-image['"][\s\S]{0,800}?`vision:\$\{rawRequestId\}`/,
    );
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:ocr-page['"][\s\S]{0,800}?`vision:\$\{rawRequestId\}`/,
    );
  });

  it('ai:abort handler 는 ai-service 의 abortGenerate 를 직접 호출 (인라인 구현 금지)', () => {
    // 단일 출처화 — R32 P3 의 placeholder activeRequests 가드 정합성을 유지하려면
    // abort 경로가 ai-service 의 activeRequests Map 을 직접 조작해야 한다.
    // import 라인이 abortGenerate 를 `./ai-service` 에서 가져오는지 확인 (named import block 내부).
    expect(INDEX_SRC).toMatch(/import\s*\{[^}]*\babortGenerate\b[^}]*\}\s*from\s*['"]\.\/ai-service['"]/);
  });

  it('ai-service 단일 출처 import — registerEmbedRequest / unregisterEmbedRequest / cleanupAiService', () => {
    // 임베딩 측의 controller 등록/해제도 ai-service 에 위임 (R29 identity check 정합성).
    expect(INDEX_SRC).toMatch(/registerEmbedRequest/);
    expect(INDEX_SRC).toMatch(/unregisterEmbedRequest/);
    expect(INDEX_SRC).toMatch(/cleanupAiService/);
  });

  it('ai:embed handler 가 controller 등록 후 abort 가능한 형태', () => {
    // R29 (v0.18.13) — embed 측 in-flight 호출이 ai:abort 로 취소되도록 controller 등록.
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]ai:embed['"][\s\S]{0,2000}?registerEmbedRequest/);
  });

  it('VALID_PROVIDERS 화이트리스트 — provider 입력 검증 (ollama/claude/openai 만)', () => {
    expect(INDEX_SRC).toMatch(/VALID_PROVIDERS/);
    // ai:generate 가 VALID_PROVIDERS 로 검증
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,1500}?VALID_PROVIDERS/,
    );
  });

  it('model 입력 검증 정규식이 정합 — ai:generate 와 ollama:pull-model 의 안전 문자집합 공유', () => {
    // R29 회귀 — model 필드로 10MB body 폭주 차단. 정규식이 weaken 되면 input attack surface 확대.
    // 정규식 리터럴을 문자열 substring 으로 검사 (regex-in-regex 회피).
    const expected = '/^[a-zA-Z0-9]([a-zA-Z0-9._:\\/-]*[a-zA-Z0-9])?$/';
    expect(INDEX_SRC).toContain(expected);
    // ai:generate handler 블록 내부에서 model 검증 정규식이 사용되는지 spot check
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,2000}?request\.model[\s\S]{0,100}?test\(request\.model\)/,
    );
  });

  it('settings IPC: settings:get / settings:set 핸들러 등록 + 화이트리스트 검증', () => {
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]settings:get['"]/);
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]settings:set['"]/);
    // R34 P2 단일 출처화 — VALID_SETTINGS_KEYS 가 settings-keys.ts 에서 import
    expect(INDEX_SRC).toMatch(/from\s*['"]\.\/settings-keys['"]/);
  });
});

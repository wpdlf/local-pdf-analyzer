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
// R38 P1 승급: 검증 로직이 `ipc-validators.ts` 로 추출되어 행위 검증은
// `__tests__/ipc-validators.test.ts` 가 직접 수행한다(SSRF/model 정규식/길이 캡/화이트리스트).
// 본 테스트는 역할을 "행위 재현"에서 "배선 drift 가드"로 좁힌다 — 각 핸들러가 단일 출처
// 검증기에 **위임**하는지(인라인 재복제 금지)와 import 단일 출처를 지킨다. 이로써 검증
// 로직의 분기 폭증을 ipc-validators.test 가, 그 연결을 본 테스트가 나눠 가드한다.

const INDEX_SRC = readFileSync(
  resolve(import.meta.dirname, '../../../src/main/index.ts'),
  'utf-8',
);

// R38 P1: model 안전 문자집합 등 단일 출처 리터럴은 ipc-validators.ts 에 산다.
const VALIDATORS_SRC = readFileSync(
  resolve(import.meta.dirname, '../../../src/main/ipc-validators.ts'),
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

  it('ai:generate 가 검증을 ipc-validators.validateGenerateRequest 에 위임 (인라인 재복제 금지)', () => {
    // R38 P1: requestId 256 캡 · SSRF(localhost) · type/provider/model/temperature/language
    // 검증 전체가 validateGenerateRequest 로 단일화됨. 실제 거부/통과 행위는 ipc-validators.test
    // 가 검증하고, 본 테스트는 핸들러가 그 함수를 호출하는지(배선)만 가드한다.
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:generate['"][\s\S]{0,600}?validateGenerateRequest\(\s*requestId\s*,\s*request\s*\)/,
    );
    // SSRF/길이 캡 로직이 단일 출처(ipc-validators)에 실제로 존재하는지 확인.
    expect(VALIDATORS_SRC).toMatch(/isLocalhostHost/);
    expect(VALIDATORS_SRC).toMatch(/\['http:',\s*'https:'\]/);
    expect(VALIDATORS_SRC).toMatch(/requestId.*256|256/);
  });

  it('ai:check-available 가 isValidProvider + isValidOllamaBaseUrl 에 위임 (SSRF 단일 출처)', () => {
    // R39 (v0.18.26): store-read 전환으로 두 validator 사이에 정규 URL 조회 + 설명 주석이
    // 삽입되어 gap 허용 폭을 200→900 으로 확장. 위임 순서(provider→baseUrl) 자체는 그대로 가드.
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ai:check-available['"][\s\S]{0,400}?isValidProvider[\s\S]{0,900}?isValidOllamaBaseUrl/,
    );
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

  it('VALID_PROVIDERS 화이트리스트 — ipc-validators 단일 출처에서 import', () => {
    // R38 P1: VALID_PROVIDERS 가 ipc-validators.ts 에서 import 되어 단일 출처화됨.
    expect(INDEX_SRC).toMatch(/import\s*\{[\s\S]*?\bVALID_PROVIDERS\b[\s\S]*?\}\s*from\s*['"]\.\/ipc-validators['"]/);
    // apikey:* 핸들러가 여전히 VALID_PROVIDERS 로 provider 를 검증한다.
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]apikey:save['"][\s\S]{0,300}?VALID_PROVIDERS/);
  });

  it('model 검증 정규식이 ipc-validators 에 단일 정의 + ollama:pull-model 이 위임', () => {
    // R29 회귀 — model 필드로 10MB body 폭주 차단. 정규식이 weaken 되면 input attack surface 확대.
    // R38 P1: 정규식 리터럴은 ipc-validators.MODEL_NAME_RE 단일 출처로 이동. 정규식 행위
    // (경계/주입 거부)는 ipc-validators.test 가 검증하고, 본 테스트는 단일 정의 + 위임을 가드.
    const expected = '/^[a-zA-Z0-9]([a-zA-Z0-9._:\\/-]*[a-zA-Z0-9])?$/';
    expect(VALIDATORS_SRC).toContain(expected);
    // index.ts 에는 동일 정규식 리터럴이 더 이상 인라인되지 않아야 한다 (재복제 금지).
    expect(INDEX_SRC).not.toContain(expected);
    // ai:generate / ollama:pull-model 이 isValidModelName(또는 validateGenerateRequest)에 위임.
    expect(INDEX_SRC).toMatch(
      /ipcMain\.handle\(['"]ollama:pull-model['"][\s\S]{0,300}?isValidModelName\(\s*model\s*\)/,
    );
  });

  it('ai:embed 가 validateEmbedTexts + validateEmbeddings 에 위임 (NaN/캡 단일 출처)', () => {
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]ai:embed['"][\s\S]{0,600}?validateEmbedTexts\(\s*texts\s*\)/);
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]ai:embed['"][\s\S]{0,2500}?validateEmbeddings\(/);
  });

  it('settings IPC: settings:get / settings:set 핸들러 등록 + 화이트리스트 검증', () => {
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]settings:get['"]/);
    expect(INDEX_SRC).toMatch(/ipcMain\.handle\(['"]settings:set['"]/);
    // R34 P2 단일 출처화 — VALID_SETTINGS_KEYS 가 settings-keys.ts 에서 import
    expect(INDEX_SRC).toMatch(/from\s*['"]\.\/settings-keys['"]/);
  });
});

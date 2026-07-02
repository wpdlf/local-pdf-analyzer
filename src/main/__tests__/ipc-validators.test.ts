import { describe, it, expect } from 'vitest';

// R38 P1 (test coverage): IPC 입력 검증기 행위 검증.
//
// 이전엔 src/main/index.ts 의 ipcMain.handle 클로저에 인라인된 검증 로직을 ipc-contract.test.ts
// 가 소스 텍스트 정규식(`INDEX_SRC.toMatch(...)`)으로만 가드했다 — "코드가 패턴을 포함하는지"는
// 확인했지만 핸들러가 실제로 올바르게 거부/통과하는지는 검증하지 못했다.
//
// 본 라운드에서 검증 로직을 ipc-validators.ts 로 추출(ps-quote/settings-store 패턴)하여
// 다음 보안 표면을 행위로 직접 검증한다:
//   - SSRF(localhost) 가드          (isValidOllamaBaseUrl / validateGenerateRequest)
//   - model 안전 문자집합 정규식      (isValidModelName / MODEL_NAME_RE)
//   - 길이 캡 (requestId/text/model)  (자기-DoS 방어)
//   - provider/type/language 화이트리스트
//   - 임베딩 NaN/Infinity/빈 벡터 거부 (벡터 스토어 오염 방지)
//   - 이미지 base64 형식

import {
  VALID_PROVIDERS,
  VALID_GENERATE_TYPES,
  VALID_LANGUAGES,
  MODEL_NAME_RE,
  isValidProvider,
  isValidModelName,
  isValidRequestId,
  isValidOllamaBaseUrl,
  validateImageBase64,
  validateEmbedTexts,
  validateEmbeddings,
  validateGenerateRequest,
} from '../ipc-validators';

describe('상수 화이트리스트 (단일 출처)', () => {
  it('VALID_PROVIDERS 는 ollama/claude/openai/gemini 만', () => {
    expect([...VALID_PROVIDERS]).toEqual(['ollama', 'claude', 'openai', 'gemini']);
  });

  it('VALID_GENERATE_TYPES 는 full/chapter/keywords/qa', () => {
    expect([...VALID_GENERATE_TYPES]).toEqual(['full', 'chapter', 'keywords', 'qa']);
  });

  it('VALID_LANGUAGES 는 settings:set summaryLanguage 집합과 동일', () => {
    expect([...VALID_LANGUAGES]).toEqual(['ko', 'en', 'ja', 'zh', 'auto']);
  });
});

describe('isValidProvider', () => {
  it.each(['ollama', 'claude', 'openai', 'gemini'])('허용: %s', (p) => {
    expect(isValidProvider(p)).toBe(true);
  });

  it.each([
    ['미지원 provider', 'mistral'],
    ['빈 문자열', ''],
    ['대문자', 'Ollama'],
    ['number', 123],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['__proto__', '__proto__'],
  ])('거부: %s', (_label, v) => {
    expect(isValidProvider(v)).toBe(false);
  });
});

describe('isValidModelName / MODEL_NAME_RE', () => {
  it.each([
    'gemma3',
    'llama3.2-vision',
    'qwen2.5:7b',
    'nomic-embed-text',
    'library/model:tag',
    'a',
    'A1',
  ])('허용: %s', (m) => {
    expect(isValidModelName(m)).toBe(true);
  });

  it.each([
    ['빈 문자열', ''],
    ['선행 특수문자', '-model'],
    ['후행 특수문자', 'model-'],
    ['공백 포함', 'mo del'],
    ['세미콜론 주입', 'model;rm -rf'],
    ['개행', 'model\nx'],
    ['백틱', 'model`x`'],
    ['$ 치환', 'model$(x)'],
    ['number', 7],
    ['null', null],
  ])('거부: %s', (_label, m) => {
    expect(isValidModelName(m)).toBe(false);
  });

  it('128자 경계: 128자는 허용, 129자는 거부 (자기-DoS 캡)', () => {
    expect(isValidModelName('a'.repeat(128))).toBe(true);
    expect(isValidModelName('a'.repeat(129))).toBe(false);
  });

  it('MODEL_NAME_RE 가 약화되지 않았다 (회귀 가드)', () => {
    // 정규식 소스 자체를 고정 — weaken 시 즉시 fail.
    expect(MODEL_NAME_RE.source).toBe('^[a-zA-Z0-9]([a-zA-Z0-9._:\\/-]*[a-zA-Z0-9])?$');
  });
});

describe('isValidRequestId', () => {
  it('정상 id 허용', () => {
    expect(isValidRequestId('req-123')).toBe(true);
  });

  it('256자 경계 (기본): 256 허용, 257 거부', () => {
    expect(isValidRequestId('a'.repeat(256))).toBe(true);
    expect(isValidRequestId('a'.repeat(257))).toBe(false);
  });

  // C5-L: vision/OCR/embed 경로가 기본 캡(256)으로 단일화되어 커스텀 max 실사용처는 없음 — API 자체를 가드.
  it('max 인자로 캡 조절', () => {
    expect(isValidRequestId('a'.repeat(128), 128)).toBe(true);
    expect(isValidRequestId('a'.repeat(129), 128)).toBe(false);
  });

  it.each([['빈 문자열', ''], ['null', null], ['number', 1], ['undefined', undefined]])(
    '거부: %s',
    (_label, v) => {
      expect(isValidRequestId(v)).toBe(false);
    },
  );
});

describe('isValidOllamaBaseUrl (SSRF 가드)', () => {
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'https://localhost',
    'http://[::1]:11434',
  ])('ollama + localhost 허용: %s', (url) => {
    expect(isValidOllamaBaseUrl(url, 'ollama')).toBe(true);
  });

  it.each([
    ['외부 호스트', 'http://evil.com:11434'],
    ['사설 IP', 'http://192.168.0.1:11434'],
    ['메타데이터 SSRF', 'http://169.254.169.254/latest/meta-data'],
    ['file 프로토콜', 'file:///etc/passwd'],
    ['ftp 프로토콜', 'ftp://localhost'],
    ['parse 실패', 'not a url'],
  ])('ollama + 비-localhost/비-http 거부: %s', (_label, url) => {
    expect(isValidOllamaBaseUrl(url, 'ollama')).toBe(false);
  });

  it('비-string 은 provider 무관 거부', () => {
    expect(isValidOllamaBaseUrl(null, 'ollama')).toBe(false);
    expect(isValidOllamaBaseUrl(123, 'claude')).toBe(false);
  });

  it('provider 가 ollama 가 아니면 string URL 제약 없음', () => {
    expect(isValidOllamaBaseUrl('http://evil.com', 'claude')).toBe(true);
    expect(isValidOllamaBaseUrl('anything', 'openai')).toBe(true);
  });
});

describe('validateImageBase64', () => {
  it('정상 base64 허용', () => {
    expect(validateImageBase64('aGVsbG8=')).toBe(true);
    expect(validateImageBase64('QUJD')).toBe(true);
  });

  it.each([
    ['빈 문자열', ''],
    ['공백 포함', 'AB CD'],
    ['중간 padding', 'AB=CD'],
    ['3개 padding', 'ABC==='],
    ['개행 포함', 'AB\nCD'],
    ['number', 123],
    ['null', null],
  ])('거부: %s', (_label, v) => {
    expect(validateImageBase64(v)).toBe(false);
  });

  it('10MB 초과 거부', () => {
    expect(validateImageBase64('A'.repeat(10 * 1024 * 1024 + 1))).toBe(false);
  });
});

describe('validateEmbedTexts', () => {
  it('정상 배열 통과', () => {
    expect(validateEmbedTexts(['a', 'b'])).toEqual({ ok: true });
  });

  it('빈 배열 거부', () => {
    expect(validateEmbedTexts([])).toEqual({ ok: false, error: 'Invalid texts array (1-200 items)' });
  });

  it('200개 허용, 201개 거부', () => {
    expect(validateEmbedTexts(Array(200).fill('x'))).toEqual({ ok: true });
    expect(validateEmbedTexts(Array(201).fill('x'))).toEqual({
      ok: false,
      error: 'Invalid texts array (1-200 items)',
    });
  });

  it('비-배열 거부', () => {
    expect(validateEmbedTexts('not array').ok).toBe(false);
    expect(validateEmbedTexts(null).ok).toBe(false);
  });

  it('빈 문자열 항목 거부', () => {
    expect(validateEmbedTexts(['ok', ''])).toEqual({ ok: false, error: 'Each text must be 1-32000 chars' });
  });

  it('32000자 항목 허용, 32001자 거부', () => {
    expect(validateEmbedTexts(['a'.repeat(32000)])).toEqual({ ok: true });
    expect(validateEmbedTexts(['a'.repeat(32001)])).toEqual({
      ok: false,
      error: 'Each text must be 1-32000 chars',
    });
  });

  it('비-string 항목 거부', () => {
    expect(validateEmbedTexts(['ok', 123]).ok).toBe(false);
  });
});

describe('validateEmbeddings (벡터 스토어 오염 방지)', () => {
  it('정상 임베딩 통과', () => {
    expect(validateEmbeddings([[0.1, 0.2], [0.3, -0.4]])).toEqual({ ok: true });
  });

  it('NaN 포함 거부', () => {
    expect(validateEmbeddings([[0.1, NaN]])).toEqual({
      ok: false,
      error: '임베딩에 유효하지 않은 값 포함 (NaN/Infinity)',
    });
  });

  it('Infinity 포함 거부', () => {
    expect(validateEmbeddings([[Infinity]])).toEqual({
      ok: false,
      error: '임베딩에 유효하지 않은 값 포함 (NaN/Infinity)',
    });
    expect(validateEmbeddings([[-Infinity]]).ok).toBe(false);
  });

  it('빈 벡터 거부', () => {
    expect(validateEmbeddings([[]])).toEqual({ ok: false, error: '빈 임베딩 벡터' });
  });

  it('비-배열 거부', () => {
    expect(validateEmbeddings('nope')).toEqual({ ok: false, error: '빈 임베딩 벡터' });
    expect(validateEmbeddings([null]).ok).toBe(false);
  });
});

describe('validateGenerateRequest (전체 검증 순서·메시지)', () => {
  const valid = {
    text: 'hello',
    type: 'full',
    provider: 'ollama',
    model: 'gemma3',
    ollamaBaseUrl: 'http://localhost:11434',
  };

  it('정상 요청 통과', () => {
    expect(validateGenerateRequest('req-1', valid)).toEqual({ ok: true });
  });

  it('cloud provider 는 ollamaBaseUrl 제약 없음', () => {
    expect(
      validateGenerateRequest('req-1', { ...valid, provider: 'claude', ollamaBaseUrl: 'http://evil.com' }),
    ).toEqual({ ok: true });
  });

  it('통과: provider gemini (cloud — ollamaBaseUrl localhost 제약 미적용)', () => {
    expect(
      validateGenerateRequest('req-1', { ...valid, provider: 'gemini', model: 'gemini-3.5-flash' }),
    ).toEqual({ ok: true });
  });

  it('optional temperature/language 정상값 통과', () => {
    expect(validateGenerateRequest('req-1', { ...valid, temperature: 0.7, language: 'en' })).toEqual({ ok: true });
  });

  it.each([
    ['requestId 빈값', '', valid, 'Invalid requestId'],
    ['requestId 257자', 'a'.repeat(257), valid, 'Invalid requestId'],
  ])('%s → %s', (_l, rid, req, err) => {
    expect(validateGenerateRequest(rid, req)).toEqual({ ok: false, error: err });
  });

  it.each([
    ['request null', null, 'Invalid text'],
    ['text 없음', { ...valid, text: undefined }, 'Invalid text'],
    ['text 빈값', { ...valid, text: '' }, 'Invalid text'],
    ['text 10MB 초과', { ...valid, text: 'a'.repeat(10 * 1024 * 1024 + 1) }, 'Invalid text'],
    ['ollamaBaseUrl 비-string', { ...valid, ollamaBaseUrl: 123 }, 'Invalid ollamaBaseUrl'],
    ['ollamaBaseUrl parse 실패', { ...valid, ollamaBaseUrl: 'not a url' }, 'Invalid ollamaBaseUrl'],
    ['ollamaBaseUrl 외부 호스트', { ...valid, ollamaBaseUrl: 'http://evil.com' }, 'Invalid ollamaBaseUrl: localhost only'],
    ['ollamaBaseUrl 메타데이터 SSRF', { ...valid, ollamaBaseUrl: 'http://169.254.169.254/' }, 'Invalid ollamaBaseUrl: localhost only'],
    ['type 미지원', { ...valid, type: 'translate' }, 'Invalid type'],
    ['provider 미지원', { ...valid, provider: 'mistral' }, 'Invalid provider'],
    ['model 빈값', { ...valid, model: '' }, 'Invalid model'],
    ['model 주입 시도', { ...valid, model: 'm; rm -rf' }, 'Invalid model'],
    ['temperature 범위 초과', { ...valid, temperature: 5 }, 'Invalid temperature'],
    ['temperature NaN', { ...valid, temperature: NaN }, 'Invalid temperature'],
    ['temperature 비-number', { ...valid, temperature: '0.5' }, 'Invalid temperature'],
    ['language 미지원', { ...valid, language: 'fr' }, 'Invalid language'],
  ])('거부: %s → %s', (_label, req, err) => {
    expect(validateGenerateRequest('req-1', req)).toEqual({ ok: false, error: err });
  });

  it('검증 순서: requestId 가 text 보다 먼저 (둘 다 불량 시 requestId 메시지)', () => {
    expect(validateGenerateRequest('', { ...valid, text: '' })).toEqual({ ok: false, error: 'Invalid requestId' });
  });

  it('검증 순서: parse 실패와 정책 위반의 메시지가 구분된다', () => {
    // parse 실패 → generic, 비-localhost → localhost only
    expect(validateGenerateRequest('r', { ...valid, ollamaBaseUrl: ':::' }).ok).toBe(false);
    expect(validateGenerateRequest('r', { ...valid, ollamaBaseUrl: ':::' })).toEqual({
      ok: false,
      error: 'Invalid ollamaBaseUrl',
    });
  });
});

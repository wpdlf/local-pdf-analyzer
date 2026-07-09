/**
 * IPC 입력 검증기 — electron 비의존 순수 함수 모듈.
 *
 * R38 P1: 이전엔 모든 검증 로직이 `src/main/index.ts` 의 `ipcMain.handle` 클로저 안에
 * 인라인돼 있어 electron 의존(app/ipcMain/BrowserWindow) 때문에 vitest 에서 직접 검증
 * 불가했다. 그래서 `__tests__/ipc-contract.test.ts` 가 소스 텍스트 정규식
 * (`INDEX_SRC.toMatch(...)`) 으로 "코드가 패턴을 포함하는지"만 확인했을 뿐, 핸들러가 실제로
 * 올바르게 거부/통과하는지(행위)는 검증하지 못했다.
 *
 * 본 모듈은 `ps-quote.ts` / `ollama-pull-progress.ts` / `settings-store.ts` / `settings-keys.ts`
 * 와 동일한 추출 패턴 — 순수 함수로 분리하여 `__tests__/ipc-validators.test.ts` 가 행위를
 * 직접 검증한다. `index.ts` 의 핸들러는 본 모듈을 호출하는 얇은 배선으로 축소된다.
 *
 * 단일 출처 원칙: model 정규식 · provider 화이트리스트 · SSRF(localhost) 가드 · 길이 캡이
 * 여러 핸들러(ai:generate / ai:check-available / ollama:pull-model / ai:embed /
 * ai:analyze-image / ai:ocr-page) 에 중복돼 drift 위험이 있던 것을 본 모듈로 통합한다.
 *
 * 주의: 모든 검증의 거부 메시지·검증 순서는 기존 index.ts 인라인 구현과 **바이트 동일**해야
 * 한다 (행위 보존 리팩터). 변경 시 ipc-validators.test.ts 가 회귀를 잡는다.
 */

import { isLocalhostHost } from '../shared/constants';

export const VALID_PROVIDERS = ['ollama', 'claude', 'openai', 'gemini'] as const;
export type ValidProvider = typeof VALID_PROVIDERS[number];

/** ai:generate 가 허용하는 요약/QA 타입. */
export const VALID_GENERATE_TYPES = ['full', 'chapter', 'keywords', 'qa', 'custom'] as const;
// 커스텀 요약 템플릿 프롬프트 길이 상한 — renderer MAX_TEMPLATE_PROMPT_LEN 과 정합(과대 페이로드 방어).
export const MAX_CUSTOM_PROMPT_LEN = 4000;

/**
 * ai:generate 의 language 화이트리스트.
 * settings:set 의 summaryLanguage 검증과 동일 집합 — 새 언어 추가 시 양쪽 동시 갱신해야
 * drift 가 발생하지 않는다.
 */
export const VALID_LANGUAGES = ['ko', 'en', 'ja', 'zh', 'auto'] as const;

/**
 * ai:generate 와 ollama:pull-model 이 공유하는 model 안전 문자집합.
 * 약화되면 input attack surface 가 확대된다(renderer compromise 시 거대 model 필드로
 * body 폭주). 정규식 변경은 ipc-validators.test.ts 가 회귀로 잡는다.
 */
export const MODEL_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._:\/-]*[a-zA-Z0-9])?$/;

export function isValidProvider(provider: unknown): provider is ValidProvider {
  return typeof provider === 'string' && (VALID_PROVIDERS as readonly string[]).includes(provider);
}

/** model 이름 검증 — 비어있지 않고 128자 이하 + 안전 문자집합. */
export function isValidModelName(model: unknown): model is string {
  return typeof model === 'string'
    && model.length > 0
    && model.length <= 128
    && MODEL_NAME_RE.test(model);
}

/** requestId 검증 — 비어있지 않고 max(기본 256) 이하. 자기-DoS 방어용 길이 캡. */
export function isValidRequestId(id: unknown, max = 256): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= max;
}

/**
 * Ollama provider 의 baseUrl 이 http/https + localhost 인지 검증 (SSRF defense-in-depth).
 * provider 가 'ollama' 가 아니면 URL 제약 없음(string 이면 true). 호출자는 provider
 * 화이트리스트(isValidProvider) 를 별도 검증해야 한다.
 *
 * ai:check-available 의 boolean 계약과 정합 — typeof 불통과/parse 실패/비-localhost 모두 false.
 */
export function isValidOllamaBaseUrl(url: unknown, provider: string): boolean {
  if (typeof url !== 'string') return false;
  if (provider !== 'ollama') return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && isLocalhostHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Vision/OCR 이미지 base64 검증 (index.ts 에서 이동).
 * v0.17.7 (M2): 불필요한 \n 허용 제거 + padding 위치 제한(종단 0~2자만).
 */
export function validateImageBase64(imageBase64: unknown): imageBase64 is string {
  return typeof imageBase64 === 'string'
    && imageBase64.length > 0
    && imageBase64.length <= 10 * 1024 * 1024
    && /^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64);
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** ai:embed 의 texts 배열 검증 — 1~200개, 각 1~32000자. */
export function validateEmbedTexts(texts: unknown): ValidationResult {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 200) {
    return { ok: false, error: 'Invalid texts array (1-200 items)' };
  }
  for (const t of texts) {
    if (typeof t !== 'string' || t.length === 0 || t.length > 32000) {
      return { ok: false, error: 'Each text must be 1-32000 chars' };
    }
  }
  return { ok: true };
}

/**
 * 임베딩 결과 벡터 검증 — 빈 벡터/NaN/Infinity 거부 (벡터 스토어 오염 방지).
 * IPC 경계에서 ai-service 반환값을 한 번 더 검증하는 defense-in-depth.
 */
export function validateEmbeddings(embeddings: unknown): ValidationResult {
  if (!Array.isArray(embeddings)) {
    return { ok: false, error: '빈 임베딩 벡터' };
  }
  for (const emb of embeddings) {
    if (!Array.isArray(emb) || emb.length === 0) {
      return { ok: false, error: '빈 임베딩 벡터' };
    }
    for (let k = 0; k < emb.length; k++) {
      if (!Number.isFinite(emb[k])) {
        return { ok: false, error: '임베딩에 유효하지 않은 값 포함 (NaN/Infinity)' };
      }
    }
  }
  return { ok: true };
}

export interface GenerateRequest {
  text: string;
  type: 'full' | 'chapter' | 'keywords' | 'qa' | 'custom';
  provider: 'ollama' | 'claude' | 'openai' | 'gemini';
  model: string;
  ollamaBaseUrl: string;
  temperature?: number;
  language?: string;
  customPrompt?: string;
}

/**
 * ai:generate 핸들러 입력 전체 검증. 검증 순서·거부 메시지는 기존 index.ts 인라인과 동일.
 *
 * 순서: requestId → text → ollamaBaseUrl(typeof) → ollama localhost(SSRF) → type →
 *       provider → model → temperature → language.
 *
 * ollamaBaseUrl 의 두 거부 메시지를 보존: parse 실패 → 'Invalid ollamaBaseUrl',
 * 비-localhost/비-http(s) → 'Invalid ollamaBaseUrl: localhost only'.
 */
export function validateGenerateRequest(requestId: unknown, request: unknown): ValidationResult {
  // 입력값 검증 (길이 캡: ai:abort=256, ai:embed=128 과 정합 — 자기-DoS 방어)
  if (!isValidRequestId(requestId, 256)) {
    return { ok: false, error: 'Invalid requestId' };
  }
  if (!request || typeof request !== 'object') {
    return { ok: false, error: 'Invalid text' };
  }
  const r = request as Record<string, unknown>;
  if (typeof r.text !== 'string' || !r.text || r.text.length > 10 * 1024 * 1024) {
    return { ok: false, error: 'Invalid text' };
  }
  if (typeof r.ollamaBaseUrl !== 'string') {
    return { ok: false, error: 'Invalid ollamaBaseUrl' };
  }
  // IPC 경계에서 localhost URL 검증 (defense-in-depth) — parse 실패와 정책 위반을 구분.
  if (r.provider === 'ollama') {
    try {
      const parsed = new URL(r.ollamaBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || !isLocalhostHost(parsed.hostname)) {
        return { ok: false, error: 'Invalid ollamaBaseUrl: localhost only' };
      }
    } catch {
      return { ok: false, error: 'Invalid ollamaBaseUrl' };
    }
  }
  if (!(VALID_GENERATE_TYPES as readonly string[]).includes(r.type as string)) {
    return { ok: false, error: 'Invalid type' };
  }
  if (!isValidProvider(r.provider)) {
    return { ok: false, error: 'Invalid provider' };
  }
  if (!isValidModelName(r.model)) {
    return { ok: false, error: 'Invalid model' };
  }
  if (r.temperature !== undefined
    && (typeof r.temperature !== 'number' || Number.isNaN(r.temperature) || r.temperature < 0 || r.temperature > 2)) {
    return { ok: false, error: 'Invalid temperature' };
  }
  if (r.language !== undefined && !(VALID_LANGUAGES as readonly string[]).includes(r.language as string)) {
    return { ok: false, error: 'Invalid language' };
  }
  // 커스텀 요약 프롬프트: 존재하면 문자열·길이 상한 검증, type==='custom' 이면 비어있지 않아야 함.
  if (r.customPrompt !== undefined && (typeof r.customPrompt !== 'string' || r.customPrompt.length > MAX_CUSTOM_PROMPT_LEN)) {
    return { ok: false, error: 'Invalid customPrompt' };
  }
  if (r.type === 'custom' && (typeof r.customPrompt !== 'string' || !r.customPrompt.trim())) {
    return { ok: false, error: 'Invalid customPrompt' };
  }
  return { ok: true };
}

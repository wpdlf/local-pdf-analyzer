/**
 * settings.json 에서 허용하는 키 목록 단일 출처.
 *
 * v0.18.19 patch R34 P2: 이전엔 `main/index.ts` 의 `VALID_SETTINGS_KEYS_SET` (loadSettings
 * 필터) 과 `VALID_SETTINGS_KEYS` (settings:set 검증) 두 곳에 같은 키 배열이 별도 리터럴로
 * 유지되었다. R32 가 `enableAnswerVerification` 을 추가할 땐 두 곳을 동시 갱신했지만, 다음
 * 키 추가 시 한쪽만 갱신될 silent drift 위험이 있었음 (한쪽만 갱신되면 settings.json 에는
 * 저장되지만 reload 시 누락되거나 그 반대). R33 Surface 4 P3 이 단위 가드 부재로 지적.
 *
 * 본 모듈로 출처를 일원화하고, drift 가드 단위 테스트는 `__tests__/settings-keys.test.ts`
 * 가 `keyof AppSettings` (renderer types) 와 본 배열의 일치 여부도 함께 검증한다.
 *
 * 새 키 추가 시:
 *   1. `renderer/types.ts` 의 `AppSettings` / `DEFAULT_SETTINGS` 에 추가
 *   2. `main/index.ts:defaultSettings` 에 추가
 *   3. 본 배열 (VALID_SETTINGS_KEYS) 에 추가
 *   4. settings:set 의 switch validator 에 case 추가 (필요 시)
 *   5. 테스트가 자동으로 1↔3 정합성을 검증 — 누락 시 fail
 *
 * 본 모듈은 electron 등 native 의존성을 import 하지 않아 vitest 의 node 환경에서 직접
 * 임포트 가능 (ps-quote.ts 와 같은 패턴).
 */

export const VALID_SETTINGS_KEYS = [
  'provider',
  'model',
  'ollamaBaseUrl',
  'theme',
  'uiLanguage',
  'defaultSummaryType',
  'maxChunkSize',
  'enableImageAnalysis',
  'enableOcrFallback',
  'summaryLanguage',
  'enableAnswerVerification',
  'persistSessions',
] as const;

export type ValidSettingsKey = typeof VALID_SETTINGS_KEYS[number];

/** O(1) lookup 용 Set. loadSettings 의 unknown-key 필터에서 사용. */
export const VALID_SETTINGS_KEYS_SET: ReadonlySet<string> = new Set(VALID_SETTINGS_KEYS);

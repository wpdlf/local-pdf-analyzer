// R37 P6 (v0.18.23): `ollama pull` 출력 파싱 로직을 OllamaManager 에서 분리 (QA M5).
//
// OllamaManager 는 electron 을 import 해 vitest 가 직접 import 할 수 없다(파일 상단 주석 참조,
// R15 H1 / R28 P2 회귀 영역). ps-quote.ts 가 escape 로직을 분리해 테스트 가능화한 것과 동일하게,
// pull 진행 출력 파싱(ANSI 제거 · \r\n 혼용 분할 · 퍼센트 추출 · 상태→사용자 메시지 매핑)을
// 순수 함수로 분리하여 __tests__/ollama-pull-progress.test.ts 가 회귀를 가드한다.

/** ANSI 이스케이프 시퀀스(색상, 커서 이동 등) 전체 제거 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * ollama pull 은 \r 과 \n 을 혼용하므로 둘 다 기준으로 split 후
 * 마지막 비어있지 않은 줄만 취한다 (진행률은 같은 줄을 \r 로 덮어쓰는 형태).
 */
export function extractLastLine(raw: string): string {
  const cleaned = stripAnsi(raw);
  const parts = cleaned.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  // noUncheckedIndexedAccess: parts[parts.length - 1] 은 length>0 에도 T|undefined.
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
}

/**
 * R44(R43 후속 F3/F8): main → renderer 구조화 진행 이벤트.
 * 이전엔 main 이 완성된 한국어 문자열을 보내 영어 UI 에서도 한국어 진행 메시지가 표시됐고,
 * 진행 중 언어 토글 시 이전 언어 스냅샷이 잔존했다. key+params 로 보내고 renderer 가
 * 렌더 시점 언어로 번역한다 (i18n.ts 의 `mainprog.<key>` / translateMainProgress).
 * `raw` 는 매핑 불가 원문 passthrough (params.text).
 */
export interface MainProgressEvent {
  key: string;
  params?: Record<string, string>;
}

/** ollama pull 원본 출력 한 줄을 구조화 진행 이벤트로 변환 */
export function toProgressEvent(line: string): MainProgressEvent {
  // "pulling abc123..." → 퍼센트 추출
  const pullMatch = line.match(/^pulling\s+\S+.*?(\d+%)/);
  if (pullMatch) return { key: 'pulling', params: { percent: pullMatch[1] ?? '' } };
  // "pulling manifest"
  if (/^pulling\s+manifest/i.test(line)) return { key: 'pullingManifest' };
  // "verifying sha256 digest"
  if (/^verifying/i.test(line)) return { key: 'verifying' };
  // "writing manifest"
  if (/^writing/i.test(line)) return { key: 'writing' };
  // "success"
  if (/^success/i.test(line)) return { key: 'success' };
  // 그 외 (예: pulling hash without %)
  if (/^pulling\s+[a-f0-9]/i.test(line)) return { key: 'preparing' };
  return { key: 'raw', params: { text: line } };
}

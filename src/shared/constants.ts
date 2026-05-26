/**
 * Main/Preload/Renderer 공유 상수.
 *
 * 주의: 이 파일은 Node.js / Browser 양쪽에서 import 되므로 어떤 런타임 API도
 * 참조하지 않아야 함 (fs/electron/window 금지). 순수 값과 타입만 포함.
 *
 * 존재 이유: 동일 값이 여러 파일에 하드코딩되어 한쪽만 수정 시 검증 로직이
 * 불일치하여 우회가 발생하는 drift 버그를 방지. 단일 source of truth.
 */

/** PDF 업로드 최대 크기 (bytes). Main 의 drop/open 검증, Renderer 의 업로더 가드에 공유. */
export const MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Ollama / 로컬 HTTP 엔드포인트 SSRF 방어용 허용 호스트.
 *
 * 4곳에 동일한 리터럴 배열 `['localhost', '127.0.0.1', '::1']` 이 중복 정의되어 있었고
 * (settings:set / ai:generate / ai:check-available / validateOllamaUrl), 한쪽만 갱신
 * (예: `[::ffff:127.0.0.1]` 추가) 되면 다른 사이트에서 우회가 발생할 위험이 있었다.
 * v0.18.18 R30 P2: 단일 source of truth 로 통합.
 */
export const LOCALHOST_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * 외부 hostname 이 로컬호스트로 평가되는지 검사 — SSRF 방어 헬퍼.
 *
 * v0.18.22: IPv6 loopback 호환성 수정. WHATWG URL parser 는 `http://[::1]` 의 hostname 을
 * `[::1]` (괄호 포함) 으로 반환하지만 LOCALHOST_HOSTS 는 `::1` (괄호 없음) 만 보유했었다.
 * 결과적으로 IPv6 loopback 이 의도와 달리 차단되던 결함을 해소. 모든 IPv4/CIDR-bracket 폼의
 * IPv6 ([::1] / [0:0:...:1]) 를 단일 비교 표면에서 처리한다.
 *
 * 호출자는 raw socket hostname (예: `::1`) 또는 URL parser 출력 (`[::1]`) 어느 쪽이든 안전.
 * 모든 ai/ollama IPC 경계가 본 헬퍼를 사용해 LOCALHOST_HOSTS.includes() 직접 호출 시
 * 발생하던 4-site drift 위험도 함께 차단.
 */
export function isLocalhostHost(hostname: string): boolean {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  // WHATWG URL parser 가 IPv6 hostname 을 [::1] 형태로 반환 → 괄호 정규화 후 비교.
  // 양 끝의 단일 `[`/`]` 만 제거 (중간 괄호는 비정상 입력으로 보존하여 매칭 실패).
  const normalized = (hostname.startsWith('[') && hostname.endsWith(']'))
    ? hostname.slice(1, -1)
    : hostname;
  return LOCALHOST_HOSTS.includes(normalized);
}

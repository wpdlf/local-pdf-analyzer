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

/** 커스텀 요약 템플릿 id 상한 — settings 검증(main)과 아래 요약 키 상한이 함께 파생된다. */
export const MAX_TEMPLATE_ID_LEN = 64;

/**
 * 세션 `summaries` 의 키(= 요약 유형) 최대 길이.
 *
 * QA22(백로그): 커스텀 템플릿의 요약 키는 `custom:<id>` 라서 **접두사 7자 + id 상한 64자 = 71자**
 * 까지 정당한데, session-store 의 세 경로가 전부 64 로 잘라 판정하고 있었고 그 처리도 제각각이었다:
 *   1) mergeSessionSummary  — 64 초과면 {ok:false} (컬렉션 인라인 요약이 영영 저장 안 됨)
 *   2) patchSession 의 summary — `.slice(0, 64)` 로 **키를 잘라 저장**(렌더러는 원본 키로 조회하므로
 *      저장은 성공했는데 다음 복원에서 못 찾는 조용한 소실 — 컬렉션 id 절단과 같은 계열)
 *   3) patchSession 의 summaryType — 64 초과면 무시(활성 유형이 옛 값으로 복원)
 * 정상 경로의 id 는 randomUUID(36자)라 키가 43자지만, settings 검증은 id 를 64자까지 허용하므로
 * 수기 편집·이관된 settings.json 이면 도달한다. 상한을 접두사 포함으로 올리고 **세 경로가 같은
 * 값으로 판정**하게 해 절단(키 drift)을 없앤다.
 */
export const MAX_SUMMARY_TYPE_LEN = 'custom:'.length + MAX_TEMPLATE_ID_LEN; // 71

/**
 * RAG 검색의 최소 코사인 유사도 — 이보다 낮은 청크는 약한 근거로 보고 버린다.
 *
 * QA30(B-7): 같은 값이 `src/main/semantic-search.ts`(의미 검색)와 `src/renderer/lib/use-qa.ts`
 * (Q&A RAG)에 **각각 리터럴 0.3 으로** 있었고 둘을 잇는 것은 "renderer 와 일치" 라는 **주석뿐**
 * 이었다. 한쪽만 조정하면 같은 문서·같은 질의어에서 검색 결과와 Q&A 근거가 갈리는데, 양쪽 다
 * "결과 없음" 으로 보일 뿐이라 사용자도 테스트도 어긋남을 관측할 수 없다(조용한 드리프트).
 * 값 자체의 튜닝은 별개 문제이고, 여기서는 **단일 출처**만 만든다.
 */
export const RAG_MIN_SCORE = 0.3;

/**
 * 단일 AI 요청의 절대 상한(폭주 백스톱) — main 의 TTL 스위퍼와 렌더러 요약 감시견의 공통 값.
 *
 * QA30(A-F1/C-추가3): 같은 3시간이 `main/ai-service.ts`(MAX_AI_REQUEST_DURATION_MS)와
 * `renderer/lib/use-summarize.ts`(MAX_TOTAL_MS)에 **각각 리터럴로** 있었고, 일치는 테스트의
 * 런타임 비교 가드로만 유지됐다. main 이 더 짧으면 렌더러가 명문화한 "토큰이 흐르는 한 규모와
 * 무관하게 완주" 계약을 뒤에서 깬다(사용자에겐 정상 요약이 갑자기 죽는 것으로 보인다).
 * 지금은 main 만 이 상수를 쓰고, 렌더러 배선은 별도로 남아 있다(use-summarize.ts).
 */
export const MAX_AI_REQUEST_DURATION_MS = 3 * 60 * 60 * 1000;

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
 * package.json 의 `name`. electron-builder 의 updater 캐시 디렉터리 이름이 이 값에서 파생된다.
 *
 * QA24(A-L2/B-M2): `clearUpdaterCache` 는 `%LOCALAPPDATA%\<name>-updater` 를 **재귀 삭제**하는데,
 * electron-updater 가 이 경로를 API 로 노출하지 않아 규약으로 계산한다. 종전 가드는
 * `dirName.endsWith('-updater')` 였는데 이는 자기가 방금 붙인 리터럴을 검사하는 **항진명제**라
 * 실제 위험(계산된 이름이 빌더가 쓰는 이름과 어긋남)을 전혀 막지 못했다.
 *
 * `app.getName()` 을 쓰면 안 된다 — electron 은 `productName` 이 있으면 그것을 반환하는데
 * electron-builder 는 **`name` 기반**으로 캐시 이름을 만든다
 * (`sanitizeFileName(metadata.name).toLowerCase() + '-updater'`, app-builder-lib/out/appInfo.js).
 * 현재는 루트 package.json 에 productName 이 없어 우연히 일치하지만, `build.productName`
 * ("PDF 자료 분석기")을 루트로 승격하는 순간 둘이 갈리고 정리는 영구 no-op 이 된다.
 *
 * 이 상수가 package.json 과 어긋나지 않도록 `updater-cache-name-drift.test.ts` 가 못박는다.
 */
export const APP_PACKAGE_NAME = 'summary-lecture-material';

/** electron-builder 의 updaterCacheDirName 규약을 재현한다(위 주석 참조). */
export const UPDATER_CACHE_DIR_NAME = `${APP_PACKAGE_NAME.toLowerCase()}-updater`;

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
  // v0.18.22 M1 (Strict): RFC 3986 준수 — `[ ]` 는 IPv6 IP-literal 전용이다.
  // `[localhost]` / `[127.0.0.1]` 같이 비-IPv6 hostname 을 brackets 로 감싸는 형태는
  // RFC 위반이며 WHATWG URL parser 도 throw 한다 (IPC 경계 미도달).
  // 정상 경로에서 도달 불가하지만 raw-socket 호출자가 향후 추가될 때 우회 소지를 사전 차단.
  // IPv6 형식 추정 휴리스틱: brackets 안에 `:` 이 포함되어야 IP-literal 로 인정.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    if (!inner.includes(':')) return false;
    return LOCALHOST_HOSTS.includes(inner);
  }
  return LOCALHOST_HOSTS.includes(hostname);
}

/**
 * Ollama base URL 유효성 — **main 의 settings:set 검증과 동일 규칙**(http/https + localhost 호스트).
 *
 * QA22(C-MED): 이 규칙이 main 에만 있어 렌더러 UI 는 무엇이든 받아들였고, main 은 거부를
 * **조용히 드롭**(filtered 에 미포함, 에러 미반환)했다. 그 결과 store(거부된 값)와 settings.json
 * (구값)이 분기해, ai:generate 는 매 호출 실패하는데 ai:check-available 은 "연결됨" 을 표시하는
 * 모순 상태가 됐다. shared 로 올려 양쪽이 같은 판정을 쓰게 한다(drift 차단).
 */
export function isValidOllamaUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLocalhostHost(parsed.hostname);
  } catch {
    return false;
  }
}

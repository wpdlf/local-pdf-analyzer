// Design Ref: §3.3.2 parseCitations — 단일 진실원, 순수 함수
// Plan SC: SC-01 (청크 page 메타데이터), SC-02 (인용 토큰), SC-05 (legacy 호환)

/**
 * 페이지 인용 토큰 정규식.
 * 매칭 예시: `[p.12]`, `[p. 5]`, `[P.100]`
 * 캡처 그룹 1: 페이지 번호 (숫자)
 *
 * 'g' flag — matchAll 반복 사용
 * 'i' flag — 대소문자 무시 (LLM 이 간혹 `[P.5]` 출력)
 */
export const CITATION_REGEX = /\[p\.\s*(\d+)\]/gi;

/**
 * safe-markdown 의 text renderer 에서 사용할 단일 세그먼트.
 * - `type: 'text'`  → 일반 텍스트 (content 사용)
 * - `type: 'citation'` → 페이지 인용 (page 사용, raw 는 디버그용)
 */
export interface CitationSegment {
  type: 'text' | 'citation';
  content?: string;
  page?: number;
  raw?: string;
}

/**
 * 텍스트를 text/citation 세그먼트 배열로 파싱.
 *
 * 동작 원칙:
 * - 인용이 하나도 없으면 전체를 단일 `{type:'text'}` 세그먼트로 반환 (FR-12 legacy 호환)
 * - 공백 문자열은 단일 text 세그먼트로 반환 (호출자가 처리)
 * - 빈 문자열은 빈 배열
 * - 0 이나 음수 페이지는 text 로 취급 (정규식 `\d+` 이 매칭 안 함)
 */
export function parseCitations(text: string): CitationSegment[] {
  if (text.length === 0) return [];
  const segments: CitationSegment[] = [];
  let lastIdx = 0;
  // matchAll 은 iterable — 매 호출마다 새 iterator 가 필요하므로 정규식을
  // 지역 복제해 lastIndex 오염을 방지. (g flag 정규식의 전역 상태 문제)
  const re = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const pageStr = match[1];
    const start = match.index ?? 0;
    if (start > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, start) });
    }
    const page = Number.parseInt(pageStr, 10);
    if (Number.isFinite(page) && page >= 1) {
      segments.push({ type: 'citation', page, raw });
    } else {
      // 0 이나 invalid 는 원본 text 를 유지 (LLM 이 잘못 생성한 경우 대비)
      segments.push({ type: 'text', content: raw });
    }
    lastIdx = start + raw.length;
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIdx) });
  }
  // 인용이 하나도 없었으면 전체를 단일 text 로 반환 (상위 코드 분기 단순화)
  if (segments.length === 0 && text.length > 0) {
    segments.push({ type: 'text', content: text });
  }
  return segments;
}

/**
 * 프롬프트 컨텍스트 빌더에서 사용할 페이지 라벨 생성.
 * - pageStart 가 없으면 빈 문자열 (라벨 미첨부)
 * - pageStart === pageEnd 이거나 pageEnd 가 없으면 `[p.N]`
 * - 범위면 `[p.N-M]` (프롬프트 전용, 최종 출력은 항상 단일 인용)
 */
export function formatPageLabel(pageStart?: number, pageEnd?: number): string {
  if (!pageStart || pageStart < 1) return '';
  if (!pageEnd || pageEnd === pageStart) return `[p.${pageStart}]`;
  if (pageEnd < pageStart) return `[p.${pageStart}]`; // 잘못된 범위 방어
  return `[p.${pageStart}-${pageEnd}]`;
}

/**
 * 인용 페이지가 현재 문서의 유효 범위(1 ~ maxPage) 안에 있는지 검증.
 * 유효하면 page, 아니면 null (UI 에서 disabled 처리)
 */
export function clampCitationPage(page: number, maxPage: number): number | null {
  if (!Number.isFinite(page) || !Number.isFinite(maxPage)) return null;
  if (page < 1 || page > maxPage) return null;
  return Math.floor(page);
}

// Design Ref: §3.3.2 parseCitations — 단일 진실원, 순수 함수
// Plan SC: SC-01 (청크 page 메타데이터), SC-02 (인용 토큰), SC-05 (legacy 호환)

/**
 * 페이지 인용 토큰 정규식.
 * 매칭 예시: `[p.12]`, `[p. 5]`, `[P.100]`
 * 캡처 그룹 1: 페이지 번호 (숫자)
 *
 * 'g' flag — matchAll 반복 사용
 * 'i' flag — 대소문자 무시 (LLM 이 간혹 `[P.5]` 출력)
 *
 * 파이프 이후의 quote 포맷(`[p.N|...]`)도 관용적으로 허용 — 과거 DR-03 하이라이트 기능에서
 * 사용한 확장이지만 기능이 제거된 후에도 LLM 이 quote 를 포함할 수 있어, 정규식이 호환적으로
 * 인식하되 quote 내용은 무시한다. `\s*\|\s*[^\]]*` 는 선택적으로 소비만 한다.
 */
export const CITATION_REGEX = /\[p\.\s*(\d+)(?:\s*\|\s*[^\]]*)?\s*\]/gi;

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
 * LLM 이 자주 어기는 인용 배치 실수를 후처리로 정리.
 * - `([p.N])` / `( [p.N] )` → `[p.N]` (괄호 stripping — 학술 스타일 관성)
 * - `(  [p.N|quote]  )` → `[p.N|quote]`
 * - 독립된 줄의 `- [p.N]` 또는 `* [p.N]` 또는 공백만의 `[p.N]` → 이전 비어있지 않은 줄 끝에 이동
 *
 * 스트리밍 도중에는 적용 불가 (부분 토큰 파괴 위험) — 각 청크 스트림 종료 후 호출.
 */
export function normalizeCitationPlacement(text: string): string {
  if (!text) return text;
  // 1) 괄호로 감싸진 인용 해제: `([p.N])` 또는 `([p.N|quote])` → `[p.N...]`
  //    `\s*` 로 괄호 내부 공백도 포함. 인용 pattern 은 기존 CITATION_REGEX 와 동일.
  let result = text.replace(/\(\s*(\[p\.\s*\d+(?:\s*\|\s*[^\]]*?)?\s*\])\s*\)/gi, '$1');

  // 2) 독립적 목록 항목 또는 공백 라인으로 떨어진 인용을 이전 라인 끝으로 이동
  //    정규식: 줄 시작 (선택적 bullet 기호 + 공백) + 인용 (여러 개 가능) + 공백만 → 끝
  const lines = result.split('\n');
  const stripped: string[] = [];
  const isStandaloneCitationLine = (line: string) =>
    /^[\s-*•]*(?:\[p\.\s*\d+(?:\s*\|\s*[^\]]*?)?\s*\]\s*[.,]?\s*)+$/i.test(line);
  for (const line of lines) {
    if (isStandaloneCitationLine(line)) {
      // 이 라인의 인용들을 추출 + 이전 비어있지 않은 라인 끝에 부착
      const citations = Array.from(line.matchAll(/\[p\.\s*\d+(?:\s*\|\s*[^\]]*?)?\s*\]/gi)).map((m) => m[0]);
      // 바로 위 비어있지 않은 라인 찾기 (역방향)
      let attached = false;
      for (let k = stripped.length - 1; k >= 0; k--) {
        if (stripped[k].trim().length > 0) {
          // 이전 라인 끝의 구두점 앞에 삽입하거나 끝에 추가
          const prev = stripped[k];
          const trailingPuncMatch = prev.match(/[.!?。！？]\s*$/);
          if (trailingPuncMatch && trailingPuncMatch.index !== undefined) {
            stripped[k] = prev.slice(0, trailingPuncMatch.index) + citations.join('') + prev.slice(trailingPuncMatch.index);
          } else {
            stripped[k] = prev + citations.join('');
          }
          attached = true;
          break;
        }
      }
      // v0.18.5 B6 fix: 부착 대상 비어있지 않은 라인이 위에 없으면 (첫 줄이 단독 인용이거나
      // 직전이 모두 공백 라인) 인용을 buffer 형태로 보존해 다음 비어있지 않은 라인에 부착.
      // 과거: `continue` 로 단순 drop → 사용자에게 출처 메타데이터 데이터 손실.
      // 새 동작: 인용 토큰만 라인으로 push → 이후 정상 라인이 나오면 그 라인에 prepend 되도록
      //         standalone 라인 패턴으로 인식되지 않게 일반 텍스트로 보존.
      //         실패 안전: 단독 라인뿐인 답변(예: 비정상 LLM 응답)은 텍스트로 그대로 유지.
      if (!attached) {
        stripped.push(citations.join(''));
      }
    } else {
      stripped.push(line);
    }
  }
  result = stripped.join('\n');

  return result;
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

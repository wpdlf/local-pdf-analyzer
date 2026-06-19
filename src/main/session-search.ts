import type { GlobalSearchResult, SearchSnippet } from '../shared/session-types';

/**
 * 저장된 세션 전체를 가로지르는 키워드 검색 — 순수 함수(파일 I/O 없음, 단위 테스트 가능).
 * session:search 핸들러(main)가 각 세션 본문을 읽어 본 함수로 매칭한다.
 *
 * 검색 대상: 파일명(가중 5) / pageTexts 페이지별 발생수(페이지 번호 확보) / summaries 본문(가중 2).
 * 대소문자 무관. 매칭 0 이면 null. 의미(임베딩) 검색은 향후 확장 — 현재는 키워드(부분 문자열).
 */

const MAX_SNIPPETS_PER_DOC = 3;
const SNIPPET_RADIUS = 50;
const FILENAME_BOOST = 5;
const SUMMARY_BOOST = 2;
export const MIN_QUERY_LENGTH = 2;

/** 매칭 주변을 잘라 한 줄 발췌로. 공백 정규화 + 양끝 … 표시. */
function makeSnippet(text: string, matchIdx: number, qLen: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIdx + qLen + SNIPPET_RADIUS);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip = snip + '…';
  return snip;
}

/** 한 페이지 내 query 발생 횟수. */
function countOccurrences(haystackLower: string, needleLower: string): number {
  let occ = 0;
  let from = haystackLower.indexOf(needleLower);
  while (from !== -1) {
    occ += 1;
    from = haystackLower.indexOf(needleLower, from + needleLower.length);
  }
  return occ;
}

interface SearchableMeta {
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
}

/**
 * 단일 세션을 query 로 검색. 매칭 없으면 null.
 * session 은 PersistedSession 형태(opaque)지만 pageTexts/summaries 만 사용 — 손상/부재 필드는 방어.
 */
export function searchPersistedSession(
  meta: SearchableMeta,
  session: unknown,
  query: string,
): GlobalSearchResult | null {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) return null;

  let score = 0;
  const snippets: SearchSnippet[] = [];

  // 파일명 매칭(부스트) — 본문 없이도 파일명으로 찾을 수 있게.
  if (meta.fileName.toLowerCase().includes(q)) score += FILENAME_BOOST;

  const s = (session && typeof session === 'object') ? session as Record<string, unknown> : {};

  // 페이지 텍스트 — 발생수만큼 가산 + 페이지별 스니펫(상한).
  const pageTexts = Array.isArray(s.pageTexts) ? s.pageTexts : [];
  for (let i = 0; i < pageTexts.length; i++) {
    const text = typeof pageTexts[i] === 'string' ? pageTexts[i] as string : '';
    if (!text) continue;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    score += countOccurrences(lower, q);
    if (snippets.length < MAX_SNIPPETS_PER_DOC) {
      snippets.push({ page: i + 1, text: makeSnippet(text, idx, q.length) });
    }
  }

  // 요약 본문 — 매칭 시 부스트(스니펫은 페이지 우선이라 별도 미수집).
  let inSummary = false;
  const summaries = (s.summaries && typeof s.summaries === 'object') ? s.summaries as Record<string, unknown> : {};
  for (const key of Object.keys(summaries)) {
    const entry = summaries[key];
    const content = (entry && typeof entry === 'object') ? (entry as Record<string, unknown>).content : undefined;
    if (typeof content === 'string' && content.toLowerCase().includes(q)) {
      inSummary = true;
      score += SUMMARY_BOOST;
    }
  }

  if (score === 0) return null;

  return {
    docHash: meta.docHash,
    fileName: meta.fileName,
    filePath: meta.filePath,
    pageCount: meta.pageCount,
    score,
    inSummary,
    snippets,
  };
}

/** 여러 세션 검색 결과를 점수 내림차순 정렬 + 상한 적용. */
export function rankSearchResults(results: GlobalSearchResult[], maxResults: number): GlobalSearchResult[] {
  return [...results]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

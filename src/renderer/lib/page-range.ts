import type { PdfDocument } from '../types';

/**
 * 페이지 범위 요약 — 문서를 [startPage, endPage] (1-based, inclusive) 로 좁힌 사본을 반환.
 *
 * 핵심 설계: 인용 `[p.N]` 의 **절대 페이지 번호를 보존**해야 한다. 그래서 pageTexts 를 단순
 * slice 하지 않고 "마스킹"한다 — 범위 밖 페이지를 빈 문자열로 치환해 인덱스(=실제 페이지 번호)를
 * 그대로 둔다. labelParagraphsWithPages / summarizeFull 은 빈 페이지를 skip 하므로(`!trim()` 가드)
 * 범위 안 페이지만 [p.N] 라벨이 붙고, 그 N 은 원본 페이지 번호와 일치한다.
 *
 * chapters 는 범위와 겹치는 것만 남기고 경계를 클램프 — summarizeByChapter 가
 * pageTexts.slice(startPage-1, endPage) 로 재구성하므로 마스킹된 pageTexts 와 정합한다.
 * (endPage 는 detectChapters 규약상 "마지막 1-based 페이지(inclusive)" 이다.)
 *
 * 순수 함수(부수효과 없음) — page-range.test.ts 가 마스킹/클램프/경계 정규화를 가드한다.
 */
export function slicePdfDocumentByPageRange(
  doc: PdfDocument,
  startPage: number,
  endPage: number,
): PdfDocument {
  const total = doc.pageCount;
  // 경계 정규화: 1~total 클램프 + start>end 시 스왑(역입력 방어)
  let s = Math.max(1, Math.min(Math.floor(startPage), total));
  let e = Math.max(1, Math.min(Math.floor(endPage), total));
  if (s > e) [s, e] = [e, s];

  // pageTexts: 범위 밖 페이지를 빈 문자열로 마스킹(인덱스=페이지번호 보존)
  const maskedPageTexts = doc.pageTexts.map((txt, i) => {
    const page = i + 1;
    return page >= s && page <= e ? txt : '';
  });

  // extractedText(pageTexts 부재 시 fallback): 범위 페이지만 연결
  const extractedText = doc.pageTexts
    .slice(s - 1, e)
    .filter((t) => t && t.trim())
    .join('\n\n');

  // images: pageIndex(0-based) 가 범위 안인 것만
  const images = doc.images.filter((img) => img.pageIndex + 1 >= s && img.pageIndex + 1 <= e);

  // chapters: 겹치는 챕터만 경계 클램프.
  // detectChapters 는 endPage 를 "마지막 1-based 페이지(inclusive)" 로 생성하고
  // summarizeByChapter 도 pageTexts.slice(startPage-1, endPage) 로 그렇게 소비한다.
  // 따라서 겹침 판정은 inclusive 양끝 비교(startPage<=e && endPage>=s)여야 하고,
  // 클램프 상한도 e(마지막 inclusive 페이지)여야 한다. (이전 `>s`/`e+1` 은 endPage 를
  // exclusive 로 오해해, 범위 시작 페이지가 챕터의 마지막 페이지와 같을 때 그 챕터를
  // 통째로 누락시켰다.)
  const chapters = doc.chapters
    .filter((ch) => ch.startPage <= e && ch.endPage >= s)
    .map((ch) => ({
      ...ch,
      startPage: Math.max(ch.startPage, s),
      endPage: Math.min(ch.endPage, e),
    }));

  return { ...doc, pageTexts: maskedPageTexts, extractedText, images, chapters };
}

/** 범위가 문서 전체를 덮으면(또는 무의미하면) 슬라이스 불필요 — 호출자가 원본을 그대로 쓰게 한다. */
export function isFullRange(range: { start: number; end: number } | null, pageCount: number): boolean {
  if (!range) return true;
  return range.start <= 1 && range.end >= pageCount;
}

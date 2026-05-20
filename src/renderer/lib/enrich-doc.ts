import type { PdfDocument } from '../types';

/**
 * Vision 이미지 설명 (페이지별) 을 PDF 문서의 본문/페이지 텍스트에 병합.
 *
 * v0.18.19 patch R34 P2: use-summarize.ts 에서 분리. 이 함수는 pure 하지만 use-summarize.ts
 * 자체가 React + electronAPI 등 무거운 의존성을 가져 vitest 가 직접 import 하기 어려웠다.
 * 별도 모듈로 분리하여 단위 테스트 (Vision-partial-failure / 불변식 / 빈 입력) 가능.
 *
 * @returns
 *   - `imageDescriptions.size === 0` 면 `{ textForSummary: doc.extractedText, enrichedPages: null }`.
 *     호출자는 `enrichedPages === null` 을 "원본 그대로 사용" 의 신호로 해석한다.
 *   - 그 외는 각 페이지에 `[이미지 분석: …]` 라인이 prepended 된 `enrichedPages` 와, 그 페이지들을
 *     `\n\n` 으로 join 한 `textForSummary` 반환.
 *
 * 불변식: `enrichedPages.length === doc.pageTexts.length`. 위반 시 throw — 챕터 슬라이싱이
 * 조용히 tail 을 누락하는 회귀를 조기 차단.
 */
export function enrichDocumentWithImages(
  doc: PdfDocument,
  imageDescriptions: Map<number, string[]>,
): { textForSummary: string; enrichedPages: string[] | null } {
  if (imageDescriptions.size === 0) return { textForSummary: doc.extractedText, enrichedPages: null };

  const enrichedPages = [...doc.pageTexts];
  for (const [pageIdx, descriptions] of imageDescriptions) {
    if (pageIdx < enrichedPages.length) {
      const desc = descriptions.map((d) => `[이미지 분석: ${d}]`).join('\n');
      enrichedPages[pageIdx] = enrichedPages[pageIdx] + '\n' + desc;
    }
  }
  // 방어적 불변식: enrichedPages.length 는 반드시 pageTexts.length 와 같아야 한다.
  // 현재 구현(spread + index-only 쓰기)은 이를 만족하지만, 향후 리팩토링이 실수로
  // 길이를 바꾸면 summarizeByChapter 의 slice(startPage-1, endPage) 가 short array 를
  // 반환하고 챕터 tail 이 조용히 누락된다. 조기 실패 유도.
  if (enrichedPages.length !== doc.pageTexts.length) {
    throw new Error(
      `enrichDocumentWithImages 불변식 위반: enrichedPages.length=${enrichedPages.length}, ` +
      `doc.pageTexts.length=${doc.pageTexts.length}`,
    );
  }
  return { textForSummary: enrichedPages.join('\n\n'), enrichedPages };
}

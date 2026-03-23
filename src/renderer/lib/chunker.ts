import type { Chapter } from '../types';

/**
 * 한글 비율에 따라 토큰당 문자 수를 동적으로 계산
 * 영어: ~4 chars/token, 한글: ~1.5 chars/token
 */
function estimateCharsPerToken(text: string): number {
  const sample = text.slice(0, 2000);
  const koreanChars = (sample.match(/[\uAC00-\uD7AF\u3130-\u318F\u1100-\u11FF]/g) || []).length;
  const koreanRatio = koreanChars / Math.max(sample.length, 1);
  // 한글 비율이 높을수록 토큰당 문자 수 감소
  return 4 - (koreanRatio * 2.5); // 100% 한글 → 1.5, 0% 한글 → 4
}

/**
 * 텍스트를 토큰 기준으로 청크 분할
 * 한글/영어 비율에 따라 청크 크기를 자동 조절
 */
export function chunkText(
  text: string,
  maxChunkSize: number = 4000,
): string[] {
  const charsPerToken = estimateCharsPerToken(text);
  const maxChars = Math.floor(maxChunkSize * charsPerToken);

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * 챕터 배열을 청크로 분할
 */
export function chunkChapters(
  chapters: Chapter[],
  maxChunkSize: number = 4000,
): { chapter: Chapter; chunks: string[] }[] {
  return chapters.map((chapter) => ({
    chapter,
    chunks: chunkText(chapter.text, maxChunkSize),
  }));
}

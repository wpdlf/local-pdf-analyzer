import type { Chapter } from '../types';

const APPROX_CHARS_PER_TOKEN = 4;

/**
 * 텍스트를 토큰 기준으로 청크 분할
 * 챕터가 maxChunkSize보다 크면 추가 분할
 */
export function chunkText(
  text: string,
  maxChunkSize: number = 4000,
): string[] {
  const maxChars = maxChunkSize * APPROX_CHARS_PER_TOKEN;

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

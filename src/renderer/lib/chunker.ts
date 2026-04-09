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
  return Math.max(1.5, 4 - (koreanRatio * 2.5)); // 100% 한글 → 1.5, 0% 한글 → 4
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
  const maxChars = Math.max(1, Math.floor(maxChunkSize * charsPerToken));

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

  // 단일 단락이 maxChars를 초과하는 경우 강제 분할
  const overflowRegex = new RegExp(`.{1,${maxChars}}`, 'gs');
  return chunks.flatMap((chunk) =>
    chunk.length > maxChars
      ? (chunk.match(overflowRegex) || [chunk])
      : [chunk],
  );
}

/**
 * RAG용 오버랩 청크 분할
 * 작은 청크 + 10% 오버랩으로 검색 정확도 향상
 */
export function chunkTextWithOverlap(
  text: string,
  maxChunkSize: number = 500,
  overlapRatio: number = 0.1,
): string[] {
  const charsPerToken = estimateCharsPerToken(text);
  const maxChars = Math.max(200, Math.floor(maxChunkSize * charsPerToken));
  const overlapChars = Math.floor(maxChars * overlapRatio);
  // 오버랩을 포함한 실제 청크 한도 — 오버랩 추가로 인한 초과 방지
  const effectiveMax = maxChars + overlapChars;

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  let prevTail = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;

    if (candidate.length > effectiveMax && current.length > 0) {
      chunks.push(current.trim());
      // overlapChars가 0이면 오버랩 없음 (slice(-0)은 전체 문자열을 반환하므로 방어)
      prevTail = overlapChars > 0 ? current.slice(-overlapChars) : '';
      current = prevTail ? prevTail + '\n\n' + para : para;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // 단일 단락이 effectiveMax를 초과하는 경우 강제 분할
  const overflowRegex = new RegExp(`.{1,${effectiveMax}}`, 'gs');
  return chunks.flatMap((chunk) =>
    chunk.length > effectiveMax
      ? (chunk.match(overflowRegex) || [chunk])
      : [chunk],
  );
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

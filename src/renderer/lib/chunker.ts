import type { Chapter } from '../types';

/**
 * 한글 비율에 따라 토큰당 문자 수를 동적으로 계산
 * 영어: ~4 chars/token, 한글: ~1.5 chars/token
 *
 * export 이유: use-summarize.ts의 통합 요약 단계에서도 동일한 추정식이 필요.
 * 한쪽만 수정 시 불일치가 발생하지 않도록 단일 구현을 공유.
 */
export function estimateCharsPerToken(text: string): number {
  const sample = text.slice(0, 2000);
  const koreanChars = (sample.match(/[\uAC00-\uD7AF\u3130-\u318F\u1100-\u11FF]/g) || []).length;
  const koreanRatio = koreanChars / Math.max(sample.length, 1);
  // 한글 비율이 높을수록 토큰당 문자 수 감소
  return Math.max(1.5, 4 - (koreanRatio * 2.5)); // 100% 한글 → 1.5, 0% 한글 → 4
}

/**
 * 긴 문자열을 codepoint 경계 안전하게 maxLen 조각으로 분할.
 * UTF-16 surrogate pair(이모지/확장 CJK) 가 잘리지 않도록 Array.from 기반 처리.
 * 순수 정규식(.{1,N})은 code unit 기준이라 surrogate pair 중간을 자를 수 있음.
 */
function splitByCodepoint(text: string, maxLen: number): string[] {
  if (maxLen <= 0) return [text];
  const chars = Array.from(text); // codepoint 단위 분할
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += maxLen) {
    out.push(chars.slice(i, i + maxLen).join(''));
  }
  return out.length > 0 ? out : [text];
}

/**
 * 문자열 끝에서 `targetChars` 만큼을 추출하되, 가능하면 문장/단어 경계 쪽으로 뒤로 넘겨
 * RAG 검색 품질 저하(단어 중간 cut)를 완화.
 * 한국어/영어 문장부호(`. ! ? 。` 및 공백)를 우선 경계로 사용, 못 찾으면 codepoint 경계 fallback.
 * 경계는 targetChars 의 절반 이상을 확보해야 의미가 있으므로 50% 이하면 codepoint fallback.
 *
 * 주의: 마지막 위치(`chars.length - 1`)는 경계로 선택하지 않는다. 해당 위치가 문장부호일 때
 * `chars.slice(i + 1)` 이 빈 배열이 되어 overlap 이 침묵 소실되는 버그가 있었음.
 */
function tailAtBoundary(text: string, targetChars: number): string {
  if (targetChars <= 0 || text.length === 0) return '';
  const chars = Array.from(text);
  if (chars.length <= targetChars) return chars.join('');
  const startIdx = chars.length - targetChars;
  // 목표 경계 이후 50% 구간에서 공백/문장부호 탐색. 마지막 위치는 제외.
  const minAcceptIdx = startIdx + Math.floor(targetChars * 0.5);
  for (let i = startIdx; i < chars.length - 1; i++) {
    if (i < minAcceptIdx) continue;
    const c = chars[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '.' || c === '!' || c === '?' || c === '。' || c === '，' || c === ',') {
      return chars.slice(i + 1).join('');
    }
  }
  // 못 찾으면 codepoint 기준 tail
  return chars.slice(startIdx).join('');
}

/**
 * 텍스트를 토큰 기준으로 청크 분할
 * 한글/영어 비율에 따라 청크 크기를 자동 조절
 */
export function chunkText(
  text: string,
  maxChunkSize: number = 4000,
): string[] {
  // 빈/공백 문자열 가드 — 빈 청크로 벡터 스토어가 오염되는 것 방지
  if (!text || !text.trim()) return [];

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

  // 단일 단락이 maxChars를 초과하는 경우 codepoint 단위로 강제 분할 (surrogate pair 안전)
  return chunks.flatMap((chunk) =>
    chunk.length > maxChars ? splitByCodepoint(chunk, maxChars) : [chunk],
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
  if (!text || !text.trim()) return [];
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
      // tail 은 단어/문장 경계 우선 추출 — 단어 중간 cut 시 RAG 검색 정확도 저하.
      // tailAtBoundary 가 surrogate pair 와 CJK 경계를 모두 존중.
      prevTail = overlapChars > 0 ? tailAtBoundary(current, overlapChars) : '';
      current = prevTail ? prevTail + '\n\n' + para : para;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // 단일 단락이 effectiveMax를 초과하는 경우 codepoint 단위로 강제 분할 (surrogate pair 안전)
  return chunks.flatMap((chunk) =>
    chunk.length > effectiveMax ? splitByCodepoint(chunk, effectiveMax) : [chunk],
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

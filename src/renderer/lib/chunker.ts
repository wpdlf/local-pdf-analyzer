import type { Chapter } from '../types';

/**
 * CJK(한글·한자·일본어 가나) 비율에 따라 토큰당 문자 수를 동적으로 계산
 * 영어: ~4 chars/token, CJK: ~1.5 chars/token
 *
 * 이전에는 한글만 감지해 일본/중국어 문서에서 청크 크기가 과대평가되어
 * LLM 컨텍스트 상한을 초과하는 위험이 있었다 (M2, 2026-04-15).
 *
 * export 이유: use-summarize.ts의 통합 요약 단계에서도 동일한 추정식이 필요.
 * 한쪽만 수정 시 불일치가 발생하지 않도록 단일 구현을 공유.
 */
export function estimateCharsPerToken(text: string): number {
  const sample = text.slice(0, 2000);
  // 한글 완성형 + 자모 + 일본어 히라가나/가타카나 + CJK 통합한자
  const cjkChars = (sample.match(/[\uAC00-\uD7AF\u3130-\u318F\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
  const cjkRatio = cjkChars / Math.max(sample.length, 1);
  // CJK 비율이 높을수록 토큰당 문자 수 감소
  return Math.max(1.5, 4 - (cjkRatio * 2.5)); // 100% CJK → 1.5, 0% CJK → 4
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
    // CJK 문장부호도 경계로 허용 — 일/중 PDF 에서 overlap 품질 향상 (L2, 2026-04-15)
    if (
      c === ' ' || c === '\n' || c === '\t' ||
      c === '.' || c === '!' || c === '?' || c === ',' ||
      c === '。' || c === '，' || c === '！' || c === '？' ||
      c === '、' || c === '：' || c === '；' || c === ':'
    ) {
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
 * 내부 헬퍼: 오버랩 청크 분할을 **원본 텍스트 오프셋과 함께** 수행.
 * `chunkTextWithOverlap` (문자열만) 과 `chunkTextWithOverlapByPage` (페이지 매핑) 가
 * 동일한 분할 로직을 공유하도록 단일 소스. (M4, 2026-04-15 refactor)
 *
 * 반환 각 항목:
 * - text: 최종 청크 문자열 (prevTail 포함, trim 완료)
 * - bodyStart / bodyEnd: prevTail 을 **제외한** body 가 원본에서 차지하는 [start, end) 범위
 * - tailStart: prevTail 이 원본에서 시작하는 위치 (없으면 -1)
 *
 * 페이지 매핑 시 `tailStart >= 0` 이면 거기부터, 아니면 `bodyStart` 부터 포함.
 */
interface ChunkOffsetResult {
  text: string;
  bodyStart: number;
  bodyEnd: number;
  tailStart: number;
}

function chunkTextWithOverlapOffsets(
  text: string,
  maxChunkSize: number,
  overlapRatio: number,
): ChunkOffsetResult[] {
  if (!text || !text.trim()) return [];
  const charsPerToken = estimateCharsPerToken(text);
  const maxChars = Math.max(200, Math.floor(maxChunkSize * charsPerToken));
  const overlapChars = Math.floor(maxChars * overlapRatio);
  const effectiveMax = maxChars + overlapChars;

  if (text.length <= maxChars) {
    return [{ text, bodyStart: 0, bodyEnd: text.length, tailStart: -1 }];
  }

  // 원본에서 paragraph 경계(start, end) 를 추적 — split 이 위치 정보를 버리므로 matchAll 사용
  interface Para { start: number; end: number; }
  const paras: Para[] = [];
  let pos = 0;
  for (const m of text.matchAll(/\n\n+/g)) {
    paras.push({ start: pos, end: m.index as number });
    pos = (m.index as number) + m[0].length;
  }
  paras.push({ start: pos, end: text.length });

  const results: ChunkOffsetResult[] = [];
  let bodyStart = -1;
  let bodyEnd = -1;
  let prevTail = '';
  let prevTailStart = -1;

  const flush = () => {
    if (bodyStart < 0 || bodyEnd <= bodyStart) return;
    const body = text.slice(bodyStart, bodyEnd);
    const raw = prevTail ? prevTail + '\n\n' + body : body;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.length <= effectiveMax) {
      results.push({ text: trimmed, bodyStart, bodyEnd, tailStart: prevTail ? prevTailStart : -1 });
    } else {
      // 거대한 단일 단락(또는 누적 다중 단락이 effectiveMax 를 넘은 경우) → codepoint 경계 분할.
      //
      // v0.18.5 B2 fix: 이전에는 모든 part 에 동일한 bodyStart/bodyEnd 를 부여해, body 가
      // 여러 페이지에 걸쳐있을 때(예: 페이지 5~10 합쳐 effectiveMax 를 1자 초과해 split)
      // 모든 청크의 page 범위가 5~10 으로 동일했고, citation 클릭 시 잘못된 페이지로
      // 점프하는 정확도 저하가 있었다.
      //
      // 새 동작: body 영역을 part 개수만큼 균등 분배해 각 part 가 자신의 위치에 대응하는
      // page 범위만 보고하도록 한다. tail 은 첫 part 에만 부여 — 이후 part 는 순수 body 슬라이스.
      // 분배는 코드포인트 길이 기준 근사치(part 가 거의 균등 길이로 잘리므로 인덱스 비율로 충분).
      const parts = splitByCodepoint(trimmed, effectiveMax);
      const bodyLen = bodyEnd - bodyStart;
      for (let k = 0; k < parts.length; k++) {
        const partBodyStart = bodyStart + Math.floor((k * bodyLen) / parts.length);
        const partBodyEnd = k === parts.length - 1
          ? bodyEnd
          : bodyStart + Math.floor(((k + 1) * bodyLen) / parts.length);
        results.push({
          text: parts[k],
          bodyStart: partBodyStart,
          bodyEnd: Math.max(partBodyEnd, partBodyStart + 1),
          tailStart: k === 0 && prevTail ? prevTailStart : -1,
        });
      }
    }
  };

  for (const para of paras) {
    if (bodyStart < 0) {
      bodyStart = para.start;
      bodyEnd = para.end;
      continue;
    }
    const bridgeLen = prevTail ? prevTail.length + 2 : 0;
    const candidateLen = bridgeLen + (para.end - bodyStart);
    if (candidateLen > effectiveMax && bodyEnd > bodyStart) {
      flush();
      // 다음 청크의 오버랩 tail 을 현재 body 에서 계산
      const body = text.slice(bodyStart, bodyEnd);
      prevTail = overlapChars > 0 ? tailAtBoundary(body, overlapChars) : '';
      // prevTail 은 body 의 접미사이므로 원본 오프셋 = bodyEnd - prevTail.length
      prevTailStart = prevTail ? bodyEnd - prevTail.length : -1;
      bodyStart = para.start;
      bodyEnd = para.end;
    } else {
      bodyEnd = para.end;
    }
  }
  flush();
  return results;
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
  return chunkTextWithOverlapOffsets(text, maxChunkSize, overlapRatio).map((c) => c.text);
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

// ─── Page-aware RAG chunking (page-citation-viewer 기능) ───
// Design Ref: §3.3.1 chunkTextWithOverlapByPage — page 메타데이터 부착
// Plan SC: SC-01 청크에 pageStart/pageEnd 포함

/**
 * 페이지 단위로 안전하게 청크를 나누면서 각 청크의 page 범위를 반환.
 * RAG 인용 기능의 기반.
 */
export interface PageChunk {
  text: string;
  /** 1-based 시작 페이지 (청크가 처음 포함된 페이지) */
  pageStart: number;
  /** 1-based 끝 페이지 (청크가 마지막으로 포함된 페이지) */
  pageEnd: number;
}

const PAGE_SEPARATOR = '\n\n';

/**
 * 페이지별 텍스트 배열을 오버랩 청크로 분할하면서 각 청크의 page 범위를 계산.
 *
 * 알고리즘 (v0.17.3 M4 refactor):
 * 1. 각 페이지의 시작 character offset 을 누적 계산 (pageOffsets)
 * 2. `chunkTextWithOverlapOffsets` 로 청크 분할과 동시에 원본 오프셋을 **직접** 획득
 *    (이전: `indexOf` 폴백 — 반복 구문에서 잘못된 위치 매칭 위험)
 * 3. 각 청크의 `tailStart` / `bodyStart..bodyEnd` 를 pageOffsets 와 이진 탐색해 1-based 페이지 범위로 변환
 *
 * 오버랩이 있는 청크는 앞 페이지의 tail 을 포함하므로 `pageStart` 는 tail 의 위치부터 산정.
 * 빈 pageTexts 는 빈 배열 반환.
 */
export function chunkTextWithOverlapByPage(
  pageTexts: string[],
  maxChunkSize: number = 500,
  overlapRatio: number = 0.1,
): PageChunk[] {
  if (!pageTexts || pageTexts.length === 0) return [];

  // 1. pageOffsets[i] = i번째 페이지의 시작 오프셋 (전체 join 문자열 기준)
  const pageOffsets: number[] = [];
  let cursor = 0;
  for (const pageText of pageTexts) {
    pageOffsets.push(cursor);
    cursor += pageText.length + PAGE_SEPARATOR.length;
  }

  // 2. 전체 텍스트 + 오프셋 추적 청크 분할
  const fullText = pageTexts.join(PAGE_SEPARATOR);
  const offsetChunks = chunkTextWithOverlapOffsets(fullText, maxChunkSize, overlapRatio);
  if (offsetChunks.length === 0) return [];

  // 3. 오프셋 → 페이지 번호 (1-based) 로 변환하는 헬퍼
  const offsetToPage = (offset: number): number => {
    // 이진 탐색: pageOffsets 에서 offset 을 초과하지 않는 가장 큰 인덱스
    let lo = 0;
    let hi = pageOffsets.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pageOffsets[mid] <= offset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best + 1; // 1-based
  };

  // 4. 각 청크의 오프셋 → 페이지 범위로 변환
  const result: PageChunk[] = [];
  for (const c of offsetChunks) {
    if (!c.text) continue;
    // tailStart >= 0 이면 overlap tail 이 있음 → 그 페이지부터 포함
    const chunkStart = c.tailStart >= 0 ? c.tailStart : c.bodyStart;
    // bodyEnd 는 exclusive → 마지막 문자는 bodyEnd - 1
    const chunkEndChar = Math.max(chunkStart, c.bodyEnd - 1);
    const pageStart = offsetToPage(chunkStart);
    const pageEnd = Math.max(pageStart, offsetToPage(chunkEndChar));
    result.push({ text: c.text, pageStart, pageEnd });
  }

  return result;
}

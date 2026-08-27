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
  // QA23(C-LOW): 이전에는 `text.slice(0, 2000)` — **문서 앞부분만** 봤다. 국문 논문·보고서는
  // 표지·영문 초록이 앞에 오는 경우가 흔해 CJK 비율이 0 으로 측정되고, 청크가 최대 2.6배
  // (1.5 → 4.0 chars/token) 커져 LLM 컨텍스트를 넘길 수 있었다 — 그 초과를 막으려고 만든
  // 함수인데 표본 편향이 남아 있었다. 문서 전체에서 **균등 간격**으로 표집한다(비용은 동일).
  const sample = sampleEvenly(text, 2000);
  // 한글 완성형 + 자모 + 일본어 히라가나/가타카나 + CJK 통합한자
  const cjkChars = (sample.match(/[\uAC00-\uD7AF\u3130-\u318F\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
  const cjkRatio = cjkChars / Math.max(sample.length, 1);
  // CJK 비율이 높을수록 토큰당 문자 수 감소
  return Math.max(1.5, 4 - (cjkRatio * 2.5)); // 100% CJK → 1.5, 0% CJK → 4
}

/**
 * 문서 전체에서 균등 간격으로 최대 `size` 자를 모아 표본을 만든다(순수).
 * 짧은 텍스트는 그대로 반환하므로 종전 동작과 동일하다.
 */
function sampleEvenly(text: string, size: number): string {
  if (text.length <= size) return text;
  // 10개 구간에서 고르게 뽑아 앞·중간·뒤가 모두 반영되게 한다.
  const buckets = 10;
  const per = Math.floor(size / buckets);
  const stride = Math.floor(text.length / buckets);
  let out = '';
  for (let i = 0; i < buckets; i++) {
    out += text.slice(i * stride, i * stride + per);
  }
  return out;
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

/** QA6-B: settings.json 수기편집/손상으로 비숫자 값(문자열 등)이 유입되면 `maxChunkSize * cpt`
 * 가 NaN 이 되고, Math.max(100, NaN)=NaN 으로 폭발 하한 방어가 무력화되어 전 문서가 1개 거대
 * 청크로 강등된다(loadSettings 는 키만 필터, 값 타입 미검증). Number 강제 후 비유한/비양수는
 * 기본값 폴백 — 숫자형 문자열("4000")은 의도대로 수용된다. */
function sanitizeChunkSize(maxChunkSize: number, fallback: number): number {
  const n = Number(maxChunkSize);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  // QA post-v0.31.15: floor 를 100 으로 상향(이전 1). settings:set 은 maxChunkSize 를 [1000,16000]
  // 로 검증하지만, 손상/수기편집된 settings.json 의 값(loadSettings 는 값 미검증)이 0/음수면
  // maxChars=1 → splitByCodepoint 가 코드포인트당 1청크로 폭발(대용량 문서에서 수십만 LLM 호출).
  // RAG 경로(chunkTextWithOverlapOffsets)가 이미 쓰는 Math.max(200,…) 하한과 동일 방어.
  const maxChars = Math.max(100, Math.floor(sanitizeChunkSize(maxChunkSize, 4000) * charsPerToken));

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxChars && current.length > 0) {
      // QA9(B-LOW): whitespace-only 문단이 경계에서 단독 current 로 남으면 ''.trim() 이 빈 청크로
      // 푸시됐다(오버랩 경로엔 이미 빈문자 가드 있음). 대칭 맞춰 빈 청크는 건너뛴다.
      const trimmed = current.trim();
      if (trimmed) chunks.push(trimmed);
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
 * - bodyOffset: `text` 안에서 body 가 시작하는 인덱스 = 앞에 붙은 overlap tail 의 길이(없으면 0)
 *
 * 페이지 매핑 시 `tailStart >= 0` 이면 거기부터, 아니면 `bodyStart` 부터 포함.
 */
interface ChunkOffsetResult {
  text: string;
  bodyStart: number;
  bodyEnd: number;
  tailStart: number;
  bodyOffset: number;
}

function chunkTextWithOverlapOffsets(
  text: string,
  maxChunkSize: number,
  overlapRatio: number,
): ChunkOffsetResult[] {
  if (!text || !text.trim()) return [];
  const charsPerToken = estimateCharsPerToken(text);
  // QA6-B: NaN 하한 무력화 방어 — chunkText 와 동일(sanitizeChunkSize 주석 참조)
  const maxChars = Math.max(200, Math.floor(sanitizeChunkSize(maxChunkSize, 500) * charsPerToken));
  const overlapChars = Math.floor(maxChars * overlapRatio);
  const effectiveMax = maxChars + overlapChars;

  if (text.length <= maxChars) {
    return [{ text, bodyStart: 0, bodyEnd: text.length, tailStart: -1, bodyOffset: 0 }];
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
    // QA29(B-6): `trimmed` 안에서 body 가 시작하는 인덱스. tail 은 `prevTail` + 구분자 2자를
    // 차지하되, 선행 trim 이 그 앞을 깎아낸 만큼 줄어든다(tailAtBoundary 는 경계 **다음** 문자부터
    // 반환하므로 공백으로 시작할 수 있다). 소비자가 tail 을 배제하고 귀속을 계산할 수 있게 노출.
    const leadTrim = raw.length - raw.trimStart().length;
    const bridgeChars = prevTail ? prevTail.length + 2 : 0;
    const tailLen = Math.max(0, bridgeChars - leadTrim);
    // 선행 trim 이 tail 을 다 먹고 **body 앞부분까지** 깎아낸 양(공백으로 시작하는 페이지에서만
    // 0 이 아니다). trimmed 안의 body 첫 글자는 원본의 `bodyStart + bodyLead` 에 대응한다.
    const bodyLead = Math.max(0, leadTrim - bridgeChars);
    if (trimmed.length <= effectiveMax) {
      results.push({
        text: trimmed, bodyStart, bodyEnd,
        tailStart: prevTail ? prevTailStart : -1,
        bodyOffset: Math.min(tailLen, trimmed.length),
      });
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
      // QA29(B-7): `trimmed` 안에서 지금까지 소비한 UTF-16 길이. parts 는 `trimmed` 의 연속
      // 슬라이스이므로 누적 길이가 곧 각 part 의 정확한 시작 오프셋이다.
      let consumed = 0;
      for (let k = 0; k < parts.length; k++) {
        const rawPart = parts[k];
        if (rawPart === undefined) continue;
        const partStartInTrimmed = consumed;
        consumed += rawPart.length;
        const partEndInTrimmed = consumed;
        // QA23(C-LOW): 오버랩은 **flush 사이**(단락 경계)에만 적용되고 이 codepoint 분할에는
        // 없었다. 빈 줄 없는 긴 페이지(표·OCR 결과의 전형)는 전부 이 경로로 잘리므로, 그 경계에
        // 걸친 문장은 **어느 청크에도 온전히 담기지 않는다** — RAG 가 근거를 못 찾아 "맞아 보이지만
        // 틀린 답"이 된다. 직전 조각의 꼬리를 앞에 붙여 경계를 덮는다(문장/단어 경계 우선).
        const partTail = k === 0 ? '' : tailAtBoundary(parts[k - 1] ?? '', overlapChars);
        const part = k === 0 ? rawPart : partTail + rawPart;
        // QA29(B-7): 종전에는 body 길이를 part 개수로 **균등 분배**해 part k 의 body 시작을
        // `k·(bodyLen/parts.length)` 로 추정했다. 그런데 실제 분할 대상은 `prevTail + '\n\n' + body`
        // 이므로 part k 의 진짜 body 시작은 `k·effectiveMax − tailLen` 이다 — 추정이 tail 길이
        // (최대 overlapChars) 만큼 **뒤로 밀려**, 빈 줄 없는 긴 페이지(표·OCR)에서 인용이 한 페이지
        // 늦게 붙었다. 균등 분배 자체도 근사였으므로, 누적 오프셋에서 tail 을 뺀 **정확한** 값으로
        // 바꾼다(body 는 trimmed 안에서 tailLen 부터 시작하고 원본과 1:1 대응한다).
        const relStart = Math.min(Math.max(partStartInTrimmed - tailLen, 0) + bodyLead, bodyLen);
        const relEnd = Math.min(Math.max(partEndInTrimmed - tailLen, 0) + bodyLead, bodyLen);
        const partBodyStart = bodyStart + relStart;
        const partBodyEnd = k === parts.length - 1 ? bodyEnd : bodyStart + relEnd;
        results.push({
          text: part,
          bodyStart: partBodyStart,
          bodyEnd: Math.max(partBodyEnd, partBodyStart + 1),
          tailStart: k === 0 && prevTail ? prevTailStart : -1,
          // 첫 part 는 flush 진입부의 prevTail 을, 이후 part 는 직전 조각의 꼬리를 앞에 달고 있다.
          bodyOffset: k === 0 ? Math.min(tailLen, part.length) : partTail.length,
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
  /**
   * QA29(B-6): `text` 안에서 **body** 가 시작하는 인덱스. `[0, bodyOffset)` 구간은 직전 청크의
   * overlap tail(= 이전 페이지 출신)이며 `pageStart` 가 가리키는 페이지의 내용이 **아니다**.
   *
   * R35 이후 `pageStart/pageEnd` 는 body 좌표계로만 산정한다(검색 recall 용 tail 이 인용을 앞
   * 페이지로 끌어당기지 않도록). 그 대가로, tail 안에 있는 문장을 근거로 인용을 만들면 라벨이
   * **한 페이지 늦게** 붙는다 — 페이지 경계에 걸친 표 캡션·정의문에서 재현된다. 소비자는
   * 검색에는 `text` 를 그대로 쓰되, 페이지 라벨을 붙일 본문으로는 `text.slice(bodyOffset)` 를
   * 쓰면 두 좌표계가 일치한다. tail 이 없으면 0.
   */
  bodyOffset: number;
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
      // noUncheckedIndexedAccess: pageOffsets[mid] 는 lo<=mid<=hi<length 로 항상 정의됨.
      if (pageOffsets[mid]! <= offset) {
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
    // R35: 페이지 귀속(attribution)은 **body 좌표 기준**으로만 산정한다. overlap tail 은
    // 이전 청크 body 의 접미사(이전 페이지 출신)이므로 검색 recall 용으로만 c.text 에 포함될 뿐,
    // pageStart 를 앞 페이지로 끌어당겨 인용을 실제 근거보다 이전 페이지로 편향시키고
    // (예: page 8 본문 청크가 page 7 tail 때문에 [p.7-8] 로 라벨링) 범위 라벨을 양산했다.
    // retrieval 좌표계(tail 포함)와 attribution 좌표계(body 전용)를 분리한다.
    // bodyEnd 는 exclusive → 마지막 문자는 bodyEnd - 1
    const chunkEndChar = Math.max(c.bodyStart, c.bodyEnd - 1);
    const pageStart = offsetToPage(c.bodyStart);
    const pageEnd = Math.max(pageStart, offsetToPage(chunkEndChar));
    result.push({ text: c.text, pageStart, pageEnd, bodyOffset: Math.min(c.bodyOffset, c.text.length) });
  }

  return result;
}

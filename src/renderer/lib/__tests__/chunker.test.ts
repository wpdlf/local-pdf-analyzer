import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// QA23(C-LOW ×2): 조용한 품질 저하 두 건.
//  (1) 한글 비율 추정이 **앞 2000자만** 본다 — 영문 초록/표지가 앞에 오는 국문 논문에서 CJK
//      비율이 과소평가돼 청크가 최대 2.6배 커지고 LLM 컨텍스트를 넘길 수 있다. 그 초과를
//      막으려고 만든 함수인데 샘플 편향이 남아 있었다.
//  (2) 페이지 **내부** 분할(splitByCodepoint)에는 오버랩이 적용되지 않는다 — 답이 그 경계에
//      걸리면 어느 청크에도 온전히 담기지 않아 RAG 가 근거를 못 찾는다("맞아 보이지만 틀린 답").
// ─────────────────────────────────────────────────────────────────────────────
import { chunkText, chunkChapters, chunkTextWithOverlap, chunkTextWithOverlapByPage, estimateCharsPerToken } from '../chunker';
import type { Chapter } from '../../types';

describe('페이지 내부 분할의 오버랩 (QA23)', () => {
  // 픽스처는 **고유 토큰**이어야 한다 — 반복 패턴이면 어떤 부분문자열도 어디에나 있어
  // 오버랩 검사가 공허해진다(첫 시도가 그래서 수정 전에도 통과했다).
  const uniqueBody = (n: number) => Array.from({ length: n }, (_, i) => `항목${String(i).padStart(4, '0')}값`).join(' ');

  it('거대 단일 단락을 쪼갤 때도 조각 사이에 오버랩이 있다', () => {
    // 빈 줄 없는 긴 페이지(표·OCR 결과의 전형) — 단락 경계가 없어 codepoint 분할로 잘린다.
    // 오버랩이 0 이면 그 경계에 걸친 문장은 **어느 청크에도 온전히 담기지 않아** RAG 가 못 찾는다.
    const text = uniqueBody(500);
    const chunks = chunkTextWithOverlap(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.slice(-30);
      expect(chunks[i]!.startsWith(prevTail.slice(0, 10)) || chunks[i]!.includes(prevTail.slice(-15)),
        `청크 ${i - 1}→${i} 경계에 오버랩이 없다`).toBe(true);
    }
  });

  it('조각 경계에 걸친 문장이 최소 한 청크에는 온전히 담긴다', () => {
    // 경계 위치를 모르므로, 문서 전체에 고유 문장을 촘촘히 심고 **전부** 온전히 담기는지 본다.
    const sentences = Array.from({ length: 200 }, (_, i) => `측정값${String(i).padStart(3, '0')}은 정상범위였다.`);
    const text = sentences.join(' ');
    const chunks = chunkTextWithOverlap(text, 300);
    const missing = sentences.filter((s) => !chunks.some((c) => c.includes(s)));
    expect(missing, `경계에 걸려 어느 청크에도 온전히 담기지 않은 문장: ${missing.slice(0, 3).join(' / ')}`).toEqual([]);
  });
});

describe('estimateCharsPerToken — 표본 편향 (QA23)', () => {
  it('앞부분이 영문이어도 문서 전체의 한글 비율을 반영한다', () => {
    // 국문 논문의 전형: 표지·영문 초록(2500자) 뒤에 한글 본문이 이어진다.
    const englishHead = 'This paper presents a method for evaluating operating system schedulers. '.repeat(35);
    const koreanBody = '본 논문은 운영체제 스케줄러를 평가하는 방법을 제시한다. '.repeat(200);
    const doc = englishHead + koreanBody;
    const cpt = estimateCharsPerToken(doc);
    // 기준선: 문서 전체를 다 본다면 얼마인가(같은 공식, 표본만 전체).
    const cjkAll = (doc.match(/[가-힣]/g) || []).length;
    const whole = Math.max(1.5, 4 - (cjkAll / doc.length) * 2.5);
    // 앞 2000자만 보면 4.0(영문 값)이 나온다 — 전체 기준선에 가까워야 한다.
    expect(cpt).toBeLessThan(4);
    expect(Math.abs(cpt - whole), `표본 추정 ${cpt} 이 전체 기준선 ${whole} 과 크게 어긋난다`).toBeLessThan(0.4);
  });

  it('실제로 영문 문서면 영문 값을 유지한다 (과잉 보정 방지)', () => {
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(300);
    expect(estimateCharsPerToken(english)).toBeGreaterThan(3.5);
  });

  it('짧은 텍스트도 종전대로 동작한다', () => {
    expect(estimateCharsPerToken('한글 문서입니다')).toBeLessThan(2.5);
    expect(estimateCharsPerToken('english text')).toBeGreaterThan(3.5);
  });
});

describe('chunkText', () => {
  it('짧은 텍스트는 하나의 청크로 반환한다', () => {
    const text = '짧은 텍스트입니다.';
    const chunks = chunkText(text, 4000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('긴 텍스트를 여러 청크로 분할한다', () => {
    // maxChunkSize=10 tokens ≈ 40 chars
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `문단 ${i + 1}: ${'가'.repeat(30)}`,
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('빈/공백 텍스트는 빈 배열을 반환한다 (벡터 스토어 오염 방지)', () => {
    expect(chunkText('', 4000)).toEqual([]);
    expect(chunkText('   ', 4000)).toEqual([]);
    expect(chunkText('\n\n\t', 4000)).toEqual([]);
  });

  // QA9(B-LOW): 경계에서 whitespace-only 문단이 단독 current 로 남으면 in-loop push 가 빈 청크를
  // 방출했다(오버랩 경로엔 이미 가드). 빈 청크가 섞이지 않아야 한다.
  it('경계의 whitespace-only 문단이 빈 청크를 만들지 않는다', () => {
    const text = 'A'.repeat(35) + '\n\n   \n\n' + 'B'.repeat(35);
    const chunks = chunkText(text, 30);
    expect(chunks).not.toContain('');
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  // QA6-B: 손상/수기편집 settings 의 비숫자 maxChunkSize 는 Math.max(100, NaN)=NaN 으로 폭발
  // 하한이 무력화돼 전 문서가 1개 거대 청크로 강등됐다 — 기본값 폴백으로 정상 분할 유지.
  it('비유한/비양수 maxChunkSize 는 기본값 폴백 (NaN 하한 무력화 방지)', () => {
    const text = Array.from({ length: 200 }, (_, i) => `문단 ${i}: ${'가'.repeat(120)}`).join('\n\n');
    expect(chunkText(text, Number('abc'))).toEqual(chunkText(text));      // NaN → 기본 4000
    expect(chunkText(text, -5)).toEqual(chunkText(text));                 // 음수 → 기본 4000
    // 숫자형 문자열(JSON 수기편집)은 숫자로 수용
    expect(chunkText(text, '10' as unknown as number)).toEqual(chunkText(text, 10));
    // RAG 경로도 동일 방어 (기본 500 폴백 — 단일 거대 청크 아님)
    expect(chunkTextWithOverlap(text, Number('abc'))).toEqual(chunkTextWithOverlap(text));
  });

  it('문단 경계에서 분할한다', () => {
    const text = '첫 번째 문단\n\n두 번째 문단\n\n세 번째 문단';
    const chunks = chunkText(text, 3); // 매우 작은 청크 크기
    for (const chunk of chunks) {
      // 각 청크가 문단 중간에서 잘리지 않음
      expect(chunk).not.toMatch(/^\n\n/);
    }
  });

  // QA post-v0.31.15: maxChunkSize 0/음수(손상 settings.json)여도 코드포인트당 1청크로
  // 폭발하지 않는다 — floor 100 하한으로 청크 수가 문서 크기에 선형 폭증하지 않아야 한다.
  it('maxChunkSize 0/음수여도 코드포인트 폭발 없음(floor 하한)', () => {
    const text = '가'.repeat(1000);
    for (const bad of [0, -5, -1000]) {
      const chunks = chunkText(text, bad);
      // 코드포인트당 1청크였다면 ~1000개. floor 100 이면 훨씬 적어야 한다.
      expect(chunks.length).toBeLessThan(60);
      expect(chunks.join('')).toContain('가');
    }
  });
});

describe('chunkTextWithOverlap', () => {
  it('짧은 텍스트는 하나의 청크로 반환한다', () => {
    const text = '짧은 RAG 텍스트';
    expect(chunkTextWithOverlap(text, 500)).toEqual([text]);
  });

  it('빈/공백 텍스트는 빈 배열', () => {
    expect(chunkTextWithOverlap('', 500)).toEqual([]);
    expect(chunkTextWithOverlap('   \n\n', 500)).toEqual([]);
  });

  it('긴 텍스트를 여러 청크로 분할한다', () => {
    // maxChunkSize=50 tokens, 한글 30자 * 20문단 = 600자 > maxChars
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `문단${i + 1} ${'가'.repeat(30)}`,
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkTextWithOverlap(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('overlap 이 0 이면 tail 이 추가되지 않는다', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `p${i}` + 'a'.repeat(200),
    );
    const text = paragraphs.join('\n\n');
    const noOverlap = chunkTextWithOverlap(text, 50, 0);
    // 청크 경계 이웃 간 공유 tail 이 없어야 함
    for (let i = 1; i < noOverlap.length; i++) {
      const prevEnd = noOverlap[i - 1]!.slice(-20);
      const currStart = noOverlap[i]!.slice(0, 20);
      expect(currStart).not.toBe(prevEnd);
    }
  });

  it('UTF-16 surrogate pair 를 잘못 분할하지 않는다 (이모지)', () => {
    // 🎉 = U+1F389, 2 code units. maxChunkSize 작게 설정해 강제 분할 유도.
    const text = '🎉'.repeat(300);
    const chunks = chunkTextWithOverlap(text, 50, 0.1);
    for (const chunk of chunks) {
      // lone surrogate 탐지 — 쌍이 맞지 않으면 잘린 것
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
          // high surrogate — 다음 code unit 은 low surrogate 여야 함
          const next = chunk.charCodeAt(i + 1);
          expect(next >= 0xDC00 && next <= 0xDFFF).toBe(true);
          i++; // skip low surrogate
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          // lone low surrogate — 실패
          throw new Error(`lone low surrogate at chunk boundary: ${chunk.slice(Math.max(0, i - 5), i + 5)}`);
        }
      }
    }
  });

  it('CJK 텍스트에서 청크 전체를 복원할 수 있다', () => {
    const text = '한글 문서 내용입니다. '.repeat(100);
    const chunks = chunkTextWithOverlap(text, 30, 0.1);
    // 모든 청크를 concat 하면 원본의 모든 고유 단어를 포함
    const combined = chunks.join(' ');
    expect(combined).toContain('한글 문서 내용');
  });

  it('문장부호로 끝나는 문단 경계에서도 overlap 이 소실되지 않는다 (tailAtBoundary 회귀 가드)', () => {
    // 각 문단이 마침표로 끝나며, 청크 분할이 문단 경계에서 일어나는 케이스.
    // 과거 버그: tailAtBoundary 가 마지막 위치의 문장부호를 경계로 인식해 빈 tail 반환 → overlap 소실.
    const paragraphs = Array.from({ length: 8 }, (_, i) => `${'가'.repeat(80)}${i + 1}.`);
    const text = paragraphs.join('\n\n');
    const chunks = chunkTextWithOverlap(text, 50, 0.2);
    // 청크가 2개 이상 생성되어야 하고, 인접 청크는 비어있지 않은 tail overlap 을 공유해야 함.
    expect(chunks.length).toBeGreaterThan(1);
    let atLeastOneOverlap = false;
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      if (prev.length === 0 || curr.length === 0) continue;
      // curr 의 시작 일부 (첫 10자) 가 prev 의 어딘가에 존재하면 overlap 으로 간주
      const currHead = curr.slice(0, Math.min(10, curr.length));
      if (prev.includes(currHead)) {
        atLeastOneOverlap = true;
        break;
      }
    }
    expect(atLeastOneOverlap).toBe(true);
  });
});

describe('chunkText surrogate safety', () => {
  it('overflow 강제 분할 시 이모지가 잘리지 않는다', () => {
    const text = '🎉'.repeat(200);
    const chunks = chunkText(text, 10); // 매우 작은 청크로 overflow 유도
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = chunk.charCodeAt(i + 1);
          expect(next >= 0xDC00 && next <= 0xDFFF).toBe(true);
          i++;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          throw new Error('lone low surrogate in overflow split');
        }
      }
    }
  });
});

describe('chunkChapters', () => {
  it('챕터별로 청크를 반환한다', () => {
    const chapters: Chapter[] = [
      { index: 1, title: '1장', startPage: 1, endPage: 5, text: '짧은 텍스트' },
      { index: 2, title: '2장', startPage: 6, endPage: 10, text: '또 다른 짧은 텍스트' },
    ];
    const result = chunkChapters(chapters, 4000);
    expect(result).toHaveLength(2);
    expect(result[0]!.chapter.title).toBe('1장');
    expect(result[0]!.chunks).toHaveLength(1);
  });

  it('큰 챕터는 여러 청크로 분할한다', () => {
    const longText = Array.from({ length: 20 }, (_, i) =>
      `절 ${i + 1}: ${'나'.repeat(50)}`,
    ).join('\n\n');

    const chapters: Chapter[] = [
      { index: 1, title: '대형 챕터', startPage: 1, endPage: 50, text: longText },
    ];
    const result = chunkChapters(chapters, 10);
    expect(result[0]!.chunks.length).toBeGreaterThan(1);
  });
});

// page-citation-viewer 기능 — Design Ref §3.3.1
describe('chunkTextWithOverlapByPage', () => {
  it('빈 pageTexts 는 빈 배열을 반환', () => {
    expect(chunkTextWithOverlapByPage([])).toEqual([]);
  });

  it('단일 짧은 페이지는 하나의 청크로 반환하고 pageStart/pageEnd 모두 1', () => {
    const result = chunkTextWithOverlapByPage(['짧은 페이지 내용'], 500, 0.1);
    expect(result).toHaveLength(1);
    expect(result[0]!.pageStart).toBe(1);
    expect(result[0]!.pageEnd).toBe(1);
    expect(result[0]!.text).toContain('짧은');
  });

  it('여러 페이지에 걸친 큰 문서를 청크로 분할하고 각 청크의 페이지 범위를 반환', () => {
    // 3 페이지, 각각 충분히 긴 텍스트
    const pageTexts = [
      '첫 번째 페이지의 내용 '.repeat(40),
      '두 번째 페이지의 내용 '.repeat(40),
      '세 번째 페이지의 내용 '.repeat(40),
    ];
    // 작은 청크 크기로 분할 유도
    const result = chunkTextWithOverlapByPage(pageTexts, 50, 0.1);
    expect(result.length).toBeGreaterThan(1);
    // 모든 청크의 pageStart/pageEnd 는 1 ~ 3 범위 내여야 함
    for (const chunk of result) {
      expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeLessThanOrEqual(3);
      expect(chunk.pageStart).toBeLessThanOrEqual(chunk.pageEnd);
    }
  });

  it('각 페이지의 내용이 해당 페이지 번호의 청크에 포함된다 (단일 페이지 판정)', () => {
    const pageTexts = [
      '페이지일 고유마커Aaa ' + '내용 '.repeat(30),
      '페이지이 고유마커Bbb ' + '내용 '.repeat(30),
      '페이지삼 고유마커Ccc ' + '내용 '.repeat(30),
    ];
    const result = chunkTextWithOverlapByPage(pageTexts, 30, 0.1);
    // 마커가 포함된 청크가 올바른 페이지 번호에 매핑되어야 함
    const aChunks = result.filter((c) => c.text.includes('고유마커Aaa'));
    const bChunks = result.filter((c) => c.text.includes('고유마커Bbb'));
    const cChunks = result.filter((c) => c.text.includes('고유마커Ccc'));
    expect(aChunks.length).toBeGreaterThan(0);
    expect(bChunks.length).toBeGreaterThan(0);
    expect(cChunks.length).toBeGreaterThan(0);
    // Aaa 를 포함하는 청크는 페이지 1 에서 시작
    expect(aChunks[0]!.pageStart).toBe(1);
    // Bbb 를 포함하는 청크는 페이지 2 를 포함
    expect(bChunks[0]!.pageStart).toBeLessThanOrEqual(2);
    expect(bChunks[0]!.pageEnd).toBeGreaterThanOrEqual(2);
    // Ccc 를 포함하는 청크는 페이지 3 을 포함
    expect(cChunks[0]!.pageEnd).toBeGreaterThanOrEqual(3);
  });

  it('청크의 pageStart/pageEnd 가 1-based 인지 검증', () => {
    const result = chunkTextWithOverlapByPage(['single page content'], 500, 0.1);
    expect(result[0]!.pageStart).toBeGreaterThanOrEqual(1);
    expect(result[0]!.pageEnd).toBeGreaterThanOrEqual(1);
  });

  // v0.18.5 B2 regression — 누적 단락이 effectiveMax 를 초과해 splitByCodepoint 에 들어가는 경우,
  // 모든 part 가 동일 페이지 범위를 갖지 않고 part 별로 다르게 분배되는지 검증.
  it('effectiveMax 를 초과한 단락 split 시 part 별 페이지 범위가 분배된다', () => {
    // 각 페이지가 단락 구분 없는 긴 텍스트 — 페이지 join 시 \n\n 추가됨.
    // 의도: chunker 가 인접 페이지를 묶어 effectiveMax 를 넘기게 만들고,
    //       splitByCodepoint 가 각 part 에 다른 페이지 범위를 부여하는지 확인.
    const pageTexts = Array.from({ length: 6 }, (_, i) =>
      `페이지${i + 1}`.repeat(1) + '내용가나다라마바사아자차카타파하'.repeat(20),
    );
    // 작은 maxChunkSize 로 분할 빈도 증가 — 단일 페이지가 effectiveMax 를 일부 초과하도록 유도
    const result = chunkTextWithOverlapByPage(pageTexts, 60, 0.1);
    expect(result.length).toBeGreaterThan(1);

    // 청크의 페이지 범위가 모두 1-6 으로 균일하지 않고 진행에 따라 변화해야 함
    const pageStarts = result.map((c) => c.pageStart);
    const pageEnds = result.map((c) => c.pageEnd);
    // pageStart 들이 모두 동일하지 않고 (즉, 분배가 일어남)
    const uniqueStarts = new Set(pageStarts);
    expect(uniqueStarts.size).toBeGreaterThan(1);
    // 모든 청크의 pageStart <= pageEnd
    for (let i = 0; i < result.length; i++) {
      expect(pageStarts[i]!).toBeLessThanOrEqual(pageEnds[i]!);
    }
    // 첫 청크의 pageStart 는 1, 마지막 청크의 pageEnd 는 6 이어야 (전체 커버)
    expect(pageStarts[0]).toBe(1);
    expect(pageEnds[pageEnds.length - 1]).toBe(6);
  });

  it('단일 페이지 거대 단락이 split 되어도 모든 part 가 같은 페이지(1)로 매핑', () => {
    // 한 페이지 안의 거대한 텍스트 → split 되어도 모두 페이지 1
    const pageTexts = ['단일페이지'.repeat(2000)];
    const result = chunkTextWithOverlapByPage(pageTexts, 50, 0);
    expect(result.length).toBeGreaterThan(1);
    for (const c of result) {
      expect(c.pageStart).toBe(1);
      expect(c.pageEnd).toBe(1);
    }
  });

  // R35 회귀 가드: overlap tail 이 pageStart 를 이전 페이지로 끌어당기지 않아야 한다.
  // page 2 시작에 위치한 마커를 포함하는 첫 청크는 body 가 page 2 에서 시작하므로
  // pageStart 가 2 여야 한다. 과거 버그: page 1 에서 끌어온 overlap tail 때문에
  // pageStart 가 1 로 편향되어 [p.1-2] 같은 범위 라벨을 양산하고 인용을 앞 페이지로 편향시켰다.
  it('overlap tail 이 pageStart 를 이전 페이지로 끌어당기지 않는다', () => {
    const pageTexts = [
      '첫페이지마커Aaa ' + '가나다라마바사 '.repeat(50),
      '둘째페이지마커Zzz ' + '아자차카타파하 '.repeat(50),
    ];
    // overlap 0.1 (>0) 로 page 2 첫 청크에 page 1 출신 tail 이 붙도록 유도
    const result = chunkTextWithOverlapByPage(pageTexts, 100, 0.1);
    const zChunk = result.find((c) => c.text.includes('둘째페이지마커Zzz'));
    expect(zChunk).toBeDefined();
    expect(zChunk!.pageStart).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA29(B-6 / B-7): 오버랩 tail 과 페이지 귀속의 좌표계 정합.
//  B-6 — 청크 `text` 는 직전 청크의 tail(이전 페이지 출신)을 앞에 달고 있는데 `pageStart` 는
//        body 기준(R35, 의도)이다. tail 안의 문장을 근거로 인용을 만들면 **한 페이지 늦은**
//        라벨이 붙는다. `bodyOffset` 으로 tail 길이를 노출해 소비자가 배제할 수 있게 한다.
//  B-7 — codepoint 강제 분할은 `prevTail + '\n\n' + body` 를 자르면서 **body 길이만** 균등
//        분배해, part k 의 body 시작 추정이 tail 길이만큼 뒤로 밀려 있었다.
//
// 두 결함을 하나의 불변식으로 고정한다: **body 는 자기 pageStart..pageEnd 안에 실제로 있다.**
// (tail 을 포함한 `text` 전체로는 성립하지 않는다 — 아래에서 그 대비도 함께 단언한다.)
// ─────────────────────────────────────────────────────────────────────────────
describe('QA29: bodyOffset 과 페이지 귀속의 정합', () => {
  const SEP = '\n\n';
  const pagesJoined = (pages: string[], startPage: number, endPage: number) =>
    pages.slice(startPage - 1, endPage).join(SEP);

  // 페이지마다 고유 토큰 — 반복 패턴이면 어떤 부분문자열도 어디에나 있어 포함 검사가 공허해진다.
  const uniquePage = (p: number, n: number) =>
    Array.from({ length: n }, (_, i) => `p${p}항목${String(i).padStart(3, '0')}`).join(' ');

  it('B-6/B-7: 모든 청크의 body(text.slice(bodyOffset))가 자신의 pageStart..pageEnd 안에 실제로 존재한다', () => {
    const pages = Array.from({ length: 8 }, (_, i) => uniquePage(i + 1, 40));
    const result = chunkTextWithOverlapByPage(pages, 120, 0.1);
    expect(result.length).toBeGreaterThan(3);
    for (const c of result) {
      const body = c.text.slice(c.bodyOffset);
      expect(body.length, 'body 가 통째로 사라졌다').toBeGreaterThan(0);
      expect(
        pagesJoined(pages, c.pageStart, c.pageEnd).includes(body),
        `body 가 [p.${c.pageStart}-${c.pageEnd}] 밖에 있다: ${body.slice(0, 40)}…`,
      ).toBe(true);
    }
  });

  it('B-6: tail 을 배제하지 않으면 같은 검사가 실패한다 — bodyOffset 이 공허한 0 이 아님', () => {
    const pages = Array.from({ length: 8 }, (_, i) => uniquePage(i + 1, 40));
    const result = chunkTextWithOverlapByPage(pages, 120, 0.1);
    // tail 이 실제로 붙은 청크가 존재하고,
    const overlapped = result.filter((c) => c.bodyOffset > 0);
    expect(overlapped.length, 'tail 이 붙은 청크가 하나도 없다 — 픽스처가 오버랩을 만들지 못했다').toBeGreaterThan(0);
    // 그 청크는 text 전체로는 자기 페이지 범위 안에 들어가지 않는다(= tail 이 이전 페이지 출신).
    const leaking = overlapped.filter((c) => !pagesJoined(pages, c.pageStart, c.pageEnd).includes(c.text));
    expect(leaking.length, 'tail 포함 text 가 전부 자기 페이지 안에 있다 — bodyOffset 이 무의미해진다').toBeGreaterThan(0);
    // tail 구간의 본문은 pageStart 보다 **앞** 페이지에서 온다.
    const c0 = leaking[0]!;
    expect(c0.pageStart).toBeGreaterThan(1);
    const tail = c0.text.slice(0, c0.bodyOffset).trim();
    expect(pagesJoined(pages, 1, c0.pageStart - 1).includes(tail.slice(0, 12))).toBe(true);
  });

  it('B-7: 빈 줄 없는 긴 페이지(표·OCR)의 codepoint 강제 분할에서도 body 귀속이 밀리지 않는다', () => {
    // 페이지 안에 단락 경계(빈 줄)가 전혀 없어 전부 splitByCodepoint 경로로 잘린다.
    const pages = Array.from({ length: 5 }, (_, i) => uniquePage(i + 1, 120));
    const result = chunkTextWithOverlapByPage(pages, 200, 0.1);
    expect(result.length).toBeGreaterThan(3);
    for (const c of result) {
      const body = c.text.slice(c.bodyOffset);
      expect(
        pagesJoined(pages, c.pageStart, c.pageEnd).includes(body),
        `split part 의 body 가 [p.${c.pageStart}-${c.pageEnd}] 밖에 있다: ${body.slice(0, 40)}…`,
      ).toBe(true);
    }
    // 페이지 첫 토큰은 그 페이지를 pageStart 로 갖는 청크의 body 에서 발견돼야 한다
    // (한 페이지 늦게 귀속되면 pageStart 가 +1 이 된다).
    for (let p = 1; p <= 5; p++) {
      const first = `p${p}항목000`;
      const owner = result.find((c) => c.text.slice(c.bodyOffset).includes(first));
      expect(owner, `p${p} 첫 토큰을 body 로 갖는 청크가 없다`).toBeDefined();
      expect(owner!.pageStart, `p${p} 첫 토큰이 p.${owner!.pageStart} 로 귀속됐다`).toBe(p);
    }
  });

  // B-7 의 관측 가능한 케이스: **텍스트가 없는 첫 페이지**(스캔 PDF 의 표지 — 파서가 '' 를 낸다).
  // 이때만 codepoint 강제 분할이 **여러 페이지에 걸친 body** 를 받는다(빈 첫 단락 때문에
  // `bodyEnd > bodyStart` 가드가 통과하지 못해 body 가 다음 페이지까지 확장된다). 종전 산식은
  // body 길이를 part 수로 균등 분배해 첫 part 의 body 시작을 원본 0(= 빈 페이지 1)으로 봤고,
  // 실제로는 2쪽 본문인 청크에 `[p.1-2]` 라는 없는 범위가 붙었다.
  it('B-7: 첫 페이지가 빈 문서에서도 첫 청크가 실제 본문 페이지로 귀속된다', () => {
    const pages = ['', uniquePage(2, 200), uniquePage(3, 200)];
    const result = chunkTextWithOverlapByPage(pages, 200, 0.1);
    const first = result[0]!;
    expect(first.text.slice(first.bodyOffset).startsWith('p2항목000')).toBe(true);
    expect(first.pageStart, '본문이 2쪽인데 빈 1쪽으로 귀속됐다').toBe(2);
    expect(first.pageEnd, '빈 페이지를 포함한 범위 라벨이 만들어졌다').toBe(2);
    // 어떤 청크도 텍스트가 없는 1쪽을 근거로 주장하지 않는다.
    expect(result.every((c) => c.pageStart >= 2)).toBe(true);
  });

  it('tail 이 없는 청크의 bodyOffset 은 0 이고, 단일 청크 문서도 0', () => {
    expect(chunkTextWithOverlapByPage(['짧은 한 페이지'], 500, 0.1)[0]!.bodyOffset).toBe(0);
    const pages = Array.from({ length: 4 }, (_, i) => uniquePage(i + 1, 30));
    const noOverlap = chunkTextWithOverlapByPage(pages, 100, 0);
    expect(noOverlap.length).toBeGreaterThan(1);
    for (const c of noOverlap) expect(c.bodyOffset).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA30(B-1): **빈 표지 문서의 첫 청크가 항상 `[p.1]` 로 귀속되던 것.**
//
// QA29(B-7)의 `bodyLead` 보정이 codepoint 강제 분할 분기에만 들어가, 단락 사이에 빈 줄이 있는
// **보통 문서**(= flush 비분할 분기)와 문서 전체가 한 청크인 경우(= 조기 반환 분기)는 선행 빈
// 페이지가 그대로 `bodyStart` 에 남았다. 위 QA29 가드는 이름과 주석이 "첫 페이지가 빈 문서"를
// 닫았다고 말하지만 픽스처가 `uniquePage(2, 200)` — **빈 줄이 하나도 없는 단일 거대 단락**이라
// split 경로로만 진입했다. 세 분기를 **하나의 불변식**으로 묶는다:
//   "텍스트가 없는 페이지를 pageStart 로 갖는 청크는 존재하지 않는다."
//
// 빈 표지·간지는 이 저장소가 정상으로 규정한 형태다(pdf-parser 의 countEmptyPages 주석). 그
// 문서의 첫 청크(초록·서론)가 `[p.1]` 로 프롬프트에 들어가면 모델의 인용이 clampCitationPage 를
// 통과해 정상 버튼이 되고, 클릭하면 글자 없는 표지로 점프한다.
// ─────────────────────────────────────────────────────────────────────────────
describe('QA30: 빈 표지 문서의 페이지 귀속 — 세 분기 공통 불변식 (B-1)', () => {
  const SEP = '\n\n';
  const pagesJoined = (pages: string[], startPage: number, endPage: number) =>
    pages.slice(startPage - 1, endPage).join(SEP);
  /** 라틴 토큰(cpt=4.0 고정) — 페이지마다 고유해 포함 검사가 공허해지지 않는다. */
  const token = (p: number, i: number) => `p${p}item${String(i).padStart(3, '0')}`;
  const para = (p: number, from: number, n: number) =>
    Array.from({ length: n }, (_, i) => token(p, from + i)).join(' ');
  /** 단락 3개(각 ~500자)로 이루어진 페이지 — 페이지 안에 빈 줄이 있어 flush 비분할 경로를 탄다. */
  const multiParaPage = (p: number) => [para(p, 0, 50), para(p, 50, 50), para(p, 100, 50)].join(SEP);

  /** maxChunkSize=500 · 라틴(cpt 4.0) → maxChars 2000 / effectiveMax 2200. */
  const CHUNK = 500;

  const assertNoEmptyPageAttribution = (pages: string[], label: string) => {
    const result = chunkTextWithOverlapByPage(pages, CHUNK, 0.1);
    expect(result.length, `${label}: 청크가 만들어지지 않았다`).toBeGreaterThan(0);
    for (const c of result) {
      const body = c.text.slice(c.bodyOffset);
      expect(body.length, `${label}: body 가 통째로 사라졌다`).toBeGreaterThan(0);
      // ① 빈 페이지를 근거 페이지로 주장하는 청크가 하나도 없다.
      expect(
        (pages[c.pageStart - 1] ?? '').trim().length,
        `${label}: 텍스트가 없는 p.${c.pageStart} 가 인용 라벨이 된다`,
      ).toBeGreaterThan(0);
      // ② 그리고 body 는 실제로 그 페이지 범위 안에 있다(①이 우연히 맞는 것을 배제).
      expect(
        pagesJoined(pages, c.pageStart, c.pageEnd).includes(body),
        `${label}: body 가 [p.${c.pageStart}-${c.pageEnd}] 밖에 있다: ${body.slice(0, 40)}…`,
      ).toBe(true);
    }
    return result;
  };

  it('픽스처 자기검증: 세 픽스처가 실제로 서로 다른 분기로 들어간다', () => {
    // (a) 조기 반환 — 전체가 maxChars(2000) 이하라 청크가 1개.
    const early = chunkTextWithOverlapByPage(['', para(2, 0, 50)], CHUNK, 0.1);
    expect(early).toHaveLength(1);

    // (b) flush 비분할 — 청크 경계가 **단락 경계**에 정확히 떨어진다(split 이면 단락 중간에서 잘린다).
    const pages = ['', multiParaPage(2), multiParaPage(3), multiParaPage(4)];
    const paras = pages.join(SEP).split(/\n\n+/).filter((s) => s.length > 0);
    const flushed = chunkTextWithOverlapByPage(pages, CHUNK, 0.1);
    expect(flushed.length).toBeGreaterThan(1);
    for (const c of flushed) {
      const body = c.text.slice(c.bodyOffset);
      expect(paras.some((p) => body.startsWith(p)), 'body 가 단락 시작에서 출발하지 않는다').toBe(true);
      expect(paras.some((p) => body.endsWith(p)), 'body 가 단락 끝에서 멈추지 않는다').toBe(true);
    }

    // (c) split — 빈 줄 없는 단일 거대 단락 하나가 여러 청크로 쪼개진다(QA29 가드가 유일하게 본 형태).
    const splitPages = ['', para(2, 0, 400)];
    expect(splitPages.join(SEP).split(/\n\n+/).filter((s) => s.length > 0)).toHaveLength(1);
    expect(chunkTextWithOverlapByPage(splitPages, CHUNK, 0.1).length).toBeGreaterThan(1);
  });

  it('빈 표지 × 조기 반환: 짧은 본문도 실제 본문 페이지로 귀속된다', () => {
    const pages = ['', para(2, 0, 50)];
    const result = assertNoEmptyPageAttribution(pages, 'early-return');
    expect(result[0]!.pageStart, '본문이 2쪽인데 빈 1쪽으로 귀속됐다').toBe(2);
    expect(result[0]!.pageEnd).toBe(2);
  });

  it('빈 표지 × flush 비분할: 단락 사이에 빈 줄이 있는 보통 문서', () => {
    const pages = ['', multiParaPage(2), multiParaPage(3), multiParaPage(4)];
    const result = assertNoEmptyPageAttribution(pages, 'flush-비분할');
    expect(result[0]!.pageStart, '본문이 2쪽인데 빈 1쪽으로 귀속됐다').toBe(2);
    expect(result[0]!.text.slice(result[0]!.bodyOffset).startsWith(token(2, 0))).toBe(true);
  });

  it('빈 표지 2장 × flush 비분할: 오차도 2페이지가 된다', () => {
    const pages = ['', '', multiParaPage(3), multiParaPage(4)];
    const result = assertNoEmptyPageAttribution(pages, '빈표지2장');
    expect(result[0]!.pageStart, '본문이 3쪽인데 빈 1쪽으로 귀속됐다').toBe(3);
  });

  it('빈 표지 × split: QA29 가 이미 닫은 경로도 같은 불변식을 지킨다 (회귀)', () => {
    const result = assertNoEmptyPageAttribution(['', para(2, 0, 400)], 'split');
    expect(result[0]!.pageStart).toBe(2);
  });

  it('대조군: 빈 페이지가 없으면 첫 청크는 그대로 p.1', () => {
    const pages = [multiParaPage(1), multiParaPage(2), multiParaPage(3)];
    const result = assertNoEmptyPageAttribution(pages, '대조군');
    expect(result[0]!.pageStart).toBe(1);
  });

  // 대칭 결함: 문서 **끝**의 빈 페이지는 후행 공백으로 body 에 딸려 들어와 pageEnd 를 부풀린다.
  // 조기 반환(짧은 문서)과 flush(긴 문서) 두 분기 모두에서 성립해야 한다.
  it.each([
    ['조기 반환', [multiParaPage(1), '', ''], 1],
    ['flush', [multiParaPage(1), multiParaPage(2), multiParaPage(3), '', ''], 2],
  ] as const)('문서 끝의 빈 페이지가 pageEnd 를 부풀리지 않는다 — %s (후행 trim 대칭)', (_label, pages, minChunks) => {
    const result = chunkTextWithOverlapByPage([...pages], CHUNK, 0.1);
    // 픽스처 자기검증: 의도한 분기로 들어갔다(1개면 조기 반환, 2개 이상이면 flush).
    expect(result.length).toBeGreaterThanOrEqual(minChunks);
    if (minChunks === 1) expect(result).toHaveLength(1);
    for (const c of result) {
      expect(
        (pages[c.pageEnd - 1] ?? '').trim().length,
        `텍스트가 없는 p.${c.pageEnd} 까지 범위가 늘어났다`,
      ).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { chunkText, chunkChapters, chunkTextWithOverlap, chunkTextWithOverlapByPage } from '../chunker';
import type { Chapter } from '../../types';

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

  it('문단 경계에서 분할한다', () => {
    const text = '첫 번째 문단\n\n두 번째 문단\n\n세 번째 문단';
    const chunks = chunkText(text, 3); // 매우 작은 청크 크기
    for (const chunk of chunks) {
      // 각 청크가 문단 중간에서 잘리지 않음
      expect(chunk).not.toMatch(/^\n\n/);
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
      const prevEnd = noOverlap[i - 1].slice(-20);
      const currStart = noOverlap[i].slice(0, 20);
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
      const prev = chunks[i - 1];
      const curr = chunks[i];
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
    expect(result[0].chapter.title).toBe('1장');
    expect(result[0].chunks).toHaveLength(1);
  });

  it('큰 챕터는 여러 청크로 분할한다', () => {
    const longText = Array.from({ length: 20 }, (_, i) =>
      `절 ${i + 1}: ${'나'.repeat(50)}`,
    ).join('\n\n');

    const chapters: Chapter[] = [
      { index: 1, title: '대형 챕터', startPage: 1, endPage: 50, text: longText },
    ];
    const result = chunkChapters(chapters, 10);
    expect(result[0].chunks.length).toBeGreaterThan(1);
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
    expect(result[0].pageStart).toBe(1);
    expect(result[0].pageEnd).toBe(1);
    expect(result[0].text).toContain('짧은');
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
    expect(aChunks[0].pageStart).toBe(1);
    // Bbb 를 포함하는 청크는 페이지 2 를 포함
    expect(bChunks[0].pageStart).toBeLessThanOrEqual(2);
    expect(bChunks[0].pageEnd).toBeGreaterThanOrEqual(2);
    // Ccc 를 포함하는 청크는 페이지 3 을 포함
    expect(cChunks[0].pageEnd).toBeGreaterThanOrEqual(3);
  });

  it('청크의 pageStart/pageEnd 가 1-based 인지 검증', () => {
    const result = chunkTextWithOverlapByPage(['single page content'], 500, 0.1);
    expect(result[0].pageStart).toBeGreaterThanOrEqual(1);
    expect(result[0].pageEnd).toBeGreaterThanOrEqual(1);
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
      expect(pageStarts[i]).toBeLessThanOrEqual(pageEnds[i]);
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
});

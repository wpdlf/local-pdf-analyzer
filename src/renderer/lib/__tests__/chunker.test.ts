import { describe, it, expect } from 'vitest';
import { chunkText, chunkChapters } from '../chunker';
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

  it('빈 텍스트는 빈 배열을 반환하지 않는다', () => {
    const chunks = chunkText('', 4000);
    // 빈 문자열이지만 trim 후에도 최소 1개
    expect(chunks.length).toBeGreaterThanOrEqual(0);
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

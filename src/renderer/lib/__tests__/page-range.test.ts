import { describe, it, expect } from 'vitest';
import { slicePdfDocumentByPageRange, isFullRange } from '../page-range';
import type { PdfDocument, PageImage, Chapter } from '../../types';

function img(pageIndex: number): PageImage {
  return { pageIndex, imageIndex: 0, base64: 'x', width: 1, height: 1, mimeType: 'image/png' };
}
function chapter(index: number, startPage: number, endPage: number): Chapter {
  return { index, title: `C${index}`, startPage, endPage, text: `ch${index}` };
}
function doc(over: Partial<PdfDocument> = {}): PdfDocument {
  return {
    id: 'd1', fileName: 'a.pdf', filePath: '/a.pdf', pageCount: 5,
    extractedText: 'p1\n\np2\n\np3\n\np4\n\np5',
    pageTexts: ['p1', 'p2', 'p3', 'p4', 'p5'],
    chapters: [chapter(0, 1, 3), chapter(1, 3, 6)], // C0: 1-2, C1: 3-5 (endPage exclusive)
    images: [img(0), img(2), img(4)], // pages 1,3,5
    createdAt: new Date(0),
    ...over,
  };
}

describe('slicePdfDocumentByPageRange', () => {
  it('pageTexts 를 마스킹해 인용 페이지 번호(인덱스)를 보존한다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 2, 4);
    // 범위 밖(1,5)은 빈 문자열, 범위 안(2,3,4)은 원본 — 길이/인덱스 보존
    expect(out.pageTexts).toEqual(['', 'p2', 'p3', 'p4', '']);
  });

  it('extractedText 는 범위 페이지만 연결한다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 2, 4);
    expect(out.extractedText).toBe('p2\n\np3\n\np4');
  });

  it('images 는 범위 안 페이지의 것만 남긴다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 2, 4);
    expect(out.images.map((i) => i.pageIndex)).toEqual([2]); // page 3 만 (1,5 제외)
  });

  it('chapters 는 겹치는 것만 남기고 경계를 클램프한다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 2, 4);
    // C0(1-2)·C1(3-5) 둘 다 겹침 → startPage/endPage 클램프
    expect(out.chapters).toEqual([
      { index: 0, title: 'C0', startPage: 2, endPage: 3, text: 'ch0' }, // 1→2, 3→3
      { index: 1, title: 'C1', startPage: 3, endPage: 5, text: 'ch1' }, // 3, 6→5
    ]);
  });

  it('범위 밖 챕터는 제외한다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 4, 5);
    // C0(1-2)는 범위(4-5)와 안 겹침 → 제외, C1(3-5)만
    expect(out.chapters.map((c) => c.index)).toEqual([1]);
  });

  it('start>end 역입력은 스왑한다', () => {
    const out = slicePdfDocumentByPageRange(doc(), 4, 2);
    expect(out.pageTexts).toEqual(['', 'p2', 'p3', 'p4', '']);
  });

  it('범위를 1~pageCount 로 클램프한다(초과 입력 방어)', () => {
    const out = slicePdfDocumentByPageRange(doc(), 0, 99);
    expect(out.pageTexts).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']); // 전체
  });

  it('단일 페이지 범위', () => {
    const out = slicePdfDocumentByPageRange(doc(), 3, 3);
    expect(out.pageTexts).toEqual(['', '', 'p3', '', '']);
    expect(out.extractedText).toBe('p3');
    expect(out.images.map((i) => i.pageIndex)).toEqual([2]);
  });

  it('원본 doc 을 변형하지 않는다(순수)', () => {
    const d = doc();
    slicePdfDocumentByPageRange(d, 2, 3);
    expect(d.pageTexts).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(d.images).toHaveLength(3);
  });
});

describe('isFullRange', () => {
  it('null 이면 전체로 본다', () => {
    expect(isFullRange(null, 5)).toBe(true);
  });
  it('전체를 덮으면 true', () => {
    expect(isFullRange({ start: 1, end: 5 }, 5)).toBe(true);
    expect(isFullRange({ start: 1, end: 9 }, 5)).toBe(true); // end 초과도 전체
  });
  it('일부면 false', () => {
    expect(isFullRange({ start: 2, end: 5 }, 5)).toBe(false);
    expect(isFullRange({ start: 1, end: 4 }, 5)).toBe(false);
  });
});

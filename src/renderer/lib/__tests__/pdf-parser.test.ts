import { describe, it, expect, vi } from 'vitest';

// pdfjs-dist를 모킹 (Node 환경에서 직접 사용 불가)
vi.mock('pdfjs-dist', () => {
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: vi.fn(),
  };
});

import * as pdfjsLib from 'pdfjs-dist';

// parsePdf를 직접 테스트하기 어려우므로, detectChapters 로직을 검증
// pdf-parser.ts의 내부 로직과 동일한 패턴 테스트
describe('PDF Parser - Chapter Detection Logic', () => {
  const headingPattern = /^(제?\d+[장절]|chapter\s*\d+|\d+\.\s)/i;

  it('"제1장" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('제1장 서론')).toBe(true);
    expect(headingPattern.test('제2장 프로세스 관리')).toBe(true);
  });

  it('"Chapter 1" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('Chapter 1 Introduction')).toBe(true);
    expect(headingPattern.test('Chapter 10 Conclusion')).toBe(true);
  });

  it('"1. " 숫자+점 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('1. 개요')).toBe(true);
    expect(headingPattern.test('3. 결론')).toBe(true);
  });

  it('"1장" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('1장 운영체제 개요')).toBe(true);
  });

  it('일반 텍스트는 챕터 헤딩으로 감지하지 않는다', () => {
    expect(headingPattern.test('프로세스는 실행 중인 프로그램이다')).toBe(false);
    expect(headingPattern.test('이 장에서는')).toBe(false);
    expect(headingPattern.test('')).toBe(false);
  });
});

describe('PDF Parser - parsePdf error handling', () => {
  it('텍스트가 부족한 PDF에서 PDF_NO_TEXT 에러를 발생시킨다', async () => {
    // getDocument 모킹: 텍스트가 거의 없는 PDF
    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: '짧음' }],
      }),
    };
    const mockPdf = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
    };
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const { parsePdf } = await import('../pdf-parser');

    await expect(parsePdf(new ArrayBuffer(10), 'test.pdf', '/test.pdf'))
      .rejects.toThrow('텍스트를 추출할 수 없습니다');
  });
});

describe('PDF Parser - parsePdf success', () => {
  it('충분한 텍스트가 있는 PDF를 정상 파싱한다', async () => {
    const longText = '프로세스는 실행 중인 프로그램의 인스턴스이다. ' +
      '운영체제는 프로세스를 관리하며 CPU 스케줄링을 수행한다.';

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: longText }],
      }),
    };
    const mockPdf = {
      numPages: 3,
      getPage: vi.fn().mockResolvedValue(mockPage),
    };
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const { parsePdf } = await import('../pdf-parser');

    const doc = await parsePdf(new ArrayBuffer(10), 'lecture.pdf', '/lecture.pdf');
    expect(doc.fileName).toBe('lecture.pdf');
    expect(doc.pageCount).toBe(3);
    expect(doc.extractedText.length).toBeGreaterThan(50);
    expect(doc.id).toBeDefined();
    expect(doc.chapters.length).toBeGreaterThan(0);
  });
});

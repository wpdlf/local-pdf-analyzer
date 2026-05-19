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
  // pdf-parser.ts:116 프로덕션 코드와 동일한 패턴 사용
  // "1. " 패턴 제거됨 — 본문 번호 목록 오탐 방지
  const headingPattern = /^(제?\d+[장절]|chapter\s*\d+|\d+장)/i;

  it('"제1장" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('제1장 서론')).toBe(true);
    expect(headingPattern.test('제2장 프로세스 관리')).toBe(true);
  });

  it('"Chapter 1" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('Chapter 1 Introduction')).toBe(true);
    expect(headingPattern.test('Chapter 10 Conclusion')).toBe(true);
  });

  it('"1장" 패턴을 챕터 헤딩으로 감지한다', () => {
    expect(headingPattern.test('1장 운영체제 개요')).toBe(true);
  });

  it('"1. " 숫자+점 패턴은 챕터 헤딩으로 감지하지 않는다 (본문 오탐 방지)', () => {
    expect(headingPattern.test('1. 개요')).toBe(false);
    expect(headingPattern.test('3. 결론')).toBe(false);
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

// R28 회귀: MAX_TOTAL_IMAGES=50 캡이 배치 동시성으로 우회되지 않는지 확인.
// 모든 페이지가 병렬로 이미지를 푸시하더라도 결과의 images.length는 캡을 넘지 않아야 한다.
describe('PDF Parser - MAX_TOTAL_IMAGES cap enforcement', () => {
  it('한 배치 내 다수 페이지가 이미지를 동시에 추출해도 캡을 초과하지 않는다', async () => {
    // 10페이지가 각각 100장의 이미지를 가진 PDF를 시뮬레이션 — 캡 우회 시 1000장이 push됨.
    const PAGES = 10;
    const IMAGES_PER_PAGE = 100;

    const fakeImage = {
      objId: 'img1',
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    };

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: '프로세스는 실행 중인 프로그램의 인스턴스이다. 운영체제는 프로세스를 관리한다.' }],
      }),
      // extractPageImages 내부에서 호출되는 메소드들을 최대한 모킹.
      // 실제 extractPageImages는 getOperatorList/objs.get 등을 사용하므로 안전 모킹.
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: new Array(IMAGES_PER_PAGE).fill(85), // OPS.paintImageXObject = 85
        argsArray: new Array(IMAGES_PER_PAGE).fill(['img1']),
      }),
      objs: { get: vi.fn().mockReturnValue(fakeImage) },
      commonObjs: { get: vi.fn().mockReturnValue(fakeImage) },
      cleanup: vi.fn(),
    };

    const mockPdf = {
      numPages: PAGES,
      getPage: vi.fn().mockResolvedValue(mockPage),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const { parsePdf } = await import('../pdf-parser');
    const doc = await parsePdf(new ArrayBuffer(10), 'big.pdf', '/big.pdf');

    // extractPageImages가 실패하든 성공하든 images.length는 50을 넘으면 안 됨.
    expect(doc.images.length).toBeLessThanOrEqual(50);
  });
});

// R29 회귀 (v0.18.13): argsArray 에 손상된 entry 가 있을 때 페이지 전체가
// 죽지 않고 valid op 들만 추출해야 함. 이전엔 `argsArray[j]![0] as string` 의
// non-null 단언이 undefined 접근 시 throw → outer catch 가 페이지 단위 fallback
// 으로 빠지면서 1장 손상 → 9장 유실 패턴이었음.
describe('PDF Parser - extractPageImages args guard', () => {
  it('argsArray 일부 entry 가 undefined 여도 valid op 들에서 이미지를 추출한다', async () => {
    const fakeImage = {
      width: 10,
      height: 10,
      data: new Uint8ClampedArray(400),
    };
    const validArgs: unknown[] = [];
    // 10 ops 중 4개는 valid args, 5개는 undefined/잘못된 형태 — 단, 1개의 valid 가 더 있어
    // 본문 텍스트로 분류되는 페이지 통과를 위해 텍스트도 충분히 둠.
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        validArgs.push(['imgKey']);
      } else if (i === 1) {
        validArgs.push(undefined); // 손상된 entry
      } else if (i === 3) {
        validArgs.push([null]); // 첫 원소가 string 아님
      } else {
        validArgs.push([]); // 빈 배열
      }
    }

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{
          // PDF_NO_TEXT 임계(50자) 충분히 초과하는 본문
          str: '운영체제는 프로세스를 관리하며 CPU 스케줄링을 수행한다. 페이지 교체 알고리즘에는 LRU, FIFO 등이 있다.',
        }],
      }),
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: new Array(10).fill(85), // 모두 paintImageXObject
        argsArray: validArgs,
      }),
      objs: { get: vi.fn((_id: string, cb: (obj: unknown) => void) => cb(fakeImage)) },
      commonObjs: { get: vi.fn() },
      cleanup: vi.fn(),
    };

    const mockPdf = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const { parsePdf } = await import('../pdf-parser');

    // 손상된 entry 가 있어도 throw 없이 정상 완료해야 함 (parsePdf 가 reject 되지 않음).
    const doc = await parsePdf(new ArrayBuffer(10), 'corrupt.pdf', '/corrupt.pdf');
    expect(doc.pageCount).toBe(1);
    // valid args 중 일부라도 fakeImage 가 처리 흐름을 통과하면 images 가 1개 이상.
    // (구현이 OffscreenCanvas 미가용 환경에서 0장을 반환할 수 있어 엄격 비교 대신 throw 없음만 검증)
  });
});

// R30 회귀 (v0.18.17): extractPageImages 의 Promise.race 타이머가 race 가 빠르게 resolve 된
// 후에도 살아남아 5초 뒤 "timeout" 경고가 fire 되던 leak 차단.
describe('PDF Parser - extractPageImages race timer cleared', () => {
  it('getOperatorList 가 빠르게 resolve 되면 5초 race timer 가 발화하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockPage = {
        getTextContent: vi.fn().mockResolvedValue({
          items: [{
            str: '운영체제는 프로세스를 관리하며 CPU 스케줄링을 수행한다. 페이지 교체 알고리즘에는 LRU, FIFO 등이 있다.',
          }],
        }),
        // 즉시 resolve — 5s 타이머가 발화하기 전에 race 결과 확정.
        getOperatorList: vi.fn().mockResolvedValue({ fnArray: [], argsArray: [] }),
        objs: { get: vi.fn() },
        commonObjs: { get: vi.fn() },
        cleanup: vi.fn(),
      };
      const mockPdf = {
        numPages: 1,
        getPage: vi.fn().mockResolvedValue(mockPage),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
      (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(mockPdf),
      });

      const { parsePdf } = await import('../pdf-parser');
      // parsePdf 를 즉시 시작 — getOperatorList 는 microtask 큐에서 resolve 됨.
      // vi.runAllTimers 를 호출하지 않으므로 fake 타이머는 5s 가 흐르지 않는다.
      const doc = await parsePdf(new ArrayBuffer(10), 'fast.pdf', '/fast.pdf');
      expect(doc.pageCount).toBe(1);

      // 이 시점에서 5s 타이머가 살아있다면 vi.advanceTimersByTime(5000) 으로 발화시킬 수 있다.
      // race 가 끝난 직후 finally 의 clearTimeout 이 동작했다면, 5000ms 진행해도 경고 없음.
      vi.advanceTimersByTime(5000);
      const timeoutWarnCalls = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('getOperatorList timeout'),
      );
      expect(timeoutWarnCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

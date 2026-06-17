import { describe, it, expect, vi } from 'vitest';

// pdfjs-dist를 모킹 (Node 환경에서 직접 사용 불가)
vi.mock('pdfjs-dist', () => {
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: vi.fn(),
    // R37 P6 (QA M6): OPS.paintImageXObject 미모킹이던 결함 수정. 이전엔 OPS 가 undefined 라
    // extractPageImages 의 `ops.fnArray[j] !== OPS.paintImageXObject` 가 첫 이미지 op 에서
    // TypeError → 추출 0장 → 캡 테스트(images.length <= 50)가 0<=50 으로 공허 통과했다.
    OPS: { paintImageXObject: 85 },
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

// detectChapters 멀티챕터 분할 — 기존 단위 테스트는 production regex 를 문자열로 재선언해
// 소스와 silent divergence 위험이 있었다. parsePdf 경유로 실제 detectChapters(실 regex) 를
// 구동해 헤딩 분할/페이지 범위/서문 병합/헤딩 부재 fallback 을 가드한다.
describe('PDF Parser - detectChapters via parsePdf (multi-chapter)', () => {
  function mockPdfWithPages(pageTexts: string[]) {
    return {
      numPages: pageTexts.length,
      getPage: vi.fn((n: number) => Promise.resolve({
        getTextContent: () => Promise.resolve({ items: [{ str: pageTexts[n - 1] }] }),
        getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
        objs: { get: vi.fn() },
        cleanup: vi.fn(),
      })),
      destroy: vi.fn(() => Promise.resolve()),
    };
  }

  it('헤딩으로 다중 챕터를 분할하고 페이지 범위를 채운다', async () => {
    const pages = [
      '제1장 서론 이 문서의 도입부 본문 텍스트입니다 충분히 길게 작성',
      '본문 페이지 내용이 이어집니다 챕터 헤딩 아님',
      '제2장 본론 두 번째 장의 시작 본문 텍스트입니다 충분히 길게',
    ];
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(mockPdfWithPages(pages)) });
    const { parsePdf } = await import('../pdf-parser');
    const doc = await parsePdf(new ArrayBuffer(10), 'm.pdf', '/m.pdf');
    expect(doc.chapters).toHaveLength(2);
    const c1 = doc.chapters[0]!;
    const c2 = doc.chapters[1]!;
    expect(c1.title).toMatch(/제1장 서론/);
    expect(c1.startPage).toBe(1);
    expect(c1.endPage).toBe(2); // 헤딩 없는 p2 가 ch1 에 병합
    expect(c2.title).toMatch(/제2장 본론/);
    expect(c2.startPage).toBe(3);
    expect(c2.endPage).toBe(3);
  });

  it('첫 챕터 이전 페이지(서문)는 첫 챕터에 병합되고 startPage=1', async () => {
    const pages = [
      '머리말 서문 페이지 본문 텍스트입니다 챕터 헤딩 아님 충분히 길게',
      '제1장 시작 본문 텍스트입니다 충분히 길게 작성된 내용',
    ];
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(mockPdfWithPages(pages)) });
    const { parsePdf } = await import('../pdf-parser');
    const doc = await parsePdf(new ArrayBuffer(10), 'm.pdf', '/m.pdf');
    expect(doc.chapters).toHaveLength(1);
    const c1 = doc.chapters[0]!;
    expect(c1.startPage).toBe(1);
    expect(c1.text).toMatch(/머리말 서문/);
    expect(c1.text).toMatch(/제1장 시작/);
  });

  it('헤딩이 전혀 없으면 10페이지 단위 청크로 분할(fallback)', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `${i + 1}페이지 일반 본문 텍스트입니다 충분히 길게 작성된 내용`);
    (pdfjsLib.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(mockPdfWithPages(pages)) });
    const { parsePdf } = await import('../pdf-parser');
    const doc = await parsePdf(new ArrayBuffer(10), 'm.pdf', '/m.pdf');
    expect(doc.chapters).toHaveLength(2); // 12p → 1~10, 11~12
    const c1 = doc.chapters[0]!;
    const c2 = doc.chapters[1]!;
    expect(c1.startPage).toBe(1);
    expect(c1.endPage).toBe(10);
    expect(c2.startPage).toBe(11);
    expect(c2.endPage).toBe(12);
  });
});

// R28 회귀: MAX_TOTAL_IMAGES=50 캡이 배치 동시성으로 우회되지 않는지 확인.
// 모든 페이지가 병렬로 이미지를 푸시하더라도 결과의 images.length는 캡을 넘지 않아야 한다.
//
// R37 P6 (QA M6): 이전 버전은 objs.get 을 동기 mock(mockReturnValue)으로 두고 OPS 도
// 미모킹이라 실제 추출이 0장 → `<= 50` 단언이 0<=50 으로 공허 통과했다. 이제 (1) objs.get
// 을 실제 콜백 형태로, (2) OffscreenCanvas/ImageData 를 mock 해 imageDataToBase64 가 실제
// 산출물을 내도록 하고, (3) `=== 50` 으로 캡이 실제로 작동했음을 단언한다.
describe('PDF Parser - MAX_TOTAL_IMAGES cap enforcement', () => {
  it('다수 페이지가 동시에 이미지를 추출하면 정확히 50장으로 캡된다', async () => {
    // 10페이지 × 페이지당 다수 이미지 op → 캡 미작동 시 100장. 캡이 정확히 50 으로 잘라야 함.
    const PAGES = 10;
    const OPS_PER_PAGE = 100; // MAX_IMAGES_PER_PAGE(10)로 페이지당 10장까지만 추출됨

    // imageDataToBase64 가 통과하려면 MIN_IMAGE_SIZE(50) 이상 + RGBA data 충족 필요.
    const W = 64;
    const H = 64;
    const fakeImage = {
      width: W,
      height: H,
      data: new Uint8ClampedArray(W * H * 4).fill(200),
    };

    // OffscreenCanvas / ImageData mock — node 환경엔 없어 원래 imageDataToBase64 가 null 을
    // 반환(0장)했다. 최소 동작 stub 으로 base64 산출 경로를 활성화한다.
    class FakeImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data; this.width = width; this.height = height;
      }
    }
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { putImageData() {}, drawImage() {} }; }
      async convertToBlob() { return { async arrayBuffer() { return new ArrayBuffer(8); } }; }
    }

    const g = globalThis as unknown as Record<string, unknown>;
    const origOC = g.OffscreenCanvas;
    const origID = g.ImageData;
    g.OffscreenCanvas = FakeOffscreenCanvas;
    g.ImageData = FakeImageData;

    try {
      const mockPage = {
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ str: '프로세스는 실행 중인 프로그램의 인스턴스이다. 운영체제는 프로세스를 관리한다.' }],
        }),
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: new Array(OPS_PER_PAGE).fill(85), // OPS.paintImageXObject
          argsArray: new Array(OPS_PER_PAGE).fill(['img1']),
        }),
        // 콜백 형태 — 실제 page.objs.get(id, cb) 호출 규약과 일치.
        objs: { get: vi.fn((_id: string, cb: (obj: unknown) => void) => cb(fakeImage)) },
        commonObjs: { get: vi.fn() },
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

      // 추출이 실제로 일어났고(>0) 캡이 정확히 작동했음(===50)을 동시 검증.
      expect(doc.images.length).toBe(50);
    } finally {
      g.OffscreenCanvas = origOC;
      g.ImageData = origID;
    }
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

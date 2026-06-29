// @vitest-environment happy-dom

// PdfViewer LRU 윈도잉(메모리 H1) — eviction IntersectionObserver 동작 검증.
// happy-dom 은 IntersectionObserver 와 canvas 2d 컨텍스트가 없어 둘 다 목으로 주입한다.
// (기본 PdfViewer.test 는 IO 미주입 → fallback 전체 렌더 경로라 eviction 을 건드리지 않으므로
//  본 파일이 윈도우 해제/보호/재진입 재렌더의 회귀를 가드한다.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const P = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: vi.fn(),
  };
  // getPage 는 공유 spy — pump 가 어떤 페이지를 실제 렌더하려 했는지(=윈도우 안) 호출로 검증.
  const getPage = vi.fn((_n: number) => Promise.resolve(page));
  const makeDoc = (numPages: number) => ({ numPages, getPage, destroy: vi.fn(() => Promise.resolve()) });
  return { page, getPage, makeDoc, getDocument: vi.fn(() => ({ promise: Promise.resolve(makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) })) };
});
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: 'mock' }, getDocument: P.getDocument }));

import { PdfViewer } from '../PdfViewer';

// ── IntersectionObserver 목: 인스턴스/콜백/옵션/관측대상 캡처 + 수동 트리거 ──
const ioInstances: FakeIO[] = [];
class FakeIO {
  cb: IntersectionObserverCallback;
  options: IntersectionObserverInit;
  elements: Element[] = [];
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.options = options ?? {};
    ioInstances.push(this);
  }
  observe(el: Element) { this.elements.push(el); }
  unobserve(el: Element) { this.elements = this.elements.filter((e) => e !== el); }
  disconnect() { this.elements = []; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
function trigger(io: FakeIO, entries: { target: Element; isIntersecting: boolean }[]) {
  io.cb(entries as unknown as IntersectionObserverEntry[], io as unknown as IntersectionObserver);
}
const findIO = (rootMargin: string) => ioInstances.find((io) => io.options.rootMargin === rootMargin);

beforeEach(() => {
  vi.clearAllMocks();
  ioInstances.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  // canvas 2d 컨텍스트 스텁 — 렌더 경로가 canvas 를 실제로 append 하도록.
  HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext'];
  P.getDocument.mockReturnValue({ promise: Promise.resolve(P.makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) });
});
afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

// IO 가 주입되면(즉시 enqueue 가 getBoundingClientRect 0 폴백으로 전체 enqueue) 3페이지 모두
// 렌더된다. 이 상태에서 evict IO 콜백을 수동 구동해 윈도잉을 검증한다.
async function renderAll(targetPage: number) {
  const utils = render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={targetPage} onClose={vi.fn()} />);
  await waitFor(() => expect(utils.container.querySelectorAll('canvas').length).toBe(3));
  const wrappers = Array.from(utils.container.querySelectorAll('[data-page-index]')) as HTMLElement[];
  return { ...utils, wrappers };
}

describe('PdfViewer LRU 윈도잉', () => {
  it('렌더 IO(±1)와 evict IO(±2) 두 옵저버가 생성된다', async () => {
    await renderAll(2);
    expect(findIO('100% 0px')).toBeTruthy(); // RENDER_ROOT_MARGIN
    expect(findIO('200% 0px')).toBeTruthy(); // EVICT_ROOT_MARGIN
  });

  it('윈도우 밖(evict IO 비교차) 페이지 → canvas 해제 + placeholder 복귀 + 높이 보존', async () => {
    const { wrappers } = await renderAll(2);
    const evictIO = findIO('200% 0px')!;
    const w1 = wrappers[0]!; // page 1 (targetPage=2 아님 → 해제 가능)
    expect(w1.querySelector('canvas')).toBeTruthy();
    const heightBefore = w1.style.height;
    expect(heightBefore).not.toBe(''); // 렌더되어 실제 높이가 박혀 있음

    trigger(evictIO, [{ target: w1, isIntersecting: false }]);

    expect(w1.querySelector('canvas')).toBeNull();       // canvas 해제
    expect(w1.querySelector('span')).toBeTruthy();        // placeholder 복귀
    expect(w1.style.minHeight).toBe(heightBefore);        // 높이 보존(스크롤 점프 방지)
  });

  it('활성 targetPage 는 evict IO 비교차여도 canvas 유지(점프 레이스 보호)', async () => {
    const { wrappers } = await renderAll(2);
    const evictIO = findIO('200% 0px')!;
    const w2 = wrappers[1]!; // page 2 = targetPage
    expect(w2.querySelector('canvas')).toBeTruthy();

    trigger(evictIO, [{ target: w2, isIntersecting: false }]);

    expect(w2.querySelector('canvas')).toBeTruthy(); // 보호로 유지
  });

  it('해제된 페이지가 다시 윈도우에 들어오면(render IO 교차) 재렌더된다', async () => {
    const { wrappers } = await renderAll(2);
    const evictIO = findIO('200% 0px')!;
    const renderIO = findIO('100% 0px')!;
    const w1 = wrappers[0]!;

    trigger(evictIO, [{ target: w1, isIntersecting: false }]);
    expect(w1.querySelector('canvas')).toBeNull();

    trigger(renderIO, [{ target: w1, isIntersecting: true }]);
    await waitFor(() => expect(w1.querySelector('canvas')).toBeTruthy());
  });

  // QA(메모리): 큐 적재 후 ±2 윈도우 밖으로 나간 비-대상 페이지는 pump 가 getPage 전에 skip.
  it('윈도우 밖(±2) 비-대상 페이지는 렌더 skip, 대상 페이지는 예외로 렌더', async () => {
    // getBoundingClientRect stub: 컨테이너=뷰포트(0~500,h500), 페이지 i=top i*5000(±2=1000 밖)
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const idx = (this as HTMLElement).dataset?.pageIndex;
      const top = idx !== undefined ? Number(idx) * 5000 : 0;
      const bottom = idx !== undefined ? top + 480 : 500;
      const height = idx !== undefined ? 480 : 500;
      return { top, bottom, height, left: 0, right: 360, width: 360, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const { container } = render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={1} onClose={vi.fn()} />);
      // 대상 page1(idx0, 뷰포트 안)은 렌더됨 → pump 가 실제로 동작했다는 증거
      await waitFor(() => expect(P.getPage.mock.calls.some((c) => c[0] === 1)).toBe(true));
      const renderIO = findIO('100% 0px')!;
      const wrappers = Array.from(container.querySelectorAll('[data-page-index]')) as HTMLElement[];

      // 먼 비-대상 페이지(idx1=page2)를 render IO 로 교차 통지 → pump 가 윈도우 밖이라 getPage 전 skip
      trigger(renderIO, [{ target: wrappers[1]!, isIntersecting: true }]);
      await Promise.resolve();
      expect(P.getPage.mock.calls.some((c) => c[0] === 2)).toBe(false); // skip — getPage 미호출
      expect(wrappers[1]!.querySelector('canvas')).toBeNull();
    } finally {
      Element.prototype.getBoundingClientRect = origRect;
    }
  });
});

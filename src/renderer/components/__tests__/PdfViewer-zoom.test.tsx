// @vitest-environment happy-dom

// PdfViewer 수동 확대·축소(v1.6.0) — 툴바 버튼·Ctrl+휠·Ctrl+키가 store 배율을 바꾸고, 그 배율이
// 실제 렌더 scale(pdfjs viewport) 에 곱해지며, 배율 변경 전후로 보던 지점이 유지되는지.
// 산술 자체는 lib/__tests__/viewer-zoom.test.ts 가 못박는다 — 여기서는 배선만 본다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const P = vi.hoisted(() => {
  const renderSpy = vi.fn((_opts: { viewport: { width: number } }) => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const page = {
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 600 * scale, height: 800 * scale }),
    render: renderSpy,
    cleanup: vi.fn(),
  };
  const makeDoc = (numPages: number) => ({ numPages, getPage: vi.fn(() => Promise.resolve(page)), destroy: vi.fn(() => Promise.resolve()) });
  return {
    page, makeDoc, renderSpy,
    getDocument: vi.fn(() => ({ promise: Promise.resolve(makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) })),
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: 'mock-worker' },
  getDocument: P.getDocument,
}));

import { PdfViewer } from '../PdfViewer';
import { useAppStore } from '../../lib/store';
import { t } from '../../lib/i18n';

// 렌더된 viewport 폭 목록 — happy-dom 은 clientWidth 0 → availableWidth 300 → fit 0.5 → clamp 0.6.
// 100% 에서 600×0.6 = 360, 200% 에서 720.
function renderedWidths(): number[] {
  return P.renderSpy.mock.calls.map((c) => c[0].viewport.width);
}

async function renderLoaded(targetPage = 1) {
  const utils = render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={targetPage} onClose={vi.fn()} />);
  await waitFor(() => expect(utils.container.querySelectorAll('canvas').length).toBe(3));
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  // canvas 2d 컨텍스트 스텁 — 렌더 경로가 canvas 를 실제로 append 하도록 (LRU 테스트와 동일).
  HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext'];
  P.getDocument.mockReturnValue({ promise: Promise.resolve(P.makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) });
  useAppStore.setState({ pdfBytes: null, citationTarget: null, citationJumpNonce: 0, pdfViewerZoom: 1 });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ pdfViewerZoom: 1 });
});

describe('PdfViewer 배율 툴바', () => {
  it('확대·축소·화면 맞춤 버튼이 있고 현재 배율을 표시한다', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: t('pdfviewer.zoomIn') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('pdfviewer.zoomOut') })).toBeTruthy();
    const reset = screen.getByRole('button', { name: t('pdfviewer.zoomReset') });
    expect(reset.textContent).toBe('100%');
  });

  it('확대 클릭 → store 배율 +25%, 축소 클릭 → −25%', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomIn') }));
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.25);
    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomOut') }));
    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomOut') }));
    expect(useAppStore.getState().pdfViewerZoom).toBe(0.75);
  });

  it('화면 맞춤 클릭 → 100% 로 복귀', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ pdfViewerZoom: 2 });
    await renderLoaded();
    expect(screen.getByRole('button', { name: t('pdfviewer.zoomReset') }).textContent).toBe('200%');
    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomReset') }));
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
  });

  it('상한(300%)에서 확대 버튼, 하한(50%)에서 축소 버튼이 비활성', async () => {
    useAppStore.setState({ pdfViewerZoom: 3 });
    await renderLoaded();
    expect((screen.getByRole('button', { name: t('pdfviewer.zoomIn') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('pdfviewer.zoomOut') }) as HTMLButtonElement).disabled).toBe(false);
    act(() => { useAppStore.setState({ pdfViewerZoom: 0.5 }); });
    expect((screen.getByRole('button', { name: t('pdfviewer.zoomOut') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('pdfviewer.zoomIn') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('배율 변경은 라이브 리전(status)으로 통지된다 — 버튼의 접근성 이름이 퍼센트를 가리므로', async () => {
    await renderLoaded();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(t('pdfviewer.zoomLevel', { percent: '100%' }));
    act(() => { useAppStore.setState({ pdfViewerZoom: 1.5 }); });
    expect(status.textContent).toContain(t('pdfviewer.zoomLevel', { percent: '150%' }));
  });
});

describe('PdfViewer 배율 → 렌더 scale', () => {
  it('100% 는 종전과 동일한 폭(360)으로 그린다', async () => {
    await renderLoaded();
    expect(renderedWidths()).toEqual([360, 360, 360]);
  });

  it('200% 로 열면 fit clamp(0.6) × 2 = 720 폭으로 그린다', async () => {
    useAppStore.setState({ pdfViewerZoom: 2 });
    await renderLoaded();
    expect(renderedWidths()).toEqual([720, 720, 720]);
  });

  it('열린 상태에서 배율을 바꾸면 전 페이지를 새 scale 로 다시 그린다', async () => {
    await renderLoaded();
    P.renderSpy.mockClear();
    act(() => { useAppStore.getState().setPdfViewerZoom(1.5); });
    await waitFor(() => expect(renderedWidths().length).toBe(3));
    expect(renderedWidths()).toEqual([540, 540, 540]);
  });

  it('100% 를 넘으면 가로 스크롤이 가능하고 페이지 열이 컨테이너보다 넓어질 수 있다', async () => {
    const { container } = await renderLoaded();
    const scroller = container.querySelector('[data-testid="pdfviewer-scroll"]') as HTMLElement;
    expect(scroller.className).toMatch(/\boverflow-auto\b/);
    // scrollbar-gutter: stable — fit scale 은 clientWidth 로 계산되는데 첫 렌더(로딩 중)엔 세로 스크롤바가
    // 없어 15px 넓게 잡히고, 이후 생긴 스크롤바는 50px 미만 변동이라 재렌더가 없다 → 100% 인데 가로
    // 스크롤바가 생기고 오른쪽이 잘렸다(실기기). 여백을 항상 예약해 첫 측정을 맞춘다. E2E(viewer-zoom)
    // 가 scrollWidth<=clientWidth 로 실동작을 보지만 CI 에선 돌지 않으므로 여기서 클래스를 못박는다.
    expect(scroller.className).toMatch(/\[scrollbar-gutter:stable\]/);
    // flex items-center 열이 컨테이너보다 넓으면 왼쪽이 잘려 닿을 수 없다 → w-max min-w-full
    const column = scroller.querySelector('.flex.flex-col.items-center') as HTMLElement;
    expect(column.className).toMatch(/\bw-max\b/);
    expect(column.className).toMatch(/\bmin-w-full\b/);
  });
});

describe('PdfViewer Ctrl+휠 / Ctrl+키', () => {
  // happy-dom 의 WheelEvent 는 init 의 ctrlKey 를 버린다(실측: ctrlKey undefined) — 명시적으로 박는다.
  function wheel(el: Element, init: WheelEventInit): WheelEvent {
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(ev, 'ctrlKey', { value: init.ctrlKey ?? false });
    el.dispatchEvent(ev);
    return ev;
  }

  it('Ctrl+휠 위(deltaY<0) → +10%, 아래 → −10%, 기본 동작(페이지 줌) 차단', async () => {
    const { container } = await renderLoaded();
    const scroller = container.querySelector('[data-testid="pdfviewer-scroll"]')!;
    const up = wheel(scroller, { ctrlKey: true, deltaY: -100 });
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.1);
    expect(up.defaultPrevented).toBe(true);
    wheel(scroller, { ctrlKey: true, deltaY: 100 });
    wheel(scroller, { ctrlKey: true, deltaY: 100 });
    expect(useAppStore.getState().pdfViewerZoom).toBe(0.9);
  });

  it('Ctrl 없는 휠은 배율을 건드리지 않고 스크롤(기본 동작)을 막지 않는다', async () => {
    const { container } = await renderLoaded();
    const scroller = container.querySelector('[data-testid="pdfviewer-scroll"]')!;
    const ev = wheel(scroller, { deltaY: -100 });
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  // window 레벨인 이유: 인용 버튼을 누른 직후엔 포커스가 요약 쪽에 있어 뷰어 영역 핸들러엔 키가
  // 닿지 않는다(E2E 실측에서 Ctrl+0 무반응). Escape 닫기와 같은 방식.
  const key = (k: string, ctrl = true) => {
    const ev = new KeyboardEvent('keydown', { key: k, ctrlKey: ctrl, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev;
  };

  it('Ctrl + "=" / "+" / "-" / "0" → 확대·확대·축소·맞춤 (뷰어가 열려 있으면 포커스 위치 무관)', async () => {
    await renderLoaded();
    expect(key('=').defaultPrevented).toBe(true);
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.25);
    key('+');
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.5);
    key('-');
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.25);
    key('0');
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
    // Ctrl 없는 "=" 는 무시
    expect(key('=', false).defaultPrevented).toBe(false);
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
  });

  it('편집 요소(textarea) 포커스 중 Ctrl+"-" 는 배율을 건드리지 않는다 (입력 단축키 보호)', async () => {
    await renderLoaded();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(key('-').defaultPrevented).toBe(false);
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
    ta.remove();
  });

  it('뷰어가 닫히면(언마운트) Ctrl+"=" 가 더 이상 배율을 바꾸지 않는다 (리스너 해제)', async () => {
    const { unmount } = await renderLoaded();
    unmount();
    key('=');
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
  });
});

describe('PdfViewer 배율 변경 시 스크롤 위치 보존', () => {
  // happy-dom 은 레이아웃이 없다 — offsetTop/offsetHeight 를 style 높이에서 도출하는 가짜 레이아웃.
  // 슬롯 i 의 top = 앞 슬롯들의 (높이 + 12px gap) 합. 렌더된 슬롯은 style.height, 해제·정리된
  // 슬롯은 style.minHeight, 둘 다 없으면 placeholder 200.
  function installFakeLayout(scroller: HTMLElement, viewportHeight: number) {
    const slotHeight = (el: HTMLElement) =>
      Number.parseFloat(el.style.height || el.style.minHeight || '200');
    const slots = () => Array.from(scroller.querySelectorAll('[data-page-index]')) as HTMLElement[];
    for (const el of slots()) {
      Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => slotHeight(el) });
      Object.defineProperty(el, 'offsetTop', {
        configurable: true,
        get: () => {
          let top = 0;
          for (const s of slots()) { if (s === el) break; top += slotHeight(s) + 12; }
          return top;
        },
      });
    }
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => viewportHeight });
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
  }

  it('2페이지 중간을 보던 중 100%→200% 이면 같은 지점이 뷰포트 중앙에 오도록 scrollTop 을 옮긴다', async () => {
    const { container } = await renderLoaded();
    const scroller = container.querySelector('[data-testid="pdfviewer-scroll"]') as HTMLElement;
    // 100% 렌더 높이 480(800×0.6) → 슬롯 top 0 / 492 / 984
    installFakeLayout(scroller, 400);
    scroller.scrollTop = 500; // 중앙 700 → 2페이지(492~972) 의 (700−492)/480 = 0.4333
    act(() => { useAppStore.getState().setPdfViewerZoom(2); });
    // 정리 단계에서 placeholder 높이가 ×2(960) 로 비례 유지 → top 0 / 972 / 1944
    // 목표 = 972 + 0.4333×960 − 200 = 1188
    expect(scroller.scrollTop).toBe(1188);
    const slots = Array.from(scroller.querySelectorAll('[data-page-index]')) as HTMLElement[];
    expect(slots[1]!.style.minHeight).toBe('960px');
  });

  it('배율이 그대로인 재렌더(패널 폭 변경)는 종전대로 높이를 비우고 scrollTop 을 건드리지 않는다', async () => {
    const { container, rerender } = await renderLoaded();
    const scroller = container.querySelector('[data-testid="pdfviewer-scroll"]') as HTMLElement;
    installFakeLayout(scroller, 400);
    scroller.scrollTop = 500;
    // pdfBytes 교체 = 문서 전환 경로(배율 비율 1) — QA22 의 stale 높이 초기화가 유지돼야 한다
    rerender(<PdfViewer pdfBytes={new Uint8Array([4, 5, 6])} targetPage={1} onClose={vi.fn()} />);
    await waitFor(() => expect(P.getDocument).toHaveBeenCalledTimes(2));
    expect(scroller.scrollTop).toBe(500);
  });
});

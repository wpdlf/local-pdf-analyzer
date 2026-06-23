// @vitest-environment happy-dom

// PdfViewer 행위 — pdfjs 격리(목) 하에 로딩/성공/실패 상태, 헤더(타이틀·페이지 표기),
// 닫기 버튼·ESC 키 동작(편집 포커스 시 무시), PdfViewerPanel 의 조건부 마운트.
// 실제 canvas 렌더는 happy-dom 한계로 검증 대상 아님 — 상태/DOM 골격만 가드.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const P = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: vi.fn(),
  };
  const makeDoc = (numPages: number) => ({ numPages, getPage: vi.fn(() => Promise.resolve(page)), destroy: vi.fn(() => Promise.resolve()) });
  return {
    page, makeDoc,
    getDocument: vi.fn(() => ({ promise: Promise.resolve(makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) })),
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: 'mock-worker' },
  getDocument: P.getDocument,
}));

import { PdfViewer, PdfViewerPanel } from '../PdfViewer';
import { useAppStore } from '../../lib/store';
import { t } from '../../lib/i18n';

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  P.getDocument.mockReturnValue({ promise: Promise.resolve(P.makeDoc(3)), destroy: vi.fn(() => Promise.resolve()) });
  useAppStore.setState({ pdfBytes: null, citationTarget: null });
});
afterEach(() => cleanup());

describe('PdfViewer', () => {
  it('로딩 중 → 로딩 표시', () => {
    // getDocument 가 resolve 되기 전 상태
    P.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn(() => Promise.resolve()) });
    render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={1} onClose={vi.fn()} />);
    expect(screen.getByText(t('pdfviewer.loading'))).toBeTruthy();
  });

  it('로드 성공 → 타이틀 + 헤더 페이지 표기 + 페이지 슬롯 N개', async () => {
    const { container } = render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={2} onClose={vi.fn()} />);
    // 헤더의 페이지 표기(현재 targetPage / 전체)
    await waitFor(() => expect(screen.getByText(t('pdfviewer.pageOf', { current: 2, total: 3 }))).toBeTruthy());
    expect(screen.getAllByText(t('pdfviewer.title')).length).toBeGreaterThan(0);
    // 페이지 슬롯 3개 (placeholder 텍스트는 렌더 effect 가 canvas 자리로 비우므로 슬롯 div 개수로 검증)
    const list = container.querySelector('.flex.flex-col.items-center.gap-3');
    expect(list?.children.length).toBe(3);
  });

  it('로드 실패 → 에러 UI + 에러 메시지', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.reject(new Error('손상된 PDF')), destroy: vi.fn(() => Promise.resolve()) });
    render(<PdfViewer pdfBytes={new Uint8Array([9])} targetPage={1} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(t('pdfviewer.renderFail'))).toBeTruthy());
    expect(screen.getByText('손상된 PDF')).toBeTruthy();
  });

  it('닫기 버튼 → onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PdfViewer pdfBytes={new Uint8Array([1])} targetPage={1} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: t('pdfviewer.close') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC 키 → onClose (편집 포커스 아님)', async () => {
    const onClose = vi.fn();
    render(<PdfViewer pdfBytes={new Uint8Array([1])} targetPage={1} onClose={onClose} />);
    await waitFor(() => expect(P.getDocument).toHaveBeenCalled());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('편집 요소(textarea) 포커스 중 ESC 는 닫지 않는다', async () => {
    const onClose = vi.fn();
    render(<PdfViewer pdfBytes={new Uint8Array([1])} targetPage={1} onClose={onClose} />);
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
    ta.remove();
  });
});

describe('PdfViewer 목차(outline)', () => {
  const ref1 = { num: 1 };
  const ref2 = { num: 2 };
  const makeOutlineDoc = () => ({
    numPages: 3,
    getPage: vi.fn(() => Promise.resolve(P.page)),
    destroy: vi.fn(() => Promise.resolve()),
    getOutline: vi.fn(async () => [
      { title: '1장 서론', dest: [ref1] },
      { title: '2장 본론', dest: [ref2], items: [] },
    ]),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async (r: unknown) => (r === ref1 ? 0 : 2)),
  });

  it('목차 있으면 토글 노출 → 클릭 시 항목 표시 → 항목 클릭 시 citationTarget 갱신', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(makeOutlineDoc()), destroy: vi.fn(() => Promise.resolve()) });
    const user = userEvent.setup();
    render(<PdfViewer pdfBytes={new Uint8Array([1, 2, 3])} targetPage={1} onClose={vi.fn()} />);

    // 추출 완료 후 토글 버튼 노출
    const toggle = await screen.findByRole('button', { name: t('outline.toggle') });
    // 처음엔 목차 트리 미표시
    expect(screen.queryByText('2장 본론')).toBeNull();

    await user.click(toggle);
    // 항목 표시
    expect(screen.getByText('1장 서론')).toBeTruthy();
    const item = screen.getByText('2장 본론');

    await user.click(item);
    // ref2 → 0-based 2 → page 3
    expect(useAppStore.getState().citationTarget).toEqual({ page: 3 });
  });

  it('목차 없으면 토글 미노출', async () => {
    // 기본 makeDoc 는 getOutline 미구현 → 추출 [] → 토글 없음
    render(<PdfViewer pdfBytes={new Uint8Array([7])} targetPage={1} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(t('pdfviewer.title')).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: t('outline.toggle') })).toBeNull();
  });
});

describe('PdfViewerPanel', () => {
  it('citationTarget 없으면 null', () => {
    useAppStore.setState({ pdfBytes: new Uint8Array([1]), citationTarget: null });
    const { container } = render(<PdfViewerPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('pdfBytes 없으면 null', () => {
    useAppStore.setState({ pdfBytes: null, citationTarget: { page: 1 } });
    const { container } = render(<PdfViewerPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('둘 다 있으면 뷰어 마운트', () => {
    useAppStore.setState({ pdfBytes: new Uint8Array([1, 2]), citationTarget: { page: 1 } });
    render(<PdfViewerPanel />);
    expect(screen.getAllByText(t('pdfviewer.title')).length).toBeGreaterThan(0);
  });

  it('뷰어 닫기 → citationTarget 해제', async () => {
    useAppStore.setState({ pdfBytes: new Uint8Array([1, 2]), citationTarget: { page: 1 } });
    const user = userEvent.setup();
    render(<PdfViewerPanel />);
    await user.click(screen.getByRole('button', { name: t('pdfviewer.close') }));
    expect(useAppStore.getState().citationTarget).toBeNull();
  });
});

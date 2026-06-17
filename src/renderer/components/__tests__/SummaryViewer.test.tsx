// @vitest-environment happy-dom

// SummaryViewer 행위 — 헤더(문서명·페이지) / 생성 중 스피너 / 완료 후 내보내기·복사·QaChat /
// 내보내기·복사 실패 배너 / 닫기(생성 중 onAbort 우선, 평시 resetSummaryState) /
// citationTarget 활성 시에만 우측 PdfViewer 패널 + ResizeHandle 마운트.
// 자식 컴포넌트(QaChat/PdfViewer/ResizeHandle)와 react-markdown 은 목으로 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const M = vi.hoisted(() => ({
  save: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  writeText: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
}));

vi.mock('../QaChat', () => ({ QaChat: () => <div data-testid="qachat" /> }));
vi.mock('../PdfViewer', () => ({ PdfViewerPanel: () => <div data-testid="pdfviewer" /> }));
vi.mock('../ResizeHandle', () => ({ ResizeHandle: () => <div data-testid="resize" /> }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div data-testid="md">{children}</div> }));
vi.mock('../../lib/safe-markdown', () => ({
  REMARK_PLUGINS: [],
  safeComponents: {},
  MarkdownErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { abort: M.abort }, file: { save: M.save } },
}));

import { SummaryViewer } from '../SummaryViewer';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

function setState(opts: Partial<{ generating: boolean; stream: string; citation: boolean; docName: string }>) {
  const { generating = false, stream = '', citation = false, docName = 'lecture.pdf' } = opts;
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    document: { fileName: docName, pageCount: 5 } as never,
    summaryStream: stream,
    isGenerating: generating,
    progress: 0,
    progressInfo: null,
    citationTarget: citation ? { page: 2 } : null,
    currentRequestId: null,
    qaRequestId: null,
    error: null,
    resetSummaryState: M.reset,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // userEvent.setup() 이 navigator.clipboard 를 자체 스텁으로 덮어쓰므로 매 테스트 재정의.
  // 복사 테스트는 fireEvent 로 클릭해 userEvent 의 clipboard 가로채기를 피한다.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: M.writeText }, configurable: true });
  setState({});
});
afterEach(() => cleanup());

describe('SummaryViewer', () => {
  it('헤더에 문서명과 페이지 수를 표시', () => {
    setState({ stream: '결과', docName: 'lecture.pdf' });
    render(<SummaryViewer />);
    expect(screen.getByText(/lecture\.pdf \(5p\)/)).toBeTruthy();
  });

  it('생성 중 + 내용 없음 → 분석 스피너', () => {
    setState({ generating: true, stream: '' });
    render(<SummaryViewer />);
    expect(screen.getByText(/AI가 자료를 분석/)).toBeTruthy();
  });

  it('완료(stream 있고 생성 아님) → 내보내기·복사·QaChat 표시', () => {
    setState({ stream: '# 요약 내용' });
    render(<SummaryViewer />);
    expect(screen.getByText('💾 .md 내보내기')).toBeTruthy();
    expect(screen.getByText('📋 복사')).toBeTruthy();
    expect(screen.getByTestId('qachat')).toBeTruthy();
    expect(screen.getByTestId('md').textContent).toContain('# 요약 내용');
  });

  it('생성 중에는 내보내기·복사·QaChat 미표시', () => {
    setState({ generating: true, stream: '부분 스트림' });
    render(<SummaryViewer />);
    expect(screen.queryByText('💾 .md 내보내기')).toBeNull();
    expect(screen.queryByTestId('qachat')).toBeNull();
  });

  it('내보내기 → file.save(stream, 파생 파일명)', async () => {
    setState({ stream: '본문', docName: 'lecture.pdf' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByText('💾 .md 내보내기'));
    expect(M.save).toHaveBeenCalledTimes(1);
    const call = M.save.mock.calls[0] as unknown as [string, string];
    expect(call[0]).toBe('본문');
    expect(call[1]).toMatch(/^lecture_.*\.md$/);
  });

  it('내보내기 실패 → EXPORT_FAIL 배너', async () => {
    M.save.mockRejectedValueOnce(new Error('disk full'));
    setState({ stream: '본문' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByText('💾 .md 내보내기'));
    await vi.waitFor(() => expect(useAppStore.getState().error?.code).toBe('EXPORT_FAIL'));
  });

  it('복사 → navigator.clipboard.writeText(stream)', async () => {
    setState({ stream: '복사할 텍스트' });
    render(<SummaryViewer />);
    fireEvent.click(screen.getByText('📋 복사'));
    expect(M.writeText).toHaveBeenCalledWith('복사할 텍스트');
  });

  it('복사 실패 → EXPORT_FAIL 배너', async () => {
    M.writeText.mockRejectedValueOnce(new Error('denied'));
    setState({ stream: '본문' });
    render(<SummaryViewer />);
    fireEvent.click(screen.getByText('📋 복사'));
    await vi.waitFor(() => expect(useAppStore.getState().error?.code).toBe('EXPORT_FAIL'));
  });

  it('평시 닫기 → resetSummaryState 호출', async () => {
    setState({ stream: '본문' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(M.reset).toHaveBeenCalledTimes(1);
  });

  it('생성 중 닫기 → onAbort 우선 호출 + resetSummaryState', async () => {
    setState({ generating: true, stream: '부분' });
    const onAbort = vi.fn();
    const user = userEvent.setup();
    render(<SummaryViewer onAbort={onAbort} />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(M.reset).toHaveBeenCalledTimes(1);
  });

  it('citationTarget 없으면 PdfViewer 패널·ResizeHandle 미마운트', () => {
    setState({ stream: '본문', citation: false });
    render(<SummaryViewer />);
    expect(screen.queryByTestId('pdfviewer')).toBeNull();
    expect(screen.queryByTestId('resize')).toBeNull();
  });

  it('citationTarget 활성 → PdfViewer 패널 + ResizeHandle 마운트', () => {
    setState({ stream: '본문', citation: true });
    render(<SummaryViewer />);
    expect(screen.getByTestId('pdfviewer')).toBeTruthy();
    expect(screen.getByTestId('resize')).toBeTruthy();
  });
});

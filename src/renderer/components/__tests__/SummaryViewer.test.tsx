// @vitest-environment happy-dom

// SummaryViewer 행위 — 헤더(문서명·페이지) / 생성 중 스피너 / 완료 후 내보내기·복사·QaChat /
// 내보내기·복사 실패 배너 / 닫기(생성 중 onAbort 우선, H1 비파괴적 접기 setSummaryCollapsed) /
// citationTarget 활성 시에만 우측 PdfViewer 패널 + ResizeHandle 마운트.
// 자식 컴포넌트(QaChat/PdfViewer/ResizeHandle)와 마크다운 렌더러는 목으로 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const M = vi.hoisted(() => ({
  save: vi.fn(() => Promise.resolve()),
  exportPdf: vi.fn(() => Promise.resolve('/out.pdf')),
  abort: vi.fn(() => Promise.resolve()),
  writeText: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
  setCollapsed: vi.fn(),
  abortGather: vi.fn(),
}));

// QA9(D-MED): 뷰어 접기 시 gather abort 호출을 검증하기 위해 스파이로 대체.
vi.mock('../../lib/use-collection-summary', () => ({ abortCollectionGather: M.abortGather }));
vi.mock('../QaChat', () => ({ QaChat: () => <div data-testid="qachat" /> }));
vi.mock('../PdfViewer', () => ({ PdfViewerPanel: () => <div data-testid="pdfviewer" /> }));
vi.mock('../ResizeHandle', () => ({ ResizeHandle: () => <div data-testid="resize" /> }));
vi.mock('../../lib/safe-markdown', () => ({
  SafeMarkdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
  // 내보내기 경로가 동적 import 하는 export-html 이 safeComponents(a/img 오버라이드)를 참조하므로 유지.
  safeComponents: {},
}));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { abort: M.abort }, file: { save: M.save, exportPdf: M.exportPdf } },
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
    setSummaryCollapsed: M.setCollapsed,
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

  it('PDF 내보내기 → file.exportPdf(html, *.pdf) 호출 (지연 import)', async () => {
    setState({ stream: '# 요약', docName: 'lecture.pdf' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByRole('button', { name: 'PDF 파일로 내보내기' }));
    // summaryToHtml 을 동적 import 하므로 호출은 마이크로태스크 뒤 — waitFor 로 대기.
    await vi.waitFor(() => expect(M.exportPdf).toHaveBeenCalledTimes(1));
    const call = M.exportPdf.mock.calls[0] as unknown as [string, string];
    expect(call[0]).toContain('<!DOCTYPE html>'); // 변환된 HTML
    expect(call[1]).toMatch(/^lecture_.*\.pdf$/);
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

  it('평시 닫기 → 비파괴적 접기(setSummaryCollapsed(true)), resetSummaryState 미호출(상태 보존)', async () => {
    // H1: ✕ 닫기가 document·summary·Q&A 를 버리던(resetSummaryState→document:null) 동작을 대체.
    setState({ stream: '본문' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(M.setCollapsed).toHaveBeenCalledWith(true);
    expect(M.reset).not.toHaveBeenCalled();
  });

  it('생성 중 닫기 → onAbort 우선 호출 + 접기(상태 보존)', async () => {
    setState({ generating: true, stream: '부분' });
    const onAbort = vi.fn();
    const user = userEvent.setup();
    render(<SummaryViewer onAbort={onAbort} />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(M.setCollapsed).toHaveBeenCalledWith(true);
    expect(M.reset).not.toHaveBeenCalled();
  });

  it('생성 중 닫기 + onAbort 미제공 → inline ai.abort(reqId) + 생성 종료 + 접기', async () => {
    // onAbort 가 없을 때의 fallback 경로: currentRequestId 를 직접 abort + flush + setIsGenerating(false).
    // 그 다음 비파괴적 접기 — in-flight 는 끊되 부분 요약/Q&A 는 보존.
    setState({ generating: true, stream: '부분' });
    useAppStore.setState({ currentRequestId: 'req-77' });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(M.abort).toHaveBeenCalledWith('req-77');
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(M.setCollapsed).toHaveBeenCalledWith(true);
    expect(M.reset).not.toHaveBeenCalled();
  });

  it('컬렉션 gather 중 닫기 → abortCollectionGather 호출(토큰 소각 방지) + 접기 (QA9 D-MED)', async () => {
    // gather 단계는 isCollectionBusy=true 이나 qaRequestId 없음 → abortQaPreservingThread 는 no-op.
    // 뷰어 접기가 gatherAbortController 를 끊지 않으면 gather 가 취소불가 백그라운드로 고아화됐다.
    setState({ stream: '부분' });
    useAppStore.setState({ isCollectionBusy: true });
    const user = userEvent.setup();
    render(<SummaryViewer />);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(M.abortGather).toHaveBeenCalledTimes(1);
    expect(M.setCollapsed).toHaveBeenCalledWith(true);
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

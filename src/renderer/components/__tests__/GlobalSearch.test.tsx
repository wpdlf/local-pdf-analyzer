// @vitest-environment happy-dom

// GlobalSearch 행위 — persistSessions 게이트 / 검색 호출·결과 렌더 / 결과 없음 / 결과 클릭 시
// openPath→handlePdfData / 하이라이트. handlePdfData 는 목 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GlobalSearchResult } from '../../../shared/session-types';

const M = vi.hoisted(() => ({
  search: vi.fn(),
  openPath: vi.fn(),
  handlePdfData: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/pdf-parser', () => ({ handlePdfData: M.handlePdfData }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { session: { search: M.search }, file: { openPath: M.openPath } },
}));

import { GlobalSearch } from '../GlobalSearch';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

const result = (over: Partial<GlobalSearchResult>): GlobalSearchResult => ({
  docHash: 'a'.repeat(64), fileName: 'lecture.pdf', filePath: '/x/lecture.pdf', pageCount: 3,
  score: 5, inSummary: false, snippets: [{ page: 2, text: '…프로세스 상태…' }], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.search.mockResolvedValue([]);
  M.openPath.mockResolvedValue({ path: '/x/lecture.pdf', name: 'lecture.pdf', data: new ArrayBuffer(8) });
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, persistSessions: true }, error: null });
});
afterEach(() => { cleanup(); useAppStore.setState({ settings: { ...DEFAULT_SETTINGS } }); });

describe('GlobalSearch', () => {
  it('persistSessions OFF → 렌더 안 함', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, persistSessions: false } });
    const { container } = render(<GlobalSearch />);
    expect(container.firstChild).toBeNull();
  });

  it('2자 미만 → 검색 버튼 비활성, search 미호출', async () => {
    render(<GlobalSearch />);
    const input = screen.getByLabelText('문서 검색');
    fireEvent.change(input, { target: { value: 'a' } });
    const btn = screen.getByRole('button', { name: '검색' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(M.search).not.toHaveBeenCalled();
  });

  it('검색 → session.search 호출 + 결과 렌더(파일명·페이지·요약배지)', async () => {
    M.search.mockResolvedValue([result({ inSummary: true })]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    expect(M.search).toHaveBeenCalledWith('프로세스');
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    expect(screen.getByText('요약 포함')).toBeTruthy();
    expect(screen.getByText('p.2')).toBeTruthy();
  });

  it('결과 없음 → noResults 안내', async () => {
    M.search.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '없는단어');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/결과가 없습니다/)).toBeTruthy());
  });

  it('결과 클릭 → file.openPath(filePath) + handlePdfData', async () => {
    M.search.mockResolvedValue([result({})]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    await user.click(screen.getByText(/lecture\.pdf/));
    expect(M.openPath).toHaveBeenCalledWith('/x/lecture.pdf');
    await waitFor(() => expect(M.handlePdfData).toHaveBeenCalledTimes(1));
  });

  it('결과 클릭 시 openPath 에러 → recent.openFail 배너', async () => {
    M.search.mockResolvedValue([result({})]);
    M.openPath.mockResolvedValue({ error: 'gone' });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    await user.click(screen.getByText(/lecture\.pdf/));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(M.handlePdfData).not.toHaveBeenCalled();
  });

  it('session.search 가 reject → 결과 없음으로 graceful (배너 없이 빈 결과)', async () => {
    M.search.mockRejectedValue(new Error('io fail'));
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '질의어');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/결과가 없습니다/)).toBeTruthy());
  });

  it('결과 클릭 시 openPath 가 throw → recent.openFail 배너(catch 경로)', async () => {
    M.search.mockResolvedValue([result({})]);
    M.openPath.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    await user.click(screen.getByText(/lecture\.pdf/));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(M.handlePdfData).not.toHaveBeenCalled();
  });
});

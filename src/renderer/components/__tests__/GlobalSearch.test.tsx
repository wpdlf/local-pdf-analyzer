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
  semantic: vi.fn(),
}));

vi.mock('../../lib/pdf-parser', () => ({ handlePdfData: M.handlePdfData }));
vi.mock('../../lib/semantic-search', () => ({ searchSessionsSemantic: M.semantic }));

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
  M.semantic.mockResolvedValue({ status: 'ok', results: [], excludedCount: 0 });
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

  it('의미 모드 전환 → searchSessionsSemantic 호출(키워드 search 미호출) + 결과 렌더', async () => {
    M.semantic.mockResolvedValue({ status: 'ok', results: [result({ snippets: [{ page: 7, text: '유사 의미 청크' }] })], excludedCount: 0 });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.click(screen.getByRole('button', { name: '의미' }));
    await user.type(screen.getByLabelText('문서 검색'), '동의어개념');
    await user.click(screen.getByRole('button', { name: '검색' }));
    expect(M.semantic).toHaveBeenCalledWith('동의어개념');
    expect(M.search).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    expect(screen.getByText('p.7')).toBeTruthy();
  });

  it('의미 모드 + 임베딩 모델 없음 → 안내 노출, 결과 없음', async () => {
    M.semantic.mockResolvedValue({ status: 'no-embed-model', results: [], excludedCount: 0 });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.click(screen.getByRole('button', { name: '의미' }));
    await user.type(screen.getByLabelText('문서 검색'), '질의어');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/임베딩 모델이 필요/)).toBeTruthy());
  });

  it('의미 모드 + 모델 불일치 제외 → 제외 안내', async () => {
    M.semantic.mockResolvedValue({ status: 'ok', results: [result({ snippets: [{ page: 1, text: '청크' }] })], excludedCount: 2 });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.click(screen.getByRole('button', { name: '의미' }));
    await user.type(screen.getByLabelText('문서 검색'), '질의어');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/2개 문서는 제외/)).toBeTruthy());
  });

  it('모드 전환 시 이전 모드의 결과/안내가 검색-전 상태로 리셋', async () => {
    M.search.mockResolvedValue([result({})]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    // 키워드 검색 → 결과 렌더
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    // 의미 모드로 전환 → 이전 결과가 즉시 사라짐(재검색 전, noResults 안내도 없음)
    await user.click(screen.getByRole('button', { name: '의미' }));
    expect(screen.queryByText(/lecture\.pdf/)).toBeNull();
    expect(screen.queryByText(/결과가 없습니다/)).toBeNull();
  });

  it('의미 모드 + 클라우드 provider(openai) → 임베딩 전송 고지 배지 노출(#5)', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, persistSessions: true, provider: 'openai' } });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    // 키워드 모드(기본)에서는 배지 없음
    expect(screen.queryByText(/OpenAI로 전송/)).toBeNull();
    // 의미 모드로 전환 → 배지 노출
    await user.click(screen.getByRole('button', { name: '의미' }));
    expect(screen.getByText(/OpenAI로 전송/)).toBeTruthy();
  });

  it('의미 모드 + 로컬 provider(ollama) → 고지 배지 없음(#5)', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, persistSessions: true, provider: 'ollama' } });
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.click(screen.getByRole('button', { name: '의미' }));
    expect(screen.queryByText(/전송/)).toBeNull();
  });

  it('같은 모드 버튼 재클릭은 결과를 유지(불필요한 리셋 없음)', async () => {
    M.search.mockResolvedValue([result({})]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText(/lecture\.pdf/)).toBeTruthy());
    // 이미 키워드 모드에서 키워드 버튼 재클릭 → 결과 유지
    await user.click(screen.getByRole('button', { name: '키워드' }));
    expect(screen.getByText(/lecture\.pdf/)).toBeTruthy();
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

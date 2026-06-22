// @vitest-environment happy-dom

// RecentDocuments 행위 (session-persistence module-4) — 영속화 OFF 숨김 / 빈 목록 안내 /
// 목록 표시(페이지·인덱스) / 열기(openPath→handlePdfData) / 열기 실패 배너 /
// 삭제(성공 시 refresh, 실패 시 배너) / StrictMode 더블 마운트 가드.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionManifestEntry } from '../../../shared/session-types';

const M = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(() => Promise.resolve({ ok: true })),
  openPath: vi.fn(),
  handlePdfData: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pdf-parser', () => ({ handlePdfData: M.handlePdfData }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    session: { list: M.list, delete: M.del },
    file: { openPath: M.openPath },
  },
}));

import { RecentDocuments } from '../RecentDocuments';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

function entry(docHash: string, fileName: string, n: number, chunks = 0): SessionManifestEntry {
  return {
    docHash, fileName, filePath: `/docs/${fileName}`, pageCount: n,
    embedModel: chunks > 0 ? 'nomic-embed-text' : null, embedDim: chunks > 0 ? 768 : null,
    chunkCount: chunks, byteSize: 1000, createdAt: 'x', lastAccessed: 'x',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  M.list.mockResolvedValue([entry('h1', '강의1.pdf', 12, 40)]);
  M.del.mockResolvedValue({ ok: true });
  M.openPath.mockResolvedValue({ data: new Uint8Array(), name: '강의1.pdf', path: '/docs/강의1.pdf' });
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, persistSessions: true },
    error: null,
  });
});
afterEach(() => cleanup());

describe('RecentDocuments', () => {
  it('영속화 OFF 면 렌더하지 않는다', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, persistSessions: false } });
    const { container } = render(<RecentDocuments />);
    expect(container.firstChild).toBeNull();
  });

  it('영속화 ON + 빈 목록 → 안내 문구(기능 발견성)', async () => {
    M.list.mockResolvedValue([]);
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/저장된 세션이 없습니다/)).toBeTruthy());
  });

  it('목록 표시 — 파일명 + 페이지 수 + 인덱스 청크', async () => {
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
    expect(screen.getByText(/12페이지/)).toBeTruthy();
    expect(screen.getByText(/인덱스 40청크/)).toBeTruthy();
  });

  it('chunkCount=0 이면 인덱스 표기 없음', async () => {
    M.list.mockResolvedValue([entry('h2', '메모.pdf', 3, 0)]);
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/메모\.pdf/)).toBeTruthy());
    expect(screen.queryByText(/청크/)).toBeNull();
  });

  it('열기 → openPath(filePath) → handlePdfData(data,name,path)', async () => {
    const user = userEvent.setup();
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(M.openPath).toHaveBeenCalledWith('/docs/강의1.pdf');
    await waitFor(() => expect(M.handlePdfData).toHaveBeenCalledWith(expect.anything(), '강의1.pdf', '/docs/강의1.pdf'));
  });

  it('열기 실패(openPath error) → PDF_PARSE_FAIL 배너 + handlePdfData 미호출', async () => {
    M.openPath.mockResolvedValue({ error: 'ENOENT' });
    const user = userEvent.setup();
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(M.handlePdfData).not.toHaveBeenCalled();
  });

  it('삭제 → delete(docHash) 호출 + 목록 갱신(refresh 재조회)', async () => {
    const user = userEvent.setup();
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
    M.list.mockResolvedValue([]); // 삭제 후 빈 목록
    await user.click(screen.getByRole('button', { name: '세션 삭제' }));
    expect(M.del).toHaveBeenCalledWith('h1');
    await waitFor(() => expect(screen.getByText(/저장된 세션이 없습니다/)).toBeTruthy());
  });

  it('삭제 실패(ok=false) → deleteFail 배너', async () => {
    M.del.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '세션 삭제' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
  });

  it('한 항목 여는 중에도 다른 항목은 비활성되지 않는다 (L2 인플라이트 행만 잠금)', async () => {
    M.list.mockResolvedValue([entry('h1', '강의1.pdf', 12, 40), entry('h2', '강의2.pdf', 5, 0)]);
    let release: (v: unknown) => void = () => {};
    M.openPath.mockReturnValue(new Promise((r) => { release = r; })); // 열기 in-flight 고정
    const user = userEvent.setup();
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/강의2\.pdf/)).toBeTruthy());
    // 첫 항목(h1) 열기 → openPath pending → busy='h1'
    const openButtons = screen.getAllByRole('button', { name: '열기' });
    await user.click(openButtons[0]!);
    await waitFor(() => expect(screen.getByText('…')).toBeTruthy()); // h1 행은 '…'
    // 다른 행(h2)의 열기 버튼은 여전히 활성 (전 행 잠금 아님)
    const h2Open = screen.getByRole('button', { name: '열기' }); // h1은 '…'이라 '열기'는 h2뿐
    expect((h2Open as HTMLButtonElement).disabled).toBe(false);
    release({ data: new Uint8Array(), name: '강의1.pdf', path: '/docs/강의1.pdf' });
  });

  it('StrictMode 더블 마운트에서도 목록이 표시된다 (mountedRef 리셋 가드)', async () => {
    render(<StrictMode><RecentDocuments /></StrictMode>);
    await waitFor(() => expect(screen.getByText(/강의1\.pdf/)).toBeTruthy());
  });
});

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
  restoreFromSession: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../../lib/pdf-parser', () => ({ handlePdfData: M.handlePdfData }));
vi.mock('../../lib/tabs', () => ({ openFromSessionOnly: M.restoreFromSession }));

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
  M.restoreFromSession.mockResolvedValue(false);
  M.openPath.mockResolvedValue({ data: new Uint8Array(), name: '강의1.pdf', path: '/docs/강의1.pdf' });
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, persistSessions: true },
    error: null,
    // QA26: notice 를 초기화하지 않으면 앞 테스트의 안내가 새어 순서 의존이 된다.
    notice: null,
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

// QA26(C-High): 원본 파일이 없을 때의 세션 폴백.
//
// 기존 테스트는 openPath 를 항상 성공으로 목킹해 **실패 경로를 한 번도 보지 않았다**. 그래서
// "실패 시 세션으로 복원한다" 는 단언이 없었고, 재기동 직후(openTabs 가 비어 switchToTab 의
// 폴백에 도달할 방법이 없는 상태)에 파일을 옮기면 디스크의 요약·Q&A 에 영영 닿지 못했다.
describe('RecentDocuments — 원본 파일 부재 시 세션 폴백 (QA26)', () => {
  it('파일이 없어도 세션이 있으면 열고, 뷰어 불가만 안내한다', async () => {
    M.list.mockResolvedValue([entry('h1', '강의1.pdf', 12, 30)]);
    M.openPath.mockResolvedValue({ error: 'ENOENT' });
    M.restoreFromSession.mockResolvedValue(true);

    render(<RecentDocuments />);
    const btn = await screen.findByRole('button', { name: /강의1\.pdf/ });
    await userEvent.click(btn);

    await waitFor(() => expect(M.restoreFromSession).toHaveBeenCalled());
    // 폴백에 넘긴 값이 목록 항목 그대로여야 한다(탭 정체성이 어긋나면 복원본이 엉뚱해진다).
    expect(M.restoreFromSession).toHaveBeenCalledWith(
      expect.objectContaining({ docHash: 'h1', filePath: '/docs/강의1.pdf', fileName: '강의1.pdf', pageCount: 12 }),
    );
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().notice?.message).toBeTruthy();
    expect(M.handlePdfData).not.toHaveBeenCalled();
  });

  it('파일도 세션도 없으면 그때 에러 배너를 띄운다', async () => {
    M.list.mockResolvedValue([entry('h1', '강의1.pdf', 12, 30)]);
    M.openPath.mockResolvedValue({ error: 'ENOENT' });
    M.restoreFromSession.mockResolvedValue(false);

    render(<RecentDocuments />);
    await userEvent.click(await screen.findByRole('button', { name: /강의1\.pdf/ }));

    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(useAppStore.getState().notice).toBeNull();
  });

  it('파일이 열리면 폴백을 시도하지 않는다', async () => {
    M.list.mockResolvedValue([entry('h1', '강의1.pdf', 12, 30)]);
    M.openPath.mockResolvedValue({ data: new Uint8Array(), name: '강의1.pdf', path: '/docs/강의1.pdf' });

    render(<RecentDocuments />);
    await userEvent.click(await screen.findByRole('button', { name: /강의1\.pdf/ }));

    await waitFor(() => expect(M.handlePdfData).toHaveBeenCalled());
    expect(M.restoreFromSession).not.toHaveBeenCalled();
  });
});

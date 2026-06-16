// @vitest-environment happy-dom

// multi-doc Phase 3 module-2: CollectionsList 행위 — 목록 표시 / 열기(openCollection 호출) /
// 삭제 / 부분 복원 안내.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const M = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(() => Promise.resolve({ ok: true })),
  openCollection: vi.fn(() => Promise.resolve({ opened: 2, total: 2 })),
  blocked: vi.fn(() => false),
}));
vi.mock('../../lib/collections-client', () => ({
  listCollections: M.list,
  deleteCollection: M.del,
  saveCollection: vi.fn(),
}));
vi.mock('../../lib/tabs', () => ({ openCollection: M.openCollection, isTabSwitchBlocked: M.blocked }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
}));

import { CollectionsList } from '../CollectionsList';
import { useAppStore } from '../../lib/store';

function coll(id: string, name: string, n: number) {
  return { id, name, docHashes: Array.from({ length: n }, (_, i) => `${id}-${i}`), createdAt: 'x', lastAccessed: 'x' };
}

beforeEach(() => {
  vi.clearAllMocks();
  M.list.mockResolvedValue([coll('c1', '강의 묶음', 3)]);
  M.openCollection.mockResolvedValue({ opened: 2, total: 2 });
  M.blocked.mockReturnValue(false);
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings, persistSessions: true },
    notice: null, error: null,
  });
});
afterEach(() => cleanup());

describe('CollectionsList', () => {
  it('영속화 OFF 면 렌더 안 함', async () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, persistSessions: false } });
    const { container } = render(<CollectionsList />);
    expect(container.firstChild).toBeNull();
  });

  it('저장된 컬렉션 목록 표시(이름 + 문서 수)', async () => {
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    expect(screen.getByText(/문서 3개/)).toBeTruthy();
  });

  it('StrictMode 더블 마운트에서도 목록이 표시된다 (dev 빈 목록 회귀 가드)', async () => {
    // mountedRef 가 재마운트 시 true 로 리셋되지 않으면 refresh 결과가 버려져 목록이 빈 채로 남는다.
    render(<StrictMode><CollectionsList /></StrictMode>);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
  });

  it('열기 → openCollection(docHashes) 호출', async () => {
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(M.openCollection).toHaveBeenCalledWith(['c1-0', 'c1-1', 'c1-2']);
  });

  it('R48: 생성/분석 중이면 열기 차단 + busy 안내(openCollection 미호출)', async () => {
    M.blocked.mockReturnValue(true);
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(M.openCollection).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppStore.getState().notice).not.toBeNull());
  });

  it('R48: 전원 복원 실패(opened 0) → COLLECTION_OPEN_FAIL 에러', async () => {
    M.openCollection.mockResolvedValue({ opened: 0, total: 2 });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('COLLECTION_OPEN_FAIL'));
  });

  it('부분 복원 시 안내 notice', async () => {
    M.openCollection.mockResolvedValue({ opened: 2, total: 3 });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().notice).not.toBeNull());
  });

  it('삭제 → deleteCollection(id) 호출 + 목록 갱신', async () => {
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    M.list.mockResolvedValue([]); // 삭제 후 빈 목록
    await user.click(screen.getByRole('button', { name: '삭제' }));
    expect(M.del).toHaveBeenCalledWith('c1');
  });
});

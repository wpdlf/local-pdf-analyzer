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
  touch: vi.fn(() => Promise.resolve({ ok: true })),
  openCollection: vi.fn(() => Promise.resolve({ opened: 2, total: 2 })),
  blocked: vi.fn(() => false),
}));
vi.mock('../../lib/collections-client', () => ({
  listCollections: M.list,
  deleteCollection: M.del,
  touchCollection: M.touch,
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

  // QA23(D-LOW): 일시 I/O 오류(EBUSY 등)를 "없음" 으로 단정하면 사용자는 전량 소실로 읽는다.
  it('목록을 불러오지 못하면 "없음" 이 아니라 실패 사유와 재시도를 보여준다', async () => {
    M.list.mockResolvedValue(null); // 클라이언트가 실패를 null 로 전달
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/컬렉션으로 저장해두면/), '없음 안내를 단정적으로 띄우면 안 된다').toBeNull();

    // 재시도하면 정상 목록으로 회복된다.
    M.list.mockResolvedValue([coll('c1', '강의 묶음', 3)]);
    await user.click(screen.getByRole('button', { name: /다시 시도/ }));
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
  });

  // QA24(A-L3): 종전에는 실패 고지가 `items.length === 0` 블록 안에만 있어, **이미 목록이 떠
  // 있는 상태**의 재조회 실패는 사유도 재시도도 없이 stale 목록으로 보였다(방금 지운 항목이
  // 그대로 남아 클릭하면 열기 실패). 목록 유무와 무관하게 고지한다.
  it('목록이 이미 떠 있는 상태의 재조회 실패도 사유와 재시도를 보여준다', async () => {
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());

    // 삭제 직후 재조회가 실패하는 상황
    M.list.mockResolvedValue(null);
    await user.click(screen.getAllByRole('button', { name: /삭제/ })[0]!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 기존 목록은 지우지 않는 정책은 그대로 — 사유만 함께 보인다.
    expect(screen.getByText(/강의 묶음/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /다시 시도/ })).toBeTruthy();
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

  // lastAccessed 는 목록 정렬 키이자 LRU 축출 키인데 갱신 지점이 저장뿐이었다 → 매일 열지만
  // 편집하지 않는 컬렉션이 상한에서 먼저 축출된다(collections.json 은 유일 사본, 회수 불가).
  it('열기 성공 → 최근 사용 표시(touch) 호출', async () => {
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(M.touch).toHaveBeenCalledWith('c1'));
  });

  it('부분 복원도 사용으로 친다 (touch 호출)', async () => {
    M.openCollection.mockResolvedValue({ opened: 2, total: 3 });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(M.touch).toHaveBeenCalledWith('c1'));
  });

  it('전원 복원 실패면 touch 하지 않는다 (실패한 열기로 LRU 순서를 바꾸지 않는다)', async () => {
    M.openCollection.mockResolvedValue({ opened: 0, total: 2 });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('COLLECTION_OPEN_FAIL'));
    expect(M.touch).not.toHaveBeenCalled();
  });

  // QA22(백로그): 연 컬렉션의 출처를 기록해야 CollectionBar 의 재저장이 신규 항목이 아니라
  // 갱신이 된다(동명 누적 방지). 부분 복원도 소속은 동일하고, 전원 실패면 기록하지 않는다.
  it('열기 성공 → collection.saved 에 원본 {id,name} 기록', async () => {
    useAppStore.setState({ collection: { enabled: false, memberHashes: [] } });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().collection.saved).toEqual({ id: 'c1', name: '강의 묶음' }));
  });

  // QA23(D-MED, 회수 불가 손실): 부분 복원(멤버 세션이 LRU 축출·손상으로 일부 사라짐)에서
  // 소속을 기록하면, 이름이 프리필된 채 저장했을 때 **복원되지 못한 멤버가 컬렉션에서 영구 삭제**
  // 된다. 그 문서를 나중에 다시 열어 세션이 살아나도 컬렉션에는 없다. 부분 복원은 "이 컬렉션을
  // 편집 중" 이라고 볼 수 없으므로 소속을 기록하지 않는다(저장하면 새 컬렉션이 된다 — 무손실).
  it('부분 복원(opened < total)이면 소속을 기록하지 않는다 — 누락 멤버 삭제 방지', async () => {
    M.openCollection.mockResolvedValue({ opened: 2, total: 3 });
    useAppStore.setState({ collection: { enabled: false, memberHashes: [] } });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().notice).not.toBeNull()); // 부분 복원 안내는 유지
    expect(useAppStore.getState().collection.saved).toBeUndefined();
  });

  it('전원 복원 실패(opened 0) 면 소속을 기록하지 않는다', async () => {
    M.openCollection.mockResolvedValue({ opened: 0, total: 2 });
    useAppStore.setState({ collection: { enabled: false, memberHashes: [] } });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '열기' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('COLLECTION_OPEN_FAIL'));
    expect(useAppStore.getState().collection.saved).toBeUndefined();
  });

  it('열려 있던 컬렉션을 삭제하면 소속이 끊긴다 (이후 저장은 신규)', async () => {
    useAppStore.setState({ collection: { enabled: true, memberHashes: [], saved: { id: 'c1', name: '강의 묶음' } } });
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/강의 묶음/)).toBeTruthy());
    M.list.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(useAppStore.getState().collection.saved).toBeUndefined());
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

  it('한 컬렉션 여는 중에도 다른 컬렉션은 비활성되지 않는다 (L2 인플라이트 행만 잠금)', async () => {
    M.list.mockResolvedValue([coll('c1', '묶음A', 2), coll('c2', '묶음B', 2)]);
    let release: (v: { opened: number; total: number }) => void = () => {};
    M.openCollection.mockReturnValue(new Promise((r) => { release = r; })); // 열기 in-flight 고정
    const user = userEvent.setup();
    render(<CollectionsList />);
    await waitFor(() => expect(screen.getByText(/묶음B/)).toBeTruthy());
    const openButtons = screen.getAllByRole('button', { name: '열기' });
    await user.click(openButtons[0]!); // c1 열기 → busy='c1'
    await waitFor(() => expect(screen.getByText('…')).toBeTruthy()); // c1 행은 '…'
    const c2Open = screen.getByRole('button', { name: '열기' }); // c2만 '열기'
    expect((c2Open as HTMLButtonElement).disabled).toBe(false);
    release({ opened: 2, total: 2 });
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

// @vitest-environment happy-dom

// multi-doc Phase 2 module-2 — CollectionBar 행위 테스트.
// 노출 조건(탭 2개+), 토글 시 기본 전체 선택, 모델 불일치 멤버 비활성+배지, 멤버 토글.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSessionList = vi.fn();
const mockSaveCollection = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true, id: 'new' })));
vi.mock('../../lib/collections-client', () => ({ saveCollection: mockSaveCollection }));
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    session: { list: mockSessionList },
  },
}));

import { CollectionBar } from '../CollectionBar';
import { useAppStore } from '../../lib/store';
import { VectorStore } from '../../lib/vector-store';

function manifestEntry(docHash: string, model: string, dim: number) {
  return {
    docHash, fileName: `${docHash}.pdf`, filePath: `/d/${docHash}.pdf`, pageCount: 10,
    embedModel: model, embedDim: dim, chunkCount: 5, byteSize: 100,
    createdAt: '2026-06-15T00:00:00Z', lastAccessed: '2026-06-15T00:00:00Z',
  };
}

/** 활성 문서 인덱스(모델 m, 3차원)를 store.ragIndex 에 세팅 */
function seedActive(): void {
  const vs = new VectorStore();
  vs.setModel('m');
  vs.addChunk('x', [1, 0, 0], 0);
  useAppStore.setState({
    ragIndex: vs,
    ragState: { isIndexing: false, progress: null, isAvailable: true, model: 'm', chunkCount: 1, error: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionList.mockResolvedValue([]);
  useAppStore.setState({
    openTabs: [],
    document: null,
    collection: { enabled: false, memberHashes: [] },
  });
});
afterEach(() => cleanup());

describe('CollectionBar 노출 조건', () => {
  it('docHash 보유 탭이 2개 미만이면 렌더 안 함', () => {
    useAppStore.setState({
      openTabs: [{ filePath: '/a', fileName: 'a.pdf', pageCount: 1, docHash: 'a'.repeat(64) }],
    });
    const { container } = render(<CollectionBar />);
    expect(container.firstChild).toBeNull();
  });

  it('탭 2개 이상이면 토글 노출', () => {
    useAppStore.setState({
      openTabs: [
        { filePath: '/a', fileName: 'a.pdf', pageCount: 1, docHash: 'a'.repeat(64) },
        { filePath: '/b', fileName: 'b.pdf', pageCount: 1, docHash: 'b'.repeat(64) },
      ],
    });
    render(<CollectionBar />);
    expect(screen.getByText('여러 문서에 걸쳐 질문')).toBeTruthy();
  });
});

describe('CollectionBar 동작', () => {
  beforeEach(() => {
    seedActive();
    useAppStore.setState({
      openTabs: [
        { filePath: '/a', fileName: 'Alpha.pdf', pageCount: 1, docHash: 'a'.repeat(64) },
        { filePath: '/b', fileName: 'Beta.pdf', pageCount: 1, docHash: 'b'.repeat(64) },
      ],
      document: { id: 'd', fileName: 'Alpha.pdf', filePath: '/a', pageCount: 1, extractedText: 'x', pageTexts: [], chapters: [], images: [], createdAt: new Date() },
    });
  });

  it('토글 ON 시 후보 전체를 기본 선택', async () => {
    const user = userEvent.setup();
    render(<CollectionBar />);
    // 비활성 상태에서는 모드 토글 체크박스 1개만 렌더된다
    await user.click(screen.getAllByRole('checkbox')[0]!);
    expect(useAppStore.getState().collection.enabled).toBe(true);
    expect(useAppStore.getState().collection.memberHashes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('동일 모델 비활성 멤버는 선택 가능(ready), 활성 문서는 강제 포함(체크+비활성)', async () => {
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'm', 3)]);
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    await waitFor(() => expect(screen.getByText(/Beta\.pdf/)).toBeTruthy());
    // 비활성 ready 멤버(Beta)는 토글 가능
    const beta = screen.getByRole('checkbox', { name: /Beta\.pdf/ }) as HTMLInputElement;
    expect(beta.disabled).toBe(false);
    // 활성 문서(Alpha)는 항상 검색 포함 — 체크된 채 비활성(해제 불가)
    const alpha = screen.getByRole('checkbox', { name: /Alpha\.pdf/ }) as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect(alpha.disabled).toBe(true);
  });

  it('모델 불일치 멤버는 검색 제외 배지 표시 + 요약용 선택 가능(QA M2)', async () => {
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'other-model', 1536)]);
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    // 배지는 "검색 제외(요약은 가능)" 로 표기 — 검색에선 빠지지만 교차 요약엔 포함된다
    await waitFor(() => expect(screen.getByText(/임베딩 모델 불일치/)).toBeTruthy());
    // Beta 체크박스는 더 이상 비활성이 아님 — 요약 멤버로 선택 가능(검색은 자체적으로 ready 만 사용)
    const betaLabel = screen.getByText(/Beta\.pdf/).closest('label')!;
    const betaBox = betaLabel.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(betaBox.disabled).toBe(false);
  });

  it('컬렉션 저장: 멤버 2개+ 일 때 버튼 노출, 클릭→이름 입력→saveCollection 호출', async () => {
    mockSaveCollection.mockClear();
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    const user = userEvent.setup();
    render(<CollectionBar />);
    // 저장 버튼 노출(멤버 2개)
    const saveBtn = await screen.findByRole('button', { name: /컬렉션 저장/ });
    await user.click(saveBtn);
    // 이름 입력 → 저장
    const input = screen.getByPlaceholderText('컬렉션 이름');
    await user.clear(input);
    await user.type(input, '나의 묶음');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(mockSaveCollection).toHaveBeenCalledWith(
      expect.objectContaining({ name: '나의 묶음', docHashes: ['a'.repeat(64), 'b'.repeat(64)] }),
    );
    expect(useAppStore.getState().notice).not.toBeNull(); // 저장 안내
  });

  // QA22(백로그): 저장 경로가 항상 id 없이 호출해 저장된 컬렉션을 열고 다시 저장할 때마다
  // main 이 새 randomUUID 를 발급했다 → 목록에 동명 항목이 쌓이고(구분 불가) 개수 상한의 LRU 가
  // 무관한 컬렉션을 밀어낸다.
  it('저장된 컬렉션을 같은 이름으로 재저장하면 그 id 로 갱신한다', async () => {
    mockSaveCollection.mockClear();
    useAppStore.setState({
      collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)], saved: { id: 'col-1', name: '나의 묶음' } },
    });
    const user = userEvent.setup();
    render(<CollectionBar />);
    await user.click(await screen.findByRole('button', { name: /컬렉션 저장/ }));
    // 기본 이름이 저장된 컬렉션 이름으로 채워진다(그대로 저장 = 갱신 경로)
    const input = screen.getByPlaceholderText('컬렉션 이름') as HTMLInputElement;
    expect(input.value).toBe('나의 묶음');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(mockSaveCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 'col-1', name: '나의 묶음' }));
    // QA23: 갱신은 멤버 목록을 교체하므로 신규 저장과 구분해 알린다(축소를 즉시 인지할 수 있게).
    await waitFor(() => expect(useAppStore.getState().notice?.message).toContain('갱신'));
    expect(useAppStore.getState().notice?.message).toContain('2개');
  });

  it('이름을 바꿔 저장하면 신규 항목(id 미전달) — "다른 이름으로 저장" 을 덮어쓰기로 오해하지 않는다', async () => {
    mockSaveCollection.mockClear();
    useAppStore.setState({
      collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)], saved: { id: 'col-1', name: '나의 묶음' } },
    });
    const user = userEvent.setup();
    render(<CollectionBar />);
    await user.click(await screen.findByRole('button', { name: /컬렉션 저장/ }));
    const input = screen.getByPlaceholderText('컬렉션 이름');
    await user.clear(input);
    await user.type(input, '다른 묶음');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(mockSaveCollection).toHaveBeenCalledWith(expect.not.objectContaining({ id: expect.anything() }));
    // 신규 저장 후에는 발급된 id 로 소속이 갱신돼 다음 재저장이 다시 갱신 경로를 탄다
    await waitFor(() => expect(useAppStore.getState().collection.saved).toEqual({ id: 'new', name: '다른 묶음' }));
  });

  it('활성 문서에 "현재" 배지', async () => {
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    await waitFor(() => expect(screen.getByText('현재')).toBeTruthy());
    const alphaLabel = screen.getByText(/Alpha\.pdf/).closest('label')!;
    expect(alphaLabel.textContent).toContain('현재');
  });
});

// QA28(B-Low): 저장 실패 시 입력 UI 를 닫고 이름을 지우면 재시도에 재입력이 필요하다 —
// 실패면 입력값·입력 UI 유지, 성공이면 닫고 비운다.
describe('CollectionBar — QA28(B-Low) 저장 실패 시 입력 유지', () => {
  beforeEach(() => {
    seedActive();
    useAppStore.setState({
      openTabs: [
        { filePath: '/a', fileName: 'Alpha.pdf', pageCount: 1, docHash: 'a'.repeat(64) },
        { filePath: '/b', fileName: 'Beta.pdf', pageCount: 1, docHash: 'b'.repeat(64) },
      ],
      document: { id: 'd', fileName: 'Alpha.pdf', filePath: '/a', pageCount: 1, extractedText: 'x', pageTexts: [], chapters: [], images: [], createdAt: new Date() },
      collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] },
      error: null,
    });
  });

  it('QA28(B-Low): 저장 실패({ok:false}) → 입력 UI 가 열린 채 이름이 유지되고 saveFail 배너', async () => {
    mockSaveCollection.mockResolvedValueOnce({ ok: false } as never);
    const user = userEvent.setup();
    render(<CollectionBar />);
    await user.click(await screen.findByRole('button', { name: /컬렉션 저장/ }));
    const input = screen.getByPlaceholderText('컬렉션 이름') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '재시도 묶음');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('COLLECTION_SAVE_FAIL'));
    const still = screen.getByPlaceholderText('컬렉션 이름') as HTMLInputElement; // 입력 UI 잔존
    expect(still.value).toBe('재시도 묶음');
    expect(screen.queryByRole('button', { name: /컬렉션 저장/ })).toBeNull(); // 💾 버튼으로 돌아가지 않음
  });

  it('QA28(B-Low): 저장 성공 → 입력 UI 닫히고 이름 비워짐(다음 열기는 기본 이름)', async () => {
    mockSaveCollection.mockResolvedValueOnce({ ok: true, id: 'ok-1' } as never);
    const user = userEvent.setup();
    render(<CollectionBar />);
    await user.click(await screen.findByRole('button', { name: /컬렉션 저장/ }));
    const input = screen.getByPlaceholderText('컬렉션 이름') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '성공 묶음');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('컬렉션 이름')).toBeNull());
    const saveBtn = await screen.findByRole('button', { name: /컬렉션 저장/ });
    expect(useAppStore.getState().error).toBeNull();
    // 포커스가 💾 버튼으로 반환된다(rAF)
    await waitFor(() => expect(document.activeElement).toBe(saveBtn));
  });
});

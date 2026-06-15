// @vitest-environment happy-dom

// multi-doc Phase 2 module-2 — CollectionBar 행위 테스트.
// 노출 조건(탭 2개+), 토글 시 기본 전체 선택, 모델 불일치 멤버 비활성+배지, 멤버 토글.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSessionList = vi.fn();
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
    ragState: { isIndexing: false, progress: null, isAvailable: true, model: 'm', chunkCount: 1 },
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

  it('동일 모델 멤버는 선택 가능(ready)', async () => {
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'm', 3)]);
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    await waitFor(() => expect(screen.getByText(/Beta\.pdf/)).toBeTruthy());
    // 멤버 체크박스(활성 토글 제외)들이 모두 enabled
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.every((b) => !(b as HTMLInputElement).disabled)).toBe(true);
  });

  it('모델 불일치 멤버는 비활성 + 배지 표시', async () => {
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'other-model', 1536)]);
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    await waitFor(() => expect(screen.getByText(/임베딩 모델 불일치/)).toBeTruthy());
    // Beta 의 체크박스는 disabled
    const betaLabel = screen.getByText(/Beta\.pdf/).closest('label')!;
    const betaBox = betaLabel.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(betaBox.disabled).toBe(true);
  });

  it('활성 문서에 "현재" 배지', async () => {
    useAppStore.setState({ collection: { enabled: true, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] } });
    render(<CollectionBar />);
    await waitFor(() => expect(screen.getByText('현재')).toBeTruthy());
    const alphaLabel = screen.getByText(/Alpha\.pdf/).closest('label')!;
    expect(alphaLabel.textContent).toContain('현재');
  });
});

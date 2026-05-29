import { describe, it, expect, vi, beforeEach } from 'vitest';

// R37 P6 (v0.18.23) — buildRagIndex 회귀 가드 (QA M3).
// buildRagIndex 는 hook 이 아닌 일반 async 함수라 export 후 직접 호출로 검증 가능하다.
// window.electronAPI.ai (checkEmbedModel/embed/abort) 와 useAppStore(zustand)에 의존하므로
// 모듈 import 이전에 window 를 stub 한다 (qa-verify.test.ts 와 동일 패턴).

const mockCheckEmbedModel = vi.fn();
const mockEmbed = vi.fn();
const mockAbort = vi.fn(() => Promise.resolve());
vi.stubGlobal('window', {
  electronAPI: {
    ai: {
      checkEmbedModel: mockCheckEmbedModel,
      embed: mockEmbed,
      abort: mockAbort,
    },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { buildRagIndex } from '../use-qa';
import { useAppStore } from '../store';

beforeEach(() => {
  const s = useAppStore.getState();
  s.ragIndex.clear();
  s.setRagState({ isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 });
  useAppStore.setState({ document: null });
  mockCheckEmbedModel.mockReset();
  mockEmbed.mockReset();
});

const TEXT = '운영체제는 프로세스를 관리한다. CPU 스케줄링과 메모리 관리는 핵심 기능이다. 가상 메모리는 페이징으로 구현된다.';

describe('buildRagIndex — 임베딩 가용성', () => {
  it('임베딩 모델 미가용이면 isAvailable=false 로 설정하고 false 반환', async () => {
    mockCheckEmbedModel.mockResolvedValue({ available: false });
    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(ok).toBe(false);
    expect(useAppStore.getState().ragState.isAvailable).toBe(false);
    expect(useAppStore.getState().ragIndex.size).toBe(0);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

describe('buildRagIndex — 정상 인덱싱', () => {
  it('문서 id 가 일치하면 청크를 임베딩해 인덱스를 채우고 true 반환', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    // 배치 길이에 정확히 맞는 임베딩 반환 (부분결과 방어 통과)
    mockEmbed.mockImplementation((texts: string[]) =>
      Promise.resolve({ success: true, embeddings: texts.map(() => [0.1, 0.2, 0.3]), model: 'nomic-embed-text' }),
    );

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);

    expect(ok).toBe(true);
    const st = useAppStore.getState();
    expect(st.ragIndex.size).toBeGreaterThan(0);
    expect(st.ragState.chunkCount).toBe(st.ragIndex.size);
    expect(st.ragState.isAvailable).toBe(true);
    expect(st.ragState.isIndexing).toBe(false);
    expect(mockEmbed).toHaveBeenCalled();
  });

  it('page-aware 메타데이터 경로(pageTexts 제공)도 인덱싱한다', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    mockEmbed.mockImplementation((texts: string[]) =>
      Promise.resolve({ success: true, embeddings: texts.map(() => [0.1, 0.2, 0.3]) }),
    );

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal, [TEXT]);
    expect(ok).toBe(true);
    expect(useAppStore.getState().ragIndex.size).toBeGreaterThan(0);
  });
});

describe('buildRagIndex — 방어 분기', () => {
  it('부분 임베딩(개수 불일치)이면 인덱스를 비우고 false 반환', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    // 항상 batch 보다 1개 많은 임베딩 → length 불일치 강제
    mockEmbed.mockImplementation((texts: string[]) =>
      Promise.resolve({ success: true, embeddings: [...texts.map(() => [0.1]), [0.2]] }),
    );

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(ok).toBe(false);
    expect(useAppStore.getState().ragIndex.size).toBe(0);
    expect(useAppStore.getState().ragState.isAvailable).toBe(false);
  });

  it('embed 실패(success:false)면 인덱스를 비우고 false 반환', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    mockEmbed.mockResolvedValue({ success: false, error: '임베딩 요청 실패' });

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(ok).toBe(false);
    expect(useAppStore.getState().ragIndex.size).toBe(0);
  });

  it('이미 abort 된 signal 이면 임베딩 없이 false 반환 (인덱스 무손상)', async () => {
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    const ac = new AbortController();
    ac.abort();
    const ok = await buildRagIndex(TEXT, 'doc1', ac.signal);
    expect(ok).toBe(false);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(useAppStore.getState().ragIndex.size).toBe(0);
  });

  it('인덱싱 완료 시점에 문서가 바뀌어(docId 불일치) stale 이면 false 반환', async () => {
    // 빌드는 doc1 으로 시작했지만 완료 직전 store.document 가 doc2 로 전환된 상황을 시뮬레이션.
    useAppStore.setState({ document: { id: 'doc2' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    mockEmbed.mockImplementation((texts: string[]) =>
      Promise.resolve({ success: true, embeddings: texts.map(() => [0.1, 0.2, 0.3]) }),
    );

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(ok).toBe(false);
  });
});

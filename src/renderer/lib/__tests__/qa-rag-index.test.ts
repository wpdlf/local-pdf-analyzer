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
  // QA27(D-MED): `error` 를 리셋하지 않아 한 테스트가 세운 'embedFailed' 가 모듈 스코프
  // Zustand 를 타고 뒤 테스트로 샜다(셔플에서 드러나는 순서 의존).
  s.setRagState({ isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null });
  useAppStore.setState({ document: null });
  mockCheckEmbedModel.mockReset();
  mockEmbed.mockReset();
});

const TEXT = '운영체제는 프로세스를 관리한다. CPU 스케줄링과 메모리 관리는 핵심 기능이다. 가상 메모리는 페이징으로 구현된다.';

describe('buildRagIndex — 임베딩 가용성', () => {
  it('임베딩 모델 미가용이면 isAvailable=false 로 설정하고 false 반환', async () => {
    // ⚠️ document 를 세우지 않으면 소유권 판정(document.id !== docId)에서 먼저 돌아와
    // checkEmbedModel 이 호출조차 되지 않는다 — 그러면 아래 단언들이 beforeEach 의 기본값을
    // 확인하는 공허한 테스트가 된다(QA31 잔여 수정 때 실제로 그렇게 됐다).
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: false });
    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(mockCheckEmbedModel, '가용성 분기에 도달하지 못했다 — 이 테스트가 공허한 상태다').toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(useAppStore.getState().ragState.isAvailable).toBe(false);
    expect(useAppStore.getState().ragIndex.size).toBe(0);
    expect(mockEmbed).not.toHaveBeenCalled();
    // 이 분기는 메모리 인덱스를 **비우지 않는다** — 그래서 error 표식이 없어도 디스크 인덱스가
    // 위험하지 않다(preserveDiskIndex 는 size===0 일 때만 필요해진다). 아래 실패 분기들과
    // 계약이 다르다는 사실 자체를 고정한다.
    expect(useAppStore.getState().ragState.error).toBeNull();
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
    // QA27(D-MED): 배치 실패 경로도 같은 조인을 지켜야 한다(형제 단언).
    expect(useAppStore.getState().ragState.error).toBe('embedFailed');
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

  // QA31 잔여: 배치 루프만 document.id 를 봤고, 그 **앞**의 두 await(설정 커밋·checkEmbedModel)
  // 뒤에는 signal.aborted 만 있었다. 루프 주석이 적고 있는 사유(React cleanup 지연으로 abort 가
  // 늦게 도달하는 창)는 앞구간에도 성립하는데, 거기에는 파괴적 쓰기가 셋 있다.
  it('checkEmbedModel 뒤에 문서가 바뀌면 새 문서의 인덱스를 비우지 않는다', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    // 새 문서가 이미 채워 둔 인덱스 — stale 빌드의 ragIndex.clear() 가 이것을 날리던 자리다.
    const s = useAppStore.getState();
    s.ragIndex.setModel('nomic-embed-text');
    s.ragIndex.addChunk('새 문서 청크', [0.1, 0.2, 0.3], 0);
    s.setRagState({ error: 'embedFailed' }); // QA19 가 디스크 인덱스 보존에 쓰는 표식

    mockCheckEmbedModel.mockImplementation(() => {
      // 이 await 이 풀리는 사이에 사용자가 다른 탭으로 전환했다.
      useAppStore.setState({ document: { id: 'doc2' } as never });
      return Promise.resolve({ available: true, model: 'nomic-embed-text' });
    });

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);

    expect(ok).toBe(false);
    expect(useAppStore.getState().ragIndex.size, 'stale 빌드가 새 문서의 인덱스를 비웠다').toBe(1);
    expect(useAppStore.getState().ragState.error, 'stale 빌드가 새 문서의 실패 표식을 지웠다').toBe('embedFailed');
    expect(useAppStore.getState().ragState.isIndexing, 'stale 빌드가 진행 중이라고 주장했다').toBe(false);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('모델 미가용 응답이 stale 이면 새 문서를 미가용으로 표시하지 않는다', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    useAppStore.getState().setRagState({ isAvailable: true, model: 'nomic-embed-text' });
    mockCheckEmbedModel.mockImplementation(() => {
      useAppStore.setState({ document: { id: 'doc2' } as never });
      return Promise.resolve({ available: false });
    });

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);

    expect(ok).toBe(false);
    expect(useAppStore.getState().ragState.isAvailable, '옛 빌드가 새 문서의 RAG 를 껐다').toBe(true);
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

  // QA post-v0.31.15(M1): 배치 임베딩 도중 문서가 전환되면(signal abort 가 아직 도달 전) addChunk
  // 없이 즉시 false — 탭 전환/드롭이 clear 한 새 문서 공유 인덱스를 stale 배치가 재오염하는 창 차단.
  it('배치 임베딩 직후 문서 전환(docId 불일치)이면 addChunk 없이 인덱스 무오염', async () => {
    useAppStore.setState({ document: { id: 'doc1' } as never });
    mockCheckEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    mockEmbed.mockImplementation((texts: string[]) => {
      // 임베딩 반환 직전 문서 전환(탭 전환/드롭). signal 은 아직 abort 되지 않은 상태.
      useAppStore.setState({ document: { id: 'doc2' } as never });
      return Promise.resolve({ success: true, embeddings: texts.map(() => [0.1, 0.2, 0.3]) });
    });

    const ok = await buildRagIndex(TEXT, 'doc1', new AbortController().signal);
    expect(ok).toBe(false);
    expect(useAppStore.getState().ragIndex.size).toBe(0); // stale 배치가 인덱스를 오염하지 않음
  });
});

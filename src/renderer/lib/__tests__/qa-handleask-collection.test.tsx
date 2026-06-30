// @vitest-environment happy-dom

// R46 후속(CI 커버리지): handleAsk 의 컬렉션 글루를 CI 에서 검증.
// 기존 collection.spec.ts(E2E)는 Ollama 의존이라 CI 에서 skip → handleAsk 가 실제로
// resolveCollectionSearch 결과를 컨텍스트로 쓰고 강등 notice 를 띄우는 배선이 무가드였다.
// AiClient/embed/session 을 모킹해 LLM·Ollama 없이 통합 경로를 가드한다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// AiClient 스트리밍 모킹 — summarize 에 전달된 promptText 를 캡처해 컨텍스트 구성 검증.
const M = vi.hoisted(() => ({ prompt: '', empty: false }));
vi.mock('../ai-client', () => ({
  AiClient: class {
    prepareSummarize() { return 'req-1'; }
    // eslint-disable-next-line require-yield
    async *summarize(prompt: string) { M.prompt = prompt; if (M.empty) return; yield '답변'; yield ' 본문'; }
  },
}));

const mockEmbed = vi.fn();
const mockSessionList = vi.fn();
const mockSessionLoad = vi.fn();
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: mockEmbed, abort: vi.fn(() => Promise.resolve()) },
    session: { list: mockSessionList, load: mockSessionLoad },
  },
}));
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { useQa } from '../use-qa';
import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';

const MODEL = 'm';

function activeIndex(): VectorStore {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  vs.addChunk('활성 ALPHA 본문', [1, 0, 0], 0, { pageStart: 2, pageEnd: 2 });
  return vs;
}

function manifestEntry(docHash: string, model: string | null, dim: number | null) {
  return {
    docHash, fileName: `${docHash}.pdf`, filePath: `/d/${docHash}.pdf`, pageCount: 10,
    embedModel: model, embedDim: dim, chunkCount: model ? 5 : 0, byteSize: 100,
    createdAt: '2026-06-15T00:00:00Z', lastAccessed: '2026-06-15T00:00:00Z',
  };
}

function betaBlob() {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  vs.addChunk('비활성 BETA 본문', [0.9, 0.1, 0], 0, { pageStart: 7, pageEnd: 7 });
  const s = vs.serialize();
  return {
    session: {
      schemaVersion: 1, docHash: 'b'.repeat(64), fileName: 'Beta.pdf', filePath: '/d/Beta.pdf',
      pageCount: 10, extractedText: 't', pageTexts: ['p'], chapters: [], summaries: {},
      summaryType: 'full', qaMessages: [], embedModel: s.model, embedDim: s.dimension, chunkMeta: s.chunkMeta,
    },
    blob: s.buffer,
  };
}

function seed(collectionEnabled: boolean): void {
  useAppStore.setState({
    document: {
      id: 'doc-a', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 5,
      extractedText: '활성 문서 본문', pageTexts: ['활성 문서 본문'], chapters: [], images: [], createdAt: new Date(),
    },
    openTabs: [
      { filePath: '/d/Alpha.pdf', fileName: 'Alpha.pdf', pageCount: 5, docHash: 'a'.repeat(64) },
      { filePath: '/d/Beta.pdf', fileName: 'Beta.pdf', pageCount: 10, docHash: 'b'.repeat(64) },
    ],
    ragIndex: activeIndex(),
    ragState: { isIndexing: false, progress: null, isAvailable: true, model: MODEL, chunkCount: 1 },
    collection: { enabled: collectionEnabled, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] },
    qaMessages: [], qaStream: '', isGenerating: false, isQaGenerating: false, qaRequestId: null,
    notice: null, error: null,
    settings: { ...useAppStore.getState().settings, provider: 'ollama', enableAnswerVerification: false, persistSessions: false, maxChunkSize: 4000 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  M.prompt = '';
  M.empty = false;
  mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: MODEL });
  mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), MODEL, 3)]);
  mockSessionLoad.mockResolvedValue(betaBlob());
});
afterEach(() => cleanup());

describe('handleAsk — 컬렉션 글루 (CI 통합)', () => {
  it('컬렉션 모드: 교차 문서 컨텍스트로 프롬프트 구성 + 답변 커밋 + 강등 notice 없음', async () => {
    seed(true);
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('두 문서 핵심?'); });

    // 프롬프트에 두 문서 출처 라벨이 모두 포함(collectionRagSearch 결과가 컨텍스트로 사용됨)
    expect(M.prompt).toContain('[Alpha.pdf p.2]');
    expect(M.prompt).toContain('[Beta.pdf p.7]');
    // 답변이 assistant 메시지로 커밋
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant' });
    expect(msgs.at(-1)?.content).toContain('답변 본문');
    // 2개 멤버 정상 교차 → 강등 표식 없음 (M3: 전역 notice 아닌 메시지 표식)
    expect(msgs.at(-1)?.degraded).toBeFalsy();
    expect(useAppStore.getState().notice).toBeNull();
  });

  it('컬렉션 모드인데 멤버가 1개뿐(모델 불일치)이면 강등 표식을 답변에 인라인으로 단다', async () => {
    seed(true);
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'other-model', 1536)]); // Beta 제외
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('두 문서 핵심?'); });

    expect(M.prompt).toContain('[Alpha.pdf p.2]'); // 활성으로 답변은 됨
    expect(M.prompt).not.toContain('Beta.pdf');
    // M3(UX): 강등을 전역 단일 슬롯 notice 대신 해당 답변 메시지에 실어 인라인 표시.
    const last = useAppStore.getState().qaMessages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', degraded: true });
    expect(useAppStore.getState().notice).toBeNull(); // 더 이상 전역 notice 를 덮어쓰지 않음
  });

  // QA post-v0.31.14 회귀: qaRequestId 를 검색(임베딩) await *이전*에 동기 발급해야 한다.
  // 이전엔 setQaRequestId 가 ragSearch await 이후라, 그 사이 qaRequestId=null 공백에서
  // Stop→재질문 시 stale 핸들러가 새 질문 답변을 가로채던 race. 임베딩을 pending 시켜
  // 그 시점에 이미 qaRequestId 가 세팅돼 있는지 검증한다.
  it('qaRequestId 를 검색 임베딩 await 이전에 동기 발급한다', async () => {
    seed(false); // 단일 문서 경로
    let releaseEmbed!: (v: unknown) => void;
    mockEmbed.mockReturnValue(new Promise((res) => { releaseEmbed = res; })); // 쿼리 임베딩에서 suspend
    const { result } = renderHook(() => useQa());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleAsk('질문');
      await Promise.resolve();
    });
    // 임베딩이 아직 pending 인데 qaRequestId 는 이미 발급됨(소유권 공백 제거).
    expect(useAppStore.getState().qaRequestId).toBe('req-1');
    expect(useAppStore.getState().isQaGenerating).toBe(true);
    // 정리: 해제 후 완료 대기
    await act(async () => { releaseEmbed({ success: true, embeddings: [[1, 0, 0]], model: MODEL }); await pending; });
  });

  // QA post-v0.31.14 회귀: 비-abort 빈 응답이면 user 단독 orphan 대신 placeholder(meta=cancelled)
  // assistant 를 주입해 짝 FIFO 불변식을 유지한다.
  it('비-abort 빈 응답 → orphan user 대신 placeholder(meta=cancelled) 주입', async () => {
    seed(false);
    M.empty = true;
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('질문'); });
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: '질문' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', meta: 'cancelled' });
  });

  it('컬렉션 비활성: 단일 문서 경로 — session.list 미호출, Beta 컨텍스트 없음', async () => {
    seed(false);
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('질문'); });

    expect(mockSessionList).not.toHaveBeenCalled();
    expect(M.prompt).not.toContain('Beta.pdf');
    expect(M.prompt).toContain('[p.2]'); // 단일 문서 인용(문서명 없음)
    expect(useAppStore.getState().qaMessages.at(-1)).toMatchObject({ role: 'assistant' });
  });
});

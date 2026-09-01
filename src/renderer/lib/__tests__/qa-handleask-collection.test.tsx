// @vitest-environment happy-dom

// R46 후속(CI 커버리지): handleAsk 의 컬렉션 글루를 CI 에서 검증.
// 기존 collection.spec.ts(E2E)는 Ollama 의존이라 CI 에서 skip → handleAsk 가 실제로
// resolveCollectionSearch 결과를 컨텍스트로 쓰고 강등 notice 를 띄우는 배선이 무가드였다.
// AiClient/embed/session 을 모킹해 LLM·Ollama 없이 통합 경로를 가드한다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// AiClient 스트리밍 모킹 — summarize 에 전달된 promptText 를 캡처해 컨텍스트 구성 검증.
// QA21: throwAfter — N개 토큰을 방출한 뒤 throw (에러 경로의 짝 복구/부분 보존 검증용).
const M = vi.hoisted(() => ({
  prompt: '', empty: false, onToken: null as null | (() => void),
  throwAfter: null as number | null,
}));
vi.mock('../ai-client', () => ({
  AiClient: class {
    prepareSummarize() { return 'req-1'; }
    // eslint-disable-next-line require-yield
    async *summarize(prompt: string) {
      M.prompt = prompt;
      if (M.empty) return;
      if (M.throwAfter === 0) throw new Error('스트림 중단');
      yield '답변';
      if (M.throwAfter === 1) throw new Error('스트림 중단');
      M.onToken?.(); // 첫 토큰 후 훅 — 테스트에서 스트리밍 도중 소유권 변경 주입
      yield ' 본문';
    }
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
    ragState: { isIndexing: false, progress: null, isAvailable: true, model: MODEL, chunkCount: 1, error: null },
    collection: { enabled: collectionEnabled, memberHashes: ['a'.repeat(64), 'b'.repeat(64)] },
    qaMessages: [], qaStream: '', isGenerating: false, isQaGenerating: false, qaRequestId: null,
    isParsing: false, isTabSwitching: false, isCollectionBusy: false,
    notice: null, error: null,
    settings: { ...useAppStore.getState().settings, provider: 'ollama', enableAnswerVerification: false, persistSessions: false, maxChunkSize: 4000 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  M.prompt = '';
  M.empty = false;
  M.onToken = null;
  M.throwAfter = null;
  mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: MODEL });
  mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), MODEL, 3)]);
  mockSessionLoad.mockResolvedValue(betaBlob());
});
afterEach(() => cleanup());

// QA21(B-MED, 데이터손실+과금): 문서 교체가 예정된 상태(파싱/탭 전환)에서 시작한 질문은
// 교체 시점의 clearQa() 가 화면·디스크 양쪽에서 지운다(직전 persistCurrentSession 은
// isQaGenerating 이라 skip). useSummarize 가 QA20 에서 고친 결함의 정확한 쌍둥이 — 그때
// 요약 버튼만 고치고 Q&A·컬렉션을 함께 훑지 않아 남아 있었다.
describe('handleAsk — 문서 교체 예정 상태 가드 (QA21)', () => {
  it('파싱 중이면 질문을 시작하지 않는다', async () => {
    seed(false);
    useAppStore.setState({ isParsing: true });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('파싱 중 질문'); });

    // 사용자 메시지조차 추가되지 않아야 한다(추가 후 폐기되면 짝 없는 orphan 이 남는다)
    expect(useAppStore.getState().qaMessages).toHaveLength(0);
    expect(useAppStore.getState().isQaGenerating).toBe(false);
    expect(M.prompt).toBe('');
  });

  it('탭 전환 중이면 질문을 시작하지 않는다 (세션-우선 복원 경로)', async () => {
    seed(false);
    useAppStore.setState({ isTabSwitching: true });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('탭 전환 중 질문'); });

    expect(useAppStore.getState().qaMessages).toHaveLength(0);
    expect(useAppStore.getState().isQaGenerating).toBe(false);
    expect(M.prompt).toBe('');
  });
});

// QA21(D-MED, 조용한 오답): RAG 검색이 빈 결과를 내면(임계값 미달 — 정상 인덱스에서도 상시
// 발생) 키워드 폴백으로 내려가는데, 그 컨텍스트에는 `[p.N]` 라벨이 하나도 없었다. 그런데 main 의
// buildPrompt 는 'keywords' 타입만 빼고 인용 규칙을 무조건 주입하고, 그 규칙은 "각 단락은 [p.N]
// 으로 시작합니다 / 거의 모든 문장에 붙이세요" 라고 단언한다 → 모델이 페이지 번호를 지어내고,
// 그 출력은 CitationButton 을 거쳐 정상 인용과 구분되지 않는 클릭 가능 버튼이 된다.
describe('handleAsk — 키워드 폴백 페이지 라벨 (QA21)', () => {
  it('RAG 결과가 없어 키워드 폴백으로 가도 컨텍스트에 [p.N] 라벨이 공급된다', async () => {
    seed(false);
    // 인덱스는 있으나 임계값을 넘는 청크가 없는 상태 = ragSearch null → 키워드 폴백
    useAppStore.setState({
      ragIndex: new VectorStore(),
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
      document: {
        id: 'doc-a', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 3,
        extractedText: '1쪽 본문입니다.\n\n2쪽 본문입니다.\n\n3쪽 본문입니다.',
        pageTexts: ['1쪽 본문입니다.', '2쪽 본문입니다.', '3쪽 본문입니다.'],
        chapters: [], images: [], createdAt: new Date(),
      },
    });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('본문 알려줘'); });

    // 인용 규칙이 요구하는 라벨이 컨텍스트에 실제로 존재해야 한다(없으면 모델은 지어낼 수밖에 없다)
    expect(M.prompt).toContain('[p.1]');
    expect(M.prompt).toContain('[p.2]');
  });

  it('Vision enriched 결과가 있으면 키워드 폴백도 그것을 본다 (요약과의 비대칭 해소)', async () => {
    seed(false);
    useAppStore.setState({
      ragIndex: new VectorStore(),
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
      document: {
        id: 'doc-a', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 2,
        extractedText: '원문만 있습니다.', pageTexts: ['원문만 있습니다.', '2쪽'],
        chapters: [], images: [], createdAt: new Date(),
      },
      // Vision 분석이 채운 enriched 페이지 텍스트
      enrichedPageTexts: ['원문만 있습니다.\n\n[그림 1] 매출 추이 차트 설명', '2쪽'],
    });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('그림 1 설명해줘'); });

    expect(M.prompt).toContain('매출 추이 차트 설명');
  });
});

// QA21(D-MED): 종료 경로 셋 중 **에러만** 짝 불변식을 복구하지 않았다. 짝 없는 user 메시지는
// ①다음 턴 프롬프트에 orphan `Q:` 로 주입되고(pair-skip 은 meta==='cancelled' 만 거른다)
// ②자동저장의 trailing lone-user 제거가 `flush && isQaGenerating` 조건이라 **디스크에 영속**되며
// ③짝수 FIFO drop 이 홀수 배열에서 선두를 assistant 로 만든다. 부분 답변도 abort 와 달리 폐기했다.
describe('handleAsk — 에러 경로 짝 불변식 (QA21)', () => {
  it('생성 중 에러가 나도 assistant 가 추가돼 짝이 유지된다', async () => {
    seed(false);
    M.throwAfter = 0; // 토큰 없이 즉시 throw
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('실패할 질문'); });

    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[1]?.role, '짝 없는 user 가 남으면 안 된다').toBe('assistant');
    expect(msgs[1]?.meta, 'LLM 컨텍스트에선 제외돼야 한다').toBe('cancelled');
    expect(useAppStore.getState().error?.code).toBe('GENERATE_FAIL'); // 배너는 그대로
  });

  it('스트리밍 중 에러면 부분 답변을 보존한다 (abort 와 동일 시맨틱)', async () => {
    seed(false);
    M.throwAfter = 1; // 토큰 1개 방출 후 throw
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('중간에 끊길 질문'); });

    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.role).toBe('assistant');
    expect(msgs[1]?.content, '이미 화면에 나온 부분 답변을 버리면 안 된다').toContain('답변');
    expect(msgs[1]?.meta).toBeUndefined(); // 실제 내용이 있으므로 placeholder 아님
  });
});

// QA21(D-LOW, 조용한 강등): 재빌드 트리거 key 에 임베딩 모델이 없어, 세션 중 모델 구성이 바뀌면
// (우선순위 높은 모델 새로 pull / 쓰던 모델 rm) 인덱스는 옛 모델로 남고 질의만 새 모델로 나간다.
// 차원이 다르면 검색이 항상 빈 결과 → RAG 배지 초록인 채 키워드로 무음 강등, 차원이 같으면
// 의미 없는 유사도로 엉뚱한 청크를 고른다. 표면화가 최소 조치.
describe('ragSearch — 임베딩 모델 변경 표면화 (QA21)', () => {
  it('질의 모델이 인덱스 모델과 다르면 ragState.error 로 고지하고 검색을 쓰지 않는다', async () => {
    seed(false); // 활성 인덱스 모델 = nomic-embed-text
    // 세션 중 임베딩 모델이 바뀐 상황 — ai:embed 가 다른 모델명을 반환
    mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: 'mxbai-embed-large' });

    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('인덱스 청크에만 있는 내용?'); });

    expect(useAppStore.getState().ragState.error).toBe('embedModelChanged');
    // 인덱스 청크가 컨텍스트로 쓰이지 않았다(무의미한 유사도로 고른 청크를 근거로 쓰지 않는다)
    expect(M.prompt).not.toContain('활성 ALPHA 본문');
  });

  it('모델이 같으면 정상 검색 — 오탐하지 않는다', async () => {
    seed(false);
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('핵심 알려줘'); });

    expect(useAppStore.getState().ragState.error).toBeNull();
    expect(M.prompt).toContain('활성 ALPHA 본문');
  });

  it('모델명이 확인되지 않으면(undefined) 비교하지 않는다 — 오탐 방지', async () => {
    seed(false);
    mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]] }); // model 없음
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('핵심 알려줘'); });

    expect(useAppStore.getState().ragState.error).toBeNull();
    expect(M.prompt).toContain('활성 ALPHA 본문');
  });
});

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

  // QA post-v0.31.15(테스트 메타감사 MED-1): qaRequestId 동기발급뿐 아니라 stillOwns() 스트림
  // 루프 가드 자체를 검증. 스트리밍 도중 소유권(qaRequestId)이 바뀌면 이후 토큰을 qaStream 에
  // append 하지 않아야 한다(루프 가드가 isQaGenerating 로 회귀하면 이 테스트가 실패).
  it('스트리밍 도중 소유권 변경 → 이후 토큰 append 중단 + assistant 미커밋 (mechanism)', async () => {
    seed(false); // fast path (verification off)
    M.onToken = () => useAppStore.setState({ qaRequestId: 'other-req', isQaGenerating: true });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('질문'); });

    // 소유권 상실 → assistant 답변 미커밋(마지막 메시지는 user).
    expect(useAppStore.getState().qaMessages.at(-1)?.role).toBe('user');
    // 소유권 상실 후 토큰(' 본문')은 stillOwns() 가드로 append 되지 않음.
    useAppStore.getState().flushQaStream();
    expect(useAppStore.getState().qaStream).not.toContain('본문');
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

// ─────────────────────────────────────────────────────────────────────────────
// QA30(B-2): **컬렉션 Q&A 는 overlap tail 을 떼지 않았다** — QA29(B-6)의 형제 누락.
//
// 단일 문서 경로는 `r.text.slice(r.bodyOffset)` 로 tail 을 뗐지만, 컬렉션은 tail 을 포함한
// 원문에 `[문서명 p.N]` 라벨을 붙였다(그 전에 `CollectionSearchResult` 에는 bodyOffset 필드
// 자체가 없었다). tail 은 **직전 청크에서 복사해 온 이전 페이지 본문**이므로, 모델이 그 문장을
// 근거로 답하면 docName 이 열린 탭과 일치하는 **클릭되는 교차 문서 인용**이 되고 클릭하면 한
// 페이지 뒤로 간다. 컬렉션 모드에서는 모든 답변이 항상 이 경로다.
//
// 이 스펙은 **실제 검색 경로를 구동**해 프롬프트 문자열을 검사한다 — 규칙을 테스트 안에 복제한
// 동어반복(qa-core 의 종전 buildSegment)으로는 프로덕션 배선이 빠져도 초록이었다.
// ─────────────────────────────────────────────────────────────────────────────
describe('overlap tail 이 라벨 붙은 세그먼트에 실리지 않는다 (QA30 B-2)', () => {
  const ALPHA_TAIL = 'ALPHATAIL 앞 페이지에서 넘어온 꼬리 문장입니다. ';
  const BETA_TAIL = 'BETATAIL 앞 페이지에서 넘어온 꼬리 문장입니다. ';

  function activeWithTail(): VectorStore {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    vs.addChunk(`${ALPHA_TAIL}ALPHABODY 활성 문서 2쪽 본문`, [1, 0, 0], 0,
      { pageStart: 2, pageEnd: 2, bodyOffset: ALPHA_TAIL.length });
    return vs;
  }

  function betaBlobWithTail() {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    vs.addChunk(`${BETA_TAIL}BETABODY 비활성 멤버 7쪽 본문`, [0.9, 0.1, 0], 0,
      { pageStart: 7, pageEnd: 7, bodyOffset: BETA_TAIL.length });
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

  it('픽스처 자기검증: tail 이 실제로 인덱스 안에 있고 사이드카 왕복에서도 보존된다', () => {
    const hit = activeWithTail().search([1, 0, 0], 1, 0)[0]!;
    expect(hit.text).toContain('ALPHATAIL');           // 검색 recall 용으로는 tail 이 남아 있어야 하고
    expect(hit.bodyOffset).toBe(ALPHA_TAIL.length);    // bodyOffset 이 공허한 0/undefined 가 아니다
    // 비활성 멤버는 index.bin 왕복을 거치므로 bodyOffset 이 직렬화/복원을 통과해야 의미가 있다.
    const restored = VectorStore.restore({
      model: MODEL, dimension: 3,
      chunkMeta: betaBlobWithTail().session.chunkMeta,
      buffer: betaBlobWithTail().blob,
    });
    expect(restored.search([0.9, 0.1, 0], 1, 0)[0]!.bodyOffset).toBe(BETA_TAIL.length);
  });

  it('단일 문서 경로: [p.N] 아래에 tail 문장이 실리지 않는다 (QA29 배선 회귀)', async () => {
    seed(false);
    useAppStore.setState({ ragIndex: activeWithTail() });
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('2쪽 내용?'); });

    expect(M.prompt).toContain('[p.2]');
    expect(M.prompt).toContain('ALPHABODY');            // 근거 본문은 들어가고
    expect(M.prompt).not.toContain('ALPHATAIL');        // 이전 페이지 꼬리는 빠진다
  });

  it('컬렉션 경로: [문서명 p.N] 세그먼트도 tail 을 떼어낸다 (형제 누락)', async () => {
    seed(true);
    useAppStore.setState({ ragIndex: activeWithTail() });
    mockSessionLoad.mockResolvedValue(betaBlobWithTail());
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('두 문서 핵심?'); });

    expect(M.prompt).toContain('[Alpha.pdf p.2]');
    expect(M.prompt).toContain('[Beta.pdf p.7]');
    expect(M.prompt).toContain('ALPHABODY');
    expect(M.prompt).toContain('BETABODY');
    expect(M.prompt, '활성 문서 청크의 tail 이 남았다').not.toContain('ALPHATAIL');
    expect(M.prompt, '비활성 멤버 청크의 tail 이 남았다 — 컬렉션 경로 미수정').not.toContain('BETATAIL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA30(B-3): 예산에 밀려 **한 글자도 기여하지 못한 문서**를 고지한다.
//
// QA21 은 멤버 수 잘림(MAX_COLLECTION_MEMBERS)만 degraded 로 고지했고, 컨텍스트 예산에 의한
// 청크 잘림에는 고지 경로가 없었다. mergeSearchResults 는 점수 내림차순이라 채택분이 한 문서에
// 몰릴 수 있고, 그러면 CollectionBar 는 "N개 문서에서 검색" 을 계속 표시하는데 실제 답변은 그중
// 하나만 보고 쓴 것이 된다.
// ─────────────────────────────────────────────────────────────────────────────
describe('예산에 밀려 기여하지 못한 멤버를 강등으로 고지한다 (QA30 B-3)', () => {
  /** 활성 문서 하나가 컨텍스트 예산(8,000자)을 거의 다 먹는 상황 */
  function hugeActiveIndex(): VectorStore {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    vs.addChunk(`ALPHAHUGE ${'a'.repeat(7700)}`, [1, 0, 0], 0, { pageStart: 2, pageEnd: 2 });
    return vs;
  }
  function betaChunkBlob() {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    vs.addChunk(`BETAEVIDENCE ${'b'.repeat(500)}`, [0.9, 0.1, 0], 0, { pageStart: 7, pageEnd: 7 });
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

  it('검색에는 참여했지만 컨텍스트에 못 들어간 멤버가 있으면 degraded 표식을 단다', async () => {
    seed(true);
    useAppStore.setState({ ragIndex: hugeActiveIndex() });
    mockSessionLoad.mockResolvedValue(betaChunkBlob());
    const { result } = renderHook(() => useQa());
    await act(async () => { await result.current.handleAsk('두 문서 핵심?'); });

    // 픽스처 자기검증: 활성 문서는 들어갔고 Beta 는 예산에 밀려 통째로 빠졌다.
    expect(M.prompt).toContain('ALPHAHUGE');
    expect(M.prompt, '픽스처가 예산을 넘기지 못했다 — 이 스펙이 공허해진다').not.toContain('BETAEVIDENCE');
    // 두 멤버 모두 index 로드에는 성공했으므로 종전 강등 조건(stores.length)으로는 잡히지 않는다.
    const last = useAppStore.getState().qaMessages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', degraded: true });
  });
});

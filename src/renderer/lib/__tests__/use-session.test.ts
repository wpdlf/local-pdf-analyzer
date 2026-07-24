import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PdfDocument, PersistedSession } from '../../types';

// store.ts 는 import 시 localStorage 를 읽으므로 먼저 stub. window.electronAPI 는 session/ai 만.
const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
const api = {
  session: { load: vi.fn(), loadMeta: vi.fn(), save: vi.fn((_payload: unknown) => Promise.resolve({ ok: true })), savePartial: vi.fn((_payload: unknown) => Promise.resolve({ ok: true })) },
  ai: { checkEmbedModel: vi.fn(() => Promise.resolve({ available: true, model: 'nomic-embed-text' })), abort: vi.fn(() => Promise.resolve()) },
  settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
};
vi.stubGlobal('window', { electronAPI: api });
// crypto.subtle(SHA-256) 은 실제 구현을 보존하고 randomUUID 만 결정적으로 덮어쓴다.
// (spread 는 prototype getter 인 subtle 을 복사하지 못하므로 명시적으로 참조)
const realSubtle = globalThis.crypto.subtle;
vi.stubGlobal('crypto', { subtle: realSubtle, randomUUID: () => 'test-uuid' });

import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';
import { restoreSessionForDocument, persistCurrentSession } from '../use-session';

const HEX = /^[a-f0-9]{64}$/;

function makeDoc(id = 'doc-1'): PdfDocument {
  return {
    id, fileName: 'lecture.pdf', filePath: '/x/lecture.pdf', pageCount: 5,
    extractedText: '본문 텍스트 콘텐츠 ' + id, pageTexts: ['p1', 'p2'], chapters: [],
    images: [], createdAt: new Date(),
  };
}

/** 유효한 직렬화 인덱스(blob+meta) 를 만든다. */
function makeIndexFixture() {
  const vs = new VectorStore();
  vs.setModel('nomic-embed-text');
  vs.addChunk('chunk one', [1, 0, 0], 0, { pageStart: 1, pageEnd: 1 });
  vs.addChunk('chunk two', [0, 1, 0], 1, { pageStart: 2, pageEnd: 2 });
  return vs.serialize();
}

function persistedSession(doc: PdfDocument, withIndex: boolean): { session: PersistedSession; blob: ArrayBuffer | null } {
  const idx = withIndex ? makeIndexFixture() : null;
  const session: PersistedSession = {
    schemaVersion: 1,
    docHash: 'PLACEHOLDER', // 실제 해시는 테스트에서 주입
    fileName: doc.fileName, filePath: doc.filePath, pageCount: doc.pageCount,
    extractedText: doc.extractedText, pageTexts: doc.pageTexts, chapters: doc.chapters,
    summaries: { full: { content: '복원된 요약', model: 'gemma3', provider: 'ollama' } },
    summaryType: 'full',
    qaMessages: [
      { id: 'q1', role: 'user', content: '질문?' },
      { id: 'a1', role: 'assistant', content: '답변.' },
    ],
    embedModel: idx ? idx.model : null,
    embedDim: idx ? idx.dimension : null,
    chunkMeta: idx ? idx.chunkMeta : [],
  };
  return { session, blob: idx ? idx.buffer : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.session.save.mockResolvedValue({ ok: true });
  api.session.savePartial.mockResolvedValue({ ok: true });
  api.session.loadMeta.mockResolvedValue(null); // 비-인덱싱 머지 경로 기본값(본문만 로드)
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  // store 초기화
  useAppStore.setState({
    document: null, summary: null, summaryStream: '', qaMessages: [],
    isGenerating: false, isQaGenerating: false, sessionRestorePending: false,
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    settings: { ...useAppStore.getState().settings, persistSessions: true, provider: 'ollama' },
  });
});

describe('restoreSessionForDocument (module-3)', () => {
  it('hit + 모델 일치 → 요약·Q&A·인덱스 복원 + 게이트 해제 + 마커 설정 (재임베딩 0)', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    const fixture = persistedSession(doc, true);
    // load 가 받는 해시로 session.docHash 를 맞춘다
    api.session.load.mockImplementation(async (hash: string) => {
      fixture.session.docHash = hash;
      return fixture;
    });

    await restoreSessionForDocument(doc);

    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('복원된 요약');
    expect(s.summaryStream).toBe('복원된 요약');
    expect(s.qaMessages).toHaveLength(2);
    expect(s.ragState.isAvailable).toBe(true);
    expect(s.ragState.chunkCount).toBe(2);
    expect(s.ragIndex.size).toBe(2);
    expect(s.restoredSession).toEqual({ docId: 'doc-1', provider: 'ollama', embedModel: 'nomic-embed-text' });
    expect(s.sessionRestorePending).toBe(false);
    // load 가 64-hex 해시로 호출됨
    expect(api.session.load.mock.calls[0]![0]).toMatch(HEX);
  });

  it('miss(null) → 게이트만 해제, 복원 없음', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockResolvedValue(null);

    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary).toBeNull();
    expect(s.qaMessages).toHaveLength(0);
    expect(s.sessionRestorePending).toBe(false);
    expect(s.restoredSession).toBeNull();
  });

  // QA6-B: 수기 편집/parseable 손상 세션 — 비문자열 summary content 는 복원 skip,
  // qaMessages 는 role/content 유효 항목만 주입(다음 턴 formatHistory→sanitizePromptInput
  // 이 비문자열 content 에서 TypeError 로 턴을 실패시키는 것 방지).
  it('손상 본문 정규화 — 비문자열 summary content 미복원 + 무효 qaMessages 항목 필터', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    const fixture = persistedSession(doc, false);
    (fixture.session.summaries as Record<string, unknown>).full = { content: 12345, model: 'm', provider: 'ollama' };
    fixture.session.qaMessages = [
      { id: 'q1', role: 'user', content: '질문?' },
      { id: 'bad1', role: 'user', content: 123 },      // 비문자열 content → 제외
      null,                                            // 항목 자체 손상 → 제외
      { id: 'bad2', role: 'system', content: 'x' },    // 무효 role → 제외
      { id: 'a1', role: 'assistant', content: '답변.' },
    ] as unknown as PersistedSession['qaMessages'];
    api.session.load.mockImplementation(async (hash: string) => {
      fixture.session.docHash = hash;
      return fixture;
    });

    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary).toBeNull();       // 비문자열 content → 복원 안 함(크래시/오염 대신 재계산)
    expect(s.summaryStream).toBe('');
    expect(s.qaMessages.map((m) => m.id)).toEqual(['q1', 'a1']); // 유효 항목만 주입
  });

  it('persistSessions=false → load 미호출, 게이트 해제', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true, settings: { ...useAppStore.getState().settings, persistSessions: false } });
    await restoreSessionForDocument(doc);
    expect(api.session.load).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionRestorePending).toBe(false);
  });

  // QA11 MED-2: 계약 변경. 이전엔 schemaVersion 불일치 시 통째로 early-return 했는데, 그러면
  // 게이트가 열린 직후 자동저장이 빈 qaMessages 로 디스크 세션을 덮어써 **재계산 불가능한 Q&A
  // 대화가 조용히 소실**된다(요약은 loadMeta 머지가 보존하지만 qaMessages 는 머지 대상이 아님).
  // 이제 파생 필드(인덱스)만 버리고 사용자 데이터는 살린다 = read-old/write-new 마이그레이션.
  it('schemaVersion 불일치 → 요약·Q&A 는 살리고 인덱스만 미채택(재빌드)', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, true);
      f.session.docHash = hash;
      f.session.schemaVersion = 999;
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    // 재계산 불가능한 사용자 데이터는 보존
    expect(s.summary?.content).toBe('복원된 요약');
    expect(s.qaMessages).toHaveLength(2);
    // 포맷을 신뢰할 수 없는 파생 필드는 폐기 → useRagBuilder 가 재빌드
    expect(s.ragState.isAvailable).toBe(false);
    expect(s.ragIndex.size).toBe(0);
    expect(s.restoredSession).toBeNull();
    expect(s.sessionRestorePending).toBe(false);
  });

  it('schemaVersion 불일치라도 인덱스 복원 경로를 타지 않는다 (checkEmbedModel 미호출)', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, true);
      f.session.docHash = hash;
      f.session.schemaVersion = 2;
      return f;
    });
    await restoreSessionForDocument(doc);
    expect(api.ai.checkEmbedModel).not.toHaveBeenCalled();
  });

  it('docHash 불일치(다른 문서) → 아무것도 복원하지 않음', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async () => {
      const f = persistedSession(doc, true);
      f.session.docHash = 'f'.repeat(64); // 요청 해시와 다름
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary).toBeNull();
    expect(s.qaMessages).toHaveLength(0);
    expect(s.sessionRestorePending).toBe(false);
  });

  it('임베딩 모델 불일치 → 인덱스 미복원(요약·Q&A 는 복원), 마커 없음', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, true);
      f.session.docHash = hash;
      return f;
    });
    api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'other-model' });

    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('복원된 요약'); // 요약은 복원
    expect(s.ragState.isAvailable).toBe(false);     // 인덱스는 미복원
    expect(s.restoredSession).toBeNull();
    expect(s.sessionRestorePending).toBe(false);
  });

  // C5-M2(QA cycle5): 복원 결정(api.load) in-flight 동안 생성이 시작되면 덮어쓰기 금지.
  // 이전엔 문서 정체성만 검사해 in-flight 요약 위로 옛 본문이 주입 → "옛+새 연결본" 영속화.
  it('C5-M2: 복원 도중 요약 생성 시작 → 요약/스트림 미덮어쓰기(Q&A 는 복원)', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, false);
      f.session.docHash = hash;
      // load in-flight 사이 사용자가 요약 시작 (handleSummarize 는 sessionRestorePending 을 안 봄)
      useAppStore.setState({ isGenerating: true, summaryStream: '새 요약 스트리밍 중' });
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summaryStream).toBe('새 요약 스트리밍 중'); // replaceSummaryStream 미주입
    expect(s.summary).toBeNull();                        // setSummary 미호출
    expect(s.qaMessages).toHaveLength(2);                // Q&A 는 유휴 — 정상 복원
    expect(s.sessionRestorePending).toBe(false);         // 게이트는 해제
  });

  it('C5-M2: 복원 도중 Q&A 생성 시작 → qaMessages 미덮어쓰기(요약은 복원)', async () => {
    const doc = makeDoc();
    const liveMsg = { id: 'live', role: 'user' as const, content: '진행 중 질문' };
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, false);
      f.session.docHash = hash;
      useAppStore.setState({ isQaGenerating: true, qaMessages: [liveMsg] });
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.qaMessages).toEqual([liveMsg]);             // setQaMessages 미호출
    expect(s.summary?.content).toBe('복원된 요약');       // 요약은 유휴 — 정상 복원
    expect(s.sessionRestorePending).toBe(false);
  });

  it('복원 도중 다른 문서로 교체되면 아무것도 건드리지 않음(레이스 가드)', async () => {
    const doc = makeDoc('doc-1');
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async () => {
      // load 사이에 다른 문서로 교체
      useAppStore.setState({ document: makeDoc('doc-2') });
      return persistedSession(doc, false);
    });
    await restoreSessionForDocument(doc);
    // doc-2 의 게이트(true)를 doc-1 복원이 건드리지 않음
    expect(useAppStore.getState().sessionRestorePending).toBe(true);
    expect(useAppStore.getState().summary).toBeNull();
  });
});

describe('persistCurrentSession (module-3)', () => {
  it('요약+Q&A+인덱스를 session.save 로 저장 (meta·blob 포함)', async () => {
    const doc = makeDoc();
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({
      document: doc,
      summary: { id: 's', documentId: doc.id, type: 'full', content: '저장할 요약', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: '저장할 요약',
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: vs,
    });
    api.session.load.mockResolvedValue(null); // 머지용 기존 없음

    await persistCurrentSession();

    expect(api.session.save).toHaveBeenCalledTimes(1);
    const payload = api.session.save.mock.calls[0]![0] as { meta: { docHash: string; chunkCount: number }; session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.meta.docHash).toMatch(HEX);
    expect(payload.meta.chunkCount).toBe(2);
    expect(payload.session.summaries.full?.content).toBe('저장할 요약');
    expect(payload.session.qaMessages).toHaveLength(1);
    expect(payload.blob).not.toBeNull();
  });

  it('P1: 같은 문서 반복 저장 시 docHash 를 1회만 계산(캐시)하고 결과는 동일', async () => {
    // 고유 doc.id — 모듈 캐시가 다른 테스트로 오염되지 않도록.
    const doc = makeDoc('p1-cache-doc');
    useAppStore.setState({ document: doc, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    api.session.load.mockResolvedValue(null);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    await persistCurrentSession();
    await persistCurrentSession();
    // 두 번째 저장은 캐시 히트 → SHA-256 재계산(digest) 없음
    expect(digestSpy).toHaveBeenCalledTimes(1);
    const calls = api.session.save.mock.calls as unknown as Array<[{ meta: { docHash: string } }]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].meta.docHash).toBe(calls[1]![0].meta.docHash); // 동일 해시
    expect(calls[0]![0].meta.docHash).toMatch(HEX);
    digestSpy.mockRestore();
  });

  it('성능: 일반 자동저장은 loadMeta(본문만) 로 머지 — load(blob 포함) 미사용', async () => {
    const doc = makeDoc('loadmeta-doc');
    useAppStore.setState({ document: doc, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    await persistCurrentSession(); // ragState.isIndexing=false → 비-인덱싱 경로
    expect(api.session.loadMeta).toHaveBeenCalledWith(expect.stringMatching(HEX));
    expect(api.session.load).not.toHaveBeenCalled();
  });

  it('E3: 연속 저장 실패가 임계치(3회) 넘으면 1회 notice, 성공 시 리셋', async () => {
    const doc = makeDoc('e3-doc');
    useAppStore.setState({ document: doc, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore(), notice: null });
    api.session.load.mockResolvedValue(null);
    // 성공 1회로 카운터/통지 플래그 리셋(이전 테스트 잔여 차단)
    api.session.save.mockResolvedValue({ ok: true });
    await persistCurrentSession();
    expect(useAppStore.getState().notice).toBeNull();
    // 연속 실패 — 3회째에만 통지
    api.session.save.mockResolvedValue({ ok: false });
    await persistCurrentSession();
    await persistCurrentSession();
    expect(useAppStore.getState().notice).toBeNull(); // 2회까진 무통지
    await persistCurrentSession();
    expect(useAppStore.getState().notice?.message).toBeTruthy(); // 3회째 통지
    // 성공하면 리셋 — 이후 다시 3회 실패해야 재통지
    useAppStore.setState({ notice: null });
    api.session.save.mockResolvedValue({ ok: true });
    await persistCurrentSession();
    api.session.save.mockResolvedValue({ ok: false });
    await persistCurrentSession();
    await persistCurrentSession();
    expect(useAppStore.getState().notice).toBeNull(); // 리셋 후 2회 — 아직
    await persistCurrentSession();
    expect(useAppStore.getState().notice?.message).toBeTruthy(); // 3회째 재통지
  });

  it('생성 중이면 저장 skip', async () => {
    useAppStore.setState({ document: makeDoc(), isGenerating: true });
    await persistCurrentSession();
    expect(api.session.save).not.toHaveBeenCalled();
  });

  // QA12(B-MED): 종료/새로고침 flush 경로는 생성 중이라도 이미 커밋된 데이터를 committed-only 로 저장.
  // 요약 완료 직후 후속 질문(isQaGenerating) → 종료 시 완성 요약이 소실되던 창을 제거한다.
  it('flush 경로: Q&A 생성 중에도 완성 요약 저장 + trailing lone-user 제거', async () => {
    const doc = makeDoc('flush-qa-doc');
    useAppStore.setState({
      document: doc,
      summary: { id: 's', documentId: doc.id, type: 'full', content: '완성 요약', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: '완성 요약',
      qaMessages: [
        { id: 'q1', role: 'user', content: '질문1' },
        { id: 'a1', role: 'assistant', content: '답변1' },
        { id: 'q2', role: 'user', content: '스트리밍 중 질문' }, // 짝 없는 trailing user
      ],
      isQaGenerating: true,
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession(true); // flush=true

    expect(api.session.save).toHaveBeenCalledTimes(1);
    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.summaries.full?.content).toBe('완성 요약'); // 완성 요약 영속
    expect(payload.session.qaMessages).toHaveLength(2); // trailing lone-user 제거
    expect(payload.session.qaMessages.at(-1)?.role).toBe('assistant');
  });

  it('디바운스(non-flush) 경로는 Q&A 생성 중 여전히 skip', async () => {
    useAppStore.setState({ document: makeDoc('debounce-qa-doc'), isQaGenerating: true });
    await persistCurrentSession(); // flush 인자 없음
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('flush 경로: 요약 재생성 중이면 부분 스트림이 아닌 직전 완성본(summary.content)을 저장', async () => {
    const doc = makeDoc('flush-resummary-doc');
    useAppStore.setState({
      document: doc,
      summary: { id: 's', documentId: doc.id, type: 'full', content: '이전 완성본', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: '새 부분 스트림', // 재요약 진행 중 성장하는 partial
      qaMessages: [],
      isGenerating: true,
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession(true); // flush=true

    expect(api.session.save).toHaveBeenCalledTimes(1);
    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    // 부분 스트림이 완성본을 덮어쓰면 안 된다 — 커밋된 '이전 완성본' 보존
    expect(payload.session.summaries.full?.content).toBe('이전 완성본');
  });

  it('persistSessions=false 면 저장 skip', async () => {
    useAppStore.setState({ document: makeDoc(), settings: { ...useAppStore.getState().settings, persistSessions: false } });
    await persistCurrentSession();
    expect(api.session.save).not.toHaveBeenCalled();
  });

  // multi-doc Phase 1 사용자 버그 계약: 인덱싱 중 flush 는 전체 skip 이 아니라
  // 부분 인덱스만 제외하고 저장한다 — 탭 전환/새 탭(+)이 인덱싱 타이밍과 겹쳐도
  // 텍스트·요약·Q&A 세션은 디스크에 남아 드롭 탭의 fallback 전환이 가능해야 한다.
  it('인덱싱 중 flush → 부분 인덱스 제외(blob=null, embedModel=null)하되 세션은 저장', async () => {
    const doc = makeDoc();
    const partial = VectorStore.restore(makeIndexFixture()); // 빌드 중간의 부분 청크 시뮬레이션
    useAppStore.setState({
      document: doc,
      summaryStream: '',
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: partial,
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: 'nomic-embed-text', chunkCount: 1, error: null },
    });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession();

    expect(api.session.save).toHaveBeenCalledTimes(1);
    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null; meta: { chunkCount: number } };
    expect(payload.session.extractedText).toBe(doc.extractedText); // 세션 본체는 저장
    expect(payload.session.embedModel).toBeNull(); // 부분 인덱스 미영속화 (R43 I-2 유지)
    expect(payload.session.chunkMeta).toEqual([]);
    expect(payload.blob).toBeNull();
    expect(payload.meta.chunkCount).toBe(0);
  });

  it('인덱싱 중 flush + 디스크에 완전한 기존 인덱스 → 기존 인덱스 보존 (재임베딩 0 유지)', async () => {
    const doc = makeDoc();
    const existing = persistedSession(doc, true); // 디스크의 완전한 세션(인덱스 포함)
    useAppStore.setState({
      document: doc,
      summaryStream: '',
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: new VectorStore(), // 재빌드 시작 직후 — 메모리 인덱스는 비어 있음
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    });
    api.session.load.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.session.embedModel).toBe('nomic-embed-text'); // 기존 인덱스 유지
    expect(payload.session.chunkMeta).toHaveLength(2);
    expect(payload.blob).toBe(existing.blob); // 기존 블롭 그대로
  });

  // QA19(C-MED, 데이터손실): RAG 빌드가 네트워크 단절로 실패하면 use-qa 가 메모리 인덱스를
  // clear(부분 저장 방지)하고 ragState.error 를 세운다. 이때 자동저장이 "인덱스 없음"으로
  // blob=null 저장하면 main 이 디스크의 이전 정상 index.bin 을 unlink 해 재임베딩을 강제했다.
  // error 상태에서도 인덱싱 중과 동일하게 디스크 인덱스를 보존해야 한다.
  it('빌드 실패(ragState.error) flush → 디스크 인덱스 보존(unlink 방지)', async () => {
    const doc = makeDoc();
    const existing = persistedSession(doc, true); // 디스크의 완전한 세션(인덱스 포함)
    useAppStore.setState({
      document: doc,
      summaryStream: '',
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: new VectorStore(), // 실패 후 clear 되어 비어 있음
      // isIndexing:false + error 세팅 = 빌드 실패로 끝난 상태
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: 'embedFailed' },
    });
    api.session.load.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.session.embedModel).toBe('nomic-embed-text'); // 기존 인덱스 유지
    expect(payload.session.chunkMeta).toHaveLength(2);
    expect(payload.blob).toBe(existing.blob); // 기존 블롭 그대로 — unlink 방지
  });

  it('인덱스 없으면 blob=null 로 저장', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc,
      summary: { id: 's', documentId: doc.id, type: 'full', content: 'x', model: 'm', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: 'x',
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(null);
    await persistCurrentSession();
    const payload = api.session.save.mock.calls[0]![0] as { blob: ArrayBuffer | null; meta: { chunkCount: number } };
    expect(payload.blob).toBeNull();
    expect(payload.meta.chunkCount).toBe(0);
  });
});

// serialize-skip(자동저장 비용↓): 인덱스가 직전 영속화 이후 무변경이면 blob 재직렬화/재전송/
// index.bin 재기록을 생략. instance+revision 시그니처로 변경을 판정. 무변경이면 부분저장
// (savePartial: qa/summary delta 만)으로 전환 → 불변 본문 IPC 도 생략.
type SavePayload = {
  meta: { chunkCount: number };
  session: PersistedSession;
  blob: ArrayBuffer | null;
  keepIndex?: boolean;
};
type PartialPayload = {
  docHash: string;
  summary: { type: string; content: string } | null;
  summaryType: string;
  qaMessages: { id: string }[];
};
describe('persistCurrentSession serialize-skip + 부분저장 (Tier2/3)', () => {
  const summaryState = (doc: PdfDocument, content: string) => ({
    summary: { id: 's', documentId: doc.id, type: 'full' as const, content, model: 'm', provider: 'ollama' as const, createdAt: new Date(), durationMs: 1 },
    summaryStream: content,
  });

  it('인덱스 무변경 시 2번째 저장은 부분저장(savePartial)으로 — 전체 save 미호출·본문 미전송', async () => {
    const doc = makeDoc('skip-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, '요약'), qaMessages: [{ id: 'q', role: 'user', content: 'q' }], ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    // 1번째: 전체 blob 기록 + 시그니처 등록 (save, savePartial 아님)
    await persistCurrentSession();
    expect(api.session.save).toHaveBeenCalledTimes(1);
    expect(api.session.savePartial).not.toHaveBeenCalled();
    const first = api.session.save.mock.calls[0]![0] as SavePayload;
    expect(first.blob).not.toBeNull();

    // 2번째: 인덱스 무변경, Q&A만 추가 → 부분저장(delta 만)
    useAppStore.setState({ qaMessages: [{ id: 'q', role: 'user', content: 'q' }, { id: 'q2', role: 'user', content: 'q2' }] });
    await persistCurrentSession();
    expect(api.session.save).toHaveBeenCalledTimes(1);        // 전체 save 추가 호출 없음
    expect(api.session.savePartial).toHaveBeenCalledTimes(1);
    const partial = api.session.savePartial.mock.calls[0]![0] as PartialPayload;
    expect(partial.qaMessages).toHaveLength(2);               // 변하는 본문(delta)
    expect(partial.summary?.content).toBe('요약');
    expect(partial.summaryType).toBe('full');
    expect(partial).not.toHaveProperty('session');           // 불변 본문 미전송
    expect(partial).not.toHaveProperty('blob');
  });

  // QA13(A-LOW): flush 경로 committed-only 정규화(summaryContentToPersist/safeQaMessages)는
  // 전체저장뿐 아니라 savePartial fast-path 에서도 동일 적용된다. Q&A 생성 중 flush 부분저장이
  // 완성요약을 유지하고 trailing lone-user 를 제거하는지 가드(QA12 코드가 두 경로에서 대칭).
  it('flush 부분저장(fast-path): Q&A 생성 중에도 완성요약 유지 + trailing lone-user 제거', async () => {
    const doc = makeDoc('flush-partial-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, '완성 요약'), qaMessages: [{ id: 'q', role: 'user', content: 'q' }, { id: 'a', role: 'assistant', content: 'a' }], ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    // 1번째 전체 저장 → 인덱스 시그니처 등록(이후 무변경 인덱스는 fast-path)
    await persistCurrentSession();
    expect(api.session.save).toHaveBeenCalledTimes(1);

    // Q&A 생성 시작 + 짝 없는 trailing user, 인덱스 무변경 → flush 부분저장 경로
    useAppStore.setState({
      isQaGenerating: true,
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }, { id: 'a', role: 'assistant', content: 'a' }, { id: 'q2', role: 'user', content: '스트리밍 중' }],
    });
    await persistCurrentSession(true); // flush=true

    expect(api.session.savePartial).toHaveBeenCalledTimes(1);
    const partial = api.session.savePartial.mock.calls[0]![0] as PartialPayload;
    expect(partial.summary?.content).toBe('완성 요약'); // 완성 요약 유지
    expect(partial.qaMessages).toHaveLength(2);          // trailing lone-user 제거
  });

  it('인덱스가 바뀌면(revision↑) 부분저장이 아니라 전체 blob 전송', async () => {
    const doc = makeDoc('change-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, 's'), ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    await persistCurrentSession(); // 등록 (chunkCount 2)
    vs.addChunk('new chunk', [0, 0, 1], 2, { pageStart: 3, pageEnd: 3 }); // revision↑

    await persistCurrentSession();
    expect(api.session.savePartial).not.toHaveBeenCalled();
    const second = api.session.save.mock.calls[1]![0] as SavePayload;
    expect(second.keepIndex).toBeFalsy();
    expect(second.blob).not.toBeNull();
    expect(second.meta.chunkCount).toBe(3);
  });

  it('QA: 머지 read 가 실제 I/O 오류면 저장 건너뜀(파괴적 덮어쓰기 대신 디스크 보존)', async () => {
    const doc = makeDoc('io-fail-doc');
    useAppStore.setState({ document: doc, ...summaryState(doc, 's'), qaMessages: [], ragIndex: new VectorStore() });
    // loadMeta(비-인덱싱 머지 경로)가 throw → 타 타입 요약 소실 방지 위해 저장 건너뜀
    api.session.loadMeta.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    api.session.load.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    await persistCurrentSession();

    expect(api.session.save).not.toHaveBeenCalled();
    expect(api.session.savePartial).not.toHaveBeenCalled();
  });

  it('QA: 인덱싱 중 머지 read I/O 오류 → 저장 건너뜀(기존 index.bin 보존)', async () => {
    const doc = makeDoc('io-fail-indexing');
    useAppStore.setState({
      document: doc, summaryStream: '', qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: new VectorStore(),
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: 'nomic-embed-text', chunkCount: 1, error: null },
    });
    api.session.load.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    await persistCurrentSession();

    expect(api.session.save).not.toHaveBeenCalled(); // index.bin unlink 회귀 방지
  });

  it('복원 직후 첫 자동저장은 부분저장 (디스크 일치, index.bin·본문 재전송 회피)', async () => {
    const doc = makeDoc('restore-skip-doc');
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    const fixture = persistedSession(doc, true);
    api.session.load.mockImplementation(async (hash: string) => { fixture.session.docHash = hash; return fixture; });

    await restoreSessionForDocument(doc); // ragIndex 복원 + baseline 시그니처 등록

    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);
    useAppStore.setState({ ...summaryState(doc, '요약 변경') });
    await persistCurrentSession();

    expect(api.session.savePartial).toHaveBeenCalledTimes(1);
    expect(api.session.save).not.toHaveBeenCalled();
    const partial = api.session.savePartial.mock.calls[0]![0] as PartialPayload;
    expect(partial.summary?.content).toBe('요약 변경');
  });

  it('부분저장 실패(디스크 세션 부재) → 전체 저장으로 폴백·인덱스 재생성(blob)', async () => {
    const doc = makeDoc('partial-fail-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, 's'), ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    await persistCurrentSession(); // 전체 저장 + 시그니처 등록
    expect(api.session.save).toHaveBeenCalledTimes(1);

    // 디스크 세션이 사라진 상황 시뮬레이션 — 부분저장이 ok:false
    api.session.savePartial.mockResolvedValue({ ok: false });
    await persistCurrentSession();

    expect(api.session.savePartial).toHaveBeenCalledTimes(1);
    // 폴백으로 전체 저장이 다시 호출되어 blob 재기록(인덱스 재생성)
    expect(api.session.save).toHaveBeenCalledTimes(2);
    const fallback = api.session.save.mock.calls[1]![0] as SavePayload;
    expect(fallback.blob).not.toBeNull();
    expect(fallback.keepIndex).toBeFalsy();
  });

  it('savePartial 미지원(구버전 preload) → keepIndex 전체 저장으로 graceful degrade', async () => {
    const doc = makeDoc('no-partial-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, 's'), ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    await persistCurrentSession(); // 등록
    // savePartial 제거(구버전 preload)
    const saved = api.session.savePartial;
    (api.session as { savePartial?: unknown }).savePartial = undefined;
    try {
      await persistCurrentSession();
      const second = api.session.save.mock.calls[1]![0] as SavePayload;
      expect(second.keepIndex).toBe(true); // blob 은 생략하되 전체 저장으로
      expect(second.blob).toBeNull();
    } finally {
      (api.session as { savePartial?: unknown }).savePartial = saved;
    }
  });
});

describe('R41 fixes', () => {
  it('High: summaryType 키가 없으면 fallback 요약의 실제 타입으로 복원 (불일치 방지)', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, false);
      f.session.docHash = hash;
      f.session.summaries = { full: { content: 'FULL 본문', model: 'm', provider: 'ollama' } };
      f.session.summaryType = 'keywords'; // summaries 에 keywords 없음
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('FULL 본문');
    expect(s.summary?.type).toBe('full');   // keywords 가 아니라 실제 타입
    expect(s.summaryType).toBe('full');
  });

  it('#3: load↔checkEmbedModel 사이 provider 변경 시 마커에 최신 provider 반영', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true, settings: { ...useAppStore.getState().settings, provider: 'ollama' } });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, true);
      f.session.docHash = hash;
      return f;
    });
    api.ai.checkEmbedModel.mockImplementation(async () => {
      // 두 await 사이 provider 토글
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, provider: 'openai' } });
      return { available: true, model: 'nomic-embed-text' };
    });
    await restoreSessionForDocument(doc);
    expect(useAppStore.getState().restoredSession?.provider).toBe('openai'); // stale 'ollama' 아님
  });

  it('#2: 동시 persist 호출이 직렬화되어 last-write-wins', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc,
      summary: { id: 's', documentId: doc.id, type: 'full', content: 'v1', model: 'm', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: 'v1',
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(null);
    const p1 = persistCurrentSession();
    // 두 번째 호출 직전 상태 갱신 — 직렬화되면 두 번째 save 가 v2 를 반영해야 함
    useAppStore.setState({ summaryStream: 'v2' });
    const p2 = persistCurrentSession();
    await Promise.all([p1, p2]);
    expect(api.session.save).toHaveBeenCalledTimes(2);
    const last = api.session.save.mock.calls.at(-1)![0] as { session: PersistedSession };
    expect(last.session.summaries.full?.content).toBe('v2');
  });
});

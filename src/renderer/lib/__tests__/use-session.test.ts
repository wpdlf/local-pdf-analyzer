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
  session: { load: vi.fn(), loadMeta: vi.fn(), save: vi.fn((_payload: unknown) => Promise.resolve({ ok: true })) },
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
  api.session.loadMeta.mockResolvedValue(null); // 비-인덱싱 머지 경로 기본값(본문만 로드)
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  // store 초기화
  useAppStore.setState({
    document: null, summary: null, summaryStream: '', qaMessages: [],
    isGenerating: false, isQaGenerating: false, sessionRestorePending: false,
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
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

  it('persistSessions=false → load 미호출, 게이트 해제', async () => {
    const doc = makeDoc();
    useAppStore.setState({ document: doc, sessionRestorePending: true, settings: { ...useAppStore.getState().settings, persistSessions: false } });
    await restoreSessionForDocument(doc);
    expect(api.session.load).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionRestorePending).toBe(false);
  });

  it('schemaVersion 불일치 → 복원 안 함', async () => {
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
    expect(s.summary).toBeNull();
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
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: 'nomic-embed-text', chunkCount: 1 },
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
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: null, chunkCount: 0 },
    });
    api.session.load.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.session.embedModel).toBe('nomic-embed-text'); // 기존 인덱스 유지
    expect(payload.session.chunkMeta).toHaveLength(2);
    expect(payload.blob).toBe(existing.blob); // 기존 블롭 그대로
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

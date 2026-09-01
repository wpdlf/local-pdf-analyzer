// @vitest-environment happy-dom

// use-session 보강 — useSessionPersistence 훅(디바운스 자동저장 게이트)과
// restoreSessionForDocument 의 미커버 분기(catch / checkEmbedModel 불가·throw /
// blob 있으나 embedModel 없음). 핵심 hit/miss/persist 경로는 use-session.test 가 별도 커버.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { PdfDocument, PersistedSession } from '../../types';

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
const api = {
  session: {
    load: vi.fn(),
    save: vi.fn(() => Promise.resolve({ ok: true })),
    // QA18(B-MED): 컬렉션 gather 중 종료 flush 는 부분저장으로만 착지해야 한다.
    savePartial: vi.fn(() => Promise.resolve({ ok: true })),
  },
  ai: { checkEmbedModel: vi.fn((): Promise<{ available: boolean; model: string | null }> => Promise.resolve({ available: true, model: 'nomic-embed-text' })), abort: vi.fn(() => Promise.resolve()) },
  settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
};
vi.stubGlobal('window', Object.assign(window, { electronAPI: api }));
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
// 실제 crypto.subtle.digest 는 fake timer 의 advanceTimersByTimeAsync 로 완전히 flush 되지
// 않아 persist 의 save 가 다음 테스트로 누설된다. 해시를 결정적 목으로 대체해 디바운스
// 자동저장 경로를 fake timer 안에서 deterministic 하게 만든다.
vi.mock('../session-hash', () => ({ hashDocumentText: vi.fn(() => Promise.resolve('deadbeefcafe')) }));

import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';
import { restoreSessionForDocument, useSessionPersistence, persistCurrentSession, __resetSessionModuleStateForTest } from '../use-session';

function makeDoc(id = 'doc-1'): PdfDocument {
  return {
    id, fileName: 'lecture.pdf', filePath: '/x/lecture.pdf', pageCount: 5,
    extractedText: '본문 텍스트 ' + id, pageTexts: ['p1', 'p2'], chapters: [],
    images: [], createdAt: new Date('2026-06-17T00:00:00Z'),
  };
}

function makeIndexFixture() {
  const vs = new VectorStore();
  vs.setModel('nomic-embed-text');
  vs.addChunk('chunk', [1, 0, 0], 0, { pageStart: 1, pageEnd: 1 });
  return vs.serialize();
}

function fixture(doc: PdfDocument, withIndex: boolean) {
  const idx = withIndex ? makeIndexFixture() : null;
  const session: PersistedSession = {
    schemaVersion: 1, docHash: 'PLACEHOLDER',
    fileName: doc.fileName, filePath: doc.filePath, pageCount: doc.pageCount,
    extractedText: doc.extractedText, pageTexts: doc.pageTexts, chapters: doc.chapters,
    summaries: { full: { content: '복원된 요약', model: 'gemma3', provider: 'ollama' } },
    summaryType: 'full', qaMessages: [],
    embedModel: idx ? idx.model : null, embedDim: idx ? idx.dimension : null,
    chunkMeta: idx ? idx.chunkMeta : [],
  };
  return { session, blob: idx ? idx.buffer : null };
}

function resetStore(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    document: null, summary: null, summaryStream: '', qaMessages: [],
    isGenerating: false, isQaGenerating: false, sessionRestorePending: false,
    // QA22(D-차단성): QA21 이 use-session.test.ts 에서 정확히 이 목록을 추가해 고친 결함이
    // **형제 파일인 여기에는 이식되지 않았다**. describe #1 의 복원 테스트가 setSummary() 로
    // summaryStreamComplete=true 를 세우면 이후 describe 까지 누수되어, fast-path 게이트
    // (use-session.ts summaryIsCommitted)를 **누수된 true 로** 통과시킨다 — 그 결과 아래
    // "컬렉션 gather 중 flush" 회귀 넷이 단독 실행 시 실패하고 전체 실행에서만 그린이었다.
    summaryStreamComplete: false, summaryStreamType: null,
    isCollectionBusy: false, summaryType: 'full',
    isParsing: false, isTabSwitching: false,
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    settings: { ...useAppStore.getState().settings, persistSessions: true, provider: 'ollama' },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // QA22(D-LOW): 모듈 스코프 상태(persistChain·시그니처·docHash 캐시·실패 래치) 초기화.
  __resetSessionModuleStateForTest();
  api.session.save.mockResolvedValue({ ok: true });
  api.session.load.mockResolvedValue(null);
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  resetStore();
});

describe('restoreSessionForDocument — 미커버 분기', () => {
  it('load 가 throw → 게이트 해제 + 복원실패 표식 + 통지 (에러를 삼키되 조용하지 않다)', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockRejectedValue(new Error('IPC 실패'));
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary).toBeNull();
    expect(s.sessionRestorePending).toBe(false);
    // QA31(C-High): 이 테스트는 예전에 위 두 줄만 단언해, 뒤이은 자동저장이 디스크의 대화를
    // 지우는 결함 동작을 **사양으로 굳히고** 있었다(회귀넷이 아니라 차폐막).
    expect(s.sessionRestoreFailed, '복원 실패가 표식으로 남아야 저장을 막을 수 있다').toBe(true);
    expect(s.notice?.message ?? '').toContain('불러오지 못했습니다');
  });

  it('복원 실패 후 자동저장이 디스크의 Q&A 를 덮어쓰지 않는다 (C-High 회귀)', async () => {
    // 재현: 문서에 요약·대화가 저장돼 있는데 index.bin EBUSY 한 번으로 session:load 가 throw
    // → 메모리는 qaMessages=[] → RAG 빌더가 인덱스를 만들며 hasContent 가 참이 되어 자동저장
    // 발화 → 요약은 loadMeta 머지가 살고 **대화만** 소실. 저장 트리거를 그대로 재현한다.
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    // **일시적** 실패여야 한다. 영구 실패면 저장 시점의 머지 read 도 throw 해서 use-session:411
    // 의 기존 방어("머지 read 실패 → 파괴적 쓰기 대신 skip")가 이미 막는다. 노출된 창은
    // AV/인덱서가 index.bin 을 순간 잠갔다 푸는 경우 — 복원은 실패하고 이후 읽기는 성공한다.
    api.session.load.mockRejectedValueOnce(new Error('EBUSY: index.bin'));
    await restoreSessionForDocument(doc);
    expect(useAppStore.getState().qaMessages, '복원 실패 후 메모리는 비어 있다').toEqual([]);
    // 잠금이 풀렸다 — 디스크에는 대화가 그대로 있고, 자동저장의 머지 read 는 이제 성공한다.
    const disk = fixture(doc, true);
    disk.session.qaMessages = [
      { id: 'q', role: 'user', content: '기존 질문' },
      { id: 'a', role: 'assistant', content: '기존 답변' },
    ] as PersistedSession['qaMessages'];
    api.session.load.mockImplementation(async (h: string) => { disk.session.docHash = h; return disk; });

    // 복원 실패 뒤 인덱스가 빌드돼 저장 트리거가 성립한 상태.
    // 복원이 실패한 줄 모르는 사용자가 새로 요약한다 — 그 저장이 디스크의 대화를 지운다.
    const vs = new VectorStore();
    vs.setModel('nomic-embed-text');
    vs.addChunk('청크', [1, 0, 0], 0, { pageStart: 1, pageEnd: 1 });
    useAppStore.setState({
      ragIndex: vs,
      ragState: { ...useAppStore.getState().ragState, chunkCount: 1, model: 'nomic-embed-text' },
      summaryStream: '새로 만든 요약', summaryStreamType: 'full', summaryStreamComplete: true,
    });
    api.session.save.mockClear();
    api.session.savePartial.mockClear();

    // 디스크에 **아무것도 쓰지 않아야** 한다 — 전체저장(save)이든 부분저장(savePartial)이든
    // 둘 다 qaMessages 를 통째로 싣기 때문이다. 한쪽만 단언하면 다른 쪽으로 새는 것을 놓친다.
    await persistCurrentSession();
    expect(api.session.save, '복원 실패 문서는 전체저장을 하지 않는다').not.toHaveBeenCalled();
    expect(api.session.savePartial, '복원 실패 문서는 부분저장도 하지 않는다').not.toHaveBeenCalled();

    await persistCurrentSession(true);
    expect(api.session.save, 'flush 에서도 전체저장하지 않는다').not.toHaveBeenCalled();
    expect(api.session.savePartial, 'flush 에서도 부분저장하지 않는다').not.toHaveBeenCalled();
  });

  it('복원이 다시 성공하면 표식이 내려가 저장이 재개된다 (실패가 영구 고착되지 않는다)', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockRejectedValue(new Error('IPC 실패'));
    await restoreSessionForDocument(doc);
    expect(useAppStore.getState().sessionRestoreFailed).toBe(true);

    api.session.load.mockImplementation(async (h: string) => { const f = fixture(doc, true); f.session.docHash = h; return f; });
    resetStore({ document: doc, sessionRestorePending: true, sessionRestoreFailed: true });
    await restoreSessionForDocument(doc);
    expect(useAppStore.getState().sessionRestoreFailed, '성공한 복원은 표식을 내려야 한다').toBe(false);
  });

  it('embedCheck.available=false → 인덱스 미복원(요약은 복원), 마커 없음', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (h: string) => { const f = fixture(doc, true); f.session.docHash = h; return f; });
    api.ai.checkEmbedModel.mockResolvedValue({ available: false, model: null });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('복원된 요약');
    expect(s.ragState.isAvailable).toBe(false);
    expect(s.restoredSession).toBeNull();
  });

  it('checkEmbedModel 이 throw → 인덱스 복원 스킵(내부 catch), 게이트 해제', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (h: string) => { const f = fixture(doc, true); f.session.docHash = h; return f; });
    api.ai.checkEmbedModel.mockRejectedValue(new Error('embed check fail'));
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('복원된 요약');
    expect(s.ragState.isAvailable).toBe(false);
    expect(s.restoredSession).toBeNull();
    expect(s.sessionRestorePending).toBe(false);
  });

  it('blob 은 있으나 embedModel 이 null → checkEmbedModel 미호출, 인덱스 스킵', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (h: string) => {
      const f = fixture(doc, true);
      f.session.docHash = h;
      f.session.embedModel = null; // blob 은 있지만 모델 메타 없음
      return f;
    });
    await restoreSessionForDocument(doc);
    expect(api.ai.checkEmbedModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().ragState.isAvailable).toBe(false);
    expect(useAppStore.getState().sessionRestorePending).toBe(false);
  });

  it('Q&A 메시지가 있으면 복원된다', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockImplementation(async (h: string) => {
      const f = fixture(doc, false);
      f.session.docHash = h;
      f.session.qaMessages = [{ id: 'q', role: 'user', content: '질문' }];
      return f;
    });
    await restoreSessionForDocument(doc);
    expect(useAppStore.getState().qaMessages).toHaveLength(1);
  });
});

describe('useSessionPersistence — 디바운스 자동저장 게이트', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    // 마운트된 훅을 언마운트해 잔존 타이머가 다음 테스트의 advance 에 누설되지 않도록 한다.
    cleanup();
    vi.useRealTimers();
  });

  async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('콘텐츠 있고 settle → 디바운스 후 자동 저장(payload 형상 포함)', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약 내용' });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).toHaveBeenCalledTimes(1);
    // preload 계약: save({ meta, session, blob }) — 형상 회귀 가드
    const arg = (api.session.save.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg).toHaveProperty('meta');
    expect(arg).toHaveProperty('session');
    expect(arg).toHaveProperty('blob');
  });

  it('persistSessions=false → 저장 안 함', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약', settings: { ...useAppStore.getState().settings, persistSessions: false } });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('문서 없으면 저장 안 함', async () => {
    resetStore({ document: null, summaryStream: '요약' });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('복원 대기 중(pending)이면 저장 안 함', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약', sessionRestorePending: true });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('생성 중이면 저장 보류', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약', isGenerating: true });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('인덱싱 중이면 저장 보류', async () => {
    resetStore({
      document: makeDoc(), summaryStream: '요약',
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('콘텐츠가 전혀 없으면 저장 안 함', async () => {
    resetStore({ document: makeDoc(), summaryStream: '', qaMessages: [] });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('디바운스 만료 전 언마운트 → 저장 취소(타이머 정리)', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약' });
    const { unmount } = renderHook(() => useSessionPersistence());
    await settle(500);
    unmount();
    await settle(1600);
    expect(api.session.save).not.toHaveBeenCalled();
  });

  it('Q&A 메시지만 있어도 저장 트리거', async () => {
    resetStore({ document: makeDoc(), summaryStream: '', qaMessages: [{ id: 'q', role: 'user', content: 'q' }] });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).toHaveBeenCalledTimes(1);
  });
});

// QA18(A-MED, 실데이터 손실 2건): 영속 저장 키는 "이 콘텐츠를 만든 요약 타입"이어야 한다.
// 이전엔 콘텐츠는 summaryStream, 키·메타는 s.summary(마지막 성공 커밋)에서 가져와 이원화돼
// 있었고, setSummary 는 성공 완주 시에만 호출되므로 중단·실패 run 에서 둘이 영구히 어긋났다.
describe('doPersistCurrentSession — 요약 저장 키 소유권(summaryStreamType)', () => {
  beforeEach(() => { api.session.save.mockClear(); api.session.load.mockReset(); });

  /** 마지막 save 호출의 session.summaries. */
  function savedSummaries(): Record<string, { content: string }> {
    const arg = (api.session.save.mock.calls.at(-1) as unknown[])[0] as { session: { summaries: Record<string, { content: string }> } };
    return arg.session.summaries;
  }

  it('중단된 새 타입 run 의 부분 스트림이 직전 타입의 완성 요약을 덮어쓰지 않는다', async () => {
    // 'full' 완성 → 'keywords' 요약 시작 → Stop. handleAbort 는 flushStream + setIsGenerating(false)
    // 만 하므로 summaryStream 에는 잘린 키워드표가, s.summary 에는 직전 full 완성본이 남는다.
    resetStore({
      document: makeDoc(),
      summary: { id: 's1', documentId: 'doc-1', type: 'full', content: '완성된 전체 요약', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      summaryStream: '| 키워드 | 설​명 |\n|---|', // 중단된 부분 표
      summaryStreamType: 'keywords',
      summaryType: 'keywords',
    });
    await persistCurrentSession();
    const s = savedSummaries();
    // 회귀 전: summaries['full'] 이 잘린 키워드표로 덮어써져 완성 요약이 파괴됐다.
    expect(Object.keys(s)).toEqual(['keywords']);
    expect(s['keywords']?.content).toContain('키워드');
    expect(s['full']).toBeUndefined();
  });

  it('첫 요약이 통합 단계에서 실패해도(s.summary=null) 완주한 청크 요약이 저장된다', async () => {
    // 마지막 통합 호출이 429/0토큰으로 throw → setSummary 미호출 → s.summary 는 null 인 채
    // summaryStream 에만 청크 요약들이 누적돼 있다(화면엔 보이므로 사용자는 저장됐다고 믿는다).
    resetStore({
      document: makeDoc(),
      summary: null,
      summaryStream: '1장 요약 ...\n2장 요약 ...',
      summaryStreamType: 'full',
      summaryType: 'full',
    });
    await persistCurrentSession();
    // 회귀 전: `summaryContentToPersist && s.summary` 게이트에 걸려 한 글자도 저장되지 않았다.
    expect(api.session.save).toHaveBeenCalledTimes(1);
    expect(savedSummaries()['full']?.content).toContain('2장 요약');
  });

  it('복원 세션(run 없음 → summaryStreamType=null)은 s.summary.type 으로 폴백한다', async () => {
    resetStore({
      document: makeDoc(),
      summary: { id: 's1', documentId: 'doc-1', type: 'keywords', content: '복원된 키워드', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 0 },
      summaryStream: '복원된 키워드',
      summaryStreamType: null,
      summaryType: 'keywords',
    });
    await persistCurrentSession();
    expect(Object.keys(savedSummaries())).toEqual(['keywords']);
  });

  // QA18(B-MED, 실데이터 손실): isCollectionBusy 는 디바운스만 막아야 한다. 종료 flush 까지
  // 통째로 skip 하면 컬렉션 통합요약(분 단위 gather) 중 종료 시 직전에 완료된 Q&A 턴·요약이
  // 사라진다 — QA10 handshake 가 no-op persist 를 기다리는 무의미 상태였다.
  it('컬렉션 gather 중: 디바운스는 보류하되 종료 flush 는 부분저장으로 착지한다', async () => {
    // 1단계: 인덱스를 가진 문서를 정상 전체저장해 부분저장 fast-path 의 전제(시그니처)를 만든다.
    const vs = new VectorStore();
    vs.setModel('nomic-embed-text');
    vs.addChunk('청크', [1, 0, 0], 0, { pageStart: 1, pageEnd: 1 });
    // QA22(D-차단성): `summaryStreamComplete: true` 를 **픽스처가 명시**해야 한다. 이 값은 실제
    // 앱에서 setSummary(성공 완주 커밋)가 세우는 것이고, "완료된 요약" 이라는 이 픽스처의 전제
    // 자체다. 이전에는 앞선 describe 의 복원 테스트가 세워 둔 값이 누수돼 우연히 통과하고 있었다
    // (resetStore 가 이 키를 리셋하지 않았음) — 단독 실행하면 실패하는 순서 의존 그린이었다.
    resetStore({
      document: makeDoc(), summaryStream: '완료된 요약', summaryStreamType: 'full',
      summaryStreamComplete: true, ragIndex: vs,
    });
    await persistCurrentSession();
    expect(api.session.save).toHaveBeenCalledTimes(1);

    // 2단계: 컬렉션 통합요약(gather) 진행 중 + 방금 완료된 Q&A 턴.
    api.session.save.mockClear();
    api.session.savePartial.mockClear();
    useAppStore.setState({
      isCollectionBusy: true,
      qaMessages: [{ id: 'q', role: 'user', content: '질문' }, { id: 'a', role: 'assistant', content: '답변' }],
    });

    await persistCurrentSession(false);
    expect(api.session.savePartial).not.toHaveBeenCalled(); // 디바운스 경로는 기존대로 보류
    expect(api.session.save).not.toHaveBeenCalled();

    // 회귀 전: 게이트에서 즉시 return 해 종료 flush 가 no-op → 방금 완료된 Q&A 턴이 소실됐다.
    await persistCurrentSession(true);
    expect(api.session.savePartial).toHaveBeenCalledTimes(1);
    const patch = (api.session.savePartial.mock.calls[0] as unknown[])[0] as { qaMessages: unknown[] };
    expect(patch.qaMessages).toHaveLength(2);
    // 전체저장으로는 폴백하지 않는다(mutex 밖 머지 read → 컬렉션 인라인 요약 lost-update 위험).
    expect(api.session.save).not.toHaveBeenCalled();
  });
});

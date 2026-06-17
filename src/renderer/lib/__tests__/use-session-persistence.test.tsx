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
  session: { load: vi.fn(), save: vi.fn(() => Promise.resolve({ ok: true })) },
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
import { restoreSessionForDocument, useSessionPersistence } from '../use-session';

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
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
    settings: { ...useAppStore.getState().settings, persistSessions: true, provider: 'ollama' },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.session.save.mockResolvedValue({ ok: true });
  api.session.load.mockResolvedValue(null);
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  resetStore();
});

describe('restoreSessionForDocument — 미커버 분기', () => {
  it('load 가 throw → 게이트만 해제(에러 삼킴)', async () => {
    const doc = makeDoc();
    resetStore({ document: doc, sessionRestorePending: true });
    api.session.load.mockRejectedValue(new Error('IPC 실패'));
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary).toBeNull();
    expect(s.sessionRestorePending).toBe(false);
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

  it('콘텐츠 있고 settle → 디바운스 후 자동 저장', async () => {
    resetStore({ document: makeDoc(), summaryStream: '요약 내용' });
    renderHook(() => useSessionPersistence());
    await settle(1600);
    expect(api.session.save).toHaveBeenCalledTimes(1);
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
      ragState: { isIndexing: true, progress: null, isAvailable: false, model: null, chunkCount: 0 },
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

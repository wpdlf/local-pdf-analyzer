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
  // save 의 반환에는 main 이 실어 보내는 indexMissing·evicted 도 포함된다(preload 계약과 동일).
  session: { load: vi.fn(), loadMeta: vi.fn(), save: vi.fn((_payload: unknown): Promise<{ ok: boolean; indexMissing?: boolean; evicted?: string[] }> => Promise.resolve({ ok: true })), savePartial: vi.fn((_payload: unknown) => Promise.resolve({ ok: true })) },
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
import { restoreSessionForDocument, persistCurrentSession, __resetSessionModuleStateForTest } from '../use-session';

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
  // QA22(D-LOW): 모듈 스코프 상태(persistChain·시그니처·docHash 캐시·실패 래치) 초기화.
  __resetSessionModuleStateForTest();
  api.session.save.mockResolvedValue({ ok: true });
  api.session.savePartial.mockResolvedValue({ ok: true });
  api.session.loadMeta.mockResolvedValue(null); // 비-인덱싱 머지 경로 기본값(본문만 로드)
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  // store 초기화
  useAppStore.setState({
    document: null, summary: null, summaryStream: '', qaMessages: [],
    // QA21(A-LOW): 이 두 키를 리셋하지 않아 테스트 간 상태가 **누수**되고 있었다 — fast-path
    // 회귀 넷 6건이 앞 테스트가 세운 summaryStreamComplete=true 에 의존해 통과했고, 단독
    // 실행하면 실패했다(순서 의존 = 회귀를 못 잡는 그린).
    summaryStreamComplete: false, summaryStreamType: null,
    // QA22 백로그 후속(셔플 실측): summaryType 도 리셋하지 않아 앞 테스트가 세운 값이 누수됐다.
    // 복원 테스트들이 이 키를 직접 세우므로(예: 'custom:keep'), 순서가 바뀌면 뒤 테스트의
    // savePartial 단언이 남의 유형을 보고 깨진다 — 위 두 키와 정확히 같은 사고.
    summaryType: 'full',
    // 컬렉션 gather 플래그도 테스트 간 누수 방지(아래 flush 케이스가 true 로 세운다).
    isCollectionBusy: false,
    isGenerating: false, isQaGenerating: false, sessionRestorePending: false,
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    // settings 를 스프레드로 이어받으면 앞 테스트가 넣은 커스텀 템플릿이 남는다 — 명시 리셋.
    settings: { ...useAppStore.getState().settings, persistSessions: true, provider: 'ollama', customSummaryTemplates: [] },
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

  // QA31 잔여: 이 함수는 호출부 셋 모두에서 `void` 로 띄워지므로 호출부의 setTabSwitching
  // 구간이 끝난 뒤에도 계속 돈다 — 그 창에서는 closeTab 이 열려 있다. 해시 계산 await 사이에
  // 탭을 닫으면 종전의 upsert 는 **닫은 탭을 되살렸다**.
  it('해시 계산 중 탭이 닫히면 되살리지 않는다', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc,
      sessionRestorePending: true,
      openTabs: [{ filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount }],
    });
    api.session.load.mockResolvedValue(null);

    // await 하지 않고 띄운다 — 첫 await(hashDocumentText)에서 제어가 돌아온 사이에 탭을 닫는다.
    const inFlight = restoreSessionForDocument(doc);
    useAppStore.getState().removeOpenTab(doc.filePath);
    await inFlight;

    expect(useAppStore.getState().openTabs).toEqual([]);
  });

  it('탭이 열려 있으면 docHash 를 기록한다 (patch 가 늘 no-op 이면 위 가드가 공허하다)', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc,
      sessionRestorePending: true,
      openTabs: [{ filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount }],
    });
    api.session.load.mockResolvedValue(null);

    await restoreSessionForDocument(doc);

    const tab = useAppStore.getState().openTabs[0];
    expect(tab?.filePath).toBe(doc.filePath);
    expect(tab?.docHash).toMatch(HEX);
  });

  /**
   * QA32(B): `:154` 의 doc 검사는 try **안**에 있어서, 그 뒤의 checkEmbedModel 이 reject 하면
   * inner catch 가 삼키고 정상 경로로 떨어지는데 그쪽엔 재확인이 없었다. 복원 게이트는
   * 문서별이 아니라 **전역**이라, 그 사이 전환된 새 문서의 복원이 세운 pending 을 옛 흐름이
   * 내린다 → 자동 재빌드와 자동저장이 반쯤 복원된 문서에 대해 발화한다.
   */
  it('인덱스 복원 중 문서가 바뀌면 새 문서의 복원 게이트를 내리지 않는다', async () => {
    const doc = makeDoc('doc-old');
    useAppStore.setState({ document: doc, sessionRestorePending: true });
    const fixture = persistedSession(doc, true);
    api.session.load.mockImplementation(async (hash: string) => {
      fixture.session.docHash = hash;
      return fixture;
    });
    // 인덱스 복원 단계에서 문서가 교체되고, 그 뒤 checkEmbedModel 이 실패한다.
    api.ai.checkEmbedModel.mockImplementation(async () => {
      useAppStore.setState({ document: makeDoc('doc-new'), sessionRestorePending: true });
      throw new Error('embed check failed');
    });

    await restoreSessionForDocument(doc);

    expect(useAppStore.getState().sessionRestorePending, '옛 흐름이 새 문서의 복원 게이트를 내렸다')
      .toBe(true);
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

  // QA27(A-Important): 복원 문서는 언제나 images:[] 라, "이미지가 있었다" 를 세션이 기억하지
  // 않으면 텍스트-only PDF 와 구분할 방법이 없다 — 재요약이 Vision 없이 조용히 진행된다.
  it('이미지가 있던 문서는 hadImages 를 세션에 남긴다 (텍스트-only 와 구분)', async () => {
    const withImages: PdfDocument = {
      ...makeDoc('had-images-doc'),
      images: [{ pageIndex: 0, imageIndex: 0, base64: 'AA', width: 10, height: 10, mimeType: 'image/png' }],
    };
    useAppStore.setState({ document: withImages, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.hadImages).toBe(true);
  });

  it('이미지가 없던 문서는 hadImages 가 참이 아니다 (거짓 안내 방지)', async () => {
    useAppStore.setState({ document: makeDoc('no-images-doc'), summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.hadImages).toBe(false);
  });

  // QA28(A-Important): 복원 문서는 images:[] 인데 hadImages 를 메모리에서 재계산만 하면 첫
  // 전체 저장이 디스크의 true 를 false 로 덮어 표식이 왕복을 못 견딘다(인덱스 없는 문서는 매
  // 자동저장이 전체 저장이라 즉시 소거). 복원된 표식은 OR 로 보존돼야 한다.
  it('복원 문서(images:[] + hadImages:true)를 다시 저장해도 hadImages 가 true 로 남는다', async () => {
    const restored: PdfDocument = { ...makeDoc('restored-doc'), images: [], hadImages: true };
    useAppStore.setState({ document: restored, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.hadImages, '복원 표식이 재저장에서 소거되면 안 된다').toBe(true);
  });

  it('hadImages 가 없는 텍스트-only 문서는 여전히 false (OR 보존이 거짓 양성을 만들지 않는다)', async () => {
    const textOnly: PdfDocument = { ...makeDoc('text-only-doc'), images: [] };
    delete textOnly.hadImages;
    useAppStore.setState({ document: textOnly, summary: null, summaryStream: '', qaMessages: [], ragIndex: new VectorStore() });
    api.session.load.mockResolvedValue(null);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.hadImages).toBe(false);
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

  // QA20(C-MED, 데이터손실): 위 flush 경로 방어(persistCommitted)는 isGenerating 에 의존하는데,
  // 중지·타임아웃·실패는 setIsGenerating(false) 를 **먼저** 실행한다. 그래서 그 뒤의 일반
  // 자동저장(디바운스, flush=false)이 부분 스트림을 완성본으로 오인해 디스크의 완성 요약을
  // 덮어썼다 — 같은 타입으로 재요약하다 중지 한 번이면 원본이 복구 불가로 소실.
  it('중지된 부분 스트림(미완주)은 디스크의 같은 타입 완성본을 덮어쓰지 않는다', async () => {
    const doc = makeDoc('aborted-resummary-doc');
    const existing = persistedSession(doc, false); // 디스크에 summaries.full = '복원된 요약'
    useAppStore.setState({
      document: doc,
      // 중지 직후 상태: isGenerating 은 이미 false, 스트림엔 부분본만 남음
      summaryStream: '중지된 10% 부분본',
      summaryStreamType: 'full',
      summaryStreamComplete: false,
      isGenerating: false,
      summary: null,
      qaMessages: [],
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(existing);
    api.session.loadMeta.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.summaries.full?.content, '완성본이 부분본으로 파괴되면 안 된다').toBe('복원된 요약');
  });

  // QA18(A-MED) 동작 유지: 기존 요약이 **없으면** 미완주 결과라도 저장한다 — "마지막 통합
  // 단계에서만 실패해 완주한 청크 요약이 한 글자도 저장되지 않던" 회귀를 되살리지 않기 위함.
  it('기존 요약이 없으면 미완주 스트림도 저장한다 (QA18 동작 유지)', async () => {
    const doc = makeDoc('partial-first-summary-doc');
    useAppStore.setState({
      document: doc,
      summaryStream: '통합 직전 실패한 청크 요약들',
      summaryStreamType: 'full',
      summaryStreamComplete: false,
      isGenerating: false,
      summary: null,
      qaMessages: [],
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(null);   // 디스크에 세션 없음
    api.session.loadMeta.mockResolvedValue(null);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.summaries.full?.content).toBe('통합 직전 실패한 청크 요약들');
  });

  // QA21(A-MED, v0.31.34 출시 회귀): QA20 의 미완주 게이트가 **커밋된 완성본까지** 차단했다.
  // flush 경로는 QA12 가 만든 통로로 "생성 중이면 부분 스트림 대신 s.summary(직전 완주본)를
  // 저장" 하는데, 진행 중인 새 run 이 clearStream 으로 summaryStreamComplete=false 를 세워
  // 두므로 게이트가 그 커밋본을 미완주로 오인했다. 디스크에 같은 타입이 있으면 skip →
  // 방금 완주한 요약이 소실되고 옛 요약이 남는다(무경고).
  it('flush 중 재요약: 방금 완주한 커밋본이 디스크의 옛 요약을 정상적으로 갱신한다', async () => {
    const doc = makeDoc('flush-committed-overwrite-doc');
    const existing = persistedSession(doc, false); // 디스크에 summaries.full = '복원된 요약'
    useAppStore.setState({
      document: doc,
      // 직전 run 이 완주해 커밋한 요약
      summary: { id: 's', documentId: doc.id, type: 'full', content: '방금 완주한 요약', model: 'gemma3', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      // 새 run 이 진행 중 — clearStream 이 완주 표식을 내렸고 스트림엔 부분본만
      summaryStream: '새 run 의 5% 부분본',
      summaryStreamType: 'full',
      summaryStreamComplete: false,
      isGenerating: true,
      qaMessages: [],
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(existing);
    api.session.loadMeta.mockResolvedValue(existing);

    await persistCurrentSession(true); // flush=true (종료/새로고침)

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.summaries.full?.content, '커밋된 완주본이 저장돼야 한다(부분본도 옛 요약도 아님)').toBe('방금 완주한 요약');
  });

  // QA21(A-MED, v0.31.34 출시 회귀): summaryStreamComplete 는 "미완주"뿐 아니라 **요약을 한 번도
  // 하지 않은 정상 상태**에서도 false 다. 그래서 요약 없는 문서(Q&A 만 한 문서)가 fast-path 에서
  // 배제됐고, 컬렉션 gather 중 flush 는 partialOnly 라 전체저장도 막혀 **아무것도 저장되지 않았다**
  // (QA18 이 열어둔 유일한 통로가 막힘 → 마지막 Q&A 턴 소실).
  it('컬렉션 gather 중 flush: 요약 없는 문서도 부분저장으로 Q&A 가 보존된다', async () => {
    const doc = makeDoc('collection-flush-noqsummary-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({
      document: doc,
      summary: null,
      summaryStream: '',        // 요약을 한 번도 하지 않은 문서
      summaryStreamType: null,
      summaryStreamComplete: false,
      qaMessages: [{ id: 'q', role: 'user', content: 'q' }],
      ragIndex: vs,
    });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    // 1번째: 전체 저장으로 시그니처 등록 (이후 인덱스 무변경 → fast-path 자격)
    await persistCurrentSession();
    expect(api.session.save).toHaveBeenCalledTimes(1);

    // 컬렉션 gather 시작 + Q&A 턴 추가 → 종료 flush
    useAppStore.setState({
      isCollectionBusy: true,
      qaMessages: [
        { id: 'q', role: 'user', content: 'q' },
        { id: 'a', role: 'assistant', content: '답변' },
      ],
    });
    await persistCurrentSession(true); // flush=true

    expect(api.session.savePartial, 'gather 중 flush 는 savePartial 로 Q&A 를 보존해야 한다').toHaveBeenCalledTimes(1);
    const partial = api.session.savePartial.mock.calls[0]![0] as PartialPayload;
    expect(partial.qaMessages).toHaveLength(2);
    expect(partial.summary, '저장할 요약이 없으므로 summaries 는 건드리지 않는다').toBeNull();
  });

  it('완주한 요약은 기존 완성본을 정상적으로 갱신한다', async () => {
    const doc = makeDoc('completed-resummary-doc');
    const existing = persistedSession(doc, false);
    useAppStore.setState({
      document: doc,
      summaryStream: '새로 완주한 요약',
      summaryStreamType: 'full',
      summaryStreamComplete: true, // setSummary 가 세운 완주 표식
      isGenerating: false,
      summary: null,
      qaMessages: [],
      ragIndex: new VectorStore(),
    });
    api.session.load.mockResolvedValue(existing);
    api.session.loadMeta.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
    expect(payload.session.summaries.full?.content).toBe('새로 완주한 요약');
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
    // 프로덕션의 readSessionMeta 는 session.json 전체(embedModel 포함, blob 제외)를 돌려준다 —
    // 목도 그렇게 둬야 "디스크에 인덱스가 있는가" 판정이 실제와 같은 입력을 본다(QA23).
    api.session.loadMeta.mockResolvedValue({ session: existing.session });
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
    api.session.loadMeta.mockResolvedValue({ session: existing.session });
    api.session.load.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.session.embedModel).toBe('nomic-embed-text'); // 기존 인덱스 유지
    expect(payload.session.chunkMeta).toHaveLength(2);
    expect(payload.blob).toBe(existing.blob); // 기존 블롭 그대로 — unlink 방지
  });

  // QA23(D-HIGH, 데이터·비용 손실): QA19 가 위 결함을 고치면서 표식(error)을 **배치 실패 3곳에만**
  // 붙이고 **가장 흔한 진입점인 가용성 체크 실패**(Ollama 미기동/키 부재/오프라인)에는 안 붙였다.
  // 그 경로는 isAvailable:false + error:null 로 끝나므로 preserveDiskIndex 가 꺼진 채 자동저장이
  // 돌아, **문서를 열어보기만 해도 디스크 index.bin 이 삭제**됐다(무음, ok:true). 다시 켜면 전
  // 문서 재임베딩 — 로컬은 수 분, 클라우드는 실과금.
  it('임베딩 불가(Ollama 꺼짐 등)로 인덱스를 못 만든 상태 → 디스크 인덱스 보존', async () => {
    const doc = makeDoc();
    const existing = persistedSession(doc, true); // 디스크에 완전한 인덱스가 있는 문서
    useAppStore.setState({
      document: doc,
      summaryStream: '복원된 요약',
      qaMessages: [],
      ragIndex: new VectorStore(), // 임베딩 불가 → 메모리 인덱스 비어 있음
      // 가용성 체크 실패의 실제 종료 상태: error 는 null 이다(use-qa 가 안 세운다)
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    });
    api.session.loadMeta.mockResolvedValue({ session: existing.session });
    api.session.load.mockResolvedValue(existing);

    await persistCurrentSession();

    const payload = api.session.save.mock.calls[0]![0] as { session: PersistedSession; blob: ArrayBuffer | null };
    expect(payload.blob, '디스크 index.bin 이 unlink 되면 안 된다').toBe(existing.blob);
    expect(payload.session.embedModel).toBe('nomic-embed-text');
    expect(payload.session.chunkMeta).toHaveLength(2);
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
  // 성공 완주해 커밋된 요약 상태. QA21(A-LOW): summaryStreamComplete 를 명시한다 — 실제로
  // setSummary 가 세우는 값이며, 이게 없으면 이 픽스처는 "요약이 완주된 문서"를 표현하지 못한다
  // (기존에는 beforeEach 미리셋 덕에 앞 테스트의 true 가 누수돼 우연히 통과하고 있었다).
  const summaryState = (doc: PdfDocument, content: string) => ({
    summary: { id: 's', documentId: doc.id, type: 'full' as const, content, model: 'm', provider: 'ollama' as const, createdAt: new Date(), durationMs: 1 },
    summaryStream: content,
    summaryStreamComplete: true,
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

  // QA27(D-Important): main 은 `indexMissing` 을 내고 렌더러는 그것으로 시그니처를 무효화하는데,
  // **그 경계를 건너는 테스트가 하나도 없었다**(session-store.test 는 main 의 반환값만 본다).
  // 소비 항 `indexMissing ||` 을 지워도 전 스위트가 초록이었다 — 실제 결과는 다음 자동저장이
  // 계속 keepIndex 로 내려가고 main 이 매번 "인덱스 없음" 으로 정규화해, index.bin 이 문서를
  // 다시 열 때까지 **영원히 재기록되지 않는** 것이다(재오픈 시 재임베딩 강제).
  it('main 이 indexMissing 을 알리면 다음 저장은 blob 을 포함한 전체 저장으로 자가회복한다', async () => {
    const doc = makeDoc('index-missing-doc');
    const vs = VectorStore.restore(makeIndexFixture());
    useAppStore.setState({ document: doc, ...summaryState(doc, 's'), ragIndex: vs });
    api.session.load.mockResolvedValue(null);
    api.session.loadMeta.mockResolvedValue(null);

    // savePartial 을 제거해 **keepIndex 전체 저장 경로**를 고정한다. 부분저장 실패 경로는
    // 그 자체로 시그니처를 무효화하므로 indexMissing 의 효과를 가려 버린다(그 길로 쓰면
    // 소비 항을 지워도 통과하는 공허한 테스트가 된다 — 실제로 한 번 그렇게 썼다).
    const saved = api.session.savePartial;
    (api.session as { savePartial?: unknown }).savePartial = undefined;
    try {
      await persistCurrentSession(); // 1회차 — 전체 저장으로 시그니처 등록
      expect((api.session.save.mock.calls[0]![0] as SavePayload).blob).not.toBeNull();

      // 2회차: 인덱스 무변경 → keepIndex. main 이 "디스크에 index.bin 이 없다" 고 알린다.
      api.session.save.mockResolvedValueOnce({ ok: true, indexMissing: true });
      await persistCurrentSession();
      expect((api.session.save.mock.calls[1]![0] as SavePayload).keepIndex).toBe(true);

      // 3회차: 시그니처가 무효화됐어야 하므로 blob 을 다시 실어 보내 디스크를 재기록한다.
      await persistCurrentSession();
      const third = api.session.save.mock.calls[2]![0] as SavePayload;
      expect(third.keepIndex, 'keepIndex 를 반복하면 디스크 인덱스가 끝내 복구되지 않는다').toBeFalsy();
      expect(third.blob).not.toBeNull();
    } finally {
      (api.session as { savePartial?: unknown }).savePartial = saved;
    }
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
    // 머지 read 는 가벼운 loadMeta 로 먼저 나간다(QA23) — 실제 I/O 오류는 readSessionMeta 가 전파한다.
    api.session.loadMeta.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
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

  // QA22(백로그): 삭제된 커스텀 템플릿의 요약(`custom:<없는 id>`)이 그대로 복원돼 활성 유형이
  // 존재하지 않는 값이 됐고, SummaryTypeSelector 폴백이 곧바로 'full' 로 되돌려 **라벨↔본문 불일치**
  // (위 R41 High 가 없앤 바로 그 조합)가 남았다. fallback 은 summaries 의 첫 항목을 집으므로
  // 고아 하나가 정상 요약을 가릴 수도 있었다.
  it('QA22: 삭제된 템플릿의 custom 요약은 복원하지 않고, 살아있는 요약을 채택한다', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc, sessionRestorePending: true,
      settings: { ...useAppStore.getState().settings, customSummaryTemplates: [] }, // 템플릿 전부 삭제된 상태
    });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, false);
      f.session.docHash = hash;
      // 고아 요약이 **첫 항목**(fallback 이 먼저 집는 자리)
      f.session.summaries = {
        'custom:gone': { content: '삭제된 템플릿 본문', model: 'm', provider: 'ollama' },
        full: { content: 'FULL 본문', model: 'm', provider: 'ollama' },
      };
      f.session.summaryType = 'custom:gone';
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('FULL 본문');
    expect(s.summary?.type).toBe('full');
    expect(s.summaryType).toBe('full');
  });

  it('QA22: 살아있는 템플릿의 custom 요약은 정상 복원된다 (과잉 차단 방지)', async () => {
    const doc = makeDoc();
    useAppStore.setState({
      document: doc, sessionRestorePending: true,
      settings: {
        ...useAppStore.getState().settings,
        customSummaryTemplates: [{ id: 'keep', name: '액션아이템', prompt: '추출하라', strategy: 'single' }],
      },
    });
    api.session.load.mockImplementation(async (hash: string) => {
      const f = persistedSession(doc, false);
      f.session.docHash = hash;
      f.session.summaries = { 'custom:keep': { content: '커스텀 본문', model: 'm', provider: 'ollama' } };
      f.session.summaryType = 'custom:keep';
      return f;
    });
    await restoreSessionForDocument(doc);
    const s = useAppStore.getState();
    expect(s.summary?.content).toBe('커스텀 본문');
    expect(s.summaryType).toBe('custom:keep');
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

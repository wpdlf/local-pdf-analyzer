import { create } from 'zustand';
import type {
  PdfDocument,
  Summary,
  DefaultSummaryType,
  AppSettings,
  OllamaStatus,
  AppError,
  QaMessage,
  ProgressInfo,
  RagIndexState,
} from '../types';
import type { OpenTab, CollectionState } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { VectorStore } from './vector-store';
import { sanitizeErrorPath } from './error-sanitize';

// 설정 저장 IPC 디바운스 타이머
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
// C5-M3(QA cycle5): 설정 IPC 커밋 대기자. 렌더러 store 는 즉시 갱신되지만 main settings.json 은
// 300ms 디바운스 뒤에 기록된다 — RAG 빌드처럼 main 이 설정을 읽는 소비자(ai:check-embed-model /
// ai:embed)가 프로바이더 전환 직후 시작되면 구 설정으로 임베딩해 인덱스가 stale/혼합 차원으로
// 오염되는 race. 대기 중 커밋이 있으면 그 완료(성공/실패 무관)까지 resolve 를 지연한다.
let settingsCommitResolve: (() => void) | null = null;
let settingsCommitPromise: Promise<void> = Promise.resolve();
/** 대기 중인 설정 IPC 커밋이 flush 될 때까지 대기. 대기 커밋이 없으면 즉시 resolve. */
export function whenSettingsCommitted(): Promise<void> {
  return settingsCommitPromise;
}
// citationPanelWidth localStorage 저장 디바운스 타이머 — 드래그 중 pointermove 마다
// setCitationPanelWidth 가 호출되어 동기 localStorage.setItem 이 초당 수백 회 발생하는 것 방지
let citationPanelWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;

// v0.18.22 R36 P4: 모듈 스코프 notice 타이머 — 기존엔 useAppStore 생성부 이후 (line 507) 에
// 선언되었으나 HMR dispose 핸들러(line 77) 와 setNotice (store 내부) 양쪽이 module init
// 후 closure 로 접근하므로 동작은 정상이었다. 다른 디바운스 타이머와 동일 영역에 배치하여
// "store 위쪽 타이머 / store 아래쪽 ...?" 라는 시각적 비대칭만 정리. 런타임 영향 없음.
const NOTICE_DISMISS_MS = 6000;
let noticeDismissTimer: ReturnType<typeof setTimeout> | null = null;

// crypto.randomUUID 는 secure context 에서만 동작. Electron file:// 는 secure context 로
// 간주되어 정상 동작하지만, 드물게 비정상 origin 또는 구 버전에서 throw 할 수 있음.
// 실패 시 충돌 가능성이 낮은 대체 식별자 생성.
function safeRandomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fallthrough */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// appendStream 배치 처리용 버퍼 (50ms 간격 flush)
// 캡슐화하여 HMR/테스트 시 안전한 리셋 지원
const streamState = {
  buffer: '',
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  cleared: false,
  reset() {
    this.buffer = '';
    this.cleared = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  },
};

// Q&A 스트림 배치 버퍼 (요약 버퍼와 격리)
const qaStreamState = {
  buffer: '',
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  cleared: false,
  reset() {
    this.buffer = '';
    this.cleared = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  },
};

// HMR 시 이전 모듈의 타이머 정리 (고스트 토큰 방지)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _meta = import.meta as any;
if (_meta.hot) {
  _meta.hot.dispose(() => {
    streamState.reset();
    qaStreamState.reset();
    if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
    // 커밋 대기자 settle — dispose 로 타이머가 사라진 promise 를 영원히 대기하는 소비자 방지
    if (settingsCommitResolve) { settingsCommitResolve(); settingsCommitResolve = null; }
    if (citationPanelWidthSaveTimer) { clearTimeout(citationPanelWidthSaveTimer); citationPanelWidthSaveTimer = null; }
    // R31 (v0.18.18 patch): noticeDismissTimer HMR 누락 — 이전 store 인스턴스의 6초
    // 타이머가 fire 하면 새 store 의 notice 를 잘못 dismiss 하려 시도하므로 같이 정리.
    if (noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
  });
}

interface AppState {
  // PDF
  document: PdfDocument | null;
  isParsing: boolean;
  setDocument: (doc: PdfDocument | null) => void;
  setIsParsing: (v: boolean) => void;

  // 다중 문서 탭 (multi-doc Phase 1) — 메타데이터만 보관, 무거운 상태는 활성 문서 단일 유지.
  // 활성 탭 = document?.filePath 파생 (별도 state 없음 — drift 원천 차단).
  openTabs: OpenTab[];
  /** 성공 로드 시 탭 등록/갱신 — filePath 중복이면 메타만 갱신 (탭 순서 유지) */
  upsertOpenTab: (tab: OpenTab) => void;
  /** 탭 목록에서 제거만 담당 — 활성 문서 정리/이웃 전환은 lib/tabs.ts 가 오케스트레이션 */
  removeOpenTab: (filePath: string) => void;

  // 다중 문서 컬렉션 Q&A (multi-doc Phase 2) — 여러 문서에 걸친 교차 RAG 검색 대상 선택.
  collection: CollectionState;
  /** 컬렉션 Q&A 모드 on/off. on 전환 시 멤버 목록은 호출자(UI)가 기본값으로 채운다. */
  setCollectionEnabled: (enabled: boolean) => void;
  /** 질의 대상 멤버 docHash 목록 교체 */
  setCollectionMembers: (memberHashes: string[]) => void;
  /** 단일 멤버 포함/제외 토글 (체크박스) */
  toggleCollectionMember: (docHash: string) => void;
  // 교차 요약 "준비(gather) 단계" 표식 — generateCollectionSummary 가 setIsQaGenerating(true) 를
  // gather 뒤에야 세팅하던 사이, 입력창·버튼이 활성으로 남아 handleAsk/handleSummarize 가 끼어들어
  // qaStream/qaRequestId 를 클로버링하던 race 차단(QA R: 컬렉션 요약 동시성). 진입 즉시 동기 세팅.
  isCollectionBusy: boolean;
  setCollectionBusy: (v: boolean) => void;
  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 표식. 기존 tabs.ts 모듈 플래그는
  // isTabSwitchBlocked 만 볼 수 있어, 그 경로를 거치지 않는 문서 열기(드롭/최근문서/전역검색/
  // Ctrl+O → handlePdfData 직행)가 컬렉션 복원 루프와 인터리브돼 탭 세트가 뒤섞였다.
  // store 로 옮겨 handlePdfData 진입 가드에서도 참조한다(zustand set 은 동기 — 가드 의미 동일).
  collectionOpenInFlight: boolean;
  setCollectionOpenInFlight: (v: boolean) => void;

  // 요약
  summary: Summary | null;
  summaryStream: string;
  summaryType: DefaultSummaryType;
  // 페이지 범위 요약 — null 이면 전체. {start,end} 는 1-based inclusive. 문서 전환 시 리셋.
  summaryPageRange: { start: number; end: number } | null;
  isGenerating: boolean;
  currentRequestId: string | null;
  progress: number;
  progressInfo: ProgressInfo | null;
  // H1(UX): 요약 뷰어 비파괴적 접기. ✕ 닫기가 문서·요약·Q&A 를 전부 버리던(resetSummaryState→
  // document:null) 결함을 대체 — collapse 시 상태는 보존하고 뷰어만 숨겨 문서 화면에서 재진입한다.
  summaryCollapsed: boolean;
  setSummaryCollapsed: (v: boolean) => void;
  setSummary: (summary: Summary | null) => void;
  appendStream: (token: string) => void;
  flushStream: () => void;
  clearStream: () => void;
  /** 후처리된 전체 내용으로 summaryStream을 교체. 호출 전에 반드시 flushStream() 수행. */
  replaceSummaryStream: (content: string) => void;
  setSummaryType: (type: DefaultSummaryType) => void;
  setSummaryPageRange: (range: { start: number; end: number } | null) => void;
  setIsGenerating: (v: boolean) => void;
  setCurrentRequestId: (id: string | null) => void;
  setProgress: (p: number) => void;
  setProgressInfo: (info: ProgressInfo | null) => void;
  resetSummaryState: () => void;

  // Q&A
  qaMessages: QaMessage[];
  qaStream: string;
  isQaGenerating: boolean;
  qaRequestId: string | null;
  // v0.18.0: 답변 검증 단계(초안 생성 + RAG 대조) 중 UI 에 "답변 준비 중..." 인디케이터 표시용.
  // qaStream 은 draft 를 담지 않음 — verifying=true 인 동안 사용자에게 표시되는 건 스피너뿐.
  // refine 단계 또는 good-draft flush 시 qaStream 이 채워지면서 verifying=false 로 전환.
  qaVerifying: boolean;
  addQaMessage: (msg: Omit<QaMessage, 'id'>) => void;
  // session-persistence: 복원 시 Q&A 대화 일괄 복원 (id 보존)
  setQaMessages: (messages: QaMessage[]) => void;
  appendQaStream: (token: string) => void;
  flushQaStream: () => void;
  clearQaStream: () => void;
  setIsQaGenerating: (v: boolean) => void;
  setQaRequestId: (id: string | null) => void;
  setQaVerifying: (v: boolean) => void;
  clearQa: () => void;

  // RAG
  ragIndex: VectorStore;
  ragState: RagIndexState;
  setRagState: (state: Partial<RagIndexState>) => void;
  // session-persistence: 복원 시 직렬화된 인덱스로 VectorStore 인스턴스 교체 (재임베딩 0)
  setRagIndex: (vs: VectorStore) => void;
  // 복원 결정(session.load) 동안 useRagBuilder 의 자동 재임베딩을 보류시키는 게이트.
  // 문서 로드 직후 true, 복원 hit(인덱스 주입)/miss(정상 빌드) 결정 후 false.
  sessionRestorePending: boolean;
  setSessionRestorePending: (v: boolean) => void;
  // 복원된 인덱스 마커 — useRagBuilder 가 같은 doc+provider 면 재빌드를 skip (재임베딩 0 보장).
  restoredSession: { docId: string; provider: string; embedModel: string | null } | null;
  setRestoredSession: (v: { docId: string; provider: string; embedModel: string | null } | null) => void;

  // Page citation (Design Ref: §4.2) — page-citation-viewer 기능
  // null 이면 PdfViewer 패널 비활성, { page: N } 이면 해당 페이지로 스크롤
  citationTarget: { page: number } | null;
  setCitationTarget: (target: { page: number } | null) => void;
  // v0.28.1 M1: 동일 페이지 재점프도 스크롤을 발화시키는 단조 증가 카운터.
  // citationTarget.page 가 원시 숫자라 같은 페이지를 다시 지정하면 PdfViewer scroll effect
  // 의 deps 가 안 바뀌어 재스크롤이 안 됐다(목차에서 현재 대상 페이지 항목 클릭 시 no-op).
  // setCitationTarget(non-null) 마다 증가시켜 effect deps 로 사용한다.
  citationJumpNonce: number;
  // DR-01: 우측 PdfViewer 패널 너비 비율 (0.0 ~ 1.0). SummaryViewer 전체 폭 중
  // 우측 패널이 차지하는 비율. 좌측(요약+Q&A)은 자동으로 1 - 비율.
  // 기본 0.5 (50/50), min 0.2 / max 0.8.
  citationPanelWidth: number;
  setCitationPanelWidth: (ratio: number) => void;
  // 원본 PDF 바이트 (PdfViewer 가 lazy 마운트 시 참조).
  // document 와 라이프사이클 동일 — setDocument(null) / 새 문서 로드 시 교체.
  pdfBytes: Uint8Array | null;
  setPdfBytes: (bytes: Uint8Array | null) => void;

  // Vision 이미지 분석으로 enrich 된 page-level 텍스트. use-summarize 에서 요약 파이프라인
  // 진입 직후 세팅되며, useRagBuilder 는 이 값이 있으면 raw pageTexts 대신 이를 사용해
  // RAG 인덱스를 재빌드한다 — 그 결과 "요약에는 이미지 설명이 있지만 Q&A 검색은 못 봄" 비대칭 해소.
  // 문서 전환(setDocument) 시 자동으로 null 로 초기화.
  enrichedPageTexts: string[] | null;
  // v0.18.19 patch R32 P3: setEnrichedPageTexts 가 호출될 때마다 단조 증가하는 카운터.
  // useRagBuilder 의 fingerprint 가 이전엔 `e${pageTexts.length}` 였는데 length 가 동일한
  // 두 번째 Vision 패스는 동일 fingerprint → 재빌드 트리거 안 됨 (Surface 1 P4). 이 카운터를
  // 사용해 같은 길이/다른 내용의 enrichment 도 감지한다.
  enrichedPageTextsVersion: number;
  setEnrichedPageTexts: (pages: string[] | null) => void;

  // 설정
  settings: AppSettings;
  updateSettings: (settings: AppSettings) => void;
  loadSettings: () => Promise<void>;

  // OCR
  ocrProgress: { current: number; total: number } | null;
  setOcrProgress: (p: { current: number; total: number } | null) => void;

  // Ollama 상태
  ollamaStatus: OllamaStatus;
  setOllamaStatus: (status: OllamaStatus) => void;

  // UI
  view: 'main' | 'settings' | 'setup';
  setView: (view: 'main' | 'settings' | 'setup') => void;
  error: AppError | null;
  setError: (error: AppError | null) => void;
  // v0.18.6 D1 fix: 에러와 분리된 정보성 notice 채널.
  // 다중 파일 드롭 등 "처리는 정상, 사용자에게 안내만" 케이스에서 setError 채널을 쓰면
  // 후속 setError(null) (파싱 성공 시 pdf-parser 가 호출) 으로 경고가 즉시 지워졌다.
  notice: { message: string } | null;
  setNotice: (notice: { message: string } | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // PDF
  document: null,
  isParsing: false,
  // 다중 문서 탭 (multi-doc Phase 1)
  openTabs: [],
  upsertOpenTab: (tab) => set((s) => {
    const idx = s.openTabs.findIndex((t) => t.filePath === tab.filePath);
    if (idx === -1) return { openTabs: [...s.openTabs, tab] };
    const next = s.openTabs.slice();
    next[idx] = tab;
    return { openTabs: next };
  }),
  removeOpenTab: (filePath) => set((s) => {
    const removed = s.openTabs.find((t) => t.filePath === filePath);
    const openTabs = s.openTabs.filter((t) => t.filePath !== filePath);
    // 닫힌 탭의 docHash 를 컬렉션 멤버에서도 제거 — 닫은 문서가 조용히 검색되거나
    // memberHashes 가 openTabs 와 어긋나 stale 상태로 남는 것을 방지.
    let collection = s.collection;
    if (removed?.docHash && collection.memberHashes.includes(removed.docHash)) {
      collection = { ...collection, memberHashes: collection.memberHashes.filter((h) => h !== removed.docHash) };
    }
    // 모든 탭이 닫히면(문서 묶음 종료) 컬렉션 모드도 초기화 — 다음 묶음에 이전 상태가 새지 않도록.
    // (탭 전환/+ 새 탭은 openTabs 가 비지 않으므로 컬렉션 상태 유지)
    if (openTabs.length === 0 && (collection.enabled || collection.memberHashes.length > 0)) {
      collection = { enabled: false, memberHashes: [] };
    }
    return { openTabs, collection };
  }),

  // 다중 문서 컬렉션 Q&A (multi-doc Phase 2)
  collection: { enabled: false, memberHashes: [] },
  setCollectionEnabled: (enabled) => set((s) => ({
    collection: { ...s.collection, enabled },
  })),
  setCollectionMembers: (memberHashes) => set((s) => ({
    collection: { ...s.collection, memberHashes },
  })),
  toggleCollectionMember: (docHash) => set((s) => {
    const has = s.collection.memberHashes.includes(docHash);
    const memberHashes = has
      ? s.collection.memberHashes.filter((h) => h !== docHash)
      : [...s.collection.memberHashes, docHash];
    return { collection: { ...s.collection, memberHashes } };
  }),
  isCollectionBusy: false,
  setCollectionBusy: (isCollectionBusy) => set({ isCollectionBusy }),
  collectionOpenInFlight: false,
  setCollectionOpenInFlight: (collectionOpenInFlight) => set({ collectionOpenInFlight }),
  setDocument: (document) => {
    if (!document) {
      // 문서 닫기 시 RAG 인덱스 + 요약/Q&A 상태 전부 해제. resetSummaryState 와 수렴.
      // 기존에는 summary/summaryStream/qaMessages 가 stale 하게 남아 다른 호출 경로에서
      // 새 문서 없이 이전 요약이 재표시되는 문제가 있었음.
      useAppStore.getState().resetSummaryState();
    } else {
      // R28 P2 (v0.18.12): 새 문서 로드 시에도 resetSummaryState 를 먼저 호출해
      // 이전 문서의 summary / summaryStream / qaMessages / pdfBytes / RAG 인덱스가 stale
      // 상태로 누출되지 않도록 함. 이전에는 호출자가 reset 을 미리 호출하는 것에 암묵적으로
      // 의존했고, 새로운 호출 경로(예: 추후 추가될 IPC drag-drop) 가 그 가드를 잊으면
      // 이전 문서의 요약이 새 문서에 따라붙는 회귀가 가능했다.
      useAppStore.getState().resetSummaryState();
      // resetSummaryState 가 document 를 null 로 비운 직후 새 document 로 교체.
      // Zustand set 은 synchronous 라 두 호출은 같은 batch 로 단일 re-render 만 유발.
      set({ document, enrichedPageTexts: null });
    }
  },
  setIsParsing: (isParsing) => set({ isParsing }),

  // 요약
  summary: null,
  summaryStream: '',
  summaryCollapsed: false,
  setSummaryCollapsed: (summaryCollapsed) => set({ summaryCollapsed }),
  summaryType: 'full',
  summaryPageRange: null,
  isGenerating: false,
  currentRequestId: null,
  progress: 0,
  progressInfo: null,
  setSummary: (summary) => set({ summary }),
  appendStream: (token) => {
    // v0.18.22 R36 P1: 세션이 이미 종료된 상태(isGenerating=false)면 토큰을 무시한다.
    // appendQaStream(R32 P3) 과 대칭 — 사용자 Stop → handleAbort 가 flushStream + setIsGenerating(false)
    // 직후, in-flight for-await 루프가 다음 iteration 의 isGenerating 체크 전에 추가 토큰을
    // append 하면 cleared 가 false 로 reset 되어 50ms flush 가 ghost token 을 summaryStream 으로
    // 흘리던 경로. QA 측 입구 게이트(line 334) 의 미러.
    if (!useAppStore.getState().isGenerating) return;
    streamState.cleared = false;
    streamState.buffer += token;
    if (!streamState.flushTimer) {
      streamState.flushTimer = setTimeout(() => {
        if (streamState.cleared) { streamState.flushTimer = null; return; }
        const buffered = streamState.buffer;
        streamState.buffer = '';
        streamState.flushTimer = null;
        set((s) => ({ summaryStream: s.summaryStream + buffered }));
      }, 50);
    }
  },
  flushStream: () => {
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    if (streamState.buffer) {
      const buffered = streamState.buffer;
      streamState.buffer = '';
      set((s) => ({ summaryStream: s.summaryStream + buffered }));
    }
  },
  clearStream: () => {
    // cleared 플래그로 이미 dequeue된 flush 타이머 콜백의 실행 방지 (ghost text 방지)
    streamState.cleared = true;
    streamState.buffer = '';
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    set({ summaryStream: '' });
  },
  replaceSummaryStream: (content) => {
    // 후처리된 전체 내용으로 교체. 이미 flushStream 호출 이후이므로 버퍼 정리만 수행.
    streamState.buffer = '';
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    set({ summaryStream: content });
  },
  setSummaryType: (summaryType) => set({ summaryType }),
  setSummaryPageRange: (summaryPageRange) => set({ summaryPageRange }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setCurrentRequestId: (currentRequestId) => set({ currentRequestId }),
  setProgress: (progress) => set({ progress }),
  setProgressInfo: (progressInfo) => set({ progressInfo }),
  resetSummaryState: () => {
    streamState.reset();
    qaStreamState.reset();
    // v0.18.20 R32 P2: in-flight ai 요청 abort. 이전에는 setDocument(newDoc) → resetSummaryState
    // 가 store 플래그만 비우고 main 의 AiClient.summarize generator 는 계속 토큰을 yield 했다.
    // 사용자가 새 문서로 빠르게 질문하면 stale 루프가 새 세션의 qaStream / appendQaStream 으로
    // 토큰을 흘려보내 두 세션 토큰이 인터리브되는 cross-session contamination 발생
    // (R32 Surface 1 P2). 여기서 IPC 를 즉시 끊어 root cause 차단 — 비용(클라우드 토큰)도
    // 같이 절약. window.electronAPI 가 없는 테스트 환경에서는 silent no-op.
    const prevState = useAppStore.getState();
    const electronAPI = (globalThis as { window?: { electronAPI?: { ai?: { abort?: (id: string) => Promise<unknown> } } } })
      .window?.electronAPI;
    if (electronAPI?.ai?.abort) {
      if (prevState.qaRequestId) electronAPI.ai.abort(prevState.qaRequestId).catch(() => {});
      if (prevState.currentRequestId) electronAPI.ai.abort(prevState.currentRequestId).catch(() => {});
    }
    // RAG 인덱스 초기화
    const { ragIndex } = prevState;
    ragIndex.clear();
    set({
      document: null,
      summaryStream: '',
      summaryCollapsed: false,
      summaryPageRange: null, // 페이지 범위는 문서별이므로 전환 시 전체로 리셋
      isGenerating: false,
      progress: 0,
      progressInfo: null,
      summary: null,
      currentRequestId: null,
      qaMessages: [],
      qaStream: '',
      isQaGenerating: false,
      qaRequestId: null,
      qaVerifying: false,
      ocrProgress: null,
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
      // 문서 전환 시 PdfViewer 패널도 닫히고 원본 바이트도 해제
      citationTarget: null,
      pdfBytes: null,
      enrichedPageTexts: null,
      // session-persistence: 이전 문서의 복원 마커/게이트 초기화 (stale skip 방지).
      // handlePdfData 는 setDocument 직후 다시 sessionRestorePending=true 로 설정한다.
      restoredSession: null,
      sessionRestorePending: false,
    });
  },

  // Q&A
  qaMessages: [],
  qaStream: '',
  isQaGenerating: false,
  qaRequestId: null,
  qaVerifying: false,
  setQaVerifying: (qaVerifying) => set({ qaVerifying }),
  addQaMessage: (msg) => set((s) => {
    const MAX_QA_TURNS = 10;
    const MAX_MSGS = MAX_QA_TURNS * 2;
    const msgs = [...s.qaMessages, { ...msg, id: safeRandomId() }];
    // v0.18.5 M3 fix: 이전에는 `slice(-MAX_MSGS)` 로 단일 메시지 drop 시
    // 윈도우 선두가 assistant 로 시작하는 orphan 상태가 만들어졌다 (user→assistant
    // 쌍이 깨져 LLM history 주입 시 "질문 없는 답변" 패턴이 컨텍스트 오염).
    // 항상 user→assistant 쌍 단위(짝수)로 drop 하여 정합성 유지.
    if (msgs.length > MAX_MSGS) {
      const excess = msgs.length - MAX_MSGS;
      // 홀수 excess 면 다음 짝까지 추가로 1개 더 drop (pair-align)
      const dropCount = excess + (excess % 2);
      return { qaMessages: msgs.slice(dropCount) };
    }
    return { qaMessages: msgs };
  }),
  appendQaStream: (token) => {
    // v0.18.19 patch R32 P3: 세션이 이미 종료된 상태(isQaGenerating=false)면 토큰을 무시한다.
    // 이전엔 handleQaAbort 가 clearQaStream 으로 cleared=true 를 세팅한 직후라도, in-flight
    // for-await 루프가 next iteration 의 isQaGenerating 체크 전에 추가 토큰을 append 하면
    // cleared 가 false 로 reset 되어 50ms flush 가 ghost token 을 qaStream 에 흘리던 경로
    // (R32 Surface 1 P4). 토큰 입구에서 한 번 더 게이트.
    if (!useAppStore.getState().isQaGenerating) return;
    qaStreamState.cleared = false;
    qaStreamState.buffer += token;
    if (!qaStreamState.flushTimer) {
      qaStreamState.flushTimer = setTimeout(() => {
        if (qaStreamState.cleared) { qaStreamState.flushTimer = null; return; }
        const buffered = qaStreamState.buffer;
        qaStreamState.buffer = '';
        qaStreamState.flushTimer = null;
        set((s) => ({ qaStream: s.qaStream + buffered }));
      }, 50);
    }
  },
  flushQaStream: () => {
    if (qaStreamState.flushTimer) {
      clearTimeout(qaStreamState.flushTimer);
      qaStreamState.flushTimer = null;
    }
    if (qaStreamState.buffer) {
      const buffered = qaStreamState.buffer;
      qaStreamState.buffer = '';
      set((s) => ({ qaStream: s.qaStream + buffered }));
    }
  },
  clearQaStream: () => {
    qaStreamState.cleared = true;
    qaStreamState.buffer = '';
    if (qaStreamState.flushTimer) {
      clearTimeout(qaStreamState.flushTimer);
      qaStreamState.flushTimer = null;
    }
    set({ qaStream: '' });
  },
  setQaMessages: (messages) => set({ qaMessages: messages }),
  setIsQaGenerating: (isQaGenerating) => set({ isQaGenerating }),
  setQaRequestId: (qaRequestId) => set({ qaRequestId }),
  clearQa: () => {
    qaStreamState.reset();
    set({ qaMessages: [], qaStream: '', isQaGenerating: false, qaRequestId: null, qaVerifying: false });
  },

  // RAG
  ragIndex: new VectorStore(),
  ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
  setRagState: (partial) => set((s) => ({ ragState: { ...s.ragState, ...partial } })),
  setRagIndex: (ragIndex) => set({ ragIndex }),
  sessionRestorePending: false,
  setSessionRestorePending: (sessionRestorePending) => set({ sessionRestorePending }),
  restoredSession: null,
  setRestoredSession: (restoredSession) => set({ restoredSession }),

  // Page citation — Design Ref §4.2
  citationTarget: null,
  citationJumpNonce: 0,
  setCitationTarget: (target) =>
    set((s) => ({
      citationTarget: target,
      // 점프 지정(non-null)마다 nonce 증가 → 동일 페이지여도 effect 재발화. 닫기(null)는 유지.
      citationJumpNonce: target ? s.citationJumpNonce + 1 : s.citationJumpNonce,
    })),
  pdfBytes: null,
  setPdfBytes: (bytes) => set({ pdfBytes: bytes }),

  enrichedPageTexts: null,
  enrichedPageTextsVersion: 0,
  // R32 P3: 매 호출마다 version 증가 → useRagBuilder fingerprint 가 길이만 같고 내용이 다른
  // enrichment 도 정확히 감지하여 재빌드 트리거.
  // v0.18.22 R36 P2: 동일 reference(특히 반복적인 null) 호출은 no-op 으로 처리하여 불필요한
  // version bump 를 차단. fingerprint 가 향후 `r` 분기에서 version 을 포함하도록 바뀌어도
  // false-positive 재빌드가 발생하지 않도록 방어적 가드.
  setEnrichedPageTexts: (pages) => set((s) => (
    s.enrichedPageTexts === pages
      ? s
      : { enrichedPageTexts: pages, enrichedPageTextsVersion: s.enrichedPageTextsVersion + 1 }
  )),
  // DR-01: 패널 너비 비율 — localStorage 에서 복원, 기본 0.5
  citationPanelWidth: (() => {
    try {
      const stored = localStorage.getItem('citationPanelWidth');
      if (stored) {
        const v = Number.parseFloat(stored);
        if (Number.isFinite(v) && v >= 0.2 && v <= 0.8) return v;
      }
    } catch { /* 접근 실패 무시 */ }
    return 0.5;
  })(),
  setCitationPanelWidth: (ratio) => {
    const clamped = Math.min(0.8, Math.max(0.2, ratio));
    set({ citationPanelWidth: clamped });
    // 드래그 중 pointermove 마다 호출되므로 localStorage 쓰기는 trailing 200ms 디바운스.
    // 마지막 값만 저장되어 동기 I/O 비용을 수백 회 → 1 회로 줄인다.
    if (citationPanelWidthSaveTimer) clearTimeout(citationPanelWidthSaveTimer);
    citationPanelWidthSaveTimer = setTimeout(() => {
      citationPanelWidthSaveTimer = null;
      try { localStorage.setItem('citationPanelWidth', String(clamped)); } catch { /* 무시 */ }
    }, 200);
  },

  // 설정
  settings: DEFAULT_SETTINGS,
  updateSettings: (newSettings) => {
    set({ settings: newSettings as AppSettings });
    // 디바운스: 빠른 연속 변경 시 마지막 1건만 IPC 전송 (TOCTOU 경쟁 방지)
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    // C5-M3: 커밋 대기자 arm — whenSettingsCommitted() 소비자(RAG 재빌드)가 main settings.json
    // 이 실제로 갱신될 때까지 기다릴 수 있게 한다. 연속 변경은 같은 promise 로 수렴(마지막
    // flush 에서 일괄 settle).
    if (!settingsCommitResolve) {
      settingsCommitPromise = new Promise<void>((resolve) => { settingsCommitResolve = resolve; });
    }
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      // 성공/실패/컨텍스트 소실 모두에서 settle — 소비자는 "커밋 시도가 끝났다"만 알면 된다
      // (실패 시 main 은 구 설정으로 남지만, 에러 배너가 뜨고 다음 변경에서 재시도).
      const settleCommit = () => { settingsCommitResolve?.(); settingsCommitResolve = null; };
      // 300ms 후 발화 시점에 렌더러 컨텍스트(window/electronAPI)가 이미 사라졌을 수 있다
      // (앱 종료 직전, 테스트 환경 teardown). 동기 ReferenceError(unhandled)를 막기 위해 가드.
      if (typeof window === 'undefined' || !window.electronAPI?.settings?.set) { settleCommit(); return; }
      window.electronAPI.settings.set(newSettings as unknown as Record<string, unknown>).then(settleCommit, () => {
        // store 에서 i18n 모듈을 직접 import 하면 circular dependency 발생 (i18n → store).
        // 대신 store 자체에서 현재 uiLanguage 를 읽어 최소 번역을 inline 으로 수행.
        const lang = useAppStore.getState().settings.uiLanguage;
        const message = lang === 'en'
          ? 'Failed to save settings. Please try again.'
          : '설정 저장에 실패했습니다. 다시 시도해주세요.';
        set({ error: { code: 'SETTINGS_SAVE_FAIL' as const, message } });
        settleCommit();
      });
    }, 300);
  },
  loadSettings: async () => {
    try {
      const saved = await window.electronAPI.settings.get();
      set((s) => {
        const merged = { ...s.settings, ...saved } as AppSettings;
        const update: Partial<AppState> = { settings: merged };
        // defaultSummaryType 설정을 summaryType에 반영
        if (merged.defaultSummaryType) {
          update.summaryType = merged.defaultSummaryType;
        }
        return update;
      });
    } catch {
      // 저장된 설정 없으면 기본값 유지
    }
  },

  // OCR
  ocrProgress: null,
  setOcrProgress: (ocrProgress) => set({ ocrProgress }),

  // Ollama 상태
  ollamaStatus: { installed: false, running: false, models: [] },
  setOllamaStatus: (ollamaStatus) => set({ ollamaStatus }),

  // UI
  view: 'main',
  setView: (view) => set({ view }),
  error: null,
  // v0.18.20 R32 P2: 모든 setError 호출에 sanitizeErrorPath 자동 적용.
  // 이전에는 AppErrorBoundary 의 render-time exception 경로만 sanitize 되고,
  // setError({ message: err.message }) 식으로 직접 banner 에 들어가는 경로(App.tsx
  // drop/Ctrl+O, PdfUploader handleFileSelect, store 자체의 SETTINGS_SAVE_FAIL 등)는
  // pdfjs / main process 의 절대경로를 그대로 노출했다 (R32 Surface 3 P2). 중앙집중
  // sanitize 로 미래에 추가될 호출자도 자동 커버.
  setError: (error) => set({
    error: error ? { ...error, message: sanitizeErrorPath(error.message) } : null,
  }),
  notice: null,
  // R30 P2 (v0.18.18): notice 는 사용자에게 영구 표시할 게 아닌 일시적 알림 (다중 파일 드롭
  // 안내 등) 이라 자동 dismiss 가 자연스럽다. 새 setNotice 가 호출되면 이전 타이머는 cancel.
  setNotice: (notice) => {
    if (noticeDismissTimer !== null) {
      clearTimeout(noticeDismissTimer);
      noticeDismissTimer = null;
    }
    set({ notice });
    if (notice !== null) {
      noticeDismissTimer = setTimeout(() => {
        // 타이머 fire 시점에 동일 notice 가 여전히 있는지 비교 — 사이에 새 notice 로 교체된
        // 경우 그것의 타이머에 의존해야 하므로 dismiss 하지 않음.
        if (useAppStore.getState().notice === notice) {
          set({ notice: null });
        }
        noticeDismissTimer = null;
      }, NOTICE_DISMISS_MS);
    }
  },
}));

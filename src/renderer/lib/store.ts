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
import { DEFAULT_SETTINGS } from '../types';
import { VectorStore } from './vector-store';

// 설정 저장 IPC 디바운스 타이머
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
// citationPanelWidth localStorage 저장 디바운스 타이머 — 드래그 중 pointermove 마다
// setCitationPanelWidth 가 호출되어 동기 localStorage.setItem 이 초당 수백 회 발생하는 것 방지
let citationPanelWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (citationPanelWidthSaveTimer) { clearTimeout(citationPanelWidthSaveTimer); citationPanelWidthSaveTimer = null; }
  });
}

interface AppState {
  // PDF
  document: PdfDocument | null;
  isParsing: boolean;
  setDocument: (doc: PdfDocument | null) => void;
  setIsParsing: (v: boolean) => void;

  // 요약
  summary: Summary | null;
  summaryStream: string;
  summaryType: DefaultSummaryType;
  isGenerating: boolean;
  currentRequestId: string | null;
  progress: number;
  progressInfo: ProgressInfo | null;
  setSummary: (summary: Summary | null) => void;
  appendStream: (token: string) => void;
  flushStream: () => void;
  clearStream: () => void;
  /** 후처리된 전체 내용으로 summaryStream을 교체. 호출 전에 반드시 flushStream() 수행. */
  replaceSummaryStream: (content: string) => void;
  setSummaryType: (type: DefaultSummaryType) => void;
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

  // Page citation (Design Ref: §4.2) — page-citation-viewer 기능
  // null 이면 PdfViewer 패널 비활성, { page: N } 이면 해당 페이지로 스크롤
  citationTarget: { page: number } | null;
  setCitationTarget: (target: { page: number } | null) => void;
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
}

export const useAppStore = create<AppState>((set) => ({
  // PDF
  document: null,
  isParsing: false,
  setDocument: (document) => {
    if (!document) {
      // 문서 닫기 시 RAG 인덱스 + 요약/Q&A 상태 전부 해제. resetSummaryState 와 수렴.
      // 기존에는 summary/summaryStream/qaMessages 가 stale 하게 남아 다른 호출 경로에서
      // 새 문서 없이 이전 요약이 재표시되는 문제가 있었음.
      useAppStore.getState().resetSummaryState();
    } else {
      // 새 문서 로드 시 이전 문서의 enrichedPageTexts 는 무효 — 반드시 초기화.
      // resetSummaryState 경로(setDocument(null))와 달리 여기서는 document 만 교체하므로
      // 명시적으로 null 세팅.
      set({ document, enrichedPageTexts: null });
    }
  },
  setIsParsing: (isParsing) => set({ isParsing }),

  // 요약
  summary: null,
  summaryStream: '',
  summaryType: 'full',
  isGenerating: false,
  currentRequestId: null,
  progress: 0,
  progressInfo: null,
  setSummary: (summary) => set({ summary }),
  appendStream: (token) => {
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
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setCurrentRequestId: (currentRequestId) => set({ currentRequestId }),
  setProgress: (progress) => set({ progress }),
  setProgressInfo: (progressInfo) => set({ progressInfo }),
  resetSummaryState: () => {
    streamState.reset();
    qaStreamState.reset();
    // RAG 인덱스 초기화
    const { ragIndex } = useAppStore.getState();
    ragIndex.clear();
    set({
      document: null,
      summaryStream: '',
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

  // Page citation — Design Ref §4.2
  citationTarget: null,
  setCitationTarget: (target) => set({ citationTarget: target }),
  pdfBytes: null,
  setPdfBytes: (bytes) => set({ pdfBytes: bytes }),

  enrichedPageTexts: null,
  setEnrichedPageTexts: (pages) => set({ enrichedPageTexts: pages }),
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
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      window.electronAPI.settings.set(newSettings as unknown as Record<string, unknown>).catch(() => {
        // store 에서 i18n 모듈을 직접 import 하면 circular dependency 발생 (i18n → store).
        // 대신 store 자체에서 현재 uiLanguage 를 읽어 최소 번역을 inline 으로 수행.
        const lang = useAppStore.getState().settings.uiLanguage;
        const message = lang === 'en'
          ? 'Failed to save settings. Please try again.'
          : '설정 저장에 실패했습니다. 다시 시도해주세요.';
        set({ error: { code: 'SETTINGS_SAVE_FAIL' as const, message } });
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
  setError: (error) => set({ error }),
}));

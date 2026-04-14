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
  addQaMessage: (msg: Omit<QaMessage, 'id'>) => void;
  appendQaStream: (token: string) => void;
  flushQaStream: () => void;
  clearQaStream: () => void;
  setIsQaGenerating: (v: boolean) => void;
  setQaRequestId: (id: string | null) => void;
  clearQa: () => void;

  // RAG
  ragIndex: VectorStore;
  ragState: RagIndexState;
  setRagState: (state: Partial<RagIndexState>) => void;

  // Page citation (Design Ref: §4.2) — page-citation-viewer 기능
  // null 이면 PdfViewer 패널 비활성, { page: N } 이면 해당 페이지로 스크롤
  citationTarget: { page: number } | null;
  setCitationTarget: (target: { page: number } | null) => void;

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
      set({ document });
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
      ocrProgress: null,
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
      // 문서 전환 시 PdfViewer 패널도 닫힘
      citationTarget: null,
    });
  },

  // Q&A
  qaMessages: [],
  qaStream: '',
  isQaGenerating: false,
  qaRequestId: null,
  addQaMessage: (msg) => set((s) => {
    const MAX_QA_TURNS = 10;
    const msgs = [...s.qaMessages, { ...msg, id: safeRandomId() }];
    // 10턴(20메시지) 초과 시 FIFO — 가장 오래된 쌍 제거
    if (msgs.length > MAX_QA_TURNS * 2) {
      return { qaMessages: msgs.slice(msgs.length - MAX_QA_TURNS * 2) };
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
    set({ qaMessages: [], qaStream: '', isQaGenerating: false, qaRequestId: null });
  },

  // RAG
  ragIndex: new VectorStore(),
  ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
  setRagState: (partial) => set((s) => ({ ragState: { ...s.ragState, ...partial } })),

  // Page citation — Design Ref §4.2
  citationTarget: null,
  setCitationTarget: (target) => set({ citationTarget: target }),

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

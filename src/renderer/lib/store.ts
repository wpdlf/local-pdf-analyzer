import { create } from 'zustand';
import type {
  PdfDocument,
  Summary,
  SummaryType,
  AppSettings,
  OllamaStatus,
  AppError,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';

interface AppState {
  // PDF
  document: PdfDocument | null;
  isParsing: boolean;
  setDocument: (doc: PdfDocument | null) => void;
  setIsParsing: (v: boolean) => void;

  // 요약
  summary: Summary | null;
  summaryStream: string;
  summaryType: SummaryType;
  isGenerating: boolean;
  currentRequestId: string | null;
  progress: number;
  setSummary: (summary: Summary | null) => void;
  appendStream: (token: string) => void;
  clearStream: () => void;
  getStreamText: () => string;
  setSummaryType: (type: SummaryType) => void;
  setIsGenerating: (v: boolean) => void;
  setCurrentRequestId: (id: string | null) => void;
  setProgress: (p: number) => void;

  // 설정
  settings: AppSettings;
  updateSettings: (settings: AppSettings) => void;
  loadSettings: () => Promise<void>;

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
  setDocument: (document) => set({ document }),
  setIsParsing: (isParsing) => set({ isParsing }),

  // 요약
  summary: null,
  summaryStream: '',
  summaryType: 'full',
  isGenerating: false,
  currentRequestId: null,
  progress: 0,
  setSummary: (summary) => set({ summary }),
  appendStream: (token) => set((s) => ({
    summaryStream: s.summaryStream + token,
  })),
  clearStream: () => set({ summaryStream: '' }),
  getStreamText: () => useAppStore.getState().summaryStream,
  setSummaryType: (summaryType) => set({ summaryType }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setCurrentRequestId: (currentRequestId) => set({ currentRequestId }),
  setProgress: (progress) => set({ progress }),

  // 설정
  settings: DEFAULT_SETTINGS,
  updateSettings: (newSettings) => {
    set({ settings: newSettings as AppSettings });
    window.electronAPI.settings.set(newSettings as Record<string, unknown>).catch(() => {
      set({ error: { code: 'EXPORT_FAIL' as const, message: '설정 저장에 실패했습니다. 다시 시도해주세요.' } });
    });
  },
  loadSettings: async () => {
    try {
      const saved = await window.electronAPI.settings.get();
      set((s) => ({ settings: { ...s.settings, ...saved } as AppSettings }));
    } catch {
      // 저장된 설정 없으면 기본값 유지
    }
  },

  // Ollama 상태
  ollamaStatus: { installed: false, running: false, models: [] },
  setOllamaStatus: (ollamaStatus) => set({ ollamaStatus }),

  // UI
  view: 'main',
  setView: (view) => set({ view }),
  error: null,
  setError: (error) => set({ error }),
}));

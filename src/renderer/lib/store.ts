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
  setDocument: (doc: PdfDocument | null) => void;

  // 요약
  summary: Summary | null;
  summaryStream: string;
  summaryType: SummaryType;
  isGenerating: boolean;
  progress: number;
  setSummary: (summary: Summary | null) => void;
  appendStream: (token: string) => void;
  clearStream: () => void;
  setSummaryType: (type: SummaryType) => void;
  setIsGenerating: (v: boolean) => void;
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
  setDocument: (document) => set({ document }),

  // 요약
  summary: null,
  summaryStream: '',
  summaryType: 'full',
  isGenerating: false,
  progress: 0,
  setSummary: (summary) => set({ summary }),
  appendStream: (token) => set((s) => ({ summaryStream: s.summaryStream + token })),
  clearStream: () => set({ summaryStream: '' }),
  setSummaryType: (summaryType) => set({ summaryType }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setProgress: (progress) => set({ progress }),

  // 설정
  settings: DEFAULT_SETTINGS,
  updateSettings: (newSettings) => {
    set(() => {
      // 전체 설정을 디스크에 저장
      window.electronAPI.settings.set(newSettings as Record<string, unknown>).catch(() => {
        console.error('설정 저장 실패');
      });
      return { settings: newSettings as AppSettings };
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

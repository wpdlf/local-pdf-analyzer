import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SessionManifestEntry, SessionStats, SessionSaveMeta, GlobalSearchResult, SemanticSearchResponse } from '../shared/session-types';
import type { SavedCollection } from '../shared/collection-types';
import type { UpdateState } from '../shared/update-types';

contextBridge.exposeInMainWorld('electronAPI', {
  ollama: {
    getStatus: () => ipcRenderer.invoke('ollama:status'),
    install: () => ipcRenderer.invoke('ollama:install'),
    start: () => ipcRenderer.invoke('ollama:start'),
    stop: () => ipcRenderer.invoke('ollama:stop'),
    pullModel: (model: string) => ipcRenderer.invoke('ollama:pull-model', model),
    cancelPull: () => ipcRenderer.invoke('ollama:cancel-pull'),
    listModels: () => ipcRenderer.invoke('ollama:list-models'),
  },
  ai: {
    generate: (requestId: string, request: {
      text: string;
      type: 'full' | 'chapter' | 'keywords' | 'qa' | 'custom';
      provider: 'ollama' | 'claude' | 'openai' | 'gemini';
      model: string;
      ollamaBaseUrl: string;
      temperature?: number;
      language?: string;
      customPrompt?: string;
    }) => ipcRenderer.invoke('ai:generate', requestId, request),
    abort: (requestId: string) => ipcRenderer.invoke('ai:abort', requestId),
    checkAvailable: (provider: 'ollama' | 'claude' | 'openai' | 'gemini', ollamaBaseUrl: string) =>
      ipcRenderer.invoke('ai:check-available', provider, ollamaBaseUrl),
    analyzeImage: (imageBase64: string, requestId?: string) => ipcRenderer.invoke('ai:analyze-image', imageBase64, requestId),
    ocrPage: (imageBase64: string, requestId?: string) => ipcRenderer.invoke('ai:ocr-page', imageBase64, requestId),
    embed: (texts: string[], requestId?: string) => ipcRenderer.invoke('ai:embed', texts, requestId),
    checkEmbedModel: () => ipcRenderer.invoke('ai:check-embed-model'),
    onToken: (callback: (requestId: string, token: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string, token: string) =>
        callback(requestId, token);
      ipcRenderer.on('ai:token', handler);
      return () => ipcRenderer.removeListener('ai:token', handler);
    },
    onDone: (callback: (requestId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string) =>
        callback(requestId);
      ipcRenderer.on('ai:done', handler);
      return () => ipcRenderer.removeListener('ai:done', handler);
    },
  },
  file: {
    save: (content: string, defaultName: string) =>
      ipcRenderer.invoke('file:save', content, defaultName),
    exportPdf: (html: string, defaultName: string) =>
      ipcRenderer.invoke('file:export-pdf', html, defaultName),
    openPdf: () => ipcRenderer.invoke('file:open-pdf'),
    openPath: (targetPath: string) => ipcRenderer.invoke('file:open-path', targetPath),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: Record<string, unknown>) => ipcRenderer.invoke('settings:set', settings),
  },
  apiKey: {
    save: (provider: 'ollama' | 'claude' | 'openai' | 'gemini', key: string) => ipcRenderer.invoke('apikey:save', provider, key),
    has: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => ipcRenderer.invoke('apikey:has', provider),
    delete: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => ipcRenderer.invoke('apikey:delete', provider),
  },
  session: {
    load: (docHash: string) => ipcRenderer.invoke('session:load', docHash),
    loadMeta: (docHash: string) => ipcRenderer.invoke('session:loadMeta', docHash),
    save: (payload: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean }) =>
      ipcRenderer.invoke('session:save', payload),
    savePartial: (payload: { docHash: string; summary: { type: string; content: string; model: string; provider: string } | null; summaryType: string; qaMessages: unknown }) =>
      ipcRenderer.invoke('session:savePartial', payload),
    saveSummary: (payload: { docHash: string; type: string; summary: { content: string; model: string; provider: string } }) =>
      ipcRenderer.invoke('session:saveSummary', payload),
    list: () => ipcRenderer.invoke('session:list'),
    delete: (docHash: string) => ipcRenderer.invoke('session:delete', docHash),
    clear: () => ipcRenderer.invoke('session:clear'),
    stats: () => ipcRenderer.invoke('session:stats'),
    search: (query: string) => ipcRenderer.invoke('session:search', query),
    searchSemantic: (queryEmbedding: number[], model: string, dim: number) =>
      ipcRenderer.invoke('session:searchSemantic', queryEmbedding, model, dim),
  },
  // multi-doc Phase 3 (module-1): 컬렉션 영속화
  collections: {
    list: () => ipcRenderer.invoke('collections:list'),
    save: (input: { id?: string; name: string; docHashes: string[] }) =>
      ipcRenderer.invoke('collections:save', input),
    delete: (id: string) => ipcRenderer.invoke('collections:delete', id),
  },
  // 자동 업데이트(electron-updater). 모든 조작은 main 이 상태 머신으로 게이트하므로 preload 는
  // 순수 전달만 한다. onStatus 는 check/download 진행을 push 로 받는 채널.
  update: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback: (state: UpdateState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
      ipcRenderer.on('update:status', handler);
      return () => ipcRenderer.removeListener('update:status', handler);
    },
  },
  openExternal: (url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return Promise.resolve();
    return ipcRenderer.invoke('shell:open-external', url);
  },
  // multi-doc Phase 1 fix: DOM 드래그앤드롭의 File 에서 실제 절대경로 획득 (Electron 공식
  // webUtils API — sandboxed preload 허용 모듈). 이전엔 드롭 경로가 파일명뿐이라 탭 전환/
  // 최근 문서 재오픈 시 file:open-path 가 파일을 찾지 못했다. 합성 File(테스트 등) 은 ''.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  onSetupProgress: (callback: (event: { key: string; params?: Record<string, string>; source?: 'install' | 'pull'; model?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progressEvent: { key: string; params?: Record<string, string>; source?: 'install' | 'pull'; model?: string }) => callback(progressEvent);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, file: { path: string; name: string; data: ArrayBuffer }) => callback(file);
    ipcRenderer.on('file:dropped', handler);
    return () => ipcRenderer.removeListener('file:dropped', handler);
  },
  // QA10(C-MED, 실데이터 손실): 종료(before-quit) 시 main 이 렌더러에 flush 를 요청하고 persist
  // 착지를 기다린다. 기존 pagehide flush 는 async(hash+IPC+원자적 쓰기)라 클라우드/외부 Ollama
  // 사용자는 ollamaManager.stop() 이 즉시 리턴해 quit 이 persist 를 앞질러 마지막 델타를 소실했다.
  // main 은 flushBeforeQuitDone ack 또는 하드 타임아웃까지 quit 을 보류한다(무응답 시 강제 진행).
  onFlushBeforeQuit: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:flush-before-quit', handler);
    return () => ipcRenderer.removeListener('app:flush-before-quit', handler);
  },
  flushBeforeQuitDone: () => ipcRenderer.send('app:flush-done'),
});

export type ElectronAPI = {
  ollama: {
    getStatus: () => Promise<{
      installed: boolean;
      running: boolean;
      version?: string;
      models: string[];
      /** QA18(C-MED): 앱이 spawn 한 프로세스인지(= 재시작이 실제로 가능한지). */
      managed: boolean;
    }>;
    install: () => Promise<{ success: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string> }>;
    start: () => Promise<boolean>;
    stop: () => Promise<boolean>;
    pullModel: (model: string) => Promise<{ success: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string> }>;
    cancelPull: () => Promise<{ success: boolean }>;
    listModels: () => Promise<string[]>;
  };
  ai: {
    generate: (requestId: string, request: {
      text: string;
      type: 'full' | 'chapter' | 'keywords' | 'qa' | 'custom';
      provider: 'ollama' | 'claude' | 'openai' | 'gemini';
      model: string;
      ollamaBaseUrl: string;
      temperature?: number;
      language?: string;
      customPrompt?: string;
    }) => Promise<{ success: boolean; error?: string; code?: string; errorKey?: string; errorParams?: Record<string, string> }>;
    abort: (requestId: string) => Promise<{ success: boolean; error?: string }>;
    analyzeImage: (imageBase64: string, requestId?: string) => Promise<{ success: boolean; description?: string; error?: string; code?: string }>;
    ocrPage: (imageBase64: string, requestId?: string) => Promise<{ success: boolean; text?: string; error?: string; code?: string }>;
    embed: (texts: string[], requestId?: string) => Promise<{ success: boolean; embeddings?: number[][]; model?: string; error?: string }>;
    checkEmbedModel: () => Promise<{ available: boolean; model?: string }>;
    checkAvailable: (provider: 'ollama' | 'claude' | 'openai' | 'gemini', ollamaBaseUrl: string) => Promise<boolean>;
    onToken: (callback: (requestId: string, token: string) => void) => () => void;
    onDone: (callback: (requestId: string) => void) => () => void;
  };
  file: {
    save: (content: string, defaultName: string) => Promise<string | null>;
    exportPdf: (html: string, defaultName: string) => Promise<string | null>;
    openPdf: () => Promise<{ path: string; name: string; data: ArrayBuffer } | { error: string } | null>;
    openPath: (targetPath: string) => Promise<{ path: string; name: string; data: ArrayBuffer } | { error: string }>;
  };
  settings: {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  apiKey: {
    // C5-L: code — main 이 에러 분류용으로 전파(KEYCHAIN_UNAVAILABLE / fs 에러코드).
    // 렌더러는 error 원문(한국어/절대경로 가능) 대신 code→i18n 매핑으로 표시한다.
    save: (provider: 'ollama' | 'claude' | 'openai' | 'gemini', key: string) => Promise<{ success: boolean; error?: string; code?: string }>;
    has: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => Promise<boolean>;
    delete: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => Promise<{ success: boolean; error?: string; code?: string }>;
  };
  session: {
    load: (docHash: string) => Promise<{ session: unknown; blob: ArrayBuffer | null } | null>;
    loadMeta: (docHash: string) => Promise<{ session: unknown } | null>;
    save: (payload: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean }) => Promise<{ ok: boolean }>;
    savePartial: (payload: { docHash: string; summary: { type: string; content: string; model: string; provider: string } | null; summaryType: string; qaMessages: unknown }) => Promise<{ ok: boolean }>;
    saveSummary: (payload: { docHash: string; type: string; summary: { content: string; model: string; provider: string } }) => Promise<{ ok: boolean }>;
    list: () => Promise<SessionManifestEntry[]>;
    delete: (docHash: string) => Promise<{ ok: boolean }>;
    clear: () => Promise<{ ok: boolean }>;
    stats: () => Promise<SessionStats>;
    search: (query: string) => Promise<GlobalSearchResult[]>;
    searchSemantic: (queryEmbedding: number[], model: string, dim: number) => Promise<SemanticSearchResponse>;
  };
  collections: {
    list: () => Promise<SavedCollection[]>;
    save: (input: { id?: string; name: string; docHashes: string[] }) => Promise<{ ok: boolean; id?: string }>;
    delete: (id: string) => Promise<{ ok: boolean }>;
  };
  update: {
    getState: () => Promise<UpdateState>;
    /** 수동 확인. main 이 진행 중이면 현재 상태를 그대로 돌려준다(재진입 무해). */
    check: () => Promise<UpdateState>;
    download: () => Promise<UpdateState>;
    /** 렌더러 flush 완주 후 앱을 종료하고 인스톨러를 실행 — 반환 전에 앱이 닫힐 수 있다. */
    install: () => Promise<UpdateState>;
    onStatus: (callback: (state: UpdateState) => void) => () => void;
  };
  openExternal: (url: string) => Promise<void>;
  getPathForFile: (file: File) => string;
  onSetupProgress: (callback: (event: { key: string; params?: Record<string, string>; source?: 'install' | 'pull'; model?: string }) => void) => () => void;
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => () => void;
  onFlushBeforeQuit: (callback: () => void) => () => void;
  flushBeforeQuitDone: () => void;
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

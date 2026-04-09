import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  ollama: {
    getStatus: () => ipcRenderer.invoke('ollama:status'),
    install: () => ipcRenderer.invoke('ollama:install'),
    start: () => ipcRenderer.invoke('ollama:start'),
    stop: () => ipcRenderer.invoke('ollama:stop'),
    pullModel: (model: string) => ipcRenderer.invoke('ollama:pull-model', model),
    listModels: () => ipcRenderer.invoke('ollama:list-models'),
  },
  ai: {
    generate: (requestId: string, request: {
      text: string;
      type: 'full' | 'chapter' | 'keywords' | 'qa';
      provider: 'ollama' | 'claude' | 'openai';
      model: string;
      ollamaBaseUrl: string;
      temperature?: number;
      language?: string;
    }) => ipcRenderer.invoke('ai:generate', requestId, request),
    abort: (requestId: string) => ipcRenderer.invoke('ai:abort', requestId),
    checkAvailable: (provider: 'ollama' | 'claude' | 'openai', ollamaBaseUrl: string) =>
      ipcRenderer.invoke('ai:check-available', provider, ollamaBaseUrl),
    analyzeImage: (imageBase64: string) => ipcRenderer.invoke('ai:analyze-image', imageBase64),
    ocrPage: (imageBase64: string) => ipcRenderer.invoke('ai:ocr-page', imageBase64),
    embed: (texts: string[]) => ipcRenderer.invoke('ai:embed', texts),
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
    openPdf: () => ipcRenderer.invoke('file:open-pdf'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: Record<string, unknown>) => ipcRenderer.invoke('settings:set', settings),
  },
  apiKey: {
    save: (provider: 'ollama' | 'claude' | 'openai', key: string) => ipcRenderer.invoke('apikey:save', provider, key),
    has: (provider: 'ollama' | 'claude' | 'openai') => ipcRenderer.invoke('apikey:has', provider),
    delete: (provider: 'ollama' | 'claude' | 'openai') => ipcRenderer.invoke('apikey:delete', provider),
  },
  openExternal: (url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return Promise.resolve();
    return ipcRenderer.invoke('shell:open-external', url);
  },
  onSetupProgress: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, file: { path: string; name: string; data: ArrayBuffer }) => callback(file);
    ipcRenderer.on('file:dropped', handler);
    return () => ipcRenderer.removeListener('file:dropped', handler);
  },
});

export type ElectronAPI = {
  ollama: {
    getStatus: () => Promise<{
      installed: boolean;
      running: boolean;
      version?: string;
      models: string[];
    }>;
    install: () => Promise<{ success: boolean; error?: string }>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    pullModel: (model: string) => Promise<{ success: boolean; error?: string }>;
    listModels: () => Promise<string[]>;
  };
  ai: {
    generate: (requestId: string, request: {
      text: string;
      type: 'full' | 'chapter' | 'keywords' | 'qa';
      provider: 'ollama' | 'claude' | 'openai';
      model: string;
      ollamaBaseUrl: string;
      temperature?: number;
      language?: string;
    }) => Promise<{ success: boolean; error?: string; code?: string }>;
    abort: (requestId: string) => Promise<{ success: boolean }>;
    analyzeImage: (imageBase64: string) => Promise<{ success: boolean; description?: string; error?: string }>;
    ocrPage: (imageBase64: string) => Promise<{ success: boolean; text?: string; error?: string }>;
    embed: (texts: string[]) => Promise<{ success: boolean; embeddings?: number[][]; model?: string; error?: string }>;
    checkEmbedModel: () => Promise<{ available: boolean; model?: string }>;
    checkAvailable: (provider: 'ollama' | 'claude' | 'openai', ollamaBaseUrl: string) => Promise<boolean>;
    onToken: (callback: (requestId: string, token: string) => void) => () => void;
    onDone: (callback: (requestId: string) => void) => () => void;
  };
  file: {
    save: (content: string, defaultName: string) => Promise<string | null>;
    openPdf: () => Promise<{ path: string; name: string; data: ArrayBuffer } | { error: string } | null>;
  };
  settings: {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  apiKey: {
    save: (provider: 'ollama' | 'claude' | 'openai', key: string) => Promise<{ success: boolean }>;
    has: (provider: 'ollama' | 'claude' | 'openai') => Promise<boolean>;
    delete: (provider: 'ollama' | 'claude' | 'openai') => Promise<{ success: boolean }>;
  };
  openExternal: (url: string) => Promise<void>;
  onSetupProgress: (callback: (message: string) => void) => () => void;
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => () => void;
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

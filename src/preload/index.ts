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
    save: (provider: string, key: string) => ipcRenderer.invoke('apikey:save', provider, key),
    get: (provider: string) => ipcRenderer.invoke('apikey:get', provider),
    delete: (provider: string) => ipcRenderer.invoke('apikey:delete', provider),
  },
  onSetupProgress: (callback: (message: string) => void) => {
    ipcRenderer.on('setup:progress', (_event, message) => callback(message));
  },
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => {
    ipcRenderer.on('file:dropped', (_event, file) => callback(file));
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
  file: {
    save: (content: string, defaultName: string) => Promise<string | null>;
    openPdf: () => Promise<{ path: string; name: string; data: Buffer } | null>;
  };
  settings: {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  apiKey: {
    save: (provider: string, key: string) => Promise<{ success: boolean }>;
    get: (provider: string) => Promise<string>;
    delete: (provider: string) => Promise<{ success: boolean }>;
  };
  onSetupProgress: (callback: (message: string) => void) => void;
  onFileDropped: (callback: (file: { path: string; name: string; data: ArrayBuffer }) => void) => void;
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

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
    // QA30(A-F5 배선): main 은 `ai:done` 에 완료 메타(StreamDoneMeta — 지금은 출력 상한 잘림
    // 표식 `{truncated:true}`)를 **두 번째 인자로** 실어 보내는데, 이 브리지가 그것을 버리고
    // requestId 만 넘기고 있었다. 페이로드는 IPC 를 건넜지만 렌더러에는 도달할 경로가 없었다.
    // meta 는 선택 인자라 기존 1-인자 콜백은 그대로 동작한다(하위호환).
    onDone: (callback: (requestId: string, meta?: { truncated?: true }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string, meta?: { truncated?: true }) =>
        callback(requestId, meta);
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
    // openDocHashes: QA21(C-MED) — 열린 탭의 세션을 LRU evict 에서 제외하기 위한 pin 목록.
    save: (payload: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean; openDocHashes?: string[] }) =>
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
    touch: (id: string) => ipcRenderer.invoke('collections:touch', id),
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
    /** meta: main 의 StreamDoneMeta — 출력 상한 잘림 표식(`{truncated:true}`). 없으면 정상 완주. */
    onDone: (callback: (requestId: string, meta?: { truncated?: true }) => void) => () => void;
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
    /**
     * QA30(C-6): main 은 이제 **`null`(확인 불가 — 파일은 있을 수 있으나 지금 못 읽음)** 을
     * 반환할 수 있다. 값은 이 브리지를 그대로 통과하지만, 타입은 아직 `boolean` 으로 둔다 —
     * 유일 소비자(SettingsPanel)의 상태가 `useState(false)`(boolean)라 지금 넓히면 렌더러가
     * 컴파일되지 않는다(그 파일은 이번 라운드에서 다른 에이전트 소유다). `null` 은 falsy 라
     * 렌더러 동작은 종전과 동일하며, "확인할 수 없음" 표시를 붙일 때 여기서 `boolean | null`
     * 로 넓히면 된다. → 보고서의 렌더러 배선 항목.
     */
    /**
     * 키가 저장돼 있는가. `null` = **확인 불가**(파일은 있는데 지금 읽을 수 없음 — AV·인덱서의
     * 일시 잠금). QA30(C-6): 종전엔 못 읽은 것과 없는 것이 똑같이 false 라, 키가 멀쩡한데
     * "API 키를 설정해주세요" 가 떴다. 소비자는 `=== false` 로 부재를 판정해야 한다.
     */
    has: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => Promise<boolean | null>;
    delete: (provider: 'ollama' | 'claude' | 'openai' | 'gemini') => Promise<{ success: boolean; error?: string; code?: string }>;
  };
  session: {
    load: (docHash: string) => Promise<{ session: unknown; blob: ArrayBuffer | null } | null>;
    loadMeta: (docHash: string) => Promise<{ session: unknown } | null>;
    // QA21(C-MED): evicted(LRU 로 삭제된 문서명, 사용자 통지용) / indexMissing(keepIndex 인데
    // 디스크에 index.bin 부재 → 렌더러가 시그니처를 무효화하고 전체 저장으로 회복).
    save: (payload: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean; openDocHashes?: string[] }) => Promise<{ ok: boolean; evicted?: string[]; indexMissing?: boolean }>;
    savePartial: (payload: { docHash: string; summary: { type: string; content: string; model: string; provider: string } | null; summaryType: string; qaMessages: unknown }) => Promise<{ ok: boolean }>;
    saveSummary: (payload: { docHash: string; type: string; summary: { content: string; model: string; provider: string } }) => Promise<{ ok: boolean }>;
    /** QA24(C-M2): 일시 I/O 오류는 `null` — "불러오지 못함" 과 "정말 없음(빈 배열)" 을 구분한다. */
    list: () => Promise<SessionManifestEntry[] | null>;
    delete: (docHash: string) => Promise<{ ok: boolean }>;
    clear: () => Promise<{ ok: boolean }>;
    stats: () => Promise<SessionStats>;
    search: (query: string) => Promise<GlobalSearchResult[]>;
    searchSemantic: (queryEmbedding: number[], model: string, dim: number) => Promise<SemanticSearchResponse>;
  };
  collections: {
    list: () => Promise<SavedCollection[]>;
    /**
     * QA30(C-11): `evicted`(LRU 로 축출된 컬렉션 이름 — 사용자 통지용)가 계약에서 빠져 있었다.
     * main 은 반환하고 CollectionBar 가 소비하는데, 중간의 이 선언만 모르는 상태였다
     * (collections-client.ts 가 반환 타입을 다시 적어 컴파일만 통과시켰다). 형제 session.save 는
     * evicted/indexMissing 을 제대로 선언한다.
     */
    save: (input: { id?: string; name: string; docHashes: string[] }) => Promise<{ ok: boolean; id?: string; evicted?: string[] }>;
    delete: (id: string) => Promise<{ ok: boolean }>;
    /** 열기 시 lastAccessed 갱신(최근 사용 표시). best-effort — 실패해도 열기에 영향 없다. */
    touch: (id: string) => Promise<{ ok: boolean }>;
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

import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fsp from 'fs/promises';
import { OllamaManager } from './ollama-manager';
import { generate, abortGenerate, checkAvailability, analyzeImage, analyzeImageForOcr, generateEmbeddings, checkEmbeddingAvailability, cleanupAiService, registerEmbedRequest, unregisterEmbedRequest } from './ai-service';
import { MAX_PDF_SIZE_BYTES, LOCALHOST_HOSTS } from '../shared/constants';

// 전역 에러 핸들러: unhandled rejection/exception으로 인한 무음 크래시 방지
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error);
});

const ollamaManager = new OllamaManager();

// electron-store는 ESM 전용이므로 JSON 파일로 직접 관리
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
// 기본 설정값 (src/renderer/types/index.ts의 DEFAULT_SETTINGS와 동기화 필요)
const defaultSettings = {
  provider: 'ollama',
  model: 'gemma3',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  uiLanguage: 'ko',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
  enableImageAnalysis: true,
  enableOcrFallback: true,
  summaryLanguage: 'ko',
  enableAnswerVerification: true,
} as const;

const VALID_SETTINGS_KEYS_SET = new Set([
  'provider', 'model', 'ollamaBaseUrl', 'theme', 'uiLanguage', 'defaultSummaryType', 'maxChunkSize', 'enableImageAnalysis', 'enableOcrFallback', 'summaryLanguage', 'enableAnswerVerification',
]);

async function loadSettings(): Promise<Record<string, unknown>> {
  try {
    const data = await fsp.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(data);
    // 허용된 키만 로드하여 임의 속성 주입 방지
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (VALID_SETTINGS_KEYS_SET.has(key)) {
        filtered[key] = parsed[key];
      }
    }
    return { ...defaultSettings, ...filtered };
  } catch (err) {
    // ENOENT(최초 실행 시 파일 없음)는 정상이므로 로그 제외. 그 외(손상된 JSON, 권한 오류 등)는
    // 사용자 리포트 시 진단에 필요 — 한 줄 경고로 가시성 확보.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[settings] load failed, using defaults:', err);
    }
    return { ...defaultSettings };
  }
}

async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  const tmpPath = settingsPath + '.tmp';
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    await fsp.rename(tmpPath, settingsPath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 1200,
    minWidth: 700,
    minHeight: 600,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
    title: '',
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 권한 요청 — 기본 거부(카메라/마이크/지오로케이션 등).
  // 예외: clipboard write — SummaryViewer 의 "복사" 버튼이 navigator.clipboard.writeText 를
  // 사용하므로 차단되면 회귀가 발생한다. read 는 불필요 → 거부.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === 'clipboard-sanitized-write') {
      cb(true);
      return;
    }
    cb(false);
  });
  // v0.17.7 (Hardening 3): permission.query() 를 통한 capability probing 차단
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'clipboard-sanitized-write';
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    // 프로덕션에서 DevTools 접근 차단
    win.webContents.on('devtools-opened', () => {
      win.webContents.closeDevTools();
    });
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  // will-navigate 와 별개로 will-redirect 도 차단 — 서버측 HTTP 리다이렉트로 인한
  // 원치 않는 네비게이션 방지.
  // 프로덕션 빌드에서는 ELECTRON_RENDERER_URL 가 undefined → 기존 코드의
  // `url.startsWith('')` 이 항상 true 가 되어 방어가 무력화되던 버그를 수정.
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL'];
  win.webContents.on('will-redirect', (event, url) => {
    if (url.startsWith('file://')) return;
    if (!app.isPackaged && devRendererUrl && url.startsWith(devRendererUrl)) return;
    event.preventDefault();
  });

  // 파일 드롭 시 file:// 탐색 차단 → 대신 IPC로 파일 데이터 전달 (비동기)
  let dropAbortController: AbortController | null = null;
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('file://') && url.toLowerCase().endsWith('.pdf')) {
      // UNC 경로 차단: file://remote-server/share/file.pdf 등 네트워크 읽기 방지
      try { if (new URL(url).hostname !== '') return; } catch { return; }
      const filePath = fileURLToPath(url);
      const MAX_PDF_SIZE = MAX_PDF_SIZE_BYTES;
      // 이전 드롭 읽기 취소
      dropAbortController?.abort();
      const ac = new AbortController();
      dropAbortController = ac;
      (async () => {
        try {
          // 심볼릭 링크/junction 차단: 악의적 .pdf 링크가 시스템 파일을 가리키는 것 방지
          const lstat = await fsp.lstat(filePath);
          if (lstat.isSymbolicLink()) {
            console.error('Dropped file is a symlink, rejected:', filePath);
            return;
          }
          const stat = await fsp.stat(filePath);
          if (!stat.isFile()) {
            console.error('Dropped path is not a regular file:', filePath);
            return;
          }
          if (stat.size > MAX_PDF_SIZE) {
            console.error('Dropped file too large:', stat.size);
            return;
          }
          const data = await fsp.readFile(filePath, { signal: ac.signal });
          if (!win.isDestroyed()) {
            // byteOffset === 0 이면 불필요한 복사 회피 (100MB PDF → 200MB 방지)
            const arrayBuf = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
              ? data.buffer
              : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            win.webContents.send('file:dropped', {
              path: filePath,
              name: path.basename(filePath),
              data: arrayBuf,
            });
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') return;
          console.error('Failed to read dropped file:', err);
        }
      })();
    }
  });

  // 창 닫힐 때 진행 중인 파일 읽기 취소
  win.on('closed', () => {
    dropAbortController?.abort();
  });

  return win;
}

// v0.17.7 (Hardening 5): 이중 인스턴스 방지 — 두 번째 실행은 첫 번째에 포커스 위임.
// settingsWriteChain 은 프로세스 내부 직렬화만 보장하므로, 이중 실행 시 settings.json
// 및 api-keys.enc 의 경쟁적 쓰기를 원천 차단.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows[0]) {
      if (windows[0].isMinimized()) windows[0].restore();
      windows[0].focus();
    }
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();

  try {
    const running = await ollamaManager.healthCheck();
    if (!running) {
      await ollamaManager.start();
    }
  } catch {
    // 첫 실행 시 미설치 상태
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS 에서는 창이 모두 닫혀도 앱이 계속 실행됨(dock 재활성화 가능). 이때 cleanupAiService
  // 를 호출하면 모듈 레벨 setInterval(ttlCleanupInterval) 이 파괴되어 다시 창을 열었을 때
  // TTL 스윕이 영구 정지되고, 진행 중이던 요약/Q&A 요청까지 abort 됨.
  // 비-darwin 에서는 `app.quit()` 이 `before-quit` 핸들러를 반드시 발화시키고, 거기서
  // `cleanupAiService()` 가 호출되므로 여기서 중복 호출하지 않는다. 과거엔 "safety net"
  // 의도였으나 실제로 before-quit 이 생략되는 경로가 없어 불필요.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isQuitting = false;
app.on('before-quit', (e) => {
  cleanupAiService();
  if (!isQuitting) {
    isQuitting = true;
    e.preventDefault();
    ollamaManager.stop().finally(() => app.quit());
  }
});

const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.enc');

// ─── API 키 메모리 캐시 ───
// 이유: 이전엔 loadApiKey 호출마다 readFileSync + safeStorage.decryptString 을 수행했는데,
// 청크가 많은 요약에선 hot path에서 수십 회 동기 파일 I/O + OS 복호화가 발생해
// 메인 이벤트 루프가 블로킹됐다. 프로세스 메모리에 복호화된 키를 캐시하고
// save/delete 시에만 무효화하여 비용을 O(1)로 축소.
//
// 보안: 캐시는 프로세스 메모리에만 존재하고 disk/IPC로 유출되지 않음.
// 렌더러에는 절대 전달되지 않으며 (기존과 동일), 앱 종료 시 자연히 소멸.
let apiKeysCache: Record<string, string> | null = null;

// R28 P2 (v0.18.12): prototype pollution 가드용 알려진 provider 목록.
// 디스크에 변조된 JSON 이 `__proto__` 같은 키를 포함해도 알려진 키만 안전하게 복사한다.
const KNOWN_API_KEY_PROVIDERS = ['ollama', 'claude', 'openai'] as const;

// R28 P2 (v0.18.12): ai:embed 동시성 캡 — 비용/리소스 amp DoS 차단용.
// 정상 RAG 인덱스 빌드 시 동시 in-flight 는 1~2이라 4 면 헤드룸 충분.
const MAX_CONCURRENT_EMBED_REQUESTS = 4;
let activeEmbedRequests = 0;

function readApiKeys(): Record<string, string> {
  if (apiKeysCache) return apiKeysCache;
  // null-prototype 객체로 캐시 — 변조된 JSON 의 `__proto__` 키가 Object.prototype 을
  // 오염시키는 경로 차단. 일반 객체 spread/lookup 은 그대로 동작한다.
  const fresh: Record<string, string> = Object.create(null);
  if (!safeStorage.isEncryptionAvailable()) {
    apiKeysCache = fresh;
    return fresh;
  }
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    // 알려진 provider 키만 추출 — 그 외(prototype 키, 미지 provider 등)는 폐기.
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const k of KNOWN_API_KEY_PROVIDERS) {
        const v = obj[k];
        if (typeof v === 'string') fresh[k] = v;
      }
    }
    apiKeysCache = fresh;
    return fresh;
  } catch {
    apiKeysCache = fresh;
    return fresh;
  }
}

function invalidateApiKeysCache(): void {
  apiKeysCache = null;
}

function writeApiKeys(keys: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // silent return 금지: 호출자가 실패를 감지할 수 있도록 throw
    // (이전 버그: silent fail 시 UI가 "저장됨"이라고 보고한 뒤 실제 사용 시에야 실패 발견)
    throw Object.assign(
      new Error('OS 키체인을 사용할 수 없어 API 키를 저장할 수 없습니다. OS 설정을 확인해주세요.'),
      { code: 'KEYCHAIN_UNAVAILABLE' },
    );
  }
  const tmpPath = apiKeysPath + '.tmp';
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  try {
    fs.writeFileSync(tmpPath, encrypted);
    fs.renameSync(tmpPath, apiKeysPath);
    // 쓰기 성공 후 캐시에 최신값 반영 — 다음 읽기에서 파일 I/O 회피.
    // R28 P2 (v0.18.12): null-prototype 객체로 캐시하여 readApiKeys 와 일관성 유지.
    const fresh: Record<string, string> = Object.create(null);
    for (const k of KNOWN_API_KEY_PROVIDERS) {
      const v = keys[k];
      if (typeof v === 'string') fresh[k] = v;
    }
    apiKeysCache = fresh;
  } catch (err) {
    // rename 실패 시 tmp 파일 정리 + 캐시 무효화 (디스크와 메모리 불일치 방지)
    try { fs.unlinkSync(tmpPath); } catch { /* 이미 삭제됨 */ }
    invalidateApiKeysCache();
    throw err;
  }
}

function saveApiKey(provider: string, key: string): void {
  // clone 후 수정 — writeApiKeys 실패 시 캐시가 불일치 상태로 남지 않도록 보호
  const keys = { ...readApiKeys(), [provider]: key };
  writeApiKeys(keys);
}

function deleteApiKey(provider: string): void {
  const keys = { ...readApiKeys() };
  delete keys[provider];
  writeApiKeys(keys);
}

function loadApiKey(provider: string): string | undefined {
  return readApiKeys()[provider];
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => {
    // API 키는 Renderer에 전달하지 않음 — Main 프로세스에서만 사용
    return loadSettings();
  });

  const VALID_PROVIDERS = ['ollama', 'claude', 'openai'] as const;
  const VALID_SETTINGS_KEYS = [
    'provider', 'model', 'ollamaBaseUrl', 'theme', 'uiLanguage',
    'defaultSummaryType', 'maxChunkSize', 'enableImageAnalysis', 'enableOcrFallback', 'summaryLanguage',
    'enableAnswerVerification',
  ] as const;

  ipcMain.handle('apikey:save', (_event, provider: string, key: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 512) {
      return { success: false, error: 'Invalid API key' };
    }
    try {
      saveApiKey(provider, key.trim());
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'API 키 저장 실패',
      };
    }
  });

  ipcMain.handle('apikey:has', (_event, provider: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return false;
    }
    const key = loadApiKey(provider);
    return !!key && key.length > 0;
  });

  ipcMain.handle('apikey:delete', (_event, provider: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    try {
      deleteApiKey(provider);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'API 키 삭제 실패',
      };
    }
  });

  const VALID_THEMES = ['light', 'dark', 'system'] as const;
  const VALID_UI_LANGUAGES = ['ko', 'en'] as const;
  const VALID_SUMMARY_TYPES = ['full', 'chapter', 'keywords'] as const;

  // settings:set 직렬화 mutex — 연속 호출 시 load→save 간 race 로 인한 lost update 방지.
  // store 의 300ms debounce 로 대부분 흡수되지만, 수동 외부 호출이나 burst 상황에도 견고하게.
  let settingsWriteChain: Promise<Record<string, unknown>> = Promise.resolve({});

  ipcMain.handle('settings:set', async (_event, partial: Record<string, unknown>) => {
    const task = async (): Promise<Record<string, unknown>> => {
      const current = await loadSettings();
      const filtered: Record<string, unknown> = {};
      for (const key of VALID_SETTINGS_KEYS) {
        if (!(key in partial)) continue;
        const val = partial[key];
        // 값 타입 검증
        switch (key) {
          case 'provider':
            if (VALID_PROVIDERS.includes(val as typeof VALID_PROVIDERS[number])) filtered[key] = val;
            break;
          case 'model':
            if (typeof val === 'string' && val.length > 0 && val.length <= 100) filtered[key] = val;
            break;
          case 'ollamaBaseUrl':
            if (typeof val === 'string') {
              try {
                const parsed = new URL(val);
                const allowedHosts = LOCALHOST_HOSTS;
                if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && allowedHosts.includes(parsed.hostname)) {
                  filtered[key] = val;
                }
              } catch { /* 유효하지 않은 URL 무시 */ }
            }
            break;
          case 'theme':
            if (VALID_THEMES.includes(val as typeof VALID_THEMES[number])) filtered[key] = val;
            break;
          case 'uiLanguage':
            if (VALID_UI_LANGUAGES.includes(val as typeof VALID_UI_LANGUAGES[number])) filtered[key] = val;
            break;
          case 'defaultSummaryType':
            if (VALID_SUMMARY_TYPES.includes(val as typeof VALID_SUMMARY_TYPES[number])) filtered[key] = val;
            break;
          case 'maxChunkSize':
            if (typeof val === 'number' && val >= 1000 && val <= 16000) filtered[key] = val;
            break;
          case 'enableImageAnalysis':
            if (typeof val === 'boolean') filtered[key] = val;
            break;
          case 'enableOcrFallback':
            if (typeof val === 'boolean') filtered[key] = val;
            break;
          case 'summaryLanguage':
            if (['ko', 'en', 'ja', 'zh', 'auto'].includes(val as string)) filtered[key] = val;
            break;
          case 'enableAnswerVerification':
            if (typeof val === 'boolean') filtered[key] = val;
            break;
        }
      }
      const updated = { ...current, ...filtered };
      await saveSettings(updated);
      return updated;
    };
    // 이전 작업의 결과는 버리고 chain 연결만 — 실패 시에도 다음 task 실행되도록 catch 로 복구
    const next = settingsWriteChain.then(task, task);
    settingsWriteChain = next.catch(() => ({}));
    return next;
  });

  ipcMain.handle('ollama:status', async () => {
    try {
      return await ollamaManager.getStatus();
    } catch (err) {
      console.error('[ollama:status] failed:', err);
      return { installed: false, running: false, models: [] };
    }
  });

  ipcMain.handle('ollama:install', async (_event) => {
    try {
      return await ollamaManager.install();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Ollama 설치 실패' };
    }
  });

  ipcMain.handle('ollama:start', async () => {
    try {
      return await ollamaManager.start();
    } catch (err) {
      console.error('[ollama:start] failed:', err);
      return false;
    }
  });

  ipcMain.handle('ollama:stop', async () => {
    try {
      // ollamaManager.stop() 은 void 반환 → 성공 시 명시적으로 true 전달해 preload 타입과 일치
      await ollamaManager.stop();
      return true;
    } catch (err) {
      console.error('[ollama:stop] failed:', err);
      return false;
    }
  });

  ipcMain.handle('ollama:pull-model', async (_event, model: string) => {
    if (typeof model !== 'string' || model.length === 0 || model.length > 128 || !/^[a-zA-Z0-9]([a-zA-Z0-9._:\/-]*[a-zA-Z0-9])?$/.test(model)) {
      return { success: false, error: 'Invalid model name' };
    }
    try {
      return await ollamaManager.pullModel(model);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '모델 다운로드 실패' };
    }
  });

  ipcMain.handle('ollama:list-models', async () => {
    try {
      return await ollamaManager.listModels();
    } catch (err) {
      console.error('[ollama:list-models] failed:', err);
      return [];
    }
  });

  // ─── AI 요약 (Main 프로세스에서 API 키를 사용하여 직접 호출) ───

  ipcMain.handle('ai:generate', async (event, requestId: string, request: {
    text: string;
    type: 'full' | 'chapter' | 'keywords' | 'qa';
    provider: 'ollama' | 'claude' | 'openai';
    model: string;
    ollamaBaseUrl: string;
    temperature?: number;
    language?: string;
  }) => {
    // 입력값 검증 (길이 캡: ai:abort=256, ai:embed=128 과 정합 — 자기-DoS 방어)
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) {
      return { success: false, error: 'Invalid requestId' };
    }
    if (!request || typeof request.text !== 'string' || !request.text || request.text.length > 10 * 1024 * 1024) {
      return { success: false, error: 'Invalid text' };
    }
    if (typeof request.ollamaBaseUrl !== 'string') {
      return { success: false, error: 'Invalid ollamaBaseUrl' };
    }
    // IPC 경계에서 localhost URL 검증 (defense-in-depth)
    if (request.provider === 'ollama') {
      try {
        const parsed = new URL(request.ollamaBaseUrl);
        const allowedHosts = LOCALHOST_HOSTS;
        if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHosts.includes(parsed.hostname)) {
          return { success: false, error: 'Invalid ollamaBaseUrl: localhost only' };
        }
      } catch { return { success: false, error: 'Invalid ollamaBaseUrl' }; }
    }
    if (!['full', 'chapter', 'keywords', 'qa'].includes(request.type)) {
      return { success: false, error: 'Invalid type' };
    }
    if (!VALID_PROVIDERS.includes(request.provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    // model 검증: 길이 상한 + 안전 문자집합. ollama:pull-model 과 동일한 regex 를 공유해
    // ai:generate 와 ollama:pull-model 입력 표면이 일관되게 보호됨.
    // renderer compromise 시 10MB model 필드로 body 폭주를 막기 위한 방어 심화.
    if (typeof request.model !== 'string' || request.model.length === 0 || request.model.length > 128
        || !/^[a-zA-Z0-9]([a-zA-Z0-9._:\/-]*[a-zA-Z0-9])?$/.test(request.model)) {
      return { success: false, error: 'Invalid model' };
    }
    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || Number.isNaN(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
      return { success: false, error: 'Invalid temperature' };
    }
    // language 화이트리스트 — settings:set 의 summaryLanguage 검증과 동일한 집합.
    // 향후 새 언어 추가 시 양쪽을 동시에 업데이트해야 drift 가 발생하지 않는다.
    if (request.language !== undefined && !['ko', 'en', 'ja', 'zh', 'auto'].includes(request.language)) {
      return { success: false, error: 'Invalid language' };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: '윈도우를 찾을 수 없습니다.' };

    const apiKey = request.provider !== 'ollama'
      ? loadApiKey(request.provider)
      : undefined;

    try {
      await generate(requestId, request, apiKey, win);
      return { success: true };
    } catch (err) {
      const error = err as Error & { code?: string };
      return {
        success: false,
        error: error.message,
        code: error.code,
      };
    }
  });

  ipcMain.handle('ai:abort', (_event, requestId: string) => {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) {
      return { success: false, error: 'Invalid requestId' };
    }
    abortGenerate(requestId);
    // R31 (v0.18.18 patch): Vision 측은 `vision:${rid}` 로 namespacing 됐으므로 prefix
    // 버전도 시도. renderer 는 bare id 만 알면 되도록 main 이 양쪽을 흡수.
    abortGenerate(`vision:${requestId}`);
    return { success: true };
  });

  ipcMain.handle('ai:check-available', async (_event, provider: string, ollamaBaseUrl: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) return false;
    if (typeof ollamaBaseUrl !== 'string') return false;
    // IPC 경계에서 localhost URL 검증
    if (provider === 'ollama') {
      try {
        const parsed = new URL(ollamaBaseUrl);
        const allowedHosts = LOCALHOST_HOSTS;
        if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHosts.includes(parsed.hostname)) return false;
      } catch { return false; }
    }
    const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
    return checkAvailability(provider as 'ollama' | 'claude' | 'openai', ollamaBaseUrl, apiKey);
  });

  // ─── Vision 공통: Ollama Vision 모델 자동 선택 ───

  const OLLAMA_VISION_MODELS = ['llava', 'llama3.2-vision', 'bakllava', 'moondream'];

  async function resolveVisionModel(errorPrefix: string) {
    const settings = await loadSettings();
    const provider = (settings.provider as 'ollama' | 'claude' | 'openai') || 'ollama';
    const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
    let model = (settings.model as string) || '';
    if (provider === 'ollama' && !OLLAMA_VISION_MODELS.some((v) => model.startsWith(v))) {
      const installed = await ollamaManager.listModels();
      const available = installed.filter((m: string) => OLLAMA_VISION_MODELS.some((v) => m.startsWith(v)));
      if (available.length === 0 || !available[0]) {
        throw new Error(`${errorPrefix} Vision 모델이 필요합니다. 설정에서 llava 모델을 설치해주세요.`);
      }
      model = available[0];
    }
    const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
    return { provider, model, ollamaBaseUrl, apiKey };
  }

  function validateImageBase64(imageBase64: unknown): imageBase64 is string {
    // v0.17.7 (M2): 불필요한 \n 허용 제거 + padding 위치 제한 (종단 0~2자만)
    return typeof imageBase64 === 'string' && imageBase64.length > 0
      && imageBase64.length <= 10 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64);
  }

  // R30 P2 (v0.18.18): requestId 선택 인자 추가 — renderer 가 ai:abort 로 in-flight Vision
  // 호출을 즉시 취소할 수 있도록 함. 이전엔 사용자 Stop 도 in-flight Vision (특히 cloud) 을
  // 끊지 못해 토큰이 끝까지 청구되던 결함.
  //
  // R31 (v0.18.18 patch): activeRequests Map 이 generate/embed/vision 호출 사이에 공유되어
  // requestId 충돌 시 (예: 손상된 renderer 가 같은 id 재사용) 다른 path 의 entry 가 controller
  // identity 미일치로 leak 됐다. Vision 측에서만 `vision:` prefix 로 namespacing 해 충돌 차단.
  // ai:abort 가 양쪽 모두 시도하므로 renderer 는 prefix 를 알 필요 없음.
  ipcMain.handle('ai:analyze-image', async (_event, imageBase64: string, requestId: unknown) => {
    if (!validateImageBase64(imageBase64)) {
      return { success: false, error: '이미지 데이터가 유효하지 않습니다.' };
    }
    const rawRequestId = (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128)
      ? requestId
      : null;
    const visionRequestId = rawRequestId ? `vision:${rawRequestId}` : null;
    let controller: AbortController | undefined;
    if (visionRequestId) {
      controller = new AbortController();
      registerEmbedRequest(visionRequestId, controller);
    }
    try {
      const { provider, model, ollamaBaseUrl, apiKey } = await resolveVisionModel('이미지 분석을 위해');
      const description = await analyzeImage(imageBase64, provider, model, ollamaBaseUrl, apiKey, controller?.signal);
      return { success: true, description };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Vision 분석 실패';
      const isAbort = msg === 'Aborted' || (err as Error & { code?: string })?.code === 'ABORT_ERR';
      // R31 P2 (v0.18.19): 매직 문자열 'Aborted' 대신 code 필드 사용 — generate path 의
      // `code: 'ABORTED'` 와 일관, renderer 가 code 로 매핑 가능.
      return isAbort
        ? { success: false, error: 'Aborted', code: 'ABORTED' }
        : { success: false, error: msg };
    } finally {
      if (visionRequestId && controller) unregisterEmbedRequest(visionRequestId, controller);
    }
  });

  // ─── OCR (스캔 PDF 텍스트 추출) ───

  ipcMain.handle('ai:ocr-page', async (_event, imageBase64: string) => {
    if (!validateImageBase64(imageBase64)) {
      return { success: false, error: '이미지 데이터가 유효하지 않습니다.' };
    }
    try {
      const { provider, model, ollamaBaseUrl, apiKey } = await resolveVisionModel('OCR을 위해');
      const text = await analyzeImageForOcr(imageBase64, provider, model, ollamaBaseUrl, apiKey);
      return { success: true, text };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'OCR 실패' };
    }
  });

  // ─── 임베딩 (RAG용) ───

  ipcMain.handle('ai:embed', async (_event, texts: unknown, requestId: unknown) => {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 200) {
      return { success: false, error: 'Invalid texts array (1-200 items)' };
    }
    for (const t of texts) {
      if (typeof t !== 'string' || t.length === 0 || t.length > 32000) {
        return { success: false, error: 'Each text must be 1-32000 chars' };
      }
    }
    // R28 P2 (v0.18.12): 동시 임베딩 호출 캡 —
    // 손상되거나 폭주하는 renderer 가 단시간에 다수 요청을 발사해 OpenAI 토큰 비용을
    // amp 하거나 Ollama 백엔드를 마비시키는 자기-DoS 경로 차단. 정상 사용 (RAG 인덱스
    // 빌드 시 50개씩 배치) 에서는 동시 in-flight 가 1~2개라 4 이면 헤드룸이 충분하다.
    if (activeEmbedRequests >= MAX_CONCURRENT_EMBED_REQUESTS) {
      return { success: false, error: '동시 임베딩 요청 한도 초과. 잠시 후 다시 시도해주세요.' };
    }
    // R29 (v0.18.13): 카운터 증가를 try 블록 *안*으로 이동.
    // 이전엔 controller/registerEmbedRequest 등록이 동기 throw 할 경우 카운터가
    // 증가만 되고 finally 에 도달하지 못해 영구 leak 됐다. 4 회 leak 후 self-DoS 발생.
    const validRequestId = (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128)
      ? requestId
      : null;
    let counted = false;
    let controller: AbortController | undefined;
    try {
      activeEmbedRequests++;
      counted = true;
      if (validRequestId) {
        controller = new AbortController();
        registerEmbedRequest(validRequestId, controller);
      }
      const settings = await loadSettings();
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai') || 'ollama';
      const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
      const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
      const result = await generateEmbeddings(texts, provider, ollamaBaseUrl, apiKey, undefined, controller?.signal);
      if (!result) {
        return { success: false, error: '임베딩 생성 불가 (해당 프로바이더 미지원)' };
      }
      // IPC 경계에서 NaN/Infinity 검증 — 벡터 스토어 오염 방지
      for (const emb of result.embeddings) {
        if (!Array.isArray(emb) || emb.length === 0) {
          return { success: false, error: '빈 임베딩 벡터' };
        }
        for (let k = 0; k < emb.length; k++) {
          if (!Number.isFinite(emb[k])) {
            return { success: false, error: '임베딩에 유효하지 않은 값 포함 (NaN/Infinity)' };
          }
        }
      }
      return { success: true, embeddings: result.embeddings, model: result.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '임베딩 생성 실패';
      // Aborted 는 renderer 가 이미 취소를 알고 있으므로 조용히 반환 (로깅 생략)
      const isAbort = msg === 'Aborted' || (err as Error & { code?: string })?.code === 'ABORT_ERR';
      return { success: false, error: isAbort ? 'Aborted' : msg };
    } finally {
      // R29 (v0.18.13): controller identity 로 owner check —
      // 같은 requestId 가 in-flight 중 재진입했을 때, 본 finally 는 자신의 controller
      // 일 때만 entry 를 삭제해야 한다 (ai-service 내부에서 이미 registerEmbedRequest
      // 가 prev abort 후 새 controller 로 덮어쓰기 때문). identity 가 다르면 새 요청의
      // entry 가 살아남아 ai:abort 가 정상 작동.
      if (validRequestId && controller) unregisterEmbedRequest(validRequestId, controller);
      if (counted) activeEmbedRequests--;
    }
  });

  ipcMain.handle('ai:check-embed-model', async () => {
    try {
      const settings = await loadSettings();
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai') || 'ollama';
      if (provider === 'openai') {
        const apiKey = loadApiKey('openai');
        return { available: !!apiKey, model: 'text-embedding-3-small' };
      }
      // Ollama or Claude (Ollama fallback)
      const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
      const installed = await ollamaManager.listModels();
      const model = await checkEmbeddingAvailability(ollamaBaseUrl, installed);
      return { available: !!model, model: model || undefined };
    } catch {
      return { available: false };
    }
  });

  // ─── 파일 ───

  const MAX_EXPORT_SIZE = 10 * 1024 * 1024; // 10MB
  ipcMain.handle('file:save', async (_event, content: unknown, defaultName: unknown) => {
    if (typeof content !== 'string' || typeof defaultName !== 'string') {
      return null;
    }
    if (content.length > MAX_EXPORT_SIZE) {
      return null;
    }
    const safeName = path.basename(defaultName).slice(0, 255);
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: safeName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (filePath) {
      // 방어: 다이얼로그 필터 우회 시 허용 확장자만 저장
      const ext = path.extname(filePath).toLowerCase();
      if (!['.md', '.txt'].includes(ext)) {
        return null;
      }
      try {
        await fsp.writeFile(filePath, content, 'utf-8');
        return filePath;
      } catch (err) {
        // EACCES/ENOSPC/EPERM 등의 fs 에러가 Promise rejection 으로 렌더러에 전파되는 것을
        // 방지. 기존 계약(성공 시 string, 취소/에러 시 null)을 유지하되 main 로그에 기록.
        console.error('file:save writeFile failed:', err);
        return null;
      }
    }
    return null;
  });

  // v0.17.7 (Hardening 2): 정확 호스트명 매칭으로 변경 — suffix 매칭은
  // gist.github.com 등 사용자 콘텐츠 도메인까지 허용하는 문제가 있었음
  const ALLOWED_EXTERNAL_HOSTS = new Set([
    'ollama.com', 'www.ollama.com',
    'anthropic.com', 'www.anthropic.com', 'console.anthropic.com', 'docs.anthropic.com',
    'openai.com', 'www.openai.com', 'platform.openai.com',
    'github.com', 'www.github.com',
  ]);

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string') return;
    // R30 P2 (v0.18.18): 입력 길이 캡 — 다른 IPC 핸들러 패턴과 일치시키고,
    // 손상된 renderer 가 multi-MB 문자열을 보내 URL parser 에 부담을 주는 경로를 사전 차단.
    if (url.length > 2048) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return;
      if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) return;
      await shell.openExternal(url);
    } catch { /* 유효하지 않은 URL 무시 */ }
  });

  ipcMain.handle('file:open-pdf', async () => {
    const MAX_PDF_SIZE = MAX_PDF_SIZE_BYTES;
    // IPC 계약: 성공 시 {path, name, data}, 선택 취소 시 null, 그 외 모든 에러는 {error}.
    // try/catch 가 dialog.showOpenDialog 까지 포함해야 display server 에러 등 드문 예외도
    // rejection 대신 구조화된 error 로 변환됨 (호출자가 unhandled rejection 없이 처리 가능).
    try {
      const { filePaths } = await dialog.showOpenDialog({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile'],
      });
      if (filePaths.length === 0) return null;
      const filePath = filePaths[0];
      // noUncheckedIndexedAccess: length 검사 후에도 좁힘 안됨. 명시적 가드.
      if (!filePath) return null;
      // drop 핸들러와 동일한 방어 — 심볼릭 링크/비정규 파일 거부.
      const lstat = await fsp.lstat(filePath);
      if (lstat.isSymbolicLink()) {
        return { error: '심볼릭 링크는 열 수 없습니다.' };
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return { error: '일반 파일이 아닙니다.' };
      }
      if (stat.size > MAX_PDF_SIZE) {
        return { error: 'PDF 파일이 너무 큽니다 (최대 100MB).' };
      }
      const buffer = await fsp.readFile(filePath);
      const arrayBuf = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
        ? buffer.buffer
        : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return {
        path: filePath,
        name: path.basename(filePath),
        data: arrayBuf,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const friendly = code === 'ENOENT' ? '파일을 찾을 수 없습니다.'
        : code === 'EPERM' || code === 'EACCES' ? '파일에 접근할 수 없습니다.'
        : 'PDF 파일을 열 수 없습니다.';
      console.error('[file:open-pdf] failed:', err);
      return { error: friendly };
    }
  });
}

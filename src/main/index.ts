import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
// R38 P1-2: sync `fs` 는 API 키 저장 로직과 함께 api-keys-store.ts 로 이동. 본 파일은 fsp 만 사용.
import fsp from 'fs/promises';
import { OllamaManager } from './ollama-manager';
import { generate, abortGenerate, checkAvailability, analyzeImage, analyzeImageForOcr, generateEmbeddings, checkEmbeddingAvailability, cleanupAiService, registerEmbedRequest, unregisterEmbedRequest, GEMINI_EMBED_MODEL } from './ai-service';
import { MAX_PDF_SIZE_BYTES, isLocalhostHost } from '../shared/constants';
// v0.18.19 patch R34 P2: settings 키 단일 출처. 이전엔 본 파일 두 곳에 별도 리터럴이 있었고
// R33 Surface 4 P3 가 drift 가드 부재를 지적. settings-keys.ts 가 양쪽을 derive 함.
import { VALID_SETTINGS_KEYS, VALID_SETTINGS_KEYS_SET } from './settings-keys';
// v0.18.22 Top5 #3: loadSettings/saveSettings 를 순수 파일 I/O 모듈로 분리하여 단위 테스트
// 가능성 확보. 동일 로직을 electron 의존성 없이 fs 모킹 기반으로 검증한다.
import { loadSettings as _loadSettings, saveSettings as _saveSettings } from './settings-store';
// R38 P1: IPC 입력 검증 로직을 순수 모듈로 분리 (ps-quote/settings-store 와 동일 패턴).
// 이전엔 핸들러 클로저에 인라인돼 electron 의존 때문에 행위 검증이 불가했고 ipc-contract.test 가
// 소스 텍스트 정규식으로만 가드했다. 본 import 로 ipc-validators.test 가 행위를 직접 검증한다.
import {
  VALID_PROVIDERS,
  isValidProvider,
  isValidModelName,
  isValidRequestId,
  isValidOllamaBaseUrl,
  validateImageBase64,
  validateEmbedTexts,
  validateEmbeddings,
  validateGenerateRequest,
} from './ipc-validators';
// R38 P1-2: API 키 암호화 저장/캐시/prototype-pollution 가드를 순수 모듈로 분리.
// safeStorage 를 주입받아 electron-free 가 되어 api-keys-store.test 가 fs 모킹으로 검증한다.
import { ApiKeyStore } from './api-keys-store';
// session-persistence (module-2): 세션·인덱스 캐싱 영속화. sessionsDir 주입으로 electron-free.
import {
  readSession,
  writeSession,
  touchSession,
  deleteSession,
  clearAll as clearAllSessions,
  listSessions,
  sessionStats,
  isValidDocHash,
} from './session-store';
import type { SessionSaveMeta } from '../shared/session-types';

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
// session-persistence: 세션 저장 루트. docHash 화이트리스트로 traversal 차단(session-store).
const sessionsDir = path.join(app.getPath('userData'), 'sessions');
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
  persistSessions: true,
} as const;

// R34 P2: VALID_SETTINGS_KEYS_SET 은 settings-keys.ts 에서 import (단일 출처).

// 첫 실행(설정 파일 부재 또는 해당 키 미저장) 시 OS 로캘 기반 언어 기본값 — ko 계열 로캘이
// 아니면 UI/요약 언어 모두 en. 기존 사용자의 저장된 설정은 _loadSettings 의 spread 순서상
// 항상 우선하므로 영향 없음. app.getLocale() 은 ready 이후에만 유효하나 loadSettings 는
// IPC 핸들러 경유로만 호출되므로 안전. 실패 시 기존 기본값(ko) 유지.
function localeAwareDefaults(): Record<string, unknown> {
  let lang: 'ko' | 'en' = 'ko';
  try {
    // R43 F6: prefix 'ko' 는 'kok'(콘칸어) 로캘과 오매칭 — 정확히 ko 또는 ko-* 만 한국어 판정
    const loc = app.getLocale().toLowerCase();
    lang = (loc === 'ko' || loc.startsWith('ko-')) ? 'ko' : 'en';
  } catch { /* getLocale 실패 시 ko 유지 */ }
  return { ...defaultSettings, uiLanguage: lang, summaryLanguage: lang };
}

async function loadSettings(): Promise<Record<string, unknown>> {
  const settings = await _loadSettings(settingsPath, localeAwareDefaults(), VALID_SETTINGS_KEYS_SET);
  // R43 F5: 레거시 가드 — uiLanguage 는 저장돼 있지만 summaryLanguage 키가 도입 전이라
  // 파일에 없는 사용자(v0.16 이전 마지막 저장)가 비-ko 로캘 OS 에서 요약 언어만 묵시적으로
  // en 으로 바뀌는 회귀 차단. 저장된 UI 언어를 따른다. (merge 결과로는 키 출처를 구분할 수
  // 없어 원본 파일을 직접 검사 — 파일 부재/손상 시 로캘 기본값 유지)
  try {
    const raw = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    if (raw && typeof raw === 'object' && 'uiLanguage' in raw && !('summaryLanguage' in raw)) {
      // R44: 값 검증 — 손으로 망가진 파일의 임의 uiLanguage 가 summaryLanguage 로 전파되지 않도록
      const ui = settings.uiLanguage;
      if (ui === 'ko' || ui === 'en') settings.summaryLanguage = ui;
    }
  } catch { /* 첫 실행(파일 없음)/손상 — localeAwareDefaults 유지 */ }
  return settings;
}

async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  return _saveSettings(settingsPath, settings);
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
  // v0.18.19 patch R32 P3: file:// re-navigation 을 무조건 허용하지 않는다. 패키지 빌드의
  // 정상 진입점은 단일 index.html 이라, 정확히 그 URL 만 통과시키고 임의의 file:// 타겟은
  // 차단한다 (Surface 2 P4). 현재 외부 URL 을 로드하는 경로는 없어 reachability 가 낮지만
  // defense-in-depth.
  //
  // R34 P1 (R33 회귀 fix): 이전 구현은 `file://${path}` (2 슬래시) 로 만들었는데 Electron 의
  // 실제 loadFile() URL 은 `file:///${path}` (3 슬래시, RFC 8089) 라 `===` 비교가 항상 false.
  // `pathToFileURL().href` 로 정확한 표준 file URL 을 만들어 비교. Windows 의 소문자 드라이브,
  // UNC, 백슬래시 정규화도 함께 처리됨.
  const packagedRendererUrl = app.isPackaged
    ? pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
    : null;
  win.webContents.on('will-redirect', (event, url) => {
    if (!app.isPackaged && devRendererUrl && url.startsWith(devRendererUrl)) return;
    if (packagedRendererUrl && url === packagedRendererUrl) return;
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

// ─── API 키 암호화 저장소 ───
// R38 P1-2: 캐시/prototype-pollution 가드/원자적 쓰기/keychain-unavailable throw 로직을
// api-keys-store.ts 로 분리(행위 검증 가능). safeStorage 를 주입 — 캐시는 프로세스 메모리에만
// 존재하고 disk/IPC 로 유출되지 않으며 렌더러에 전달되지 않음(기존과 동일).
const apiKeyStore = new ApiKeyStore(apiKeysPath, safeStorage);

// R28 P2 (v0.18.12): ai:embed 동시성 캡 — 비용/리소스 amp DoS 차단용.
// 정상 RAG 인덱스 빌드 시 동시 in-flight 는 1~2이라 4 면 헤드룸 충분.
const MAX_CONCURRENT_EMBED_REQUESTS = 4;
let activeEmbedRequests = 0;

// R38 P2: export — electron 모킹 기반 핸들러 행위 검증(__tests__/ipc-handlers.test.ts)이
// 본 함수를 직접 호출해 ipcMain.handle 로 등록된 핸들러를 캡처·invoke 한다. 프로덕션 경로는
// 변함없이 app.whenReady().then 에서 1회 호출된다.
export function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => {
    // API 키는 Renderer에 전달하지 않음 — Main 프로세스에서만 사용
    return loadSettings();
  });

  // R38 P1: VALID_PROVIDERS 는 ipc-validators.ts 에서 import (단일 출처).
  // R34 P2: VALID_SETTINGS_KEYS 는 settings-keys.ts 에서 import (단일 출처).
  // 이전엔 본 함수 안과 모듈 상단에 같은 키 배열이 두 번 박혀 있어 drift 위험.

  ipcMain.handle('apikey:save', (_event, provider: string, key: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 512) {
      return { success: false, error: 'Invalid API key' };
    }
    try {
      apiKeyStore.save(provider, key.trim());
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
    const key = apiKeyStore.load(provider);
    return !!key && key.length > 0;
  });

  ipcMain.handle('apikey:delete', (_event, provider: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    try {
      apiKeyStore.delete(provider);
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
                if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLocalhostHost(parsed.hostname)) {
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
          case 'persistSessions':
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

  // ─── session-persistence: 세션·인덱스 캐싱 (module-2) ───
  // Design Ref: §4 — docHash 검증·LRU·원자적 저장은 session-store 에 위임. manifest load→save
  // 원자성을 위해 settings 와 동일한 직렬화 mutex 로 쓰기 race 를 차단한다.
  let sessionWriteChain: Promise<unknown> = Promise.resolve();
  function serializeSessionWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = sessionWriteChain.then(task, task);
    sessionWriteChain = next.catch(() => undefined);
    return next;
  }

  ipcMain.handle('session:load', async (_event, docHash: unknown) => {
    if (!isValidDocHash(docHash)) return null;
    const result = await readSession(sessionsDir, docHash);
    // 최근 사용 표시(lastAccessed) — load 를 블록하지 않도록 fire-and-forget + mutex 직렬화
    if (result) void serializeSessionWrite(() => touchSession(sessionsDir, docHash, Date.now()));
    return result;
  });

  ipcMain.handle('session:save', async (_event, payload: unknown) => {
    const p = payload as { meta?: SessionSaveMeta; session?: unknown; blob?: ArrayBuffer | null } | null;
    if (!p || !p.meta || !isValidDocHash(p.meta.docHash)) return { ok: false };
    const meta = p.meta;
    const session = p.session;
    const blob = p.blob ?? null;
    return serializeSessionWrite(() => writeSession(sessionsDir, { meta, session, blob, now: Date.now() }));
  });

  ipcMain.handle('session:list', async () => {
    return listSessions(sessionsDir);
  });

  ipcMain.handle('session:delete', async (_event, docHash: unknown) => {
    if (!isValidDocHash(docHash)) return { ok: false };
    return serializeSessionWrite(() => deleteSession(sessionsDir, docHash));
  });

  ipcMain.handle('session:clear', async () => {
    return serializeSessionWrite(() => clearAllSessions(sessionsDir));
  });

  ipcMain.handle('session:stats', async () => {
    return sessionStats(sessionsDir);
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
    // R38 P1: ai:generate 와 동일한 model 안전 문자집합(MODEL_NAME_RE)을 공유 — 단일 출처.
    if (!isValidModelName(model)) {
      return { success: false, error: 'Invalid model name' };
    }
    try {
      return await ollamaManager.pullModel(model);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '모델 다운로드 실패' };
    }
  });

  // R44(R43 후속 F9): 진행 중인 모델 다운로드 취소. Ollama 는 부분 다운로드 레이어를
  // 캐시하므로 중단해도 다음 pull 에서 이어받는다 — "취소" 의 멘탈 모델과 일치시키고,
  // orphan pull 이 후속 수동 pull 을 '이미 진행 중' 에러로 차단하던 문제를 해소.
  ipcMain.handle('ollama:cancel-pull', async () => {
    try {
      await ollamaManager.killPullProcess();
      return { success: true };
    } catch (err) {
      console.error('[ollama:cancel-pull] failed:', err);
      return { success: false };
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
    provider: 'ollama' | 'claude' | 'openai' | 'gemini';
    model: string;
    ollamaBaseUrl: string;
    temperature?: number;
    language?: string;
  }) => {
    // R38 P1: 입력 검증 전체를 ipc-validators 의 순수 함수로 위임 (행위 검증 가능).
    // 검증 순서·거부 메시지는 ipc-validators.test.ts 가 회귀로 가드한다. SSRF(localhost)
    // 가드 · model 정규식 · 길이 캡 · provider/type/language 화이트리스트가 모두 포함됨.
    const valid = validateGenerateRequest(requestId, request);
    if (!valid.ok) {
      return { success: false, error: valid.error };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: '윈도우를 찾을 수 없습니다.' };

    const apiKey = request.provider !== 'ollama'
      ? apiKeyStore.load(request.provider)
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
    if (!isValidRequestId(requestId, 256)) {
      return { success: false, error: 'Invalid requestId' };
    }
    abortGenerate(requestId);
    // R31 (v0.18.18 patch): Vision 측은 `vision:${rid}` 로 namespacing 됐으므로 prefix
    // 버전도 시도. renderer 는 bare id 만 알면 되도록 main 이 양쪽을 흡수.
    abortGenerate(`vision:${requestId}`);
    return { success: true };
  });

  ipcMain.handle('ai:check-available', async (_event, provider: string, _ollamaBaseUrl: string) => {
    // R38 P1: provider 화이트리스트 + ollama localhost SSRF 가드를 ipc-validators 로 위임.
    if (!isValidProvider(provider)) return false;
    // R39 (v0.18.26): SSRF 포트-스캔 오라클 차단. 이전엔 renderer 가 전달한 URL 을 그대로
    // checkAvailability 에 넘겨, 손상된 렌더러가 `ai:check-available('ollama', 'http://127.0.0.1:<임의포트>')`
    // 를 per-call 로 호출하며 임의 localhost 포트를 스윕하는 프로브 오라클이 됐다(host/protocol 은
    // 검증되나 port 미검증). embeddings/vision 핸들러와 동일하게 settings store 의 정규 URL 만
    // 사용해 renderer 인자를 신뢰 경계 밖으로 밀어낸다. renderer 의 isAvailable() 은 항상 저장된
    // settings.ollamaBaseUrl 로 호출하므로(저장 전 임의 입력 테스트 경로 없음) UX 영향 없음.
    const ollamaBaseUrl =
      provider === 'ollama'
        ? ((await loadSettings()).ollamaBaseUrl as string) || 'http://localhost:11434'
        : _ollamaBaseUrl;
    if (!isValidOllamaBaseUrl(ollamaBaseUrl, provider)) return false;
    const apiKey = provider !== 'ollama' ? apiKeyStore.load(provider) : undefined;
    return checkAvailability(provider, ollamaBaseUrl, apiKey);
  });

  // ─── Vision 공통: Ollama Vision 모델 자동 선택 ───

  const OLLAMA_VISION_MODELS = ['llava', 'llama3.2-vision', 'bakllava', 'moondream'];

  async function resolveVisionModel(errorPrefix: string) {
    const settings = await loadSettings();
    const provider = (settings.provider as 'ollama' | 'claude' | 'openai' | 'gemini') || 'ollama';
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
    const apiKey = provider !== 'ollama' ? apiKeyStore.load(provider) : undefined;
    return { provider, model, ollamaBaseUrl, apiKey };
  }

  // R38 P1: validateImageBase64 는 ipc-validators.ts 로 이동 (행위 검증 가능).

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

  // v0.18.20 R32 P2: requestId 선택 인자 추가 — renderer 가 ai:abort 로 in-flight OCR 호출을
  // 즉시 취소할 수 있도록 함. R30 P2 가 ai:analyze-image 만 고치고 OCR 경로는 누락되어 있었다.
  // 클라우드 OCR 은 BATCH_SIZE=8 (cloud) × ~90s 호출이라 Stop 클릭 후에도 in-flight 8건이
  // 끝까지 진행되며 토큰 비용 청구되던 결함 (R32 Surface 2 P2). analyze-image 와 동일한
  // `vision:` prefix namespacing 으로 activeRequests 충돌 방지.
  ipcMain.handle('ai:ocr-page', async (_event, imageBase64: string, requestId: unknown) => {
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
      const { provider, model, ollamaBaseUrl, apiKey } = await resolveVisionModel('OCR을 위해');
      const text = await analyzeImageForOcr(imageBase64, provider, model, ollamaBaseUrl, apiKey, controller?.signal);
      return { success: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OCR 실패';
      const isAbort = msg === 'Aborted' || (err as Error & { code?: string })?.code === 'ABORT_ERR';
      return isAbort
        ? { success: false, error: 'Aborted', code: 'ABORTED' }
        : { success: false, error: msg };
    } finally {
      if (visionRequestId && controller) unregisterEmbedRequest(visionRequestId, controller);
    }
  });

  // ─── 임베딩 (RAG용) ───

  ipcMain.handle('ai:embed', async (_event, texts: unknown, requestId: unknown) => {
    // R38 P1: texts 배열 검증(1-200개, 각 1-32000자)을 ipc-validators 로 위임.
    const textsCheck = validateEmbedTexts(texts);
    if (!textsCheck.ok) {
      return { success: false, error: textsCheck.error };
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
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai' | 'gemini') || 'ollama';
      const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
      const apiKey = provider !== 'ollama' ? apiKeyStore.load(provider) : undefined;
      // R38 P1: texts 는 validateEmbedTexts 가 string[] 임을 이미 보증 (위 early return).
      // 검증을 별도 함수로 분리하면서 Array.isArray 의 흐름 narrowing 이 소실되므로 명시 cast.
      const result = await generateEmbeddings(texts as string[], provider, ollamaBaseUrl, apiKey, undefined, controller?.signal);
      if (!result) {
        return { success: false, error: '임베딩 생성 불가 (해당 프로바이더 미지원)' };
      }
      // R38 P1: IPC 경계에서 빈 벡터/NaN/Infinity 검증 — 벡터 스토어 오염 방지 (ipc-validators).
      const embCheck = validateEmbeddings(result.embeddings);
      if (!embCheck.ok) {
        return { success: false, error: embCheck.error };
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
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai' | 'gemini') || 'ollama';
      if (provider === 'openai') {
        const apiKey = apiKeyStore.load('openai');
        return { available: !!apiKey, model: 'text-embedding-3-small' };
      }
      if (provider === 'gemini') {
        const apiKey = apiKeyStore.load('gemini');
        return { available: !!apiKey, model: GEMINI_EMBED_MODEL };
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

  // session-persistence(module-4): 최근목록에서 특정 경로의 PDF 를 다이얼로그 없이 재오픈.
  // file:open-pdf 와 동일한 보안 가드(.pdf 확장자 + 심볼릭링크 거부 + isFile + 100MB 캡)를
  // 적용해 임의 파일 읽기 표면을 차단한다. 경로는 manifest(사용자가 이전에 연 파일)에서 옴.
  ipcMain.handle('file:open-path', async (_event, targetPath: unknown) => {
    const MAX_PDF_SIZE = MAX_PDF_SIZE_BYTES;
    if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.length > 4096) {
      return { error: '잘못된 경로입니다.' };
    }
    if (path.extname(targetPath).toLowerCase() !== '.pdf') {
      return { error: 'PDF 파일만 열 수 있습니다.' };
    }
    try {
      const lstat = await fsp.lstat(targetPath);
      if (lstat.isSymbolicLink()) return { error: '심볼릭 링크는 열 수 없습니다.' };
      const stat = await fsp.stat(targetPath);
      if (!stat.isFile()) return { error: '일반 파일이 아닙니다.' };
      if (stat.size > MAX_PDF_SIZE) return { error: 'PDF 파일이 너무 큽니다 (최대 100MB).' };
      const buffer = await fsp.readFile(targetPath);
      const arrayBuf = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
        ? buffer.buffer
        : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { path: targetPath, name: path.basename(targetPath), data: arrayBuf };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const friendly = code === 'ENOENT' ? '파일을 찾을 수 없습니다 (이동/삭제되었을 수 있습니다).'
        : code === 'EPERM' || code === 'EACCES' ? '파일에 접근할 수 없습니다.'
        : 'PDF 파일을 열 수 없습니다.';
      console.error('[file:open-path] failed:', err);
      return { error: friendly };
    }
  });
}

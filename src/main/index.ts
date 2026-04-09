import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fsp from 'fs/promises';
import { OllamaManager } from './ollama-manager';
import { generate, abortGenerate, checkAvailability, analyzeImage, analyzeImageForOcr, generateEmbeddings, checkEmbeddingAvailability, cleanupAiService } from './ai-service';

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
} as const;

const VALID_SETTINGS_KEYS_SET = new Set([
  'provider', 'model', 'ollamaBaseUrl', 'theme', 'uiLanguage', 'defaultSummaryType', 'maxChunkSize', 'enableImageAnalysis', 'enableOcrFallback', 'summaryLanguage',
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
  } catch {
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
    },
    title: '',
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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

  // 파일 드롭 시 file:// 탐색 차단 → 대신 IPC로 파일 데이터 전달 (비동기)
  let dropAbortController: AbortController | null = null;
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('file://') && url.toLowerCase().endsWith('.pdf')) {
      // UNC 경로 차단: file://remote-server/share/file.pdf 등 네트워크 읽기 방지
      try { if (new URL(url).hostname !== '') return; } catch { return; }
      const filePath = fileURLToPath(url);
      const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB
      // 이전 드롭 읽기 취소
      dropAbortController?.abort();
      const ac = new AbortController();
      dropAbortController = ac;
      (async () => {
        try {
          const stat = await fsp.stat(filePath);
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
  cleanupAiService(); // safety net: before-quit 미호출 시 대비
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

function readApiKeys(): Record<string, string> {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch {
    return {};
  }
}

function writeApiKeys(keys: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[API Keys] OS 키체인을 사용할 수 없어 API 키를 저장할 수 없습니다.');
    return;
  }
  const tmpPath = apiKeysPath + '.tmp';
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  try {
    fs.writeFileSync(tmpPath, encrypted);
    fs.renameSync(tmpPath, apiKeysPath);
  } catch (err) {
    // rename 실패 시 tmp 파일 정리하여 디스크 누수 방지
    try { fs.unlinkSync(tmpPath); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}

function saveApiKey(provider: string, key: string): void {
  const keys = readApiKeys();
  keys[provider] = key;
  writeApiKeys(keys);
}

function deleteApiKey(provider: string): void {
  const keys = readApiKeys();
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
  ] as const;

  ipcMain.handle('apikey:save', (_event, provider: string, key: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 512) {
      return { success: false, error: 'Invalid API key' };
    }
    saveApiKey(provider, key.trim());
    return { success: true };
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
    deleteApiKey(provider);
    return { success: true };
  });

  const VALID_THEMES = ['light', 'dark', 'system'] as const;
  const VALID_UI_LANGUAGES = ['ko', 'en'] as const;
  const VALID_SUMMARY_TYPES = ['full', 'chapter', 'keywords'] as const;

  ipcMain.handle('settings:set', async (_event, partial: Record<string, unknown>) => {
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
              const allowedHosts = ['localhost', '127.0.0.1', '::1'];
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
      }
    }
    const updated = { ...current, ...filtered };
    await saveSettings(updated);
    return updated;
  });

  ipcMain.handle('ollama:status', async () => {
    return ollamaManager.getStatus();
  });

  ipcMain.handle('ollama:install', async (_event) => {
    return ollamaManager.install();
  });

  ipcMain.handle('ollama:start', async () => {
    return ollamaManager.start();
  });

  ipcMain.handle('ollama:stop', async () => {
    return ollamaManager.stop();
  });

  ipcMain.handle('ollama:pull-model', async (_event, model: string) => {
    if (typeof model !== 'string' || model.length === 0 || model.length > 128 || !/^[a-zA-Z0-9]([a-zA-Z0-9._:\/-]*[a-zA-Z0-9])?$/.test(model)) {
      return { success: false, error: 'Invalid model name' };
    }
    return ollamaManager.pullModel(model);
  });

  ipcMain.handle('ollama:list-models', async () => {
    return ollamaManager.listModels();
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
    // 입력값 검증
    if (typeof requestId !== 'string' || !requestId) {
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
        const allowedHosts = ['localhost', '127.0.0.1', '::1'];
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
    if (typeof request.model !== 'string' || !request.model) {
      return { success: false, error: 'Invalid model' };
    }
    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || Number.isNaN(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
      return { success: false, error: 'Invalid temperature' };
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
    return { success: true };
  });

  ipcMain.handle('ai:check-available', async (_event, provider: string, ollamaBaseUrl: string) => {
    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) return false;
    if (typeof ollamaBaseUrl !== 'string') return false;
    // IPC 경계에서 localhost URL 검증
    if (provider === 'ollama') {
      try {
        const parsed = new URL(ollamaBaseUrl);
        const allowedHosts = ['localhost', '127.0.0.1', '::1'];
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
      if (available.length === 0) {
        throw new Error(`${errorPrefix} Vision 모델이 필요합니다. 설정에서 llava 모델을 설치해주세요.`);
      }
      model = available[0];
    }
    const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
    return { provider, model, ollamaBaseUrl, apiKey };
  }

  function validateImageBase64(imageBase64: unknown): imageBase64 is string {
    return typeof imageBase64 === 'string' && imageBase64.length > 0
      && imageBase64.length <= 10 * 1024 * 1024 && /^[A-Za-z0-9+/\n]+=*$/.test(imageBase64);
  }

  ipcMain.handle('ai:analyze-image', async (_event, imageBase64: string) => {
    if (!validateImageBase64(imageBase64)) {
      return { success: false, error: '이미지 데이터가 유효하지 않습니다.' };
    }
    try {
      const { provider, model, ollamaBaseUrl, apiKey } = await resolveVisionModel('이미지 분석을 위해');
      const description = await analyzeImage(imageBase64, provider, model, ollamaBaseUrl, apiKey);
      return { success: true, description };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Vision 분석 실패' };
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

  ipcMain.handle('ai:embed', async (_event, texts: unknown) => {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 200) {
      return { success: false, error: 'Invalid texts array (1-200 items)' };
    }
    for (const t of texts) {
      if (typeof t !== 'string' || t.length === 0 || t.length > 32000) {
        return { success: false, error: 'Each text must be 1-32000 chars' };
      }
    }
    try {
      const settings = await loadSettings();
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai') || 'ollama';
      const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
      const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
      const result = await generateEmbeddings(texts, provider, ollamaBaseUrl, apiKey);
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
      return { success: false, error: err instanceof Error ? err.message : '임베딩 생성 실패' };
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
      await fsp.writeFile(filePath, content, 'utf-8');
      return filePath;
    }
    return null;
  });

  const ALLOWED_EXTERNAL_DOMAINS = ['ollama.com', 'anthropic.com', 'openai.com', 'github.com'];

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string') return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return;
      if (!ALLOWED_EXTERNAL_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) return;
      await shell.openExternal(url);
    } catch { /* 유효하지 않은 URL 무시 */ }
  });

  ipcMain.handle('file:open-pdf', async () => {
    const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (filePaths.length > 0) {
      const stat = await fsp.stat(filePaths[0]);
      if (stat.size > MAX_PDF_SIZE) {
        return { error: 'PDF 파일이 너무 큽니다 (최대 100MB).' };
      }
      const buffer = await fsp.readFile(filePaths[0]);
      const arrayBuf = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
        ? buffer.buffer
        : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return {
        path: filePaths[0],
        name: path.basename(filePaths[0]),
        data: arrayBuf,
      };
    }
    return null;
  });
}

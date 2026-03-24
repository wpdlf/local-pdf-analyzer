import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { OllamaManager } from './ollama-manager';
import { generate, abortGenerate, checkAvailability, analyzeImage } from './ai-service';

const ollamaManager = new OllamaManager();

// electron-store는 ESM 전용이므로 JSON 파일로 직접 관리
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
// 기본 설정값 (src/renderer/types/index.ts의 DEFAULT_SETTINGS와 동기화 필요)
const defaultSettings = {
  provider: 'ollama',
  model: 'gemma3',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
  enableImageAnalysis: true,
} as const;

const VALID_SETTINGS_KEYS_SET = new Set([
  'provider', 'model', 'ollamaBaseUrl', 'theme', 'defaultSummaryType', 'maxChunkSize', 'enableImageAnalysis',
]);

function loadSettings(): Record<string, unknown> {
  try {
    const data = fs.readFileSync(settingsPath, 'utf-8');
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

function saveSettings(settings: Record<string, unknown>): void {
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'PDF 자료 요약기',
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  // 파일 드롭 시 file:// 탐색 차단 → 대신 IPC로 파일 데이터 전달
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('file://') && url.toLowerCase().endsWith('.pdf')) {
      const filePath = fileURLToPath(url);
      try {
        const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB
        const fd = fs.openSync(filePath, 'r');
        try {
          const stat = fs.fstatSync(fd);
          if (stat.size > MAX_PDF_SIZE) {
            console.error('Dropped file too large:', stat.size);
            return;
          }
          const data = Buffer.alloc(stat.size);
          fs.readSync(fd, data, 0, stat.size, 0);
          win.webContents.send('file:dropped', {
            path: filePath,
            name: path.basename(filePath),
            data: data.buffer,
          });
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        console.error('Failed to read dropped file:', err);
      }
    }
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  ollamaManager.stop();
});

const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.enc');

function writeApiKeys(keys: Record<string, string>): void {
  const tmpPath = apiKeysPath + '.tmp';
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.writeFileSync(tmpPath, encrypted);
  fs.renameSync(tmpPath, apiKeysPath);
}

function saveApiKey(provider: string, key: string): void {
  let keys: Record<string, string> = {};
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    keys = JSON.parse(safeStorage.decryptString(encrypted));
  } catch { /* 첫 저장 */ }
  keys[provider] = key;
  writeApiKeys(keys);
}

function deleteApiKey(provider: string): void {
  let keys: Record<string, string> = {};
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    keys = JSON.parse(safeStorage.decryptString(encrypted));
  } catch { /* 파일 없음 */ }
  delete keys[provider];
  writeApiKeys(keys);
}

function loadApiKey(provider: string): string | undefined {
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    const keys = JSON.parse(safeStorage.decryptString(encrypted));
    return keys[provider];
  } catch {
    return undefined;
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => {
    // API 키는 Renderer에 전달하지 않음 — Main 프로세스에서만 사용
    return loadSettings();
  });

  const VALID_PROVIDERS = ['ollama', 'claude', 'openai'] as const;
  const VALID_SETTINGS_KEYS = [
    'provider', 'model', 'ollamaBaseUrl', 'theme',
    'defaultSummaryType', 'maxChunkSize', 'enableImageAnalysis',
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
  const VALID_SUMMARY_TYPES = ['full', 'chapter', 'keywords'] as const;

  ipcMain.handle('settings:set', (_event, partial: Record<string, unknown>) => {
    const current = loadSettings();
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
        case 'defaultSummaryType':
          if (VALID_SUMMARY_TYPES.includes(val as typeof VALID_SUMMARY_TYPES[number])) filtered[key] = val;
          break;
        case 'maxChunkSize':
          if (typeof val === 'number' && val >= 1000 && val <= 16000) filtered[key] = val;
          break;
        case 'enableImageAnalysis':
          if (typeof val === 'boolean') filtered[key] = val;
          break;
      }
    }
    const updated = { ...current, ...filtered };
    saveSettings(updated);
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
    type: 'full' | 'chapter' | 'keywords';
    provider: 'ollama' | 'claude' | 'openai';
    model: string;
    ollamaBaseUrl: string;
    temperature?: number;
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
    if (!['full', 'chapter', 'keywords'].includes(request.type)) {
      return { success: false, error: 'Invalid type' };
    }
    if (!VALID_PROVIDERS.includes(request.provider as typeof VALID_PROVIDERS[number])) {
      return { success: false, error: 'Invalid provider' };
    }
    if (typeof request.model !== 'string' || !request.model) {
      return { success: false, error: 'Invalid model' };
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
    abortGenerate(requestId);
    return { success: true };
  });

  ipcMain.handle('ai:check-available', async (_event, provider: 'ollama' | 'claude' | 'openai', ollamaBaseUrl: string) => {
    const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
    return checkAvailability(provider, ollamaBaseUrl, apiKey);
  });

  ipcMain.handle('ai:analyze-image', async (_event, imageBase64: string) => {
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0 || imageBase64.length > 10 * 1024 * 1024) {
      return { success: false, error: '이미지 데이터가 유효하지 않습니다.' };
    }
    try {
      const settings = loadSettings();
      const provider = (settings.provider as 'ollama' | 'claude' | 'openai') || 'ollama';
      const ollamaBaseUrl = (settings.ollamaBaseUrl as string) || 'http://localhost:11434';
      // Ollama: Vision 모델 자동 선택 (텍스트 모델은 Vision 미지원)
      const OLLAMA_VISION_MODELS = ['llava', 'llama3.2-vision', 'bakllava', 'moondream'];
      const configuredModel = (settings.model as string) || '';
      let model = configuredModel;
      if (provider === 'ollama' && !OLLAMA_VISION_MODELS.some((v) => configuredModel.startsWith(v))) {
        // 설치된 Vision 모델 탐색
        const installed = await ollamaManager.listModels();
        const availableVision = installed.filter((m: string) => OLLAMA_VISION_MODELS.some((v) => m.startsWith(v)));
        if (availableVision.length === 0) {
          return { success: false, error: '이미지 분석을 위해 Vision 모델이 필요합니다. 설정에서 llava 모델을 설치해주세요.' };
        }
        model = availableVision[0];
      }
      const apiKey = provider !== 'ollama' ? loadApiKey(provider) : undefined;
      const description = await analyzeImage(imageBase64, provider, model, ollamaBaseUrl, apiKey);
      return { success: true, description };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Vision 분석 실패' };
    }
  });

  // ─── 파일 ───

  ipcMain.handle('file:save', async (_event, content: unknown, defaultName: unknown) => {
    if (typeof content !== 'string' || typeof defaultName !== 'string') {
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
      const fsp = await import('fs/promises');
      await fsp.writeFile(filePath, content, 'utf-8');
      return filePath;
    }
    return null;
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    // https/http URL만 허용
    if (/^https?:\/\//.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('file:open-pdf', async () => {
    const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (filePaths.length > 0) {
      const fsp = await import('fs/promises');
      const stat = await fsp.stat(filePaths[0]);
      if (stat.size > MAX_PDF_SIZE) {
        return { error: 'PDF 파일이 너무 큽니다 (최대 100MB).' };
      }
      const buffer = await fsp.readFile(filePaths[0]);
      return {
        path: filePaths[0],
        name: path.basename(filePaths[0]),
        data: buffer,
      };
    }
    return null;
  });
}

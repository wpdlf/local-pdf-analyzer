import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { OllamaManager } from './ollama-manager';
import { generate, abortGenerate, checkAvailability } from './ai-service';

const ollamaManager = new OllamaManager();

// electron-store는 ESM 전용이므로 JSON 파일로 직접 관리
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  provider: 'ollama',
  model: 'llama3.2',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
};

const VALID_SETTINGS_KEYS_SET = new Set([
  'provider', 'model', 'ollamaBaseUrl', 'theme', 'defaultSummaryType', 'maxChunkSize',
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
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

  if (process.env['ELECTRON_RENDERER_URL']) {
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
        const data = fs.readFileSync(filePath);
        win.webContents.send('file:dropped', {
          path: filePath,
          name: path.basename(filePath),
          data: data.buffer,
        });
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

function saveApiKey(provider: string, key: string): void {
  let keys: Record<string, string> = {};
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    keys = JSON.parse(safeStorage.decryptString(encrypted));
  } catch { /* 첫 저장 */ }
  keys[provider] = key;
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.writeFileSync(apiKeysPath, encrypted);
}

function deleteApiKey(provider: string): void {
  let keys: Record<string, string> = {};
  try {
    const encrypted = fs.readFileSync(apiKeysPath);
    keys = JSON.parse(safeStorage.decryptString(encrypted));
  } catch { /* 파일 없음 */ }
  delete keys[provider];
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.writeFileSync(apiKeysPath, encrypted);
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
    'defaultSummaryType', 'maxChunkSize',
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
            try { new URL(val); filtered[key] = val; } catch { /* 유효하지 않은 URL 무시 */ }
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
    if (!/^[a-zA-Z0-9._:\/-]+$/.test(model)) {
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
    if (!request || typeof request.text !== 'string' || !request.text) {
      return { success: false, error: 'Invalid text' };
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
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (filePaths.length > 0) {
      const fsp = await import('fs/promises');
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

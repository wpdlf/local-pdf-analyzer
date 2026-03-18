import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import { OllamaManager } from './ollama-manager';

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

function loadSettings(): Record<string, unknown> {
  try {
    const data = fs.readFileSync(settingsPath, 'utf-8');
    return { ...defaultSettings, ...JSON.parse(data) };
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
      sandbox: false,
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
      const filePath = decodeURIComponent(url.replace('file:///', '').replace('file://', ''));
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
    const settings = loadSettings();
    // API 키를 마스킹하여 전달 (실제 키는 apikey:get으로 별도 조회)
    return {
      ...settings,
      claudeApiKey: loadApiKey('claude') ? '••••••••' : undefined,
      openaiApiKey: loadApiKey('openai') ? '••••••••' : undefined,
    };
  });

  ipcMain.handle('apikey:save', (_event, provider: string, key: string) => {
    saveApiKey(provider, key);
    return { success: true };
  });

  ipcMain.handle('apikey:get', (_event, provider: string) => {
    return loadApiKey(provider) || '';
  });

  ipcMain.handle('apikey:delete', (_event, provider: string) => {
    saveApiKey(provider, '');
    return { success: true };
  });

  ipcMain.handle('settings:set', (_event, partial: Record<string, unknown>) => {
    const current = loadSettings();
    // API 키는 settings.json에 저장하지 않음 (암호화 별도 저장)
    const { claudeApiKey, openaiApiKey, ...rest } = partial;
    const updated = { ...current, ...rest };
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
    return ollamaManager.pullModel(model);
  });

  ipcMain.handle('ollama:list-models', async () => {
    return ollamaManager.listModels();
  });

  ipcMain.handle('file:save', async (_event, content: string, defaultName: string) => {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
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

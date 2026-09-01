import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';

// R38 P2 (test coverage): IPC 핸들러 "행위" 검증 — electron 모킹 + 핸들러 캡처/invoke.
//
// ipc-validators.test(R38 P1) 가 검증 로직 자체를, ipc-contract.test 가 배선 drift 를 가드한다면,
// 본 테스트는 그 둘로 못 잡는 **핸들러 오케스트레이션**을 검증한다:
//   - settings:set 직렬화 mutex (burst 시 lost update 방지)
//   - ai:embed 동시성 캡 + 카운터 누수 방지 (R28 P2 / R29 회귀)
//   - ai:abort 이중 namespace 디스패치 (bare + `vision:`)
//   - apikey:* provider 화이트리스트 + KEYCHAIN_UNAVAILABLE 에러 매핑
//   - shell:open-external host allowlist (gist.github.com 회귀 / https-only)
//   - file:save 확장자 allowlist + 크기 캡
//   - ollama:status / pull-model delegation + 에러 래핑
//
// 방법: index.ts 의 I/O·네트워크 의존성(electron / ai-service / ollama-manager / api-keys-store /
// settings-store / fs/promises)을 모킹하고, registerIpcHandlers() 를 직접 호출해 ipcMain.handle
// 로 등록된 핸들러 클로저를 캡처한 뒤 직접 invoke 한다. 순수 모듈(ipc-validators / settings-keys /
// shared/constants)은 실물 유지하여 핸들러가 그것들과 올바르게 결합하는지까지 함께 검증된다.

const H = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shell: { openExternal: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ai: {
    generate: vi.fn(),
    abortGenerate: vi.fn(),
    abortAllRequests: vi.fn(),
    checkAvailability: vi.fn(),
    analyzeImage: vi.fn(),
    analyzeImageForOcr: vi.fn(),
    generateEmbeddings: vi.fn(),
    checkEmbeddingAvailability: vi.fn(),
    cleanupAiService: vi.fn(),
    registerEmbedRequest: vi.fn(),
    unregisterEmbedRequest: vi.fn(),
    // vi.mock 이 ai-service 모듈 전체를 대체하므로 index.ts 가 import 하는 상수도 제공
    GEMINI_EMBED_MODEL: 'gemini-embedding-2',
  },
  ollama: {
    getStatus: vi.fn(),
    isInstalled: vi.fn(),
    install: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    healthCheck: vi.fn(),
    listModels: vi.fn(),
    pullModel: vi.fn(),
    killPullProcess: vi.fn(),
  },
  store: { read: vi.fn(), load: vi.fn(), loadState: vi.fn(), save: vi.fn(), delete: vi.fn(), invalidate: vi.fn() },
  settings: { load: vi.fn(), save: vi.fn() },
  // localeAwareDefaults 가 호출하는 app.getLocale — 테스트별 로캘 override 용
  appLocale: vi.fn(() => 'ko-KR'),
  fsp: {
    writeFile: vi.fn(), readFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(),
    // session-store(module-2) 가 사용하는 추가 메서드
    rename: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), unlink: vi.fn(),
  },
  // QA28(C-MED): file:export-pdf 의 격리 세션·오프스크린 창 관측용.
  exportWin: {
    partitions: [] as string[],
    onBeforeRequest: null as null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
    ctorOpts: null as null | Record<string, unknown>,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    loadFile: vi.fn(),
    printToPDF: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
    // pending Promise — app.whenReady().then 콜백(registerIpcHandlers 자동 호출)이 발화하지
    // 않게 하여 테스트가 직접 registerIpcHandlers() 를 호출해 1회만 등록하도록 한다.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    once: vi.fn(),
    quit: vi.fn(),
    isPackaged: false,
    // 자동 업데이트 서비스가 초기 상태(currentVersion)를 만들 때 사용.
    getVersion: () => '0.0.0-test',
    getLocale: H.appLocale,
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return []; }
    static fromWebContents(): unknown { return { isDestroyed: () => false }; }
    // QA28(C-MED): file:export-pdf 가 만드는 오프스크린 창 — 생성 옵션·webContents 호출을 캡처.
    webContents = {
      setWindowOpenHandler: H.exportWin.setWindowOpenHandler,
      on: H.exportWin.on,
      printToPDF: H.exportWin.printToPDF,
    };
    constructor(opts: Record<string, unknown>) { H.exportWin.ctorOpts = opts; }
    loadFile = H.exportWin.loadFile;
    isDestroyed(): boolean { return false; }
    destroy(): void { /* no-op */ }
  },
  session: {
    fromPartition: (name: string) => {
      H.exportWin.partitions.push(name);
      return {
        webRequest: {
          onBeforeRequest: (fn: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) => {
            H.exportWin.onBeforeRequest = fn;
          },
        },
      };
    },
  },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { H.handlers.set(ch, fn); } },
  dialog: H.dialog,
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: H.shell,
}));

// index.ts 가 정적 import 하는 electron-updater — 실물은 electron 런타임을 요구한다.
// isPackaged:false 라 updater 서비스는 wire 하지 않지만(no-op), 모듈 로드 자체는 발생한다.
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));
vi.mock('../ai-service', () => H.ai);
vi.mock('../ollama-manager', () => ({
  OllamaManager: class {
    getStatus = H.ollama.getStatus;
    isInstalled = H.ollama.isInstalled;
    install = H.ollama.install;
    start = H.ollama.start;
    stop = H.ollama.stop;
    healthCheck = H.ollama.healthCheck;
    listModels = H.ollama.listModels;
    pullModel = H.ollama.pullModel;
    killPullProcess = H.ollama.killPullProcess;
  },
}));
vi.mock('../api-keys-store', () => ({
  ApiKeyStore: class {
    read = H.store.read;
    load = H.store.load;
    loadState = H.store.loadState;
    save = H.store.save;
    delete = H.store.delete;
    invalidate = H.store.invalidate;
  },
}));
vi.mock('../settings-store', () => ({ loadSettings: H.settings.load, saveSettings: H.settings.save }));
vi.mock('fs/promises', () => ({ default: H.fsp }));

import { registerIpcHandlers } from '../index';

/** 캡처된 핸들러를 dummy event 와 함께 호출. */
function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = H.handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, ...args);
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  registerIpcHandlers();
});

beforeEach(() => {
  // 기본 동작 (각 테스트가 필요 시 override). clearAllMocks(global afterEach)는 call 만 비우므로
  // 구현은 매 테스트 재설정.
  H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434' });
  H.settings.save.mockResolvedValue(undefined);
  H.appLocale.mockReturnValue('ko-KR');
  H.store.load.mockReturnValue(undefined);
  // QA30(C-6): loadState 는 load 의 정보 보존형(transient 구분). 기본값은 "정상 읽기" 로
  // 세워 기존 테스트가 H.store.load 만 조작해도 종전처럼 동작하게 한다.
  H.store.loadState.mockImplementation((provider: string) => ({ key: H.store.load(provider), transient: false }));
  H.store.save.mockReturnValue(undefined);
  H.store.delete.mockReturnValue(undefined);
  // QA22(D-MED): fsp 목 **구현**도 매 테스트 재설정한다. clearAllMocks 는 call 만 비우므로,
  // file:open-path 테스트가 세운 `readFile → '%PDF-1.4 test'` 가 파일 끝까지 살아남아
  // collections 테스트가 **손상 JSON reset 경로**를 탔다(stderr 에 "load failed, resetting" 실측).
  // 그 결과 "파일 없음(ENOENT) → 빈 배열" 테스트는 ENOENT 분기를 전혀 검증하지 않았고,
  // 그 분기가 rethrow 로 바뀌어도 그린이었다. writeFile 의 EACCES 목도 같은 방식으로 누수됐다.
  H.fsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  H.fsp.writeFile.mockResolvedValue(undefined);
  H.fsp.rename.mockResolvedValue(undefined);
  H.fsp.unlink.mockResolvedValue(undefined);
  H.fsp.lstat.mockResolvedValue({ isSymbolicLink: () => false });
  H.fsp.stat.mockResolvedValue({ isFile: () => true, size: 1000 });
});

describe('핸들러 등록', () => {
  it('필수 핸들러가 모두 캡처됨', () => {
    for (const ch of [
      'settings:get', 'settings:set', 'apikey:save', 'apikey:has', 'apikey:delete',
      'ai:generate', 'ai:abort', 'ai:embed', 'ollama:status', 'ollama:pull-model',
      'shell:open-external', 'file:save', 'file:open-pdf',
    ]) {
      expect(H.handlers.has(ch), `${ch} 미등록`).toBe(true);
    }
  });
});

describe('apikey:save', () => {
  it('미지원 provider 거부 (store 미호출)', async () => {
    expect(await invoke('apikey:save', 'mistral', 'sk-x')).toEqual({ success: false, error: 'Invalid provider' });
    expect(H.store.save).not.toHaveBeenCalled();
  });

  it.each([['빈 키', ''], ['공백 키', '   '], ['512 초과', 'x'.repeat(513)]])(
    '유효하지 않은 키 거부: %s',
    async (_l, key) => {
      expect(await invoke('apikey:save', 'claude', key)).toEqual({ success: false, error: 'Invalid API key' });
      expect(H.store.save).not.toHaveBeenCalled();
    },
  );

  it('정상 저장 — 키 trim 후 store.save 위임', async () => {
    expect(await invoke('apikey:save', 'claude', '  sk-123  ')).toEqual({ success: true });
    expect(H.store.save).toHaveBeenCalledWith('claude', 'sk-123');
  });

  // C5-L(QA cycle5): code 도 함께 전파 — 렌더러가 error 원문(한국어/절대경로 가능) 대신
  // code→i18n 매핑으로 표시할 수 있게 하는 계약.
  // QA6-A: error 페이로드 자체도 generic — fs 에러 원문의 userData 절대경로를 IPC 로 실어
  // 보내지 않는다(렌더러는 code 만 사용).
  it('KEYCHAIN_UNAVAILABLE throw → {success:false, error(generic), code} 로 매핑 — 원문 비전송', async () => {
    H.store.save.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: rename C:\\Users\\x\\api-keys.enc.tmp'), { code: 'KEYCHAIN_UNAVAILABLE' });
    });
    expect(await invoke('apikey:save', 'openai', 'sk-o'))
      .toEqual({ success: false, error: 'API key save failed', code: 'KEYCHAIN_UNAVAILABLE' });
  });
});

describe('apikey:has / apikey:delete', () => {
  it('has: 미지원 provider → false', async () => {
    expect(await invoke('apikey:has', 'mistral')).toBe(false);
  });

  it('has: 저장된 키 있으면 true, 없으면 false', async () => {
    H.store.load.mockReturnValue('sk-c');
    expect(await invoke('apikey:has', 'claude')).toBe(true);
    H.store.load.mockReturnValue(undefined);
    expect(await invoke('apikey:has', 'claude')).toBe(false);
  });

  it('delete: 미지원 provider → {success:false}', async () => {
    expect(await invoke('apikey:delete', 'mistral')).toEqual({ success: false, error: 'Invalid provider' });
    expect(H.store.delete).not.toHaveBeenCalled();
  });

  it('delete: 정상 → store.delete 위임', async () => {
    expect(await invoke('apikey:delete', 'claude')).toEqual({ success: true });
    expect(H.store.delete).toHaveBeenCalledWith('claude');
  });

  it('R44 F9: ollama:cancel-pull → killPullProcess 위임', async () => {
    H.ollama.killPullProcess.mockResolvedValue(undefined);
    expect(await invoke('ollama:cancel-pull')).toEqual({ success: true });
    expect(H.ollama.killPullProcess).toHaveBeenCalledTimes(1);
  });

  it('R44 F9: ollama:cancel-pull — killPullProcess throw 시 {success:false}', async () => {
    H.ollama.killPullProcess.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await invoke('ollama:cancel-pull')).toEqual({ success: false });
    errSpy.mockRestore();
  });

  it('gemini provider 키 저장/조회 — 화이트리스트 통과', async () => {
    expect(await invoke('apikey:save', 'gemini', 'AIza-test-key')).toEqual({ success: true });
    expect(H.store.save).toHaveBeenCalledWith('gemini', 'AIza-test-key');
    H.store.load.mockReturnValue('AIza-test-key');
    expect(await invoke('apikey:has', 'gemini')).toBe(true);
  });
});

describe('ai:check-embed-model (gemini)', () => {
  it('provider gemini + 키 저장 → gemini 임베딩 모델 사용 가능', async () => {
    H.settings.load.mockResolvedValue({ provider: 'gemini' });
    H.store.load.mockReturnValue('AIza-test-key');
    expect(await invoke('ai:check-embed-model')).toEqual({ available: true, model: 'gemini-embedding-2' });
  });

  it('provider gemini + 키 없음 → 사용 불가 (키워드 검색 fallback 경로)', async () => {
    H.settings.load.mockResolvedValue({ provider: 'gemini' });
    H.store.load.mockReturnValue(undefined);
    expect(await invoke('ai:check-embed-model')).toEqual({ available: false, model: 'gemini-embedding-2' });
  });
});

describe('shell:open-external (host allowlist)', () => {
  it('허용 호스트 https → openExternal 호출', async () => {
    await invoke('shell:open-external', 'https://github.com/anthropics');
    expect(H.shell.openExternal).toHaveBeenCalledWith('https://github.com/anthropics');
  });

  it.each([
    ['gist.github.com (사용자 콘텐츠 — 회귀 가드)', 'https://gist.github.com/evil'],
    ['미허용 외부 호스트', 'https://evil.com'],
    ['http (비-https)', 'http://github.com'],
    ['비-string', 12345],
    ['2048 초과 URL', 'https://github.com/' + 'a'.repeat(2050)],
  ])('거부: %s (openExternal 미호출)', async (_l, url) => {
    await invoke('shell:open-external', url);
    expect(H.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('file:save (확장자 allowlist + 크기 캡)', () => {
  it('비-string content → null (다이얼로그 미호출)', async () => {
    expect(await invoke('file:save', 123, 'out.md')).toBeNull();
    expect(H.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('10MB 초과 content → null', async () => {
    expect(await invoke('file:save', 'a'.repeat(10 * 1024 * 1024 + 1), 'out.md')).toBeNull();
    expect(H.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('사용자 취소(filePath 없음) → null', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: undefined });
    expect(await invoke('file:save', 'hello', 'out.md')).toBeNull();
    expect(H.fsp.writeFile).not.toHaveBeenCalled();
  });

  it('허용되지 않은 확장자(.exe) → null (write 미수행)', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.exe' });
    expect(await invoke('file:save', 'hello', 'out.exe')).toBeNull();
    expect(H.fsp.writeFile).not.toHaveBeenCalled();
  });

  it('.md 정상 저장 → writeFile 후 경로 반환', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.md' });
    H.fsp.writeFile.mockResolvedValue(undefined);
    expect(await invoke('file:save', 'hello', 'out.md')).toBe('/tmp/out.md');
    // QA30(C-3): 제자리 덮어쓰기가 아니라 `.tmp` -> rename (아래 원자성 describe 참조).
    expect(H.fsp.writeFile).toHaveBeenCalledWith('/tmp/out.md.tmp', 'hello', 'utf-8');
    expect(H.fsp.rename).toHaveBeenCalledWith('/tmp/out.md.tmp', '/tmp/out.md');
  });

  it('writeFile 실패 → reject (E2: 취소 null 과 구분해 렌더러가 에러 표면화)', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.txt' });
    H.fsp.writeFile.mockRejectedValue(new Error('EACCES'));
    await expect(invoke('file:save', 'hello', 'out.txt')).rejects.toThrow('file:save failed');
  });

  it('취소(다이얼로그 경로 없음) → null (에러 아님)', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: undefined });
    expect(await invoke('file:save', 'hello', 'out.md')).toBeNull();
  });
});

describe('ai:generate (errorKey 전파 — QA7 i18n)', () => {
  const req = {
    text: 'hi', type: 'full', provider: 'claude', model: 'claude-sonnet-4-20250514',
    ollamaBaseUrl: 'http://localhost:11434',
  };

  it('generate 가 errorKey/errorParams 를 실은 에러로 reject → result 에 전파', async () => {
    H.ai.generate.mockRejectedValueOnce(Object.assign(
      new Error('Claude 요청 한도를 초과했습니다 (rate limit). 잠시 후 다시 시도해주세요.'),
      { errorKey: 'cloudRateLimit', errorParams: { provider: 'Claude' } },
    ));
    const r = await invoke('ai:generate', 'req-1', req) as { success: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string> };
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('cloudRateLimit');
    expect(r.errorParams).toEqual({ provider: 'Claude' });
    // 원문도 fallback 용으로 유지
    expect(r.error).toContain('rate limit');
  });

  it('errorKey 없는 에러는 error 원문만(구버전 호환)', async () => {
    H.ai.generate.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'GENERATE_FAIL' }));
    const r = await invoke('ai:generate', 'req-2', req) as { success: boolean; error?: string; errorKey?: string };
    expect(r.success).toBe(false);
    expect(r.error).toBe('boom');
    expect(r.errorKey).toBeUndefined();
  });
});

describe('QA28(C-Low): ai:generate 의 ollamaBaseUrl 은 저장 설정의 정규 URL 만 쓴다 (포트-스캔 오라클 형제 경로)', () => {
  const base = { text: 'hi', type: 'full' as const, model: 'llama3', ollamaBaseUrl: 'http://127.0.0.1:1' };

  it("provider 'ollama' — 렌더러가 보낸 URL 을 버리고 settings-store 의 URL 로 generate 한다", async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:23456' });
    H.ai.generate.mockResolvedValueOnce(undefined);
    const r = await invoke('ai:generate', 'req-o', { ...base, provider: 'ollama' }) as { success: boolean };
    expect(r.success).toBe(true);
    expect(H.ai.generate).toHaveBeenCalledTimes(1);
    const passed = H.ai.generate.mock.calls[0]![1] as { ollamaBaseUrl: string; provider: string };
    expect(passed.ollamaBaseUrl).toBe('http://localhost:23456');
    expect(passed.ollamaBaseUrl).not.toBe('http://127.0.0.1:1');
  });

  it("provider 'claude' — 요청 객체가 그대로(동일 참조) 전달된다", async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:23456' });
    H.ai.generate.mockResolvedValueOnce(undefined);
    const req = { ...base, provider: 'claude', model: 'claude-sonnet-4-20250514' };
    await invoke('ai:generate', 'req-c', req);
    expect(H.ai.generate.mock.calls[0]![1]).toBe(req);
  });
});

describe('QA28(C-MED): file:export-pdf 는 격리 세션에서 임시 HTML 자신 외 모든 요청을 차단한다', () => {
  beforeEach(() => {
    H.exportWin.partitions.length = 0;
    H.exportWin.onBeforeRequest = null;
    H.exportWin.ctorOpts = null;
    H.exportWin.loadFile.mockResolvedValue(undefined);
    H.exportWin.printToPDF.mockResolvedValue(Buffer.from('%PDF'));
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.pdf' });
  });

  it('export-* 파티션 세션이 창에 주입되고, 외부 URL 은 cancel·자기 파일 URL 은 통과', async () => {
    const r = await invoke('file:export-pdf', '<p>hi</p>', 'out.pdf');
    expect(r).toBe('/tmp/out.pdf');
    expect(H.exportWin.partitions).toHaveLength(1);
    expect(H.exportWin.partitions[0]).toMatch(/^export-/);
    // 세션이 실제로 BrowserWindow 의 webPreferences 로 들어갔다(만들기만 하고 안 쓰면 무의미).
    const prefs = H.exportWin.ctorOpts?.webPreferences as Record<string, unknown>;
    expect(prefs.session).toBeDefined();
    expect(prefs.javascript).toBe(false);

    const tmpHtml = H.fsp.writeFile.mock.calls[0]![0] as string;
    expect(tmpHtml).toMatch(/pdf-export-.*\.html$/);
    const selfUrl = pathToFileURL(tmpHtml).href;
    const listener = H.exportWin.onBeforeRequest;
    expect(listener).toBeTypeOf('function');
    const decide = (url: string) => {
      let out: { cancel: boolean } | null = null;
      listener!({ url }, (res) => { out = res; });
      return out;
    };
    expect(decide('https://evil.example/?exfil=1')).toEqual({ cancel: true });
    expect(decide('file:///C:/Windows/win.ini')).toEqual({ cancel: true });
    expect(decide(selfUrl)).toEqual({ cancel: false });
  });

  it('창 열기는 deny, will-navigate 는 차단 리스너 등록', async () => {
    await invoke('file:export-pdf', '<p>hi</p>', 'out.pdf');
    expect(H.exportWin.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = H.exportWin.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string };
    expect(handler()).toEqual({ action: 'deny' });
    const nav = H.exportWin.on.mock.calls.find(([ev]) => ev === 'will-navigate');
    expect(nav).toBeDefined();
    const e = { preventDefault: vi.fn() };
    (nav![1] as (e: unknown) => void)(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe('ai:abort (이중 namespace 디스패치)', () => {
  it('유효하지 않은 requestId 거부 (abortGenerate 미호출)', () => {
    expect(invoke('ai:abort', '')).toEqual({ success: false, error: 'Invalid requestId' });
    expect(H.ai.abortGenerate).not.toHaveBeenCalled();
  });

  it('bare + `vision:` 양쪽 abort', () => {
    expect(invoke('ai:abort', 'rid-1')).toEqual({ success: true });
    expect(H.ai.abortGenerate).toHaveBeenCalledWith('rid-1');
    expect(H.ai.abortGenerate).toHaveBeenCalledWith('vision:rid-1');
    expect(H.ai.abortGenerate).toHaveBeenCalledTimes(2);
  });
});

// R39 (v0.18.26): SSRF 포트-스캔 오라클 회귀 가드. ai:check-available 가 renderer 전달 URL 을
// 신뢰하면 손상된 렌더러가 임의 localhost 포트를 프로브할 수 있으므로, ollama 는 settings store
// 의 정규 URL 만 사용해야 한다. (적대적 검증 R39 — store-read 전환)
describe('ai:check-available (SSRF 포트 오라클 가드)', () => {
  it('ollama: renderer 가 보낸 임의 포트 URL 을 무시하고 settings store URL 로 호출', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434' });
    H.ai.checkAvailability.mockResolvedValue(true);

    // 손상된 렌더러가 Redis(6379) 등 임의 localhost 포트를 프로브하려 시도
    const result = await invoke('ai:check-available', 'ollama', 'http://127.0.0.1:6379');

    expect(result).toBe(true);
    // 핵심 단언: 악성 인자가 아니라 store 의 정규 URL 로 위임됐는가
    expect(H.ai.checkAvailability).toHaveBeenCalledWith('ollama', 'http://localhost:11434', undefined);
    expect(H.ai.checkAvailability).not.toHaveBeenCalledWith('ollama', 'http://127.0.0.1:6379', undefined);
  });

  it('ollama: store 가 커스텀 포트를 보유하면 그 URL 을 사용(커스텀 포트 보존)', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:23456' });
    H.ai.checkAvailability.mockResolvedValue(true);

    await invoke('ai:check-available', 'ollama', 'http://127.0.0.1:6379');

    expect(H.ai.checkAvailability).toHaveBeenCalledWith('ollama', 'http://localhost:23456', undefined);
  });

  it('잘못된 provider 는 store 조회 없이 false', async () => {
    H.settings.load.mockClear();
    const result = await invoke('ai:check-available', 'evil', 'http://localhost:11434');
    expect(result).toBe(false);
    expect(H.ai.checkAvailability).not.toHaveBeenCalled();
  });

  // R40 보강: store-read 의 두 안전망(falsy 폴백 / 비-string typeof 가드)을 회귀로 고정.
  // 사용자가 settings.json 을 직접 편집하면 ollamaBaseUrl 이 비정상 값일 수 있다.
  it('ollama: store 의 ollamaBaseUrl 이 없으면(undefined) 기본 localhost:11434 로 폴백', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama' }); // ollamaBaseUrl 누락
    H.ai.checkAvailability.mockResolvedValue(true);

    const result = await invoke('ai:check-available', 'ollama', 'http://127.0.0.1:6379');

    expect(result).toBe(true);
    // `|| 'http://localhost:11434'` 폴백이 발동 — 악성 인자가 아니라 기본값으로 위임
    expect(H.ai.checkAvailability).toHaveBeenCalledWith('ollama', 'http://localhost:11434', undefined);
  });

  it('ollama: store 의 ollamaBaseUrl 이 비-string(truthy)이면 typeof 가드로 false (checkAvailability 미호출)', async () => {
    // 123 은 truthy 라 `|| 폴백` 을 통과하지만, isValidOllamaBaseUrl 의 typeof !== 'string' 가 차단.
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 123 });
    H.ai.checkAvailability.mockResolvedValue(true);

    const result = await invoke('ai:check-available', 'ollama', 'http://127.0.0.1:6379');

    expect(result).toBe(false);
    expect(H.ai.checkAvailability).not.toHaveBeenCalled();
  });
});

describe('ollama:status / pull-model', () => {
  it('status: getStatus 결과 그대로 반환', async () => {
    H.ollama.getStatus.mockResolvedValue({ installed: true, running: true, models: ['gemma3'] });
    expect(await invoke('ollama:status')).toEqual({ installed: true, running: true, models: ['gemma3'] });
  });

  it('status: getStatus throw → 안전 fallback', async () => {
    H.ollama.getStatus.mockRejectedValue(new Error('boom'));
    // QA18(C-MED): fallback 도 managed 를 포함해야 렌더러가 "외부 관리라 재시작 불가" 와
    // "상태 조회 실패" 를 구분하지 않고 안전측(재시작 시도 허용)으로 수렴한다.
    expect(await invoke('ollama:status')).toEqual({ installed: false, running: false, models: [], managed: false });
  });

  it('pull-model: 유효하지 않은 model 거부 (pullModel 미호출)', async () => {
    expect(await invoke('ollama:pull-model', 'bad name;rm')).toEqual({ success: false, error: 'Invalid model name' });
    expect(H.ollama.pullModel).not.toHaveBeenCalled();
  });

  it('pull-model: 정상 → pullModel 위임', async () => {
    H.ollama.pullModel.mockResolvedValue({ success: true });
    expect(await invoke('ollama:pull-model', 'gemma3')).toEqual({ success: true });
    expect(H.ollama.pullModel).toHaveBeenCalledWith('gemma3');
  });
});

describe('settings:set (검증 + 직렬화 mutex)', () => {
  it('유효한 키만 통과 + 병합 후 saveSettings 위임', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama' });
    const updated = await invoke('settings:set', {
      theme: 'dark',
      maxChunkSize: 999, // 1000 미만 → 거부
      provider: 'claude',
      bogusKey: 'x', // 미지 키 → 거부
    }) as Record<string, unknown>;

    expect(updated.theme).toBe('dark');
    expect(updated.provider).toBe('claude');
    expect(updated).not.toHaveProperty('maxChunkSize');
    expect(updated).not.toHaveProperty('bogusKey');
    expect(H.settings.save).toHaveBeenCalledTimes(1);
  });

  it('maxChunkSize: float 은 거부, 정수는 통과 (QA9 C-LOW, Number.isInteger)', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama' });
    const rejected = await invoke('settings:set', { maxChunkSize: 1500.5 }) as Record<string, unknown>;
    expect(rejected).not.toHaveProperty('maxChunkSize');
    const accepted = await invoke('settings:set', { maxChunkSize: 2000 }) as Record<string, unknown>;
    expect(accepted.maxChunkSize).toBe(2000);
  });

  it('burst 동시 호출 시 lost update 없음 (load→save 직렬화)', async () => {
    // stateful 저장소 — saveSettings 에 인위적 지연을 둬 mutex 가 없으면 두 번째 호출이
    // 첫 번째 쓰기를 덮어쓰도록(lost update) 만든다.
    let state: Record<string, unknown> = { provider: 'ollama' };
    H.settings.load.mockImplementation(async () => ({ ...state }));
    H.settings.save.mockImplementation(async (_path: unknown, s: Record<string, unknown>) => {
      await tick(10);
      state = s;
    });

    const p1 = invoke('settings:set', { theme: 'dark' });
    const p2 = invoke('settings:set', { uiLanguage: 'en' });
    await Promise.all([p1, p2]);

    // mutex 가 있으면 두 번째 task 가 첫 번째 save 완료 후 load → 둘 다 보존.
    expect(state.theme).toBe('dark');
    expect(state.uiLanguage).toBe('en');
  });
});

describe('ai:embed (동시성 캡 + 카운터 누수 방지)', () => {
  it('4개 in-flight 시 5번째는 한도 초과 거부, 해제 후 재요청은 통과', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    H.ai.generateEmbeddings.mockImplementation(() => new Promise((res) => resolvers.push(res)));

    // 캡 검사 + 카운터 증가는 첫 await 이전(동기)이라 4회 동기 호출로 슬롯이 찬다.
    const p1 = invoke('ai:embed', ['a'], 'r1');
    const p2 = invoke('ai:embed', ['b'], 'r2');
    const p3 = invoke('ai:embed', ['c'], 'r3');
    const p4 = invoke('ai:embed', ['d'], 'r4');

    const r5 = await invoke('ai:embed', ['e'], 'r5');
    expect(r5).toEqual({ success: false, error: '동시 임베딩 요청 한도 초과. 잠시 후 다시 시도해주세요.' });

    // generateEmbeddings 는 첫 await(loadSettings) 이후 호출되므로, 4개가 거기까지 도달할
    // 때까지 기다린 뒤 해제한다 (그 전엔 resolvers 가 비어 있어 hang).
    await tick(0);
    expect(H.ai.generateEmbeddings).toHaveBeenCalledTimes(4);
    expect(resolvers.length).toBe(4);

    // 4개 해제 → 카운터 0 복귀 (finally 누수 없음)
    resolvers.forEach((res) => res({ embeddings: [[0.1, 0.2]], model: 'm' }));
    const settled = await Promise.all([p1, p2, p3, p4]) as Array<{ success: boolean }>;
    settled.forEach((r) => expect(r.success).toBe(true));

    // 슬롯이 비었으므로 새 요청이 generateEmbeddings 까지 도달
    const p6 = invoke('ai:embed', ['f'], 'r6');
    await tick(0);
    expect(H.ai.generateEmbeddings).toHaveBeenCalledTimes(5);
    resolvers[resolvers.length - 1]!({ embeddings: [[0.3]], model: 'm' });
    expect((await p6 as { success: boolean }).success).toBe(true);
  });

  it('유효하지 않은 texts 거부 (generateEmbeddings 미호출)', async () => {
    expect(await invoke('ai:embed', [], 'r')).toEqual({ success: false, error: 'Invalid texts array (1-200 items)' });
    expect(H.ai.generateEmbeddings).not.toHaveBeenCalled();
  });

  // QA post-v0.31.14 회귀: Ollama embed 가 check-embed-model 과 동일한 해석 모델을 사용해야 한다.
  // 이전엔 모델을 undefined 로 넘겨 embedOllama 가 nomic-embed-text 로 폴백 → nomic 미설치 +
  // 다른 임베딩 모델만 있는 환경에서 404 → 조용한 키워드 강등(divergence).
  it('Ollama embed 는 설치된 임베딩 모델(nomic 아님)을 해석해 generateEmbeddings 에 넘긴다', async () => {
    H.ollama.listModels.mockResolvedValue(['mxbai-embed-large:latest', 'llama3:latest']);
    H.ai.checkEmbeddingAvailability.mockResolvedValue('mxbai-embed-large:latest');
    H.ai.generateEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2]], model: 'mxbai-embed-large:latest' });

    const r = await invoke('ai:embed', ['hello'], 'r1') as { success: boolean; model?: string };
    expect(r.success).toBe(true);
    // 5번째 인자(embeddingModel)가 undefined 가 아니라 해석된 모델이어야 한다.
    const call = H.ai.generateEmbeddings.mock.calls[0]!;
    expect(call[1]).toBe('ollama');
    expect(call[4]).toBe('mxbai-embed-large:latest');
  });

  // QA post-v0.31.15(테스트 메타감사 LOW-4): 클라우드 프로바이더는 listModels 로 모델을 해석하지
  // 않고 embeddingModel=undefined 로 넘긴다(고정 단일 모델). ollama/claude 게이트가 클라우드로
  // 넓어지는 회귀를 잡는 네거티브 가드.
  it('openai embed 는 listModels 미호출 + embeddingModel undefined 로 위임', async () => {
    H.settings.load.mockResolvedValue({ provider: 'openai', ollamaBaseUrl: 'http://localhost:11434' });
    H.store.load.mockReturnValue('sk-test-key');
    H.ai.generateEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2]], model: 'text-embedding-3-small' });

    const r = await invoke('ai:embed', ['hello'], 'r1') as { success: boolean };
    expect(r.success).toBe(true);
    expect(H.ollama.listModels).not.toHaveBeenCalled(); // 클라우드는 모델 해석 안 함
    const call = H.ai.generateEmbeddings.mock.calls[0]!;
    expect(call[1]).toBe('openai');
    expect(call[4]).toBeUndefined(); // 고정 모델 → embeddingModel 미전달
  });
});

// session-persistence module-2 (L3): session:* IPC 핸들러 — docHash 검증 + session-store 위임 계약.
describe('session:* (영속화 핸들러)', () => {
  const HASH = 'a'.repeat(64);
  beforeEach(() => {
    H.fsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    H.fsp.writeFile.mockResolvedValue(undefined);
    H.fsp.rename.mockResolvedValue(undefined);
    H.fsp.mkdir.mockResolvedValue(undefined);
    H.fsp.rm.mockResolvedValue(undefined);
    H.fsp.unlink.mockResolvedValue(undefined);
  });

  it('session:load 잘못된 docHash → null (fs 접근 없음)', async () => {
    H.fsp.readFile.mockClear();
    expect(await invoke('session:load', '../evil')).toBeNull();
    expect(H.fsp.readFile).not.toHaveBeenCalled();
  });

  it('session:load 부재 docHash → null', async () => {
    expect(await invoke('session:load', HASH)).toBeNull();
  });

  it('session:save 메타 누락/잘못된 docHash → { ok:false }', async () => {
    expect(await invoke('session:save', { session: {}, blob: null })).toEqual({ ok: false });
    expect(await invoke('session:save', { meta: { docHash: 'bad' }, session: {}, blob: null })).toEqual({ ok: false });
  });

  it('session:save 유효 → { ok:true } + session.json 기록 위임', async () => {
    const meta = { docHash: HASH, fileName: 'd.pdf', filePath: '/d.pdf', pageCount: 3, embedModel: 'm', embedDim: 3, chunkCount: 1 };
    const r = await invoke('session:save', { meta, session: { docHash: HASH }, blob: null });
    expect(r).toEqual({ ok: true });
    const wroteSession = H.fsp.writeFile.mock.calls.some((c) => String(c[0]).includes('session.json'));
    expect(wroteSession).toBe(true);
  });

  // C5-L(QA cycle5): blob 타입 검증 — 숫자 blob 은 writeSession 의 new Uint8Array(blob) 이
  // **길이** 로 해석해 GB 단위 할당을 시도했다(자기-DoS). 유효 ArrayBuffer 는 계속 허용.
  it('session:save blob 검증: 숫자/비-ArrayBuffer 거부, 유효 ArrayBuffer 허용', async () => {
    const meta = { docHash: HASH, fileName: 'd.pdf', filePath: '/d.pdf', pageCount: 3, embedModel: 'm', embedDim: 3, chunkCount: 1 };
    // 숫자 blob(길이 해석 위협) → 할당 시도 전에 거부
    expect(await invoke('session:save', { meta, session: { docHash: HASH }, blob: 2 ** 31 }))
      .toEqual({ ok: false });
    // 문자열 등 비-ArrayBuffer 도 거부
    expect(await invoke('session:save', { meta, session: { docHash: HASH }, blob: 'x' }))
      .toEqual({ ok: false });
    // 유효 ArrayBuffer 는 정상 저장
    const r = await invoke('session:save', { meta, session: { docHash: HASH }, blob: new ArrayBuffer(16) });
    expect(r).toEqual({ ok: true });
  });

  // QA6-D: 상한(64MB) 초과 blob 은 세션 전체 거부 대신 blob 만 강등 — 이전엔 정당한 초대형
  // 인덱스(고차원 클라우드 임베딩 × 수천 청크)가 요약/Q&A/본문까지 영구 저장 불가로 만들었다.
  // 본문은 저장, index.bin 미기록, manifest 인덱스 메타는 비워 '인덱스 있음' 오표시 방지.
  it('session:save 상한 초과 blob → blob 강등 + { ok:true } (본문 저장, index.bin 미기록)', async () => {
    const meta = { docHash: HASH, fileName: 'd.pdf', filePath: '/d.pdf', pageCount: 3, embedModel: 'm', embedDim: 3, chunkCount: 1 };
    H.fsp.writeFile.mockClear();
    const r = await invoke('session:save', { meta, session: { docHash: HASH }, blob: new ArrayBuffer(64 * 1024 * 1024 + 1) });
    expect(r).toEqual({ ok: true });
    expect(H.fsp.writeFile.mock.calls.some((c) => String(c[0]).includes('session.json'))).toBe(true);
    expect(H.fsp.writeFile.mock.calls.some((c) => String(c[0]).includes('index.bin'))).toBe(false);
    // manifest 인덱스 메타 강등 확인 (embedModel null / chunkCount 0)
    const manifestWrite = H.fsp.writeFile.mock.calls.filter((c) => String(c[0]).includes('manifest.json')).pop();
    expect(manifestWrite).toBeDefined();
    const written = JSON.parse(String(manifestWrite?.[1])) as { entries: { docHash: string; embedModel: string | null; chunkCount: number }[] };
    const entry = written.entries.find((e) => e.docHash === HASH);
    expect(entry?.embedModel).toBeNull();
    expect(entry?.chunkCount).toBe(0);
  });

  it('session:delete 잘못된 docHash → { ok:false }', async () => {
    expect(await invoke('session:delete', 'nope')).toEqual({ ok: false });
  });

  it('session:list → 빈 배열(매니페스트 없음)', async () => {
    expect(await invoke('session:list')).toEqual([]);
  });

  it('session:stats → count 0 + dir 에 sessions 포함', async () => {
    const s = await invoke('session:stats') as { count: number; totalBytes: number; dir: string };
    expect(s.count).toBe(0);
    expect(s.dir).toContain('sessions');
  });

  // QA29(C-4): 전체 검색은 저장된 **모든** 세션을 하나의 Promise.all 로 읽고 JSON.parse 했다.
  // 온디스크 상한이 200MB 이므로 파싱 스파이크가 통째로 main 에 쌓이고, 그동안 창 닫기 flush
  // handshake(2s 타임아웃)·업데이터 이벤트·모든 IPC 가 멈춘다. 팬아웃을 캡한다.
  it('session:search 의 세션 읽기가 동시 4건을 넘지 않는다', async () => {
    const hashes = Array.from({ length: 12 }, (_, i) => String(i).padStart(64, '0'));
    const entries = hashes.map((h) => ({
      docHash: h, fileName: `${h}.pdf`, filePath: `/${h}.pdf`, pageCount: 1,
      embedModel: null, embedDim: null, chunkCount: 0, byteSize: 0,
      createdAt: '2026-01-01', lastAccessed: '2026-01-01',
    }));
    let inFlight = 0;
    let peak = 0;
    H.fsp.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ entries });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return JSON.stringify({ docHash: 'x', pageTexts: ['검색어가 들어 있는 본문'] });
    });

    const results = await invoke('session:search', '검색어') as unknown[];

    expect(results.length, '캡을 둬도 전 세션이 검색된다').toBe(12);
    expect(peak, '캡이 없으면 12건이 한 번에 파싱돼 main 이 그만큼 잡힌다').toBeLessThanOrEqual(4);
    // QA30(D6): 하한이 없으면 캡을 1 로 낮춘 완전 직렬화도 통과한다.
    expect(peak, '캡이 1 로 쪼그라들면 검색이 통째로 직렬화된다 — 그것도 회귀다').toBeGreaterThan(1);
  });
});

// session-persistence module-4 (L3): file:open-path — 최근목록 재오픈 보안 가드.
describe('file:open-path (최근목록 재오픈 보안 가드)', () => {
  beforeEach(() => {
    H.fsp.lstat.mockResolvedValue({ isSymbolicLink: () => false });
    H.fsp.stat.mockResolvedValue({ isFile: () => true, size: 1000 });
    H.fsp.readFile.mockResolvedValue(Buffer.from('%PDF-1.4 test'));
  });

  it('비-string/빈 경로 거부 (fs 접근 없음)', async () => {
    H.fsp.lstat.mockClear();
    expect((await invoke('file:open-path', 123) as { error: string }).error).toBeTruthy();
    expect((await invoke('file:open-path', '') as { error: string }).error).toBeTruthy();
    expect(H.fsp.lstat).not.toHaveBeenCalled();
  });

  it('.pdf 아닌 확장자 거부 (fs 접근 없음)', async () => {
    H.fsp.lstat.mockClear();
    const r = await invoke('file:open-path', '/x/secret.txt') as { error: string };
    expect(r.error).toBeTruthy();
    expect(H.fsp.lstat).not.toHaveBeenCalled();
  });

  // QA20(B-MED): UNC 는 lstat 만으로 SMB 클라이언트를 깨워 원격 서버에 NTLM 자격증명을 흘린다.
  // 드롭 경로(will-navigate)는 이미 UNC 를 막고 있었는데 이 경로만 빠져 있던 비대칭 — fs 접근
  // 이전에 차단해야 의미가 있다(lstat 자체가 인증 시도이므로).
  it('UNC 경로 거부 (fs 접근 없음 — NTLM 유출 방지)', async () => {
    H.fsp.lstat.mockClear();
    for (const p of ['\\\\attacker.example\\share\\a.pdf', '//attacker.example/share/a.pdf']) {
      const r = await invoke('file:open-path', p) as { error: string };
      expect(r.error, p).toBeTruthy();
    }
    expect(H.fsp.lstat, 'lstat 자체가 원격 인증을 유발하므로 호출되면 안 된다').not.toHaveBeenCalled();
  });

  it('널바이트 포함 경로 거부 (fs 접근 없음)', async () => {
    H.fsp.lstat.mockClear();
    const r = await invoke('file:open-path', '/x/a.pdf\0.txt') as { error: string };
    expect(r.error).toBeTruthy();
    expect(H.fsp.lstat).not.toHaveBeenCalled();
  });

  it('심볼릭 링크 거부 (readFile 미도달)', async () => {
    H.fsp.lstat.mockResolvedValue({ isSymbolicLink: () => true });
    H.fsp.readFile.mockClear();
    const r = await invoke('file:open-path', '/x/a.pdf') as { error: string };
    expect(r.error).toBeTruthy();
    expect(H.fsp.readFile).not.toHaveBeenCalled();
  });

  it('일반 파일 아니면 거부', async () => {
    H.fsp.stat.mockResolvedValue({ isFile: () => false, size: 10 });
    expect((await invoke('file:open-path', '/x/a.pdf') as { error: string }).error).toBeTruthy();
  });

  it('유효한 .pdf → { path, name, data }', async () => {
    const r = await invoke('file:open-path', '/docs/lecture.pdf') as { path: string; name: string; data: ArrayBuffer };
    expect(r.path).toBe('/docs/lecture.pdf');
    expect(r.name).toBe('lecture.pdf');
    expect(r.data).toBeInstanceOf(ArrayBuffer);
  });
});

// 첫 실행 언어 감지: localeAwareDefaults 가 OS 로캘 기반 uiLanguage/summaryLanguage 기본값을
// settings-store loadSettings 의 defaults 인자로 전달하는지 검증. 저장된 설정이 있으면
// settings-store 의 spread 가 defaults 를 덮으므로(settings-store.test 에서 가드) 기존 사용자 무영향.
describe('settings:get 로캘 기반 언어 기본값', () => {
  const lastDefaults = () =>
    H.settings.load.mock.calls.at(-1)?.[1] as Record<string, unknown>;

  it('ko 계열 로캘 → 기본값 ko 유지', async () => {
    H.appLocale.mockReturnValue('ko-KR');
    await invoke('settings:get');
    expect(lastDefaults().uiLanguage).toBe('ko');
    expect(lastDefaults().summaryLanguage).toBe('ko');
  });

  it('비-ko 로캘(en-US) → uiLanguage/summaryLanguage 기본값 en', async () => {
    H.appLocale.mockReturnValue('en-US');
    await invoke('settings:get');
    expect(lastDefaults().uiLanguage).toBe('en');
    expect(lastDefaults().summaryLanguage).toBe('en');
  });

  it('getLocale throw 시 ko 로 안전 fallback', async () => {
    H.appLocale.mockImplementation(() => { throw new Error('locale unavailable'); });
    await invoke('settings:get');
    expect(lastDefaults().uiLanguage).toBe('ko');
  });
});

// multi-doc Phase 3 module-1: collections:* 핸들러 입력 검증 + 위임.
// 저장 로직 자체는 collections-store L1 이 검증 — 여기선 핸들러의 입력 shape 가드와 배선만.
describe('collections:* 핸들러', () => {
  const H64 = 'a'.repeat(64);

  it('등록됨', () => {
    for (const ch of ['collections:list', 'collections:save', 'collections:delete', 'collections:touch']) {
      expect(H.handlers.has(ch), `${ch} 미등록`).toBe(true);
    }
  });

  it('save: name 비문자열/ docHashes 비배열은 store 호출 전 거부', async () => {
    expect(await invoke('collections:save', { name: 123, docHashes: [H64] })).toEqual({ ok: false });
    expect(await invoke('collections:save', { name: 'x', docHashes: 'nope' })).toEqual({ ok: false });
    expect(await invoke('collections:save', null)).toEqual({ ok: false });
  });

  it('save: 유효 입력은 위임되어 ok + id 반환', async () => {
    const r = await invoke('collections:save', { name: '묶음', docHashes: [H64] }) as { ok: boolean; id?: string };
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
  });

  it('list: 배열 반환(파일 없음 → 빈 배열)', async () => {
    expect(await invoke('collections:list')).toEqual([]);
  });

  it('delete: 위임되어 ok 반환', async () => {
    expect(await invoke('collections:delete', 'some-id')).toEqual({ ok: true });
  });

  // 저장돼 있지 않은 id 를 ok 로 돌려주면 렌더러가 갱신됐다고 오인한다. (여기 harness 는 readFile
  // 이 항상 ENOENT라 저장 왕복이 성립하지 않는다 — 갱신 성공 경로는 collections-store L1 이 검증)
  it('touch: 저장돼 있지 않은 id / 비문자열은 ok:false (무음 성공 금지)', async () => {
    expect(await invoke('collections:touch', 'nope')).toEqual({ ok: false });
    expect(await invoke('collections:touch', null)).toEqual({ ok: false });
  });
});

/**
 * QA30(C-5): QA24 가 `loadSettings` 를 throw 형으로 바꾼 뒤 **호출자 스윕이 두 곳에서 멈췄다**
 * (ai:generate 의 preflight 는 try 밖, ai:check-available 은 try 자체가 없음).
 *
 * 기존 ipc-handlers 테스트가 이걸 못 잡은 이유: `beforeEach` 가 항상
 * `H.settings.load.mockResolvedValue(...)` 로 **성공**을 세워서, loadSettings reject 시나리오가
 * 이 파일에 한 건도 없었다. 여기서는 매 케이스가 명시적으로 reject 를 세운다.
 */
describe('QA30(C-5): settings 읽기 실패(EBUSY)가 AI 경로를 오염시키지 않는다', () => {
  const ebusy = () => Object.assign(
    new Error("EBUSY: resource busy or locked, open 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\app\\\\settings.json'"),
    { code: 'EBUSY' },
  );
  const genReq = {
    text: 'hi', type: 'full' as const, model: 'llama3',
    provider: 'ollama' as const, ollamaBaseUrl: 'http://localhost:11434',
  };

  it('ai:generate — 요약이 죽지 않고 요청측(SSRF 검증 통과) URL 로 진행한다', async () => {
    H.settings.load.mockRejectedValue(ebusy());
    H.ai.generate.mockResolvedValueOnce(undefined);
    const r = await invoke('ai:generate', 'req-ebusy', genReq) as { success: boolean; error?: string };
    // 종전: preflight 가 try 밖에서 던져 핸들러가 reject → 렌더러 배너에 EBUSY 원문이 떴다.
    expect(r.success).toBe(true);
    expect(H.ai.generate).toHaveBeenCalledTimes(1);
    const passed = H.ai.generate.mock.calls[0]![1] as { ollamaBaseUrl: string };
    expect(passed.ollamaBaseUrl).toBe('http://localhost:11434');
  });

  it('ai:check-available — 계약대로 false 로 수렴한다(reject 아님)', async () => {
    H.settings.load.mockRejectedValue(ebusy());
    const r = await invoke('ai:check-available', 'ollama', 'http://localhost:11434');
    expect(r).toBe(false);
    expect(H.ai.checkAvailability).not.toHaveBeenCalled();
  });

  it('ai:check-available — 클라우드 provider 는 settings 를 읽지 않으므로 영향이 없다', async () => {
    H.settings.load.mockRejectedValue(ebusy());
    H.ai.checkAvailability.mockResolvedValue(true);
    expect(await invoke('ai:check-available', 'claude', 'http://localhost:11434')).toBe(true);
  });

  it.each([
    ['ai:embed', () => invoke('ai:embed', ['t'], 'rid-embed')],
    ['ai:analyze-image', () => invoke('ai:analyze-image', 'a'.repeat(200), 'rid-vision')],
    ['ai:ocr-page', () => invoke('ai:ocr-page', 'a'.repeat(200), 'rid-ocr')],
  ])('%s — userData 절대경로를 IPC 페이로드에 싣지 않는다 (generic + code)', async (_label, call) => {
    H.settings.load.mockRejectedValue(ebusy());
    const r = await call() as { success: boolean; error: string; code?: string };
    expect(r.success).toBe(false);
    // QA6-A 정책: fs 에러 원문(경로 포함)은 렌더러로 나가지 않는다.
    expect(r.error).not.toMatch(/settings\.json/);
    expect(r.error).not.toMatch(/EBUSY/);
    expect(r.error).not.toMatch(/AppData/);
    expect(r.code).toBe('SETTINGS_READ_FAILED');
  });
});

/**
 * QA30(A축 배선): callVision 이 붙인 code/errorKey/errorParams 가 Vision/OCR 응답에서 전량
 * 버려지고 있었다(ai:generate 는 이미 싣는다).
 */
describe('QA30: Vision/OCR 실패도 code/errorKey 를 전파한다', () => {
  it('BLOCKED(errorKey 보유)는 message 와 함께 그대로 전달된다', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', model: 'llava', ollamaBaseUrl: 'http://localhost:11434' });
    H.ai.analyzeImage.mockRejectedValueOnce(Object.assign(
      new Error('응답이 차단되었습니다.'),
      { code: 'BLOCKED', errorKey: 'responseBlocked', errorParams: { reason: 'SAFETY' } },
    ));
    const r = await invoke('ai:analyze-image', 'a'.repeat(200), 'rid-b') as
      { success: boolean; error: string; code?: string; errorKey?: string; errorParams?: Record<string, string> };
    expect(r).toMatchObject({
      success: false, code: 'BLOCKED', errorKey: 'responseBlocked', errorParams: { reason: 'SAFETY' },
    });
    expect(r.error).toContain('차단');
  });

  it('abort 는 종전 계약 그대로(ABORTED)', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', model: 'llava', ollamaBaseUrl: 'http://localhost:11434' });
    H.ai.analyzeImageForOcr.mockRejectedValueOnce(Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }));
    expect(await invoke('ai:ocr-page', 'a'.repeat(200), 'rid-a'))
      .toEqual({ success: false, error: 'Aborted', code: 'ABORTED' });
  });

  it('Vision 모델 부재 안내처럼 **행동 가능한** 메시지는 generic 으로 뭉개지 않는다', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' });
    H.ollama.listModels.mockResolvedValue([]); // vision 모델 없음
    const r = await invoke('ai:analyze-image', 'a'.repeat(200), 'rid-nm') as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toContain('llava');
  });
});

/**
 * QA30(C-6): apikey:has 가 "못 읽음" 과 "없음" 을 구분한다. 종전에는 AV 가 순간 잠그면 false 가
 * 되어 설정 화면이 "키 미저장" 으로 뜨고 클라우드가 "API 키를 설정해주세요" 를 띄웠다.
 */
describe('QA30(C-6): apikey:has 는 "확인 불가" 를 false 로 단정하지 않는다', () => {
  it('일시 I/O 오류(transient) → null', async () => {
    H.store.loadState.mockReturnValue({ key: undefined, transient: true });
    expect(await invoke('apikey:has', 'claude')).toBeNull();
  });

  it('정말 없음 → false / 있음 → true (종전 계약 유지)', async () => {
    H.store.loadState.mockReturnValue({ key: undefined, transient: false });
    expect(await invoke('apikey:has', 'claude')).toBe(false);
    H.store.loadState.mockReturnValue({ key: 'sk-real', transient: false });
    expect(await invoke('apikey:has', 'claude')).toBe(true);
  });

  it('미지원 provider 는 store 조회 없이 false', async () => {
    H.store.loadState.mockClear();
    expect(await invoke('apikey:has', 'mistral')).toBe(false);
    expect(H.store.loadState).not.toHaveBeenCalled();
  });
});

/**
 * QA30(C-8): settings:set 만 인자 shape 검증이 없었다(43채널 중 유일).
 */
describe('QA30(C-8): settings:set 인자 shape 가드', () => {
  it.each([['null', null], ['undefined', undefined], ['문자열', 'x'], ['숫자', 7], ['배열', ['a']]])(
    '%s 인자는 raw TypeError 도 무의미한 재기록도 만들지 않는다',
    async (_label, bad) => {
      H.settings.load.mockResolvedValue({ provider: 'ollama', uiLanguage: 'ko' });
      H.settings.save.mockClear();
      const r = await invoke('settings:set', bad) as Record<string, unknown>;
      expect(r).toMatchObject({ provider: 'ollama', uiLanguage: 'ko' }); // 현재 설정을 그대로
      expect(H.settings.save, '저장할 것이 없는데 디스크를 다시 썼다').not.toHaveBeenCalled();
    },
  );

  it('정상 객체는 종전대로 저장된다(가드가 정상 경로를 막지 않는다)', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', uiLanguage: 'ko' });
    H.settings.save.mockClear();
    const r = await invoke('settings:set', { uiLanguage: 'en' }) as Record<string, unknown>;
    expect(r.uiLanguage).toBe('en');
    expect(H.settings.save).toHaveBeenCalledTimes(1);
  });
});

/**
 * QA30(C-9): session:search 의 query 는 상한이 없는 유일한 문자열 인자였다.
 */
describe('QA30(C-9): session:search query 길이 상한', () => {
  it('상한 초과 질의는 디스크를 읽지도 않고 빈 결과', async () => {
    H.fsp.readFile.mockClear();
    expect(await invoke('session:search', 'q'.repeat(513))).toEqual([]);
    // "빈 결과" 만으로는 공허하다(어떤 질의든 빈 결과가 나올 수 있다) — **읽지 않았음** 을 본다.
    expect(H.fsp.readFile).not.toHaveBeenCalled();
  });

  it('상한 이내 질의는 종전대로 세션을 읽는다', async () => {
    H.fsp.readFile.mockClear();
    expect(await invoke('session:search', 'q'.repeat(512))).toEqual([]);
    expect(H.fsp.readFile).toHaveBeenCalled(); // manifest 를 읽으려 시도했다
  });
});

/**
 * QA30(C-3): 사용자에게 파일을 돌려주는 두 채널만 제자리 덮어쓰기였다.
 *
 * 반환값이 아니라 **실패 후 디스크 상태**를 본다: `writeFile` 을 실제 `open(w)` 처럼
 * "먼저 잘라내고 쓴다" 로 모사해, 실패 시 대상 파일이 0바이트로 남는지를 직접 관측한다
 * (조사 단계 실측: 원본 62바이트 → open(w) 직후 0바이트).
 */
describe('QA30(C-3): file:save / file:export-pdf 는 원자적으로 쓴다', () => {
  const disk = new Map<string, string | Uint8Array>();
  let failOn: string | null = null;

  beforeEach(() => {
    disk.clear();
    failOn = null;
    H.fsp.writeFile.mockImplementation(async (p: string, data: string | Uint8Array) => {
      disk.set(p, ''); // open(w) 는 열자마자 기존 내용을 잘라낸다
      if (failOn === p) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      disk.set(p, data);
    });
    H.fsp.rename.mockImplementation(async (a: string, b: string) => {
      const v = disk.get(a);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      disk.set(b, v);
      disk.delete(a);
    });
    H.fsp.unlink.mockImplementation(async (p: string) => { disk.delete(p); });
  });

  it('file:save 실패 — 이전 내보내기 결과가 파괴되지 않고 tmp 찌꺼기도 남지 않는다', async () => {
    disk.set('/tmp/out.md', '이전에 내보낸 요약본');
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.md' });
    failOn = '/tmp/out.md.tmp';
    await expect(invoke('file:save', 'new content', 'out.md')).rejects.toThrow('file:save failed');
    expect(disk.get('/tmp/out.md'), '실패한 저장이 원본을 0바이트로 만들었다').toBe('이전에 내보낸 요약본');
    expect(disk.has('/tmp/out.md.tmp')).toBe(false);
  });

  it('file:save 성공 — tmp 를 거쳐 최종 경로에 안착한다', async () => {
    disk.set('/tmp/out.md', '옛 내용');
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.md' });
    expect(await invoke('file:save', '새 내용', 'out.md')).toBe('/tmp/out.md');
    expect(disk.get('/tmp/out.md')).toBe('새 내용');
    expect(disk.has('/tmp/out.md.tmp')).toBe(false);
  });

  it('file:export-pdf 실패(ENOSPC) — 이전 PDF 가 살아남는다', async () => {
    disk.set('/tmp/out.pdf', 'PREVIOUS-PDF-BYTES');
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.pdf' });
    H.exportWin.loadFile.mockResolvedValue(undefined);
    H.exportWin.printToPDF.mockResolvedValue(Buffer.from('NEW-PDF'));
    failOn = '/tmp/out.pdf.tmp';
    await expect(invoke('file:export-pdf', '<p>x</p>', 'out.pdf')).rejects.toThrow('file:export-pdf failed');
    expect(disk.get('/tmp/out.pdf')).toBe('PREVIOUS-PDF-BYTES');
    expect(disk.has('/tmp/out.pdf.tmp')).toBe(false);
  });
});

/**
 * QA30(C-10): loadSettings 가 settings.json 을 **매 호출 두 번** 읽던 것(본체 1회 + v0.16 레거시
 * 가드의 원본 재독 1회). 요약 청크마다·임베딩 배치마다 도는 핫패스라, 중복 읽기가 EBUSY 노출
 * 창을 정확히 2배로 넓혀 C-5·C-6 의 도달 확률을 직접 키웠다.
 */
describe('QA30(C-10): settings.json 은 호출당 한 번만 읽는다', () => {
  it('settings:get / ai:generate 는 원본 재독(fs.readFile)을 하지 않는다', async () => {
    H.settings.load.mockResolvedValue({ provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434' });
    H.ai.generate.mockResolvedValue(undefined);
    H.fsp.readFile.mockClear();

    await invoke('settings:get');
    await invoke('ai:generate', 'req-c10', {
      text: 'hi', type: 'full', model: 'llama3', provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434',
    });

    const settingsReads = H.fsp.readFile.mock.calls.filter((c) => String(c[0]).includes('settings.json'));
    expect(settingsReads, '레거시 가드가 settings.json 을 다시 읽고 있다').toHaveLength(0);
    // 실제 읽기는 settings-store 안에서 1회 — 그 호출 자체는 그대로 일어난다.
    expect(H.settings.load).toHaveBeenCalled();
  });

  it('레거시 파일 보정(R43 F5)은 그대로 동작한다 — 키 출처는 onRawKeys 로 받는다', async () => {
    // v0.16 이전 파일: uiLanguage 는 있고 summaryLanguage 는 없음. 비-ko 로캘.
    H.appLocale.mockReturnValue('en-US');
    H.settings.load.mockImplementation(async (
      _p: string, defaults: Record<string, unknown>, _k: unknown, _v: unknown,
      onRawKeys?: (keys: string[]) => void,
    ) => {
      onRawKeys?.(['provider', 'uiLanguage']);
      return { ...defaults, uiLanguage: 'ko' };
    });
    const out = await invoke('settings:get') as Record<string, unknown>;
    // 저장된 UI 언어(ko)를 요약 언어로 승계 — 로캘 기본값(en)이 아니다.
    expect(out.summaryLanguage).toBe('ko');
  });

  it('파일에 summaryLanguage 가 있으면 보정하지 않는다', async () => {
    H.appLocale.mockReturnValue('en-US');
    H.settings.load.mockImplementation(async (
      _p: string, defaults: Record<string, unknown>, _k: unknown, _v: unknown,
      onRawKeys?: (keys: string[]) => void,
    ) => {
      onRawKeys?.(['uiLanguage', 'summaryLanguage']);
      return { ...defaults, uiLanguage: 'ko', summaryLanguage: 'en' };
    });
    const out = await invoke('settings:get') as Record<string, unknown>;
    expect(out.summaryLanguage).toBe('en');
  });

  it('파일 부재·손상(onRawKeys 미호출)이면 로캘 기본값을 유지한다', async () => {
    H.appLocale.mockReturnValue('en-US');
    H.settings.load.mockImplementation(async (_p: string, defaults: Record<string, unknown>) => ({ ...defaults }));
    const out = await invoke('settings:get') as Record<string, unknown>;
    expect(out.summaryLanguage).toBe('en');
    expect(out.uiLanguage).toBe('en');
  });
});

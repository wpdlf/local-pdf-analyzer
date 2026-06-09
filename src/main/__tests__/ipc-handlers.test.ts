import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

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
    checkAvailability: vi.fn(),
    analyzeImage: vi.fn(),
    analyzeImageForOcr: vi.fn(),
    generateEmbeddings: vi.fn(),
    checkEmbeddingAvailability: vi.fn(),
    cleanupAiService: vi.fn(),
    registerEmbedRequest: vi.fn(),
    unregisterEmbedRequest: vi.fn(),
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
  store: { read: vi.fn(), load: vi.fn(), save: vi.fn(), delete: vi.fn(), invalidate: vi.fn() },
  settings: { load: vi.fn(), save: vi.fn() },
  fsp: { writeFile: vi.fn(), readFile: vi.fn(), stat: vi.fn(), lstat: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
    // pending Promise — app.whenReady().then 콜백(registerIpcHandlers 자동 호출)이 발화하지
    // 않게 하여 테스트가 직접 registerIpcHandlers() 를 호출해 1회만 등록하도록 한다.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return []; }
    static fromWebContents(): unknown { return { isDestroyed: () => false }; }
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
  H.store.load.mockReturnValue(undefined);
  H.store.save.mockReturnValue(undefined);
  H.store.delete.mockReturnValue(undefined);
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
    expect(await invoke('apikey:save', 'gemini', 'sk-x')).toEqual({ success: false, error: 'Invalid provider' });
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

  it('KEYCHAIN_UNAVAILABLE throw → {success:false, error} 로 매핑', async () => {
    H.store.save.mockImplementation(() => {
      throw Object.assign(new Error('OS 키체인 사용 불가'), { code: 'KEYCHAIN_UNAVAILABLE' });
    });
    expect(await invoke('apikey:save', 'openai', 'sk-o')).toEqual({ success: false, error: 'OS 키체인 사용 불가' });
  });
});

describe('apikey:has / apikey:delete', () => {
  it('has: 미지원 provider → false', async () => {
    expect(await invoke('apikey:has', 'gemini')).toBe(false);
  });

  it('has: 저장된 키 있으면 true, 없으면 false', async () => {
    H.store.load.mockReturnValue('sk-c');
    expect(await invoke('apikey:has', 'claude')).toBe(true);
    H.store.load.mockReturnValue(undefined);
    expect(await invoke('apikey:has', 'claude')).toBe(false);
  });

  it('delete: 미지원 provider → {success:false}', async () => {
    expect(await invoke('apikey:delete', 'gemini')).toEqual({ success: false, error: 'Invalid provider' });
    expect(H.store.delete).not.toHaveBeenCalled();
  });

  it('delete: 정상 → store.delete 위임', async () => {
    expect(await invoke('apikey:delete', 'claude')).toEqual({ success: true });
    expect(H.store.delete).toHaveBeenCalledWith('claude');
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
    expect(H.fsp.writeFile).toHaveBeenCalledWith('/tmp/out.md', 'hello', 'utf-8');
  });

  it('writeFile 실패 → null (rejection 전파 안 함)', async () => {
    H.dialog.showSaveDialog.mockResolvedValue({ filePath: '/tmp/out.txt' });
    H.fsp.writeFile.mockRejectedValue(new Error('EACCES'));
    expect(await invoke('file:save', 'hello', 'out.txt')).toBeNull();
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
    expect(await invoke('ollama:status')).toEqual({ installed: false, running: false, models: [] });
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
});

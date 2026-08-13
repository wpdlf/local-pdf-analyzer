import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// QA23(B-LOW → 별도 작업): index.ts 의 **합성 층** 행위 검증.
//
// QA16→QA17→QA18 세 사이클 연속으로 실데이터 손실이 난 곳이 정확히 이 층이다:
//   QA16 창 X 닫기가 종료 flush 를 우회 / QA17 이중 클릭이 진행 중 flush 를 끊음 /
//   QA18 종료 경로가 in-flight flush 를 건너뛰어 darwin 좀비 + isQuitting 고착.
// 그때마다 "이 판단에 단위 테스트가 없다"가 원인이었고, QA18 이 결정 로직을
// window-flush-policy.ts 로 분리해 순수 부분은 회귀 넷을 얻었다. 그러나 **판정을 부작용
// (preventDefault / destroy / 표식 추가·삭제 / IPC send)에 연결하는 부분**은 여전히 무테스트였다
// — 순수 모듈 커버리지 100% 가 이 층의 안전을 보장하지 않는다(QA23 B축 지적).
//
// 방법: electron 을 **상태를 가진 가짜**로 모킹한다. BrowserWindow 는 인스턴스를 추적하고
// on('close') 핸들러를 캡처하는 클래스로 두어, 실제 close 이벤트를 시뮬레이션하고 그 결과
// (preventDefault 여부, flush IPC 발신, 파괴 시점)를 관찰한다.
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => {
  interface FakeEvent { defaultPrevented: boolean; preventDefault(): void }
  class FakeWebContents {
    sent: string[] = [];
    send(channel: string) { this.sent.push(channel); }
    setWindowOpenHandler() {}
    on() {}
    session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
    openDevTools() {}
  }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    static getAllWindows(): FakeBrowserWindow[] {
      return FakeBrowserWindow.instances.filter((w) => !w.destroyed);
    }
    static fromWebContents() { return { isDestroyed: () => false }; }
    destroyed = false;
    webContents = new FakeWebContents();
    private handlers = new Map<string, ((e: FakeEvent) => void)[]>();
    constructor() { FakeBrowserWindow.instances.push(this); }
    on(event: string, fn: (e: FakeEvent) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    once(event: string, fn: (e: FakeEvent) => void) { this.on(event, fn); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    show() {}
    focus() {}
    isMinimized() { return false; }
    restore() {}
    /** 실제 'close' 이벤트를 흉내낸다 — preventDefault 여부를 돌려준다. */
    emitClose(): boolean {
      const e: FakeEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const fn of this.handlers.get('close') ?? []) fn(e);
      return e.defaultPrevented;
    }
  }
  return {
    FakeBrowserWindow,
    ipcListeners: new Map<string, ((...a: unknown[]) => void)[]>(),
    updaterState: { status: 'idle' as string },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
    once: vi.fn(),
    whenReady: () => new Promise(() => {}), // ready 콜백 미발화 — 테스트가 직접 호출한다
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getLocale: () => 'ko-KR',
  },
  BrowserWindow: H.FakeBrowserWindow,
  ipcMain: {
    handle: vi.fn(),
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      const l = H.ipcListeners.get(ch) ?? []; l.push(fn); H.ipcListeners.set(ch, l);
    },
    removeListener: (ch: string, fn: (...a: unknown[]) => void) => {
      H.ipcListeners.set(ch, (H.ipcListeners.get(ch) ?? []).filter((f) => f !== fn));
    },
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }) },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('../ai-service', () => ({
  generate: vi.fn(), abortGenerate: vi.fn(), abortAllRequests: vi.fn(), checkAvailability: vi.fn(),
  analyzeImage: vi.fn(), analyzeImageForOcr: vi.fn(), generateEmbeddings: vi.fn(),
  checkEmbeddingAvailability: vi.fn(), cleanupAiService: vi.fn(),
  registerEmbedRequest: vi.fn(), unregisterEmbedRequest: vi.fn(), GEMINI_EMBED_MODEL: 'gemini-embedding-2',
}));
vi.mock('../ollama-manager', () => ({ OllamaManager: class { stop = vi.fn(); healthCheck = vi.fn(); killPullProcess = vi.fn(); } }));
vi.mock('../api-keys-store', () => ({ ApiKeyStore: class { read = vi.fn(); load = vi.fn(); save = vi.fn(); delete = vi.fn(); invalidate = vi.fn(); } }));
vi.mock('../settings-store', () => ({ loadSettings: vi.fn(async () => ({})), saveSettings: vi.fn() }));
vi.mock('fs/promises', () => ({
  default: { writeFile: vi.fn(), readFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(), rename: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), unlink: vi.fn(), readdir: vi.fn() },
}));

import { createWindow, flushRenderersBeforeQuit, revertFlushMarks } from '../index';

/** 렌더러가 flush ack 를 보낸 것처럼 — app:flush-done 리스너를 그 창의 webContents 로 호출. */
function ackFlush(win: { webContents: unknown }): void {
  for (const fn of H.ipcListeners.get('app:flush-done') ?? []) fn({ sender: win.webContents });
}

const FakeBW = H.FakeBrowserWindow;

beforeEach(() => {
  FakeBW.instances.length = 0;
  H.ipcListeners.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe('창 X 닫기 → flush 인터셉트 (QA16 회귀 가드)', () => {
  it('첫 close 는 가로채고 flush IPC 를 보낸다 (즉시 파괴 금지)', () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;

    const prevented = win.emitClose();

    expect(prevented, '가로채지 않으면 창이 즉시 파괴돼 마지막 델타가 소실된다').toBe(true);
    expect(win.webContents.sent).toContain('app:flush-before-quit');
    expect(win.isDestroyed(), 'flush 완주 전에 파괴하면 안 된다').toBe(false);
  });

  it('flush ack 를 받으면 창을 파괴한다 (닫기가 영원히 취소되지 않는다)', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.emitClose();

    ackFlush(win);
    await Promise.resolve();
    await Promise.resolve();

    expect(win.isDestroyed(), 'ack 후에도 살아 있으면 창이 닫히지 않는다').toBe(true);
  });

  it('ack 가 없어도 타임아웃 뒤 파괴한다 (렌더러 무응답에 갇히지 않는다)', async () => {
    vi.useFakeTimers();
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.emitClose();

    await vi.advanceTimersByTimeAsync(5000);

    expect(win.isDestroyed()).toBe(true);
  });
});

describe('flush 진행 중 재진입 (QA17 이중 클릭 회귀 가드)', () => {
  it('두 번째 close 도 가로채되 flush 를 다시 시작하지 않는다', () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.emitClose();
    const sentAfterFirst = win.webContents.sent.length;

    const prevented = win.emitClose();

    expect(prevented, '진행 중 flush 를 네이티브 close 가 끊으면 델타가 소실된다').toBe(true);
    expect(win.webContents.sent.length, 'flush 를 두 번 시작하면 안 된다').toBe(sentAfterFirst);
    expect(win.isDestroyed()).toBe(false);
  });
});

describe('flush 완료 후 close (이중 flush 방지)', () => {
  it('이미 flush 한 창의 close 는 가로채지 않는다', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.emitClose();
    ackFlush(win);
    await Promise.resolve();
    await Promise.resolve();
    // 파괴된 창을 다시 close 하는 상황을 배제하기 위해 되살린다(표식은 그대로 남아 있다).
    win.destroyed = false;

    const prevented = win.emitClose();

    expect(prevented, '완료된 창을 또 가로채면 종료가 지연된다').toBe(false);
  });
});

describe('flushRenderersBeforeQuit — 대상 선정 (QA18 회귀 가드)', () => {
  it('평범한 창에 flush 를 보내고 표식을 남긴다', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;

    const p = flushRenderersBeforeQuit();
    expect(win.webContents.sent).toContain('app:flush-before-quit');
    ackFlush(win);
    await p;

    // 표식이 남았으므로 이후 close 는 가로채지 않는다.
    expect(win.emitClose()).toBe(false);
  });

  it('진행 중인 flush 를 건너뛰지 않고 기다린다 (darwin 좀비·isQuitting 고착 방지)', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.emitClose(); // 창 X 로 flush 시작 — 아직 ack 없음

    let settled = false;
    const p = flushRenderersBeforeQuit().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, '진행 중 flush 를 skip 하면 종료가 그 창의 preventDefault 에 취소된다').toBe(false);
    // 진행 중인 flush 를 기다리는 것이지 새로 시작하는 게 아니다(send 는 1회뿐).
    expect(win.webContents.sent.filter((c) => c === 'app:flush-before-quit').length).toBe(1);

    ackFlush(win);
    await p;
    expect(settled).toBe(true);
  });

  it('파괴된 창은 대상에서 제외한다', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    win.destroy();

    await flushRenderersBeforeQuit(); // 대상 0개 → 즉시 resolve
    expect(win.webContents.sent).not.toContain('app:flush-before-quit');
  });
});

// 배선 가드: updater 는 installerExists 를 **주입받아야만** 확인할 수 있다. 순수 판정이 맞아도
// index.ts 가 주입하지 않으면 실기기에서는 그대로 앱이 조용히 꺼진다(2026-08-07 에 겪은 그것).
describe('updater 배선 — 인스톨러 실재 확인 주입', () => {
  const MAIN_SRC = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf-8');

  it('installerExists 를 실제 파일 확인으로 주입한다', () => {
    expect(MAIN_SRC).toMatch(/installerExists:\s*\(filePath: string\) =>\s*existsSync\(filePath\)/);
  });

  it('onInstallAborted 는 표식 롤백 함수를 그대로 넘긴다', () => {
    expect(MAIN_SRC).toMatch(/onInstallAborted:\s*revertFlushMarks/);
  });

  it('clearUpdaterCache 를 주입한다 (체크섬 실패 시 손상 캐시 정리)', () => {
    expect(MAIN_SRC).toMatch(/clearUpdaterCache,/);
  });

  // QA24(A-L2/B-M2): 종전 가드는 `dirName.endsWith('-updater')` 의 **존재**를 소스 스캔으로
  // 확인했는데, 그 조건은 자기가 방금 붙인 리터럴을 검사하는 항진명제라 지켜주는 게 없었다.
  // 게다가 이 검사는 코드가 아니라 **주석에도 매칭**된다(실제로 그 코드를 제거한 뒤에도 통과했다).
  // 실질을 본다: 이름은 drift 테스트가 못박은 상수에서 와야 하고, app.getName() 에서 오면 안 된다
  // (electron 은 productName 이 있으면 그것을 반환하는데 electron-builder 는 name 기반이다).
  it('캐시 디렉터리 이름을 UPDATER_CACHE_DIR_NAME 상수에서 가져온다', () => {
    const body = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function clearUpdaterCache'),
      MAIN_SRC.indexOf('function broadcastUpdateState'),
    );
    // 주석을 걷어낸 실제 코드만 본다 — 위 사건의 재발 방지.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/dirName\s*=\s*UPDATER_CACHE_DIR_NAME/);
    expect(code, 'app.getName() 은 productName 을 반환할 수 있어 빌더의 규약과 갈린다').not.toMatch(/app\.getName\(\)/);
  });

  it('%LOCALAPPDATA% 를 electron-updater 와 같은 출처(env)에서 1순위로 읽는다', () => {
    const body = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function clearUpdaterCache'),
      MAIN_SRC.indexOf('function broadcastUpdateState'),
    );
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/process\.env\.LOCALAPPDATA/);
  });

  // QA24(B-L1): 캐시 **루트 전체**를 지우면 차등 다운로드 기준본(`installer.exe`)까지 날아가
  // 그 뒤로 계속 전량(≈101MB) 다운로드가 된다 — NSIS 설치가 다시 일어나기 전에는 복구되지
  // 않는다. 손상되는 것은 재조립 결과물과 그 기준 blockmap 뿐이므로 그 둘만 지운다.
  it('차등 다운로드 기준본(installer.exe)은 남기고 pending/ 과 current.blockmap 만 지운다', () => {
    const body = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function clearUpdaterCache'),
      MAIN_SRC.indexOf('function broadcastUpdateState'),
    );
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/'pending'/);
    expect(code).toMatch(/'current\.blockmap'/);
    // 루트를 통째로 지우면 안 된다 — rmSync 의 인자가 target 자체이면 기준본이 함께 사라진다.
    expect(code, '캐시 루트 전체 삭제는 차등 기준본까지 날린다').not.toMatch(/rmSync\(\s*target\s*,/);
  });
});

describe('revertFlushMarks — 설치 무산 롤백 (QA19 본문 검증)', () => {
  // updater.test 는 콜백이 **호출되는지**만 검증할 수 있다. 이 본문이 실제로 표식을 지우지
  // 않으면, 설치 무산 후 창 X 닫기가 'allow' 로 빠져 종료 flush 를 통째로 우회한다.
  it('표식을 지워 다음 close 가 다시 flush 를 타게 한다', async () => {
    const win = createWindow() as unknown as InstanceType<typeof FakeBW>;
    // 설치 직전 flush — 창이 flushed 로 표시된다.
    const p = flushRenderersBeforeQuit();
    ackFlush(win);
    await p;
    expect(win.emitClose(), '표식이 있으면 close 가 통과한다(설치 전제)').toBe(false);

    revertFlushMarks();

    expect(win.emitClose(), '롤백 후에는 다시 가로채 flush 해야 한다').toBe(true);
    expect(win.webContents.sent.filter((c) => c === 'app:flush-before-quit').length).toBe(2);
  });
});

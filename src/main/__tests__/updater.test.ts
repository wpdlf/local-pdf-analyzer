import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdaterService, INSTALL_QUIT_GRACE_MS, type AutoUpdaterLike, type IpcMainLike, type UpdaterDeps } from '../updater';
import type { UpdateState } from '../../shared/update-types';

// updater.ts 행위 검증 — electron / electron-updater 를 주입받으므로 node 환경에서 직접 구동한다.
// update-policy.test 가 "상태 전이"를 소유한다면, 본 테스트는 그 위의 오케스트레이션을 본다:
//   - 미지원 환경(dev/비-Windows)에서 네트워크 호출이 0 인가
//   - 설치 전에 렌더러 flush 를 반드시 완주시키는가 (데이터 손실 방어의 핵심 계약)
//   - 조작 재진입(중복 다운로드/이중 설치)이 차단되는가
//   - progress 폭주가 브로드캐스트로 그대로 새지 않는가

type Listener = (...args: never[]) => void;

function makeAutoUpdater() {
  const listeners = new Map<string, Listener[]>();
  const au = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: Listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return au;
    }),
    checkForUpdates: vi.fn(() => Promise.resolve({})),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  };
  const emit = (event: string, payload?: unknown) => {
    for (const l of listeners.get(event) ?? []) (l as (p?: unknown) => void)(payload);
  };
  return { au, emit, listeners };
}

function setup(over: Partial<UpdaterDeps> = {}) {
  const { au, emit } = makeAutoUpdater();
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => { handlers.set(channel, listener as (...args: never[]) => unknown); },
  };
  const broadcasts: UpdateState[] = [];
  const flush = vi.fn(() => Promise.resolve());
  const service = createUpdaterService({
    autoUpdater: au as unknown as AutoUpdaterLike,
    ipcMain,
    currentVersion: '1.0.0',
    isPackaged: true,
    platform: 'win32',
    broadcast: (s) => { broadcasts.push(s); },
    flushBeforeInstall: flush,
    isAutoCheckEnabled: () => Promise.resolve(true),
    ...over,
  });
  service.wire();
  service.registerHandlers();
  return { service, au, emit, handlers, broadcasts, flush };
}

/** 확인 → available 까지 진행시킨 서비스 */
async function toAvailable(ctx: ReturnType<typeof setup>, version = '1.1.0') {
  await ctx.service.check('manual');
  ctx.emit('update-available', { version });
}

describe('createUpdaterService — 정책 플래그', () => {
  it('wire 시 자동 다운로드/종료시 자동설치를 끈다 (사용자 승인 후에만 진행)', () => {
    const { au } = setup();
    expect(au.autoDownload).toBe(false);
    expect(au.autoInstallOnAppQuit).toBe(false);
  });

  it('미지원 환경에서는 이벤트를 구독하지도, 플래그를 건드리지도 않는다', () => {
    const { au } = setup({ isPackaged: false });
    expect(au.on).not.toHaveBeenCalled();
    expect(au.autoDownload).toBe(true);
  });
});

describe('check', () => {
  it('수동 확인은 autoUpdater.checkForUpdates 를 호출하고 checking 을 브로드캐스트', async () => {
    const ctx = setup();
    await ctx.service.check('manual');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(1);
    // 진행 표시가 사용자에게 도달해야 한다 — 확인이 끝난 뒤의 최종 상태와 별개로.
    expect(ctx.broadcasts.map((s) => s.status)).toContain('checking');
  });

  it('미지원 환경(dev)에서는 네트워크 호출도 브로드캐스트도 없다', async () => {
    const ctx = setup({ isPackaged: false });
    const state = await ctx.service.check('manual');
    expect(ctx.au.checkForUpdates).not.toHaveBeenCalled();
    expect(ctx.broadcasts).toEqual([]);
    expect(state.status).toBe('unsupported');
  });

  it('자동 확인은 설정이 꺼져 있으면 실행하지 않는다', async () => {
    const ctx = setup({ isAutoCheckEnabled: () => Promise.resolve(false) });
    await ctx.service.check('auto');
    expect(ctx.au.checkForUpdates).not.toHaveBeenCalled();
  });

  it('자동 확인은 최소 간격 내 재호출 시 건너뛴다 (수동은 영향 없음)', async () => {
    let clock = 1_000_000;
    const ctx = setup({ now: () => clock });
    await ctx.service.check('auto');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await ctx.service.check('auto');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(1);
    await ctx.service.check('manual');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('설정 조회가 throw 해도 자동 확인은 기본값(ON)으로 진행한다', async () => {
    const ctx = setup({ isAutoCheckEnabled: () => Promise.reject(new Error('settings io')) });
    await ctx.service.check('auto');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdates 가 reject 하면 errorKey 상태로 수렴한다', async () => {
    const ctx = setup();
    ctx.au.checkForUpdates.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND github.com'));
    const state = await ctx.service.check('manual');
    expect(state).toMatchObject({ status: 'error', errorKey: 'updateNetwork' });
  });

  it('이벤트 없이 resolve 해도 checking 에 고착되지 않는다 (영구 잠금 방어)', async () => {
    const ctx = setup();
    // 이벤트를 하나도 emit 하지 않고 resolve — 이후 확인이 canCheck 에 영구 차단되면 안 된다.
    const state = await ctx.service.check('manual');
    expect(state.status).toBe('not-available');
    await ctx.service.check('manual');
    expect(ctx.au.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('reject + error 이벤트가 함께 와도 브로드캐스트는 1회 (중복 전이 흡수)', async () => {
    const ctx = setup();
    ctx.au.checkForUpdates.mockImplementationOnce(() => {
      ctx.emit('error', new Error('ENOTFOUND'));
      return Promise.reject(new Error('ENOTFOUND'));
    });
    await ctx.service.check('manual');
    const errorBroadcasts = ctx.broadcasts.filter((s) => s.status === 'error');
    expect(errorBroadcasts).toHaveLength(1);
  });
});

describe('download', () => {
  it('available 상태에서만 다운로드를 시작한다', async () => {
    const ctx = setup();
    await ctx.service.download();
    expect(ctx.au.downloadUpdate).not.toHaveBeenCalled();

    await toAvailable(ctx);
    await ctx.service.download();
    expect(ctx.au.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('다운로드 중 재호출은 무시된다 (중복 다운로드 차단)', async () => {
    const ctx = setup();
    await toAvailable(ctx);
    ctx.au.downloadUpdate.mockImplementationOnce(() => new Promise(() => {}));
    void ctx.service.download();
    await ctx.service.download();
    expect(ctx.au.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('progress 이벤트는 정수 percent 가 바뀔 때만 브로드캐스트된다', async () => {
    const ctx = setup();
    await toAvailable(ctx);
    ctx.au.downloadUpdate.mockImplementationOnce(() => new Promise(() => {}));
    void ctx.service.download();
    const before = ctx.broadcasts.length;
    ctx.emit('download-progress', { percent: 10.1 });
    ctx.emit('download-progress', { percent: 10.4 });
    ctx.emit('download-progress', { percent: 10.9 });
    ctx.emit('download-progress', { percent: 11.0 });
    expect(ctx.broadcasts.length - before).toBe(2);
  });

  it('이벤트 없이 resolve 해도 downloading 에 고착되지 않는다 (설치 가능 상태로 확정)', async () => {
    const ctx = setup();
    await toAvailable(ctx);
    const state = await ctx.service.download();
    expect(state).toMatchObject({ status: 'downloaded', newVersion: '1.1.0' });
  });

  it('downloadUpdate 가 reject 하면 errorKey 상태로 수렴한다', async () => {
    const ctx = setup();
    await toAvailable(ctx);
    ctx.au.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    const state = await ctx.service.download();
    expect(state).toMatchObject({ status: 'error', errorKey: 'updateChecksum' });
  });
});

describe('install — 데이터 손실 방어', () => {
  async function toDownloaded(ctx: ReturnType<typeof setup>) {
    await toAvailable(ctx);
    await ctx.service.download();
    ctx.emit('update-downloaded', { version: '1.1.0' });
  }

  it('downloaded 가 아니면 설치하지 않는다', async () => {
    const ctx = setup();
    await ctx.service.install();
    expect(ctx.au.quitAndInstall).not.toHaveBeenCalled();
    await toAvailable(ctx);
    await ctx.service.install();
    expect(ctx.au.quitAndInstall).not.toHaveBeenCalled();
  });

  it('quitAndInstall 전에 렌더러 flush 를 완주시킨다 (QA10/16/17/18 손실 경로 차단)', async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push('flush-start');
      await Promise.resolve();
      order.push('flush-done');
    });
    const ctx = setup({ flushBeforeInstall: flush });
    await toDownloaded(ctx);
    ctx.au.quitAndInstall.mockImplementation(() => { order.push('quitAndInstall'); });

    await ctx.service.install();
    expect(order).toEqual(['flush-start', 'flush-done', 'quitAndInstall']);
  });

  it('flush 가 실패해도 설치는 진행한다 (best-effort — 종료 경로와 동일 정책)', async () => {
    const ctx = setup({ flushBeforeInstall: () => Promise.reject(new Error('renderer gone')) });
    await toDownloaded(ctx);
    await ctx.service.install();
    expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('설치는 NSIS UI 표시 + 설치 후 재실행 인자로 호출한다', async () => {
    const ctx = setup();
    await toDownloaded(ctx);
    await ctx.service.install();
    expect(ctx.au.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('연타해도 인스톨러는 한 번만 실행된다', async () => {
    const ctx = setup();
    await toDownloaded(ctx);
    await Promise.all([ctx.service.install(), ctx.service.install(), ctx.service.install()]);
    expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // QA19(A-MED, 실데이터 손실): electron-updater 의 quitAndInstall 은 실패해도 throw 하지
  // 않는다(BaseUpdater.install 이 dispatchError 후 false 반환 → app.quit() 미호출). 그래서
  // "유예 시간 내 미종료 = 실패"로 판정해 ①설치 잠금 해제 ②flush 표식 롤백 ③사용자 표면화를
  // 해야 한다. ②가 없으면 이후 창 X 닫기가 종료 flush 를 건너뛰어 마지막 델타가 소실된다.
  describe('설치 무산(앱이 종료되지 않음) 처리', () => {
    it('유예 시간 뒤 잠금이 풀려 재시도할 수 있다', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup();
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
        // 종료되지 않은 채 유예 시간 경과
        vi.advanceTimersByTime(INSTALL_QUIT_GRACE_MS + 1);
        await ctx.service.install();
        expect(ctx.au.quitAndInstall, '잠금이 영구 고착되면 재시도가 조용히 무시된다').toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flush 표식 롤백 콜백을 호출한다 (창닫기 flush 우회 방지)', async () => {
      vi.useFakeTimers();
      try {
        const onInstallAborted = vi.fn();
        const ctx = setup({ onInstallAborted });
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(onInstallAborted).not.toHaveBeenCalled(); // 아직 종료 대기 중
        vi.advanceTimersByTime(INSTALL_QUIT_GRACE_MS + 1);
        expect(onInstallAborted).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('실패를 errorKey 로 표면화하되 설치 자격(downloaded)은 유지한다', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup();
        await toDownloaded(ctx);
        await ctx.service.install();
        vi.advanceTimersByTime(INSTALL_QUIT_GRACE_MS + 1);
        const state = ctx.service.getState();
        expect(state.errorKey).toBe('updateInstallFailed');
        expect(state.status, '설치 자격까지 잃으면 재다운로드 외에 길이 없다').toBe('downloaded');
      } finally {
        vi.useRealTimers();
      }
    });

    it('정상 설치(앱 종료)에서는 롤백 콜백이 호출되지 않는다', async () => {
      vi.useFakeTimers();
      try {
        const onInstallAborted = vi.fn();
        const ctx = setup({ onInstallAborted });
        await toDownloaded(ctx);
        await ctx.service.install();
        // 유예 시간 이전 = 앱이 정상 종료되는 구간
        vi.advanceTimersByTime(INSTALL_QUIT_GRACE_MS - 1);
        expect(onInstallAborted).not.toHaveBeenCalled();
        expect(ctx.service.getState().errorKey).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('IPC 핸들러', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('update:* 4개 채널을 등록한다', () => {
    expect([...ctx.handlers.keys()].sort()).toEqual([
      'update:check', 'update:download', 'update:get-state', 'update:install',
    ]);
  });

  it('update:get-state 는 현재 상태를 반환한다', async () => {
    const state = await (ctx.handlers.get('update:get-state') as () => Promise<UpdateState>)();
    expect(state).toMatchObject({ status: 'idle', currentVersion: '1.0.0' });
  });

  it('update:check 는 수동 확인 경로 — 설정 OFF 여도 실행된다', async () => {
    const off = setup({ isAutoCheckEnabled: () => Promise.resolve(false) });
    await (off.handlers.get('update:check') as () => Promise<UpdateState>)();
    expect(off.au.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('브로드캐스트 실패 격리', () => {
  it('창 파괴 중 send 가 throw 해도 상태 갱신은 유지된다', async () => {
    const ctx = setup({
      broadcast: () => { throw new Error('Object has been destroyed'); },
    });
    // 브로드캐스트가 매번 throw 해도 내부 상태 머신은 정상 진행해야 한다(다음 조작 게이트가 열림).
    await expect(ctx.service.check('manual')).resolves.toMatchObject({ status: 'not-available' });
  });
});

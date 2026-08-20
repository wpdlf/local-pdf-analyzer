import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdaterService, INSTALL_QUIT_GRACE_MS, type AutoUpdaterLike, type IpcMainLike, type UpdaterDeps } from '../updater';
import { canDownload } from '../update-policy';
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

// 실기기 검증(2026-08-07)에서 발견: 다운로드가 실패한 뒤 배너의 "다시 시도" 를 눌러도
// **아무 반응이 없었다**. QA19(C-LOW)가 정책(canDownload)으로 error 후 재시도를 일부러 열어놨고
// v0.31.40 배너가 그 버튼을 노출하는데, 정작 download() 가 게이트에 newVersion 을 넘기지 않아
// (기본값 null) `status==='error' && newVersion!==null` 이 **항상 false** 였다.
// 정책은 열려 있는데 배선이 닫고 있던 형태 — 세 층(정책·오케스트레이션·UI)이 다 있는데 동작하지 않았다.
describe('다운로드 실패 후 재시도', () => {
  async function toDownloadError(ctx: ReturnType<typeof setup>) {
    await toAvailable(ctx, '1.1.0');
    ctx.au.downloadUpdate.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await ctx.service.download();
  }

  it('확인된 버전이 남아 있으면 재시도가 실제로 다운로드를 시작한다', async () => {
    const ctx = setup();
    await toDownloadError(ctx);
    expect(ctx.service.getState()).toMatchObject({ status: 'error', newVersion: '1.1.0' });

    ctx.au.downloadUpdate.mockResolvedValueOnce([]);
    await ctx.service.download();

    expect(ctx.au.downloadUpdate, '재시도가 조용히 폐기되면 버튼이 죽은 것이다').toHaveBeenCalledTimes(2);
  });

  it('확인된 버전이 없으면 재시도하지 않는다 (재확인이 먼저)', async () => {
    const ctx = setup();
    await ctx.service.check('manual');
    ctx.emit('error', new Error('ENOTFOUND')); // available 없이 확인 자체가 실패 → newVersion 없음
    const before = ctx.au.downloadUpdate.mock.calls.length;
    await ctx.service.download();
    expect(ctx.au.downloadUpdate.mock.calls.length).toBe(before);
  });
});

// 실기기 검증(2026-08-07): 차등 다운로드가 어긋난 캐시로 **손상된 인스톨러**를 만들어냈고
// (크기 2바이트 차이 + sha512 불일치) 체크섬 검증이 이를 거부했다 — 여기까지는 옳은 동작이다.
// 문제는 그다음: 손상된 temp 파일이 캐시에 남아 **다음 시도를 계속 오염**시킬 수 있다.
// 체크섬이 틀렸다는 건 디스크의 것을 믿을 수 없다는 뜻이므로, 지우고 새로 받는 것이 유일한 회복이다.
describe('체크섬 실패 시 캐시 정리', () => {
  it('updateChecksum 오류면 업데이터 캐시를 비운다', async () => {
    const clearCache = vi.fn();
    const ctx = setup({ clearUpdaterCache: clearCache });
    await toAvailable(ctx, '1.1.0');
    ctx.au.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));

    await ctx.service.download();

    expect(ctx.service.getState().errorKey).toBe('updateChecksum');
    expect(clearCache, '손상된 캐시를 남기면 다음 시도도 같은 결과가 된다').toHaveBeenCalledTimes(1);
  });

  it('네트워크 오류 등 다른 실패에서는 캐시를 건드리지 않는다 (부분 다운로드 재개 여지 보존)', async () => {
    const clearCache = vi.fn();
    const ctx = setup({ clearUpdaterCache: clearCache });
    await toAvailable(ctx, '1.1.0');
    ctx.au.downloadUpdate.mockRejectedValueOnce(new Error('ENOTFOUND'));

    await ctx.service.download();

    expect(ctx.service.getState().errorKey).toBe('updateNetwork');
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('정리 자체가 실패해도 상태 전이는 정상 진행한다 (best-effort)', async () => {
    const ctx = setup({ clearUpdaterCache: () => { throw new Error('EBUSY'); } });
    await toAvailable(ctx, '1.1.0');
    ctx.au.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'));

    await expect(ctx.service.download()).resolves.toMatchObject({ errorKey: 'updateChecksum' });
  });

  it('체크섬 오류가 이벤트로 와도 정리한다 (reject 경로 외)', async () => {
    const clearCache = vi.fn();
    const ctx = setup({ clearUpdaterCache: clearCache });
    await toAvailable(ctx, '1.1.0');
    ctx.emit('error', new Error('sha512 checksum mismatch'));
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  // QA24(A-M3): classifyUpdateError 는 /sha512|checksum|integrity|signature/ 에 걸리는 **모든**
  // 에러를 updateChecksum 으로 분류한다. 그래서 이미 검증을 통과해 받아둔 인스톨러를 들고 있는
  // 상태에서 서명·무결성 문구를 포함한 error 가 한 번 흘러도 캐시가 통째로 지워졌다 —
  // 리듀서는 downloaded 를 유지하니 UI 는 "설치 준비됨" 인데 디스크에는 인스톨러가 없고,
  // 설치를 누르면 installer-missing 에 착지한다.
  it('설치 대기(downloaded) 중의 체크섬 오류는 캐시를 지우지 않는다 — 멀쩡한 인스톨러 보호', async () => {
    const clearCache = vi.fn();
    const ctx = setup({ clearUpdaterCache: clearCache });
    await toAvailable(ctx, '1.1.0');
    await ctx.service.download();
    ctx.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:/cache/pending/Setup.exe' });

    ctx.emit('error', new Error('signature verification failed'));

    expect(ctx.service.getState().status, '설치 자격은 유지된다').toBe('downloaded');
    expect(clearCache, '받아둔 인스톨러를 지우면 UI 는 설치 준비됨인데 디스크는 비어 있다').not.toHaveBeenCalled();
  });
});

describe('install — 데이터 손실 방어', () => {
  async function toDownloaded(ctx: ReturnType<typeof setup>) {
    await toAvailable(ctx);
    await ctx.service.download();
    // electron-updater 6 의 update-downloaded 는 실제 파일 경로(downloadedFile)를 함께 준다.
    ctx.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:/cache/pending/Setup.exe' });
  }

  /** downloadedFile 을 싣지 않는 경우(구버전/피드 차이) — 존재 확인을 할 수 없는 상태. */
  async function toDownloadedWithoutPath(ctx: ReturnType<typeof setup>) {
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

  // QA24(B-I2): flush await 는 창당 최대 2초 열려 있는 구간이다. 그 사이 autoUpdater 의
  // error 가 도착하면 on('error') 가 finishAbortedInstall() 로 installing 을 이미 false 로
  // 되돌린다. 종전에는 그대로 quitAndInstall 을 호출했고, 이어 만드는 백스톱 타이머는
  // `if (!installing) return` 에 걸려 무력화됐다 — 설치 무산을 감지할 주체가 사라진다.
  it('flush 대기 중 error 가 도착하면 설치를 시작하지 않는다 (백스톱 무력화 차단)', async () => {
    // flush 가 진행되는 동안 설치 무산 신호가 도착하는 상황 — flush 콜백 안에서 emit 해
    // 타이밍을 결정적으로 고정한다(실제로는 창당 최대 2초 열려 있는 구간).
    let emitError: (() => void) | null = null;
    const ctx = setup({ flushBeforeInstall: async () => { emitError?.(); } });
    emitError = () => ctx.emit('error', new Error('NSIS spawn failed'));
    await toDownloaded(ctx);

    await ctx.service.install();

    expect(ctx.au.quitAndInstall, '취소된 설치를 그대로 진행하면 백스톱이 사라진다').not.toHaveBeenCalled();
    // 상태는 downloaded 로 복귀해 재시도가 가능해야 한다(설치 자격 보존).
    expect(ctx.service.getState().status).toBe('downloaded');
    // 그리고 그 재시도는 실제로 동작해야 한다 — 잠금이 고착되지 않았음의 확증.
    emitError = null; // 이번 flush 에서는 무산 신호가 오지 않는다
    await ctx.service.install();
    expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
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

    // QA23(B-MED, 실데이터 손실): 롤백이 15초 백스톱에만 걸려 있었다. electron-updater 는
    // 인스톨러 경로 부재 등에서 **t≈0 에 error 를 발화**하는데, 그 15초 동안 flush 표식이 남아
    // 사용자의 가장 개연성 높은 반응(창 X 닫기)이 종료 flush 를 통째로 우회했다. 신호가 오면
    // 기다리지 않는다.
    it('설치 중 error 이벤트가 오면 즉시 롤백한다 (15초 대기 없음)', async () => {
      vi.useFakeTimers();
      try {
        const onInstallAborted = vi.fn();
        const ctx = setup({ onInstallAborted });
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(onInstallAborted).not.toHaveBeenCalled();

        ctx.emit('error', new Error('No update filepath provided'));
        expect(onInstallAborted, '실패 신호를 받고도 15초를 기다리면 그 사이 델타가 소실된다').toHaveBeenCalledTimes(1);
        expect(ctx.service.getState().status).toBe('downloaded'); // 재시도 가능 상태로 복귀

        // 백스톱 타이머가 뒤늦게 발화해 거짓 실패를 덧씌우지 않는다.
        const before = ctx.broadcasts.length;
        vi.advanceTimersByTime(INSTALL_QUIT_GRACE_MS + 1);
        expect(onInstallAborted).toHaveBeenCalledTimes(1);
        expect(ctx.broadcasts.length).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    // QA23(B-LOW): 타이머가 어디서도 clear 되지 않아, 정상 설치라도 종료가 15초를 넘기면
    // (ollama taskkill 체인 최악값이 그에 육박) 거짓 실패 브로드캐스트 + **잠금 해제**가 일어났다.
    // electron-updater 는 실패 시 quitAndInstallCalled 를 되돌리므로 연타 시 인스톨러 이중 spawn 위험.
    it('설치가 error 로 정리된 뒤에는 잠금이 풀려 재시도할 수 있다', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup();
        await toDownloaded(ctx);
        await ctx.service.install();
        ctx.emit('error', new Error('No update filepath provided'));
        await ctx.service.install();
        expect(ctx.au.quitAndInstall, '정리 후에는 재시도가 가능해야 한다').toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // QA23 후속(실기기 검증에서 발견, 2026-08-07): 인스톨러 파일이 사라진 상태에서 설치를 누르면
    // **앱이 그냥 종료되고 아무 설명도 남지 않았다**. electron-updater 는 update-info.json 에서
    // 경로만 읽고 **파일 존재를 확인하지 않은 채** spawn 을 시도하는데, spawn 실패는 비동기라
    // `install()` 은 이미 성공을 반환하고 `app.quit()` 이 예약된다. 앱이 죽어버리므로 Tier2 에서
    // 넣은 처리(즉시 에러 표시·재시도·flush 표식 롤백)가 개입할 여지가 없다 — 앱이 살아 있어야
    // 동작하기 때문. 백신 격리로 실제로 흔한 시나리오이고, 사용자는 "설치를 눌렀는데 앱만 꺼지고
    // 다시 켜면 구버전" 을 겪는다. 종료 **전에** 막아야 한다.
    describe('인스톨러 파일이 사라진 경우', () => {
      it('quitAndInstall 을 호출하지 않는다 (앱이 조용히 죽지 않도록)', async () => {
        const ctx = setup({ installerExists: () => false });
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(ctx.au.quitAndInstall, '파일이 없는데 종료를 시작하면 무음 실패가 된다').not.toHaveBeenCalled();
      });

      it('사유를 남기고 재다운로드가 가능한 상태로 되돌린다', async () => {
        const ctx = setup({ installerExists: () => false });
        await toDownloaded(ctx);
        await ctx.service.install();
        const s = ctx.service.getState();
        expect(s.errorKey).toBe('updateInstallerMissing');
        expect(canDownload(s.status, s.newVersion), '재다운로드 경로가 열려 있어야 한다').toBe(true);
      });

      it('flush 표식을 되돌린다 (설치 대기 상태로 남지 않도록)', async () => {
        const onInstallAborted = vi.fn();
        const ctx = setup({ installerExists: () => false, onInstallAborted });
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(onInstallAborted).toHaveBeenCalledTimes(1);
      });

      it('파일이 있으면 종전대로 설치를 진행한다 (과잉 차단 방지)', async () => {
        const ctx = setup({ installerExists: () => true });
        await toDownloaded(ctx);
        await ctx.service.install();
        expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
      });

      it('경로를 못 얻은 경우(구버전 이벤트 등)에는 차단하지 않는다', async () => {
        // downloadedFile 을 싣지 않는 피드/버전에서 설치가 막히면 그게 더 나쁜 회귀다.
        const ctx = setup({ installerExists: () => false });
        await toDownloadedWithoutPath(ctx);
        await ctx.service.install();
        expect(ctx.au.quitAndInstall).toHaveBeenCalledTimes(1);
      });

      // QA24(A-M2/B-M4): 재다운로드가 **이벤트 없이** 완료되는 고착 방어 경로를 타면, 종전에는
      // 직전(이미 사라진) 경로가 그대로 남아 설치가 영구히 막혔다 — 백신이 인스톨러를 격리한 뒤
      // 재시도하는 시나리오에서 사용자는 재다운로드를 반복해도 같은 실패만 본다.
      it('재다운로드 시 직전 인스톨러 경로가 남아 설치를 영구 차단하지 않는다', async () => {
        const ctx = setup({ installerExists: () => false }); // 옛 경로는 이제 존재하지 않는다
        // 1차: 경로를 받은 정상 다운로드
        await toDownloaded(ctx);
        // 설치 시도 → 파일이 없으므로 installer-missing (정상 동작)
        await ctx.service.install();
        expect(ctx.service.getState().errorKey).toBe('updateInstallerMissing');
        expect(ctx.au.quitAndInstall).not.toHaveBeenCalled();

        // 2차: 재시도 — downloadUpdate 는 resolve 하지만 update-downloaded 이벤트가 없는 경우
        await ctx.service.download();

        expect(ctx.service.getState().status).toBe('downloaded');
        await ctx.service.install();
        expect(
          ctx.au.quitAndInstall,
          '스테일 경로가 남으면 재다운로드해도 영원히 installer-missing 이 반복된다',
        ).toHaveBeenCalledTimes(1);
      });
    });

    it('설치 요청 즉시 installing 상태가 되어 재클릭이 조용히 폐기되지 않는다', async () => {
      const ctx = setup();
      await toDownloaded(ctx);
      await ctx.service.install();
      expect(ctx.service.getState().status).toBe('installing');
      // 이 상태는 브로드캐스트돼 UI 가 "설치 중"을 표시할 수 있어야 한다.
      expect(ctx.broadcasts.some((s) => s.status === 'installing')).toBe(true);
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

// 실기기 검증(2026-08-20)이 찾은 두 결함의 회귀 넷.
//
// 둘 다 **앱을 껐다 켜야만** 드러나는 종류라 기존 유닛/E2E 로는 잡히지 않았다. 이벤트를 주입하는
// 테스트는 프로세스가 죽었다 살아나는 구간을 표현하지 않기 때문이다. 여기서는 "새로 기동한
// 프로세스가 디스크에 남은 것을 어떻게 해석하는가"를 직접 구동한다.
describe('createUpdaterService — 재기동 시 staged 인스톨러 (실기기 2026-08-20)', () => {
  const PENDING = { sha512: 'AAAA==', filePath: 'C:/cache/pending/Setup-1.1.2.exe' };

  it('이미 받아둔 것과 같은 업데이트면 downloaded 로 복원한다 ("다운로드" 재노출 방지)', async () => {
    const ctx = setup({ readPendingUpdate: () => PENDING });
    await ctx.service.check('manual');
    ctx.emit('update-available', { version: '1.1.2', files: [{ sha512: 'AAAA==' }] });

    const state = ctx.handlers.get('update:get-state')!() as UpdateState;
    expect(state.status).toBe('downloaded');
    expect(state.newVersion).toBe('1.1.2');
  });

  it('sha512 가 다르면 available 에 머문다 (다른 버전의 잔여물을 오인하지 않는다)', async () => {
    const ctx = setup({ readPendingUpdate: () => ({ ...PENDING, sha512: 'OLD==' }) });
    await ctx.service.check('manual');
    ctx.emit('update-available', { version: '1.1.2', files: [{ sha512: 'AAAA==' }] });

    expect((ctx.handlers.get('update:get-state')!() as UpdateState).status).toBe('available');
  });

  it('staged 된 것이 없으면 평소대로 available 이다', async () => {
    const ctx = setup({ readPendingUpdate: () => null });
    await ctx.service.check('manual');
    ctx.emit('update-available', { version: '1.1.2', files: [{ sha512: 'AAAA==' }] });

    expect((ctx.handlers.get('update:get-state')!() as UpdateState).status).toBe('available');
  });

  it('피드가 sha512 를 싣지 않으면 추측하지 않는다', async () => {
    const ctx = setup({ readPendingUpdate: () => PENDING });
    await ctx.service.check('manual');
    ctx.emit('update-available', { version: '1.1.2' });

    expect((ctx.handlers.get('update:get-state')!() as UpdateState).status).toBe('available');
  });

  it('복원된 상태에서 설치하면 그 파일 경로로 실재 확인을 한다', async () => {
    const installerExists = vi.fn(() => true);
    const ctx = setup({ readPendingUpdate: () => PENDING, installerExists });
    await ctx.service.check('manual');
    ctx.emit('update-available', { version: '1.1.2', files: [{ sha512: 'AAAA==' }] });
    await ctx.service.install();

    // 경로를 복원하지 못했다면 확인 자체를 건너뛰어(installerExists 미호출) 파일이 사라진
    // 경우에도 앱이 조용히 꺼지는 예전 결함으로 되돌아간다.
    expect(installerExists).toHaveBeenCalledWith(PENDING.filePath);
    expect(ctx.au.quitAndInstall).toHaveBeenCalled();
  });
});

describe('createUpdaterService — 설치 완료 후 pending 정리 (실기기 2026-08-20)', () => {
  it('최신 버전이면 staged 인스톨러를 지운다 (설치 후 105MB 잔류 방지)', async () => {
    const clearPendingUpdate = vi.fn();
    const ctx = setup({
      readPendingUpdate: () => ({ sha512: 'X==', filePath: 'C:/cache/pending/old.exe' }),
      clearPendingUpdate,
    });
    await ctx.service.check('manual');
    ctx.emit('update-not-available', {});

    expect(clearPendingUpdate).toHaveBeenCalledTimes(1);
  });

  it('staged 된 것이 없으면 정리를 시도하지 않는다', async () => {
    const clearPendingUpdate = vi.fn();
    const ctx = setup({ readPendingUpdate: () => null, clearPendingUpdate });
    await ctx.service.check('manual');
    ctx.emit('update-not-available', {});

    expect(clearPendingUpdate).not.toHaveBeenCalled();
  });

  // ⚠️ "available 에서는 지우지 않는다" 는 테스트를 처음에 넣었다가 지웠다 — 정리 코드는
  // update-not-available 핸들러 안에만 있어서 available 이벤트로는 그 줄에 닿지도 않는다.
  // 뮤테이션(가드 제거)이 통과하는 것으로 그 공허함이 드러났고, 그래서 프로덕션 쪽의 중복
  // status 가드도 함께 걷어냈다(canCheck 이 downloaded 중의 재확인을 막으므로 항상 참이었다).

  it('정리 중 예외가 나도 상태를 깨뜨리지 않는다 (best-effort)', async () => {
    const ctx = setup({
      readPendingUpdate: () => ({ sha512: 'X==', filePath: 'p' }),
      clearPendingUpdate: () => { throw new Error('EBUSY'); },
    });
    await ctx.service.check('manual');
    expect(() => ctx.emit('update-not-available', {})).not.toThrow();
    expect((ctx.handlers.get('update:get-state')!() as UpdateState).status).toBe('not-available');
  });
});

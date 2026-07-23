/**
 * 자동 업데이트 서비스 — electron-updater 배선 + IPC.
 *
 * 결정 로직은 update-policy.ts(순수)에 있고, 여기서는 부작용만 다룬다:
 *   - autoUpdater 이벤트 → 정규화 이벤트 → 리듀서 → 렌더러 브로드캐스트
 *   - update:* IPC 핸들러
 *   - 설치 직전 렌더러 flush 핸드셰이크
 *
 * electron / electron-updater 를 import 하지 않고 **주입**받는다(ApiKeyStore 의 safeStorage
 * 주입과 동일 패턴). 덕분에 본 모듈 전체가 vitest node 환경에서 행위 검증된다.
 *
 * 정책 두 가지를 명시적으로 고정한다:
 *   1. autoDownload = false — 인스톨러가 100MB 를 넘고 사용자가 종량제/모바일 테더링일 수 있다.
 *      확인은 자동으로, 다운로드는 승인 후.
 *   2. autoInstallOnAppQuit = false — 사용자가 "재시작하여 설치"를 누른 경우에만 설치한다.
 *      기본값(true)이면 앱을 그냥 닫았을 때 NSIS 인스톨러가 예고 없이 뜬다. 본 앱의 NSIS 는
 *      oneClick:false(설치 경로 변경 허용)라 무음 설치가 보장되지 않아 더더욱 부적절.
 */

import {
  canCheck,
  canDownload,
  canInstall,
  classifyUpdateError,
  createInitialState,
  nextUpdateState,
  shouldAutoCheck,
  type UpdateEvent,
} from './update-policy';
import type { UpdateState } from '../shared/update-types';

/** autoUpdater 이벤트 페이로드 중 실제로 읽는 필드만 (electron-updater 의 UpdateInfo 부분집합) */
export interface UpdateInfoLike { version?: string }
export interface DownloadProgressLike { percent?: number }

/**
 * electron-updater 의 autoUpdater 중 본 모듈이 실제로 쓰는 표면만 구조적으로 선언.
 * 이벤트별 리스너 타입을 오버로드로 못박아 두면 payload 필드 오타가 타입 체크에서 걸린다.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: DownloadProgressLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** ipcMain 중 본 모듈이 쓰는 표면. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  ipcMain: IpcMainLike;
  /** 현재 앱 버전 (app.getVersion) */
  currentVersion: string;
  /** app.isPackaged */
  isPackaged: boolean;
  /** process.platform */
  platform: string;
  /** 상태를 모든 살아있는 창에 전송 */
  broadcast: (state: UpdateState) => void;
  /**
   * 설치 직전 렌더러 persist flush. 종료 경로(flushRenderersBeforeQuit)와 **같은** 핸드셰이크를
   * 재사용해야 한다 — quitAndInstall 은 앱을 즉시 종료시키므로, 이것이 없으면 QA10/16/17/18 이
   * 반복해서 막아온 "마지막 델타(요약·Q&A·인덱스) 소실"이 업데이트 경로로 그대로 재현된다.
   */
  flushBeforeInstall: () => Promise<void>;
  /** 설정의 autoCheckUpdates 조회 (settings.json 은 비동기 로드) */
  isAutoCheckEnabled: () => Promise<boolean>;
  now?: () => number;
}

export interface UpdaterService {
  getState(): UpdateState;
  /** autoUpdater 이벤트 구독 + 정책 플래그 설정. 지원 환경이 아니면 no-op. */
  wire(): void;
  /** update:* IPC 핸들러 등록 */
  registerHandlers(): void;
  /** trigger='auto' 는 설정/간격 게이트를 통과해야 실행된다. */
  check(trigger: 'auto' | 'manual'): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
}

export function createUpdaterService(deps: UpdaterDeps): UpdaterService {
  const now = deps.now ?? (() => Date.now());
  const supported = deps.isPackaged && deps.platform === 'win32';
  let state = createInitialState(deps.currentVersion, supported);
  let lastCheckedAt: number | null = null;
  // quitAndInstall 은 되돌릴 수 없다 — 연타/중복 호출로 인스톨러가 두 번 spawn 되지 않도록 가드.
  let installing = false;

  function apply(event: UpdateEvent): void {
    const next = nextUpdateState(state, event);
    // 리듀서가 동일 참조를 반환하면 실질 변화 없음 — 브로드캐스트 생략(다운로드 중 초당 수십 회
    // 발생하는 progress 이벤트가 IPC 를 포화시키지 않도록).
    if (next === state) return;
    state = next;
    try {
      deps.broadcast(state);
    } catch (err) {
      // 창이 파괴되는 중이면 send 가 throw 할 수 있다. 상태 갱신 자체는 유지.
      console.error('[update] broadcast failed:', err);
    }
  }

  function wire(): void {
    if (!supported) return;
    deps.autoUpdater.autoDownload = false;
    deps.autoUpdater.autoInstallOnAppQuit = false;
    deps.autoUpdater.on('checking-for-update', () => apply({ type: 'check-started' }));
    deps.autoUpdater.on('update-available', (info) => {
      apply({ type: 'available', version: String(info?.version ?? '') });
    });
    deps.autoUpdater.on('update-not-available', () => apply({ type: 'not-available' }));
    deps.autoUpdater.on('download-progress', (progress) => {
      apply({ type: 'progress', percent: Number(progress?.percent ?? 0) });
    });
    deps.autoUpdater.on('update-downloaded', (info) => {
      apply({ type: 'downloaded', version: String(info?.version ?? state.newVersion ?? '') });
    });
    deps.autoUpdater.on('error', (err) => {
      apply({ type: 'error', errorKey: classifyUpdateError(err) });
    });
  }

  async function check(trigger: 'auto' | 'manual'): Promise<UpdateState> {
    if (!supported) return state;
    if (trigger === 'auto') {
      let enabled = true;
      try {
        enabled = await deps.isAutoCheckEnabled();
      } catch {
        // 설정 로드 실패는 기본값(켜짐)으로 진행 — 확인은 부작용이 없다.
      }
      if (!shouldAutoCheck({
        isPackaged: deps.isPackaged,
        platform: deps.platform,
        enabled,
        lastCheckedAt,
        now: now(),
      })) {
        return state;
      }
    }
    if (!canCheck(state.status)) return state;
    lastCheckedAt = now();
    apply({ type: 'check-started' });
    try {
      await deps.autoUpdater.checkForUpdates();
      // electron-updater 는 update-available / update-not-available 을 promise resolve **전에**
      // 발화한다. 그럼에도 아무 이벤트가 오지 않았다면 상태가 'checking' 에 고착되고, canCheck
      // 게이트가 이후 모든 확인(자동·수동 전부)을 영구 차단한다 — QA18 의 "IPC 타임아웃 자멸 →
      // 영구 정지"와 동일한 실패 형태. 관측된 신호가 없으면 최신 버전으로 간주해 잠금을 푼다.
      if (state.status === 'checking') apply({ type: 'not-available' });
    } catch (err) {
      // autoUpdater 는 실패 시 reject 와 'error' 이벤트를 모두 낼 수 있다 — 리듀서가 동일
      // errorKey 의 중복 전이를 흡수하므로 이중 처리해도 브로드캐스트는 1회.
      apply({ type: 'error', errorKey: classifyUpdateError(err) });
    }
    return state;
  }

  async function download(): Promise<UpdateState> {
    if (!supported || !canDownload(state.status)) return state;
    apply({ type: 'download-started' });
    try {
      await deps.autoUpdater.downloadUpdate();
      // check 와 동일한 고착 방어. downloadUpdate 의 resolve 는 파일 수신 성공을 뜻하므로
      // (실패는 reject) update-downloaded 이벤트가 없었더라도 완료로 확정한다 — 그러지 않으면
      // 'downloading' 에 갇혀 확인·다운로드·설치가 모두 막힌다.
      if (state.status === 'downloading') {
        apply({ type: 'downloaded', version: state.newVersion ?? '' });
      }
    } catch (err) {
      apply({ type: 'error', errorKey: classifyUpdateError(err) });
    }
    return state;
  }

  async function install(): Promise<UpdateState> {
    if (!supported || !canInstall(state.status) || installing) return state;
    installing = true;
    try {
      // 종료 flush 를 먼저 완주시킨다. quitAndInstall 이 유발하는 app.quit() 은 before-quit
      // 핸들러를 거치지만, 그쪽에 의존하면 인스톨러 spawn 과 flush 가 경쟁한다 — 여기서
      // 명시적으로 착지시킨 뒤 넘긴다(before-quit 은 flushedWindows 가드로 중복 flush 안 함).
      await deps.flushBeforeInstall();
    } catch (err) {
      // flush 실패로 업데이트를 막지는 않는다(best-effort) — 종료 경로와 동일 정책.
      console.error('[update] flush before install failed:', err);
    }
    try {
      // isSilent=false: NSIS oneClick:false 빌드라 설치 UI 가 필요하다.
      // isForceRunAfter=true: 설치 후 앱을 다시 띄운다("재시작하여 설치"의 멘탈 모델).
      deps.autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      installing = false;
      apply({ type: 'error', errorKey: classifyUpdateError(err) });
    }
    return state;
  }

  function registerHandlers(): void {
    deps.ipcMain.handle('update:get-state', (() => state) as never);
    deps.ipcMain.handle('update:check', (() => check('manual')) as never);
    deps.ipcMain.handle('update:download', (() => download()) as never);
    deps.ipcMain.handle('update:install', (() => install()) as never);
  }

  return {
    getState: () => state,
    wire,
    registerHandlers,
    check,
    download,
    install,
  };
}

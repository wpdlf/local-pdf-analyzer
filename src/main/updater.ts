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
  isPendingUpdateUsable,
  shouldAutoCheck,
  type PendingUpdateLike,
  type UpdateEvent,
} from './update-policy';
import type { UpdateState } from '../shared/update-types';

/**
 * autoUpdater 이벤트 페이로드 중 실제로 읽는 필드만 (electron-updater 의 UpdateInfo 부분집합).
 * `downloadedFile` 은 `update-downloaded` 에만 실려 오는 실제 인스톨러 경로(UpdateDownloadedEvent).
 */
export interface UpdateInfoLike {
  version?: string;
  downloadedFile?: string;
  /** 피드가 싣는 파일 목록. 설치 대상 exe 의 sha512 로 캐시된 인스톨러와 동일성을 판정한다. */
  files?: { url?: string; sha512?: string }[];
}
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
  /**
   * 설치가 시작되지 못했을 때(앱이 종료되지 않음) 호출된다.
   *
   * QA19(A-MED, 실데이터 손실): `flushBeforeInstall` 은 종료를 전제로 창을 "flush 완료"로
   * 표시하는데(index.ts flushedWindows), 설치가 무산되면 그 표식만 남는다. 이후 창 X 닫기가
   * `decideCloseAction` 에서 `hasFlushed → 'allow'` 로 판정돼 **종료 flush 인터셉트를 통째로
   * 건너뛰고** 마지막 델타가 소실된다(QA16 이 고친 경로의 부활). 소유자가 표식을 되돌린다.
   */
  onInstallAborted?: () => void;
  /**
   * 받아둔 인스톨러가 디스크에 실재하는지(기본 fs.existsSync 주입).
   *
   * 실기기 검증(2026-08-07)에서 발견: 파일이 사라진 상태로 설치를 누르면 **앱이 그냥 꺼지고 아무
   * 설명이 남지 않는다**. electron-updater 는 경로만 읽고 존재를 확인하지 않은 채 spawn 하는데,
   * spawn 실패는 비동기라 `install()` 은 이미 성공을 반환하고 `app.quit()` 이 예약되기 때문이다.
   * 앱이 죽어버리면 이 모듈의 실패 처리(에러 표시·재시도·표식 롤백)가 개입할 여지가 없다 —
   * **종료 전에** 막아야 한다. 백신 격리로 실제로 흔한 시나리오다.
   */
  installerExists?: (filePath: string) => boolean;
  /**
   * 업데이터 캐시(받아둔 인스톨러·blockmap·update-info)를 비운다.
   *
   * **체크섬 실패에서만** 호출한다. 실기기 검증(2026-08-07)에서 차등 다운로드가 어긋난 캐시로
   * 손상된 인스톨러를 만들어냈고(크기 2바이트 차이 + sha512 불일치) 검증이 이를 거부했는데,
   * 손상된 파일이 캐시에 남아 **다음 시도를 계속 오염**시킬 수 있었다. 체크섬이 틀렸다는 건
   * 디스크의 것을 믿을 수 없다는 뜻이므로 지우고 새로 받는 것이 유일한 회복이다.
   * 네트워크 오류 등 다른 실패에는 호출하지 않는다 — 부분 다운로드 재개 여지를 없앨 이유가 없다.
   */
  clearUpdaterCache?: () => void;
  /**
   * 캐시에 staged 된 인스톨러 정보를 읽는다(`pending/update-info.json` + 파일 실재 확인).
   * 없거나 읽을 수 없으면 null. fs 접근은 주입해 이 모듈을 순수하게 유지한다.
   */
  readPendingUpdate?: () => PendingUpdateLike | null;
  /**
   * `pending/` 만 비운다. 캐시 **루트**의 installer.exe / current.blockmap 은 차등 다운로드
   * 기준본이므로 건드리지 않는다(QA24 B-L1).
   */
  clearPendingUpdate?: () => void;
  now?: () => number;
}

/**
 * `quitAndInstall` 호출 후 앱 종료를 기다리는 유예 시간.
 *
 * electron-updater 의 `quitAndInstall` 은 실패해도 **throw 하지 않는다** — `BaseUpdater.install`
 * 이 인스톨러 경로/다운로드 정보 부재 시 `dispatchError` 후 `false` 를 반환하고, quitAndInstall
 * 은 `app.quit()` 을 호출하지 않은 채 조용히 리턴한다. 따라서 try/catch 로는 실패를 알 수 없어,
 * "이 시간 안에 종료되지 않았으면 실패"로 판정한다. 정상 경로에서는 before-quit 의 flush(이미
 * 완료라 skip)+ollama stop 뒤 곧바로 종료되므로 이 타이머는 발화하지 않는다.
 */
export const INSTALL_QUIT_GRACE_MS = 15000;

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

/**
 * 피드 파일 목록에서 **설치 대상 exe** 를 고른다 — electron-updater 의 findFile 과 같은 규칙.
 *
 * QA26(A-Low): 종전에는 `files[0]` 을 썼다. 현재는 win-x64 단일 타깃이라 일치하지만, arm64 를
 * 추가하거나 web installer 가 latest.yml 에 함께 실리면 첫 항목이 설치 대상이 아닐 수 있다.
 * 그러면 sha512 대조가 엉뚱한 파일과 이뤄져 복원 판정이 뒤집힌다(NsisUpdater.js:33 이 쓰는
 * findFile(files, 'exe') 와 같은 기준으로 맞춘다 — url 이 없는 피드에서는 종전대로 첫 항목).
 */
export function pickInstallerFile(
  files: { url?: string; sha512?: string }[] | undefined,
): { url?: string; sha512?: string } | undefined {
  if (!files || files.length === 0) return undefined;
  const exes = files.filter((f) => typeof f.url === 'string' && f.url.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return files[0]; // url 미제공 피드 — 종전 동작 유지
  return exes.find((f) => f.url!.includes(process.arch)) ?? exes[0];
}

export function createUpdaterService(deps: UpdaterDeps): UpdaterService {
  const now = deps.now ?? (() => Date.now());
  const supported = deps.isPackaged && deps.platform === 'win32';
  let state = createInitialState(deps.currentVersion, supported);
  let lastCheckedAt: number | null = null;
  // quitAndInstall 은 되돌릴 수 없다 — 연타/중복 호출로 인스톨러가 두 번 spawn 되지 않도록 가드.
  let installing = false;
  // 설치 무산 감지 타이머(INSTALL_QUIT_GRACE_MS). 정상 경로에서는 앱이 먼저 죽어 발화하지 않는다.
  let installAbortTimer: ReturnType<typeof setTimeout> | null = null;
  // update-downloaded 가 알려준 실제 인스톨러 경로. 설치 직전 존재 확인용(없으면 확인 생략).
  let downloadedFilePath: string | null = null;
  /**
   * **이 프로세스에서** 다운로드 경로를 거쳤는가.
   *
   * QA26(A-Critical): 복원 분기가 디스크만 보고 상태를 downloaded 로 올리는데, electron-updater
   * 의 `installerPath` 는 `downloadedUpdateHelper.file` 이고 그 헬퍼는 **`executeDownload` 안의
   * `getOrCreateDownloadHelper()` 에서만** 생성된다(AppUpdater.js:542-556, 호출부 585 한 곳).
   * 확인 경로는 헬퍼를 만들지 않으므로, 다운로드를 거치지 않은 프로세스에서 quitAndInstall 을
   * 부르면 `install()` 이 installerPath==null 로 dispatchError 후 false 를 반환한다
   * (BaseUpdater.js:38-53). 그 error 는 리듀서에서 downloaded+errorKey 로 되돌아가는데
   * (update-policy.ts:266-268 — QA19/QA23 이 "설치 대기분을 에러로 잃지 않는다"고 만든 방어),
   * downloaded 에서는 canDownload·canCheck 가 모두 false 라 **재기동해도 반복되는 영구 고착**이
   * 된다. 패치 전에는 "다운로드" 버튼이 캐시를 재사용해 즉시 정상 경로로 합류시켜 주었는데,
   * 그 버튼을 없앤 것이 곧 유일한 회복 경로를 없앤 것이었다.
   */
  let downloadedThisProcess = false;

  /**
   * 실패를 상태에 반영한다. 체크섬 실패면 손상된 캐시를 함께 비운다(위 clearUpdaterCache 주석).
   * 정리 실패는 삼킨다 — best-effort 이고, 여기서 throw 하면 실패 표면화 자체를 잃는다.
   */
  function applyError(errorKey: string): void {
    // QA24(A-M3): 종전에는 errorKey 만 보고 캐시를 지웠다. classifyUpdateError 는
    // /sha512|checksum|integrity|signature/ 에 걸리는 **모든** 에러를 updateChecksum 으로
    // 분류하므로, 이미 정상적으로 받아둔(downloaded) 상태에서 서명·무결성 문구를 포함한 error
    // 이벤트가 한 번 흘러도 캐시가 통째로 지워졌다 — 리듀서는 downloaded 를 유지하니 UI 는
    // "설치 준비됨" 인데 디스크에는 인스톨러가 없고, 설치를 누르면 installer-missing 에 착지한다.
    // 이 수정의 의도는 "다운로드 과정의 체크섬 실패로 **손상본이 캐시에 남는 것**" 이었다.
    // 반대로 downloaded/installing 은 **검증을 통과한 인스톨러를 디스크에 들고 있는** 상태이므로
    // 여기서 지우면 멀쩡한 것을 없애는 셈이다(installing 중 error 는 downloaded 로 복귀하고,
    // 그때 인스톨러가 그대로 있어야 재시도가 성립한다). 그 둘만 제외한다.
    if (errorKey === 'updateChecksum' && state.status !== 'downloaded' && state.status !== 'installing') {
      try {
        deps.clearUpdaterCache?.();
      } catch (err) {
        console.error('[update] updater cache 정리 실패:', err);
      }
    }
    apply({ type: 'error', errorKey });
  }

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
      const version = String(info?.version ?? '');
      // 실기기 검증(2026-08-20): 다운로드를 마치고 설치를 누르지 않은 채 앱을 껐다 켜면
      // 상태가 처음부터 다시 시작해 **"다운로드" 버튼**이 떴다 — 검증까지 끝난 인스톨러가
      // pending/ 에 그대로 있는데도. 실손해는 없지만(재클릭 시 electron-updater 가 캐시를
      // 재사용해 즉시 끝난다) UI 가 필요한 작업량을 과장한다. 디스크를 보고 상태를 복원한다.
      //
      // QA26(A-Low): 판정을 **먼저** 하고 상태를 한 번만 낸다. 종전에는 available 을 낸 뒤
      // downloaded 를 덧씌워 같은 틱에 브로드캐스트가 2건 나갔고, IPC 는 별개 태스크로 전달되어
      // React 자동 배칭이 묶지 않으므로 "다운로드" 배너가 한 프레임 그려졌다 교체될 수 있었다.
      const pending = deps.readPendingUpdate?.() ?? null;
      const usable = isPendingUpdateUsable(pending, pickInstallerFile(info?.files)?.sha512);
      if (usable) {
        downloadedFilePath = pending!.filePath;
        apply({ type: 'downloaded', version });
      } else {
        apply({ type: 'available', version });
      }
    });
    deps.autoUpdater.on('update-not-available', () => {
      apply({ type: 'not-available' });
      // 최신 버전을 쓰고 있다는 것이 확정된 시점 = staged 인스톨러가 쓸모없어진 시점이다.
      // 설치 직후가 아니라 다음 기동이라 파일 잠금(EBUSY)도 없다. 루트의 차등 기준본은
      // 건드리지 않는다(QA24 B-L1) — 지우면 이후 매번 전량 다운로드가 된다.
      // status 를 다시 보지 않는다 — canCheck 이 downloaded/downloading 중의 재확인을 막으므로
      // 이 핸들러에 도달했다는 것 자체가 "최신을 쓰고 있다"는 뜻이다. 조건을 덧붙이면 절대
      // 거짓이 되지 않는 죽은 가드가 되고, 그것을 지키는 테스트도 공허해진다(QA25 교훈).
      // QA26(A-Low): 릴리즈 회수·CDN 캐시로 구버전 latest.yml 이 응답되면 방금 받은 인스톨러가
      // 삭제된다. 데이터 손실은 아니고 재다운로드로 회복되지만, **이 프로세스에서 받은 것**은
      // 사용자가 곧 설치할 물건이므로 보수적으로 남긴다(다음 기동에서 정리된다).
      if (!downloadedThisProcess && deps.readPendingUpdate?.() != null) {
        try {
          deps.clearPendingUpdate?.();
        } catch (err) {
          console.error('[update] pending 정리 실패:', err);
        }
      }
    });
    deps.autoUpdater.on('download-progress', (progress) => {
      apply({ type: 'progress', percent: Number(progress?.percent ?? 0) });
    });
    deps.autoUpdater.on('update-downloaded', (info) => {
      // 설치 직전 존재 확인에 쓸 실제 파일 경로를 보관(없으면 확인을 건너뛴다 — 아래 install 참조).
      downloadedFilePath = typeof info?.downloadedFile === 'string' ? info.downloadedFile : null;
      // 이 이벤트는 실제 다운로드와 캐시 재사용 양쪽에서 온다 — 어느 쪽이든 electron-updater 의
      // downloadedUpdateHelper 가 채워졌다는 뜻이므로 설치가 가능한 상태다.
      downloadedThisProcess = true;
      apply({ type: 'downloaded', version: String(info?.version ?? state.newVersion ?? '') });
    });
    deps.autoUpdater.on('error', (err) => {
      // QA23(B-MED/B-MED): 설치 시도 중 도착한 error 는 **설치 무산의 즉시 신호**다.
      // electron-updater 는 인스톨러 경로 부재 등에서 dispatchError 를 t≈0 에 발화하는데,
      // 이전에는 15초 백스톱 타이머만 롤백을 수행해 그 사이 창 X 닫기가 flush 표식을 타고
      // 종료 flush 를 우회했다(실데이터 손실). 신호가 오면 기다리지 않는다.
      if (installing) finishAbortedInstall();
      applyError(classifyUpdateError(err));
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
      applyError(classifyUpdateError(err));
    }
    return state;
  }

  async function download(): Promise<UpdateState> {
    // newVersion 을 반드시 함께 넘긴다 — QA19(C-LOW)가 정책으로 열어둔 "실패 후 재확인 없이
    // 재시도" 는 `status==='error' && newVersion!==null` 이 조건인데, 인자를 빠뜨리면 기본값
    // null 때문에 **항상 false** 가 되어 재시도 버튼이 조용히 죽는다(2026-08-07 실기기 발견:
    // 다운로드 실패 후 "다시 시도" 를 눌러도 아무 반응이 없었다). 정책·UI 는 있는데 배선만 닫혀
    // 있던 형태.
    if (!supported || !canDownload(state.status, state.newVersion)) return state;
    // QA24(A-M2/B-M4): 새 다운로드를 시작하는 순간 직전 경로는 무효다. 종전에는 이 값이
    // update-downloaded 에서만 세팅되고 **어디에서도 null 로 되돌지 않아**, 아래 고착 방어
    // 경로(이벤트 없이 downloaded 확정)를 타면 삭제된 옛 경로가 그대로 남았다. 그러면 설치
    // 직전 존재 확인이 옛 경로를 보고 실패해, 재다운로드를 반복해도 영원히 설치할 수 없다
    // (백신이 인스톨러를 격리한 뒤 재시도하는 시나리오에서 실제로 도달 가능).
    downloadedFilePath = null;
    downloadedThisProcess = false;
    apply({ type: 'download-started' });
    try {
      await deps.autoUpdater.downloadUpdate();
      // QA26(A-Critical): 신호는 **이벤트 도착이 아니라 호출 완료**다. downloadedUpdateHelper 는
      // executeDownload 안에서 생성되므로(AppUpdater.js:585) downloadUpdate 가 resolve 했다는
      // 것 자체가 electron-updater 가 설치 가능한 상태라는 뜻이다. 이벤트를 기준으로 삼으면
      // "이벤트 없이 resolve" 하는 고착 방어 경로(QA24 A-M2)에서 설치가 막힌다.
      downloadedThisProcess = true;
      // check 와 동일한 고착 방어. downloadUpdate 의 resolve 는 파일 수신 성공을 뜻하므로
      // (실패는 reject) update-downloaded 이벤트가 없었더라도 완료로 확정한다 — 그러지 않으면
      // 'downloading' 에 갇혀 확인·다운로드·설치가 모두 막힌다.
      if (state.status === 'downloading') {
        apply({ type: 'downloaded', version: state.newVersion ?? '' });
      }
    } catch (err) {
      applyError(classifyUpdateError(err));
    }
    return state;
  }

  /**
   * 설치가 무산됐을 때의 공통 정리(QA23) — 잠금 해제 + 백스톱 타이머 취소 + flush 표식 롤백.
   *
   * 이전에는 이 처리가 15초 타이머 콜백 안에만 있었다. 그래서 ①실패 신호(error 이벤트)가 즉시
   * 와도 15초를 기다렸고 ②정상 설치가 15초를 넘겨 종료되면 타이머가 그대로 발화해 거짓 실패를
   * 브로드캐스트하고 **잠금까지 풀어** 연타 시 인스톨러가 두 번 spawn 될 수 있었다.
   */
  function finishAbortedInstall(): void {
    if (installAbortTimer) {
      clearTimeout(installAbortTimer);
      installAbortTimer = null;
    }
    if (!installing) return;
    installing = false;
    try {
      deps.onInstallAborted?.();
    } catch (err) {
      console.error('[update] onInstallAborted failed:', err);
    }
  }

  async function install(): Promise<UpdateState> {
    if (!supported || !canInstall(state.status) || installing) return state;
    // 종료를 시작하기 **전에** 인스톨러 실재를 확인한다. quitAndInstall 은 파일이 없어도
    // app.quit() 을 예약하므로(spawn 실패는 비동기), 여기서 막지 않으면 앱이 조용히 꺼지고
    // 사용자는 "설치를 눌렀는데 다시 켜니 구버전" 만 겪는다(실기기 검증 2026-08-07).
    // 경로를 못 얻은 경우(downloadedFile 미제공)에는 확인을 건너뛴다 — 확인 불가를 이유로
    // 설치를 막으면 그게 더 나쁜 회귀다.
    if (downloadedFilePath && deps.installerExists && !deps.installerExists(downloadedFilePath)) {
      try {
        deps.onInstallAborted?.(); // flush 표식 롤백 — 설치 대기 상태로 남지 않도록
      } catch (err) {
        console.error('[update] onInstallAborted failed:', err);
      }
      apply({ type: 'installer-missing' });
      return state;
    }
    // QA26(A-Critical): 복원 경로면 electron-updater 의 내부 상태가 비어 있다. 디스크에 파일이
    // 있어도 `downloadedUpdateHelper` 가 null 이라 quitAndInstall 이 즉시 실패하고, 그 실패가
    // downloaded 로 되돌아가면 canDownload·canCheck 가 모두 닫혀 **영구 고착**이 된다.
    //
    // 여기서 downloadUpdate() 를 한 번 태워 정상 경로에 합류시킨다. 캐시가 유효하면
    // getValidCachedUpdateFile 이 sha512 를 재대조한 뒤 곧바로 update-downloaded 를 발화하므로
    // (DownloadedUpdateHelper.js:88-131, AppUpdater.js:592-608) **네트워크 비용이 0** 이다.
    // 덤으로 우리 복원 판정(파일 실재만 확인)보다 강한 검증을 electron-updater 에 위임하게 된다 —
    // 백신이 파일을 0바이트로 만든 경우 등은 여기서 걸러져 재다운로드로 회복된다.
    if (!downloadedThisProcess) {
      apply({ type: 'download-started' }); // 재사용이면 즉시 끝나지만, 실다운로드가 되면 진행률이 필요하다
      try {
        await deps.autoUpdater.downloadUpdate();
        downloadedThisProcess = true; // 호출 완료 = 헬퍼 생성 완료(위 download() 주석 참조)
      } catch (err) {
        applyError(classifyUpdateError(err));
        return state;
      }
      // 캐시가 무효해 재다운로드까지 실패한 경우 — 여기서 멈춘다. 상태는 error 계열이므로
      // canDownload 가 열려 사용자가 재시도할 수 있다(고착되지 않는다).
      if (!downloadedThisProcess) {
        applyError('updateInstallFailed');
        return state;
      }
    }
    installing = true;
    // 설치 구간을 상태로 드러낸다 — 버튼이 "설치 중"으로 바뀌어 재클릭이 조용히 폐기되지 않는다.
    apply({ type: 'install-started' });
    try {
      // 종료 flush 를 먼저 완주시킨다. quitAndInstall 이 유발하는 app.quit() 은 before-quit
      // 핸들러를 거치지만, 그쪽에 의존하면 인스톨러 spawn 과 flush 가 경쟁한다 — 여기서
      // 명시적으로 착지시킨 뒤 넘긴다(before-quit 은 flushedWindows 가드로 중복 flush 안 함).
      await deps.flushBeforeInstall();
    } catch (err) {
      // flush 실패로 업데이트를 막지는 않는다(best-effort) — 종료 경로와 동일 정책.
      console.error('[update] flush before install failed:', err);
    }
    // QA24(B-I2): 위 await 는 창당 최대 2초 열려 있는 구간이다. 그 사이 autoUpdater 의 error 가
    // 도착하면 on('error') 가 finishAbortedInstall() 로 **installing 을 이미 false 로 되돌린다**.
    // 종전에는 그 뒤로도 그대로 quitAndInstall 을 호출했고, 이어서 만드는 백스톱 타이머는
    // `if (!installing) return` 에 걸려 무력화됐다 — 설치 무산을 감지할 주체가 사라진다.
    // 게다가 상태는 downloaded 로 돌아가 있어 canInstall 이 다시 열리므로 사용자가 한 번 더
    // 누르면 install() 재진입 + 두 번째 quitAndInstall 이 된다.
    // 설치가 이미 취소됐다면 여기서 멈춘다(error 핸들러가 상태·표식 롤백을 마쳤다).
    if (!installing) return state;
    try {
      // isSilent=false: NSIS oneClick:false 빌드라 설치 UI 가 필요하다.
      // isForceRunAfter=true: 설치 후 앱을 다시 띄운다("재시작하여 설치"의 멘탈 모델).
      deps.autoUpdater.quitAndInstall(false, true);
      // 실패는 throw 가 아니라 "종료되지 않음"으로 나타난다(INSTALL_QUIT_GRACE_MS 주석 참조).
      // 유예 시간 뒤에도 이 프로세스가 살아있다면 설치가 시작되지 못한 것 — 잠금을 풀어
      // 재시도를 허용하고, flush 표식을 되돌리고, 사용자에게 실패를 표면화한다.
      installAbortTimer = setTimeout(() => {
        installAbortTimer = null;
        if (!installing) return; // 이미 error 신호로 정리됨(QA23) — 거짓 실패를 덧씌우지 않는다.
        finishAbortedInstall();
        applyError('updateInstallFailed');
      }, INSTALL_QUIT_GRACE_MS);
      // 종료를 막지 않도록 unref (Electron 종료 시퀀스가 타이머를 기다리지 않게).
      installAbortTimer.unref?.();
    } catch (err) {
      // 방어적 — 현행 electron-updater 는 여기로 오지 않지만 구현이 바뀔 수 있다.
      finishAbortedInstall();
      applyError(classifyUpdateError(err));
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

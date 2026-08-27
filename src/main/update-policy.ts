/**
 * 자동 업데이트 결정 로직 — 순수 모듈.
 *
 * window-flush-policy.ts 와 동일한 분리 원칙: electron / electron-updater 를 import 하지 않아
 * vitest 의 node 환경에서 직접 테스트할 수 있다. updater.ts 는 여기서 계산된 상태를 브로드캐스트
 * 하고 실제 부작용(네트워크·프로세스 종료)만 담당한다.
 *
 * 여기에 로직을 모으는 이유: 업데이트는 "상태 전이 + 조작 가능 여부"가 전부인데, 이를 이벤트
 * 핸들러 클로저에 흩어두면 (a) 순서가 뒤바뀐 이벤트(late progress, 이미 다운로드된 뒤의 재확인)
 * 와 (b) 조작 재진입(다운로드 중 다시 다운로드)이 무테스트 영역으로 남는다. QA16~18 이 3사이클
 * 연속으로 결함을 낸 창닫기 flush 결정 로직과 같은 구조의 위험이라 처음부터 분리한다.
 */

import type { UpdateState, UpdateStatus } from '../shared/update-types';

/** autoUpdater 이벤트를 정규화한 내부 이벤트 (updater.ts 가 매핑) */
export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'download-started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  /** 설치 요청 접수(QA23) — 실제 종료까지의 구간을 상태로 드러낸다. */
  | { type: 'install-started' }
  /** 받아둔 인스톨러가 사라짐(백신 격리·수동 삭제) — 설치 불가, 재다운로드가 유일한 회복. */
  | { type: 'installer-missing' }
  | { type: 'error'; errorKey: string };

/**
 * 자동 확인 최소 간격. 창을 여러 번 여닫거나 앱을 자주 재시작하는 사용자가 GitHub API 를
 * 불필요하게 반복 호출하지 않도록 프로세스 메모리 기준으로 제한한다(영속 아님 — 재시작하면
 * 다시 1회 확인. 하루 수 회 수준이라 rate limit 여유가 충분하다).
 */
export const AUTO_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 앱 기동 후 자동 확인까지의 지연. 부팅 직후는 Ollama healthCheck·세션 reconcile·렌더러 초기
 * 로드가 겹치는 구간이라, 업데이트 확인의 네트워크·디스크 경합을 피해 뒤로 민다.
 */
export const AUTO_CHECK_STARTUP_DELAY_MS = 8000;

export function createInitialState(currentVersion: string, supported: boolean): UpdateState {
  return {
    status: supported ? 'idle' : 'unsupported',
    currentVersion,
    newVersion: null,
    percent: 0,
    errorKey: null,
  };
}

/**
 * 업데이트가 가능한 실행 환경인지.
 * - 비패키징(dev/preview/E2E)에서는 electron-updater 가 app-update.yml 부재로 즉시 throw 한다.
 * - macOS 는 서명/공증 자격이 없어 릴리즈 빌드 자체가 비활성(release.yml 주석 참조)이라 피드가
 *   존재하지 않는다. 지원 플랫폼이 늘어나면 여기만 고치면 된다.
 */
export function isUpdateSupported(isPackaged: boolean, platform: string): boolean {
  return isPackaged && platform === 'win32';
}

/**
 * 확인을 새로 시작할 수 있는가 — 진행 중(확인/다운로드)이면 재진입 금지.
 *
 * QA19(A·C 수렴): `downloaded` 도 제외한다. 이미 받아둔 설치 대기분이 있는데 재확인하면
 * `check-started` 가 상태를 `checking` 으로 밀어 설치 자격(canInstall)이 사라지고, 오프라인
 * 이면 `error` 로 착지해 **디스크에 인스톨러가 있는데도 설치할 방법이 없어진다**. 설치 대기
 * 중에 재확인해서 얻을 것도 없다(설치하면 그만이고, 더 새 버전은 설치 후 확인된다).
 */
export function canCheck(status: UpdateStatus): boolean {
  return status !== 'unsupported'
    && status !== 'checking'
    && status !== 'downloading'
    && status !== 'downloaded'
    // 설치 진행 중 확인은 무의미하고(곧 종료된다) 상태를 덮어 설치 자격을 잃게 만든다.
    && status !== 'installing';
}

/**
 * 다운로드를 시작할 수 있는가.
 * QA19(C-LOW): 다운로드 실패(error) 후에도 확인된 버전이 남아 있으면 재시도를 허용한다 —
 * 리듀서가 newVersion 을 보존하는 이유가 "재확인 없이 재시도"인데 게이트가 그것을 막고 있었다.
 */
export function canDownload(status: UpdateStatus, newVersion: string | null = null): boolean {
  if (status === 'available') return true;
  return status === 'error' && newVersion !== null;
}

/**
 * 재시작+설치가 가능한가 — 다운로드가 끝난 상태에서만.
 * `installing` 은 제외한다: 진행 중 재클릭은 인스톨러 이중 spawn 위험이 있고, 이제는 상태가
 * UI 에 드러나므로(설치 중 표시) 조용히 폐기되는 클릭도 없다(QA23 B-MED).
 */
export function canInstall(status: UpdateStatus): boolean {
  return status === 'downloaded';
}

export interface AutoCheckInput {
  isPackaged: boolean;
  platform: string;
  /** 설정의 autoCheckUpdates */
  enabled: boolean;
  /** 이번 프로세스에서 마지막으로 확인한 시각 (없으면 null) */
  lastCheckedAt: number | null;
  now: number;
}

/** 자동(비수동) 확인을 실행할지. 수동 "지금 확인"은 이 게이트를 거치지 않는다. */
export function shouldAutoCheck({ isPackaged, platform, enabled, lastCheckedAt, now }: AutoCheckInput): boolean {
  if (!enabled) return false;
  if (!isUpdateSupported(isPackaged, platform)) return false;
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= AUTO_CHECK_MIN_INTERVAL_MS;
}

/**
 * 업데이트 실패 errorKey 전체 집합 — i18n 사전과의 계약 단일 출처.
 *
 * ai-service / ollama-manager 의 errorKey 는 문자열 리터럴 우변이라 i18n drift 가드
 * (i18n.test.ts)가 소스 스캔으로 잡지만, 본 모듈은 분류 함수의 **반환값**이라 그 정규식에
 * 걸리지 않는다. 배열로 export 해 테스트가 런타임으로 대조하게 한다(번역 누락 시 사용자는
 * `mainerr.updateNetwork` 같은 raw 키를 보게 되므로 가드가 필요).
 */
export const UPDATE_ERROR_KEYS = [
  'updateNetwork',
  'updateNoFeed',
  'updateChecksum',
  'updateUnknown',
  /** QA19(A-MED): quitAndInstall 이 앱을 종료시키지 못했다 — 인스톨러 유실/차단 추정. */
  'updateInstallFailed',
  /**
   * 받아둔 인스톨러 파일이 사라졌다(백신 격리·수동 삭제·캐시 정리).
   *
   * 실기기 검증(2026-08-07)에서 발견: electron-updater 는 경로만 읽고 **존재를 확인하지 않은 채**
   * spawn 하는데 실패가 비동기라 `app.quit()` 이 이미 예약된다 → **앱이 그냥 꺼지고 아무 설명이
   * 남지 않았다**(다시 켜면 구버전). 종료 전에 우리가 막고 이 사유를 남긴다.
   */
  'updateInstallerMissing',
] as const;
export type UpdateErrorKey = typeof UPDATE_ERROR_KEYS[number];

/**
 * 실패 원인을 구조화 errorKey 로 분류. renderer 는 `mainerr.{key}` 로 번역한다.
 * (ai-service 의 errorKey 규약과 동일 — 영어 UI 에 한국어/영문 원문이 새는 경로 차단)
 */
export function classifyUpdateError(message: unknown): UpdateErrorKey {
  const text = (message instanceof Error ? message.message : String(message ?? '')).toLowerCase();
  if (/enotfound|econnrefused|etimedout|enetunreach|eai_again|network|getaddrinfo|socket hang up/.test(text)) {
    return 'updateNetwork';
  }
  // 릴리즈에 latest.yml 이 없거나(자산 업로드 누락) 저장소가 비공개로 바뀐 경우.
  if (/404|not found|cannot find|latest\.yml|no published versions/.test(text)) {
    return 'updateNoFeed';
  }
  // 다운로드 파일이 피드의 해시와 불일치 — 전송 손상 또는 자산 교체.
  if (/sha512|checksum|integrity|signature/.test(text)) {
    return 'updateChecksum';
  }
  return 'updateUnknown';
}

/** 진행률 정규화 — 비정상값(NaN/음수/100 초과)은 버리고 정수로 절단. */
function normalizePercent(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.floor(value);
}

/**
 * 상태 리듀서. 항상 새 객체를 반환하지 않고, 실질 변화가 없으면 **동일 참조**를 반환해
 * updater.ts 가 불필요한 브로드캐스트(다운로드 중 초당 수십 회)를 건너뛸 수 있게 한다.
 */
export function nextUpdateState(prev: UpdateState, event: UpdateEvent): UpdateState {
  // 지원하지 않는 환경에서는 어떤 이벤트도 상태를 바꾸지 않는다(방어 — 이 경로는 애초에
  // autoUpdater 를 wire 하지 않으므로 도달하지 않아야 한다).
  if (prev.status === 'unsupported') return prev;

  // QA24(B-I1): 'installing' 은 종착지다 — 이 구간에 도착하는 확인·다운로드 계열 이벤트는
  // 모두 무시한다. 개별 case 마다 가드를 흩어 놓으면 새 이벤트 타입이 생길 때 형제 누락이
  // 반복되므로(이 프로젝트의 최다 결함 클래스) 진입부에서 한 번에 막는다. 설치 구간을 빠져나오는
  // 길은 'error'(설치 무산 → downloaded 복귀)와 프로세스 종료 둘뿐이다.
  if (prev.status === 'installing' && event.type !== 'error') return prev;

  switch (event.type) {
    case 'check-started':
      if (prev.status === 'checking') return prev;
      // QA19(A·C 수렴, 설치 어포던스 상실): 다운로드 완료 상태는 확인이 시작돼도 유지한다.
      // 이 가드가 없으면 상태가 먼저 'checking' 으로 밀려, 아래 'available' 케이스의
      // "downloaded 유지" 방어가 prev 를 이미 'checking' 으로 보게 되어 **도달 불가능**해진다
      // (실제 이벤트 순서가 check-started → available 이기 때문). canCheck 가 downloaded 를
      // 막으므로 정상 경로로는 도달하지 않지만, 외부 트리거(자동 확인 경쟁 등) 대비 이중 방어.
      if (prev.status === 'downloaded') return prev;
      return { ...prev, status: 'checking', percent: 0, errorKey: null };

    case 'available': {
      // QA24(B-M1): 빈 버전 문자열은 null 로 정규화한다. 종전에는 `newVersion: ''` 가 저장돼
      // 재시도 자격 판정이 층마다 갈렸다 — canDownload 는 `!== null` 이라 열리는데, 배너와
      // 설정 패널은 진리값(`!!version`)이라 닫혀서 **정책은 동작하는데 버튼이 없는** 상태가
      // 됐다(ec7fe9a[1] 이 고친 "정책은 열려 있고 배선이 닫힘" 과 같은 클래스). 저장 시점에
      // 한 번만 정규화해 세 층이 같은 값을 보게 한다. 배너 자체는 버전이 없어도 뜨고 문구만
      // 폴백한다(QA19 D-LOW 정책 유지).
      const version = event.version || null;
      // 이미 받아둔 버전과 같은 버전의 재확인(수동 확인 등)은 다운로드 완료 상태를 유지한다.
      // 그러지 않으면 "재시작하여 설치" 버튼이 사라지고 사용자가 같은 파일을 다시 받게 된다.
      if (prev.status === 'downloaded' && prev.newVersion === version) return prev;
      // 다운로드 중 같은 버전의 available 이 다시 오면(연속 확인) 진행 중인 다운로드를 유지.
      if (prev.status === 'downloading' && prev.newVersion === version) return prev;
      return { ...prev, status: 'available', newVersion: version, percent: 0, errorKey: null };
    }

    case 'not-available':
      return { ...prev, status: 'not-available', newVersion: null, percent: 0, errorKey: null };

    case 'download-started':
      if (prev.status === 'downloading') return prev;
      return { ...prev, status: 'downloading', percent: 0, errorKey: null };

    case 'progress': {
      // 완료 후 도착한 지각 progress 는 무시 — 'downloaded' 를 되돌리면 설치 버튼이 사라진다.
      if (prev.status === 'downloaded') return prev;
      // QA24(B-I1): error·installing 도 같은 이유로 역행시키지 않는다. 종전에는 downloaded 만
      // 방어해, 다운로드 실패(reject) 직후 지각 progress 가 도착하면 status 가 'downloading' 으로
      // 되돌아갔다. 그런데 downloading 은 canCheck·canDownload·canInstall **세 게이트가 전부
      // 닫힌** 상태이고, 이 시점엔 진행 중인 다운로드가 없어 완료 이벤트도 오지 않는다
      // → 앱 재시작 전까지 업데이트 기능 전체가 사망한다(QA18 의 "IPC 타임아웃 자멸" 과 동형).
      // check/download 에는 고착 방어 폴백이 있는데 progress 역행에만 대응이 없었다.
      // 재시도는 반드시 download-started 를 먼저 거치므로 정상 경로는 막히지 않는다.
      if (prev.status === 'error' || prev.status === 'installing') return prev;
      const percent = normalizePercent(event.percent, prev.percent);
      if (prev.status === 'downloading' && percent === prev.percent) return prev;
      return { ...prev, status: 'downloading', percent, errorKey: null };
    }

    case 'downloaded': {
      // QA24(B-I1): 설치 구간은 종착지다. 설치 중 지각 downloaded 가 오면 설치 버튼이 되살아나고,
      // 그 클릭은 updater 의 installing 불리언에 조용히 폐기된다(QA23 B-MED 가 없앤 클래스의 부활).
      // (진입부 가드가 이미 막지만, 이 케이스만 따로 읽는 사람을 위해 남긴다.)
      if (prev.status === 'installing') return prev;
      const version = event.version || null; // QA24(B-M1): available 과 동일 정규화
      if (prev.status === 'downloaded' && prev.newVersion === version) return prev;
      return { ...prev, status: 'downloaded', newVersion: version, percent: 100, errorKey: null };
    }

    case 'install-started':
      // 설치 요청 ~ 실제 종료 사이의 구간을 상태로 표현한다(QA23 B-MED). 이게 없으면 UI 가
      // "설치 준비됨" 그대로라 사용자가 버튼을 다시 누르고, 그 클릭은 내부 잠금에 조용히 폐기된다.
      if (prev.status !== 'downloaded') return prev; // canInstall 과 동일 전제
      return { ...prev, status: 'installing', errorKey: null };

    case 'installer-missing':
      // 다른 실패와 달리 **downloaded 를 유지하면 안 된다** — 디스크에 인스톨러가 없으므로 설치
      // 버튼을 남겨두면 눌러도 같은 실패를 반복한다. newVersion 은 보존해 canDownload 가 열리고
      // (재확인 없이) 재다운로드로 회복할 수 있게 한다.
      return { ...prev, status: 'error', percent: 0, errorKey: 'updateInstallerMissing' };

    case 'error':
      if (prev.status === 'error' && prev.errorKey === event.errorKey) return prev;
      // QA19: 설치 대기분은 에러로도 잃지 않는다. 백그라운드 확인 실패나 설치 시작 실패가
      // 이미 받아둔 인스톨러의 설치 자격까지 회수하면 사용자는 재다운로드 외에 길이 없다.
      // status 는 downloaded 로 유지하되 errorKey 는 실어 보내, UI 가 "설치 가능 + 직전 실패
      // 사유"를 함께 보여줄 수 있게 한다(설치 시작 실패를 무음으로 삼키지 않기 위함).
      // QA23: 설치 시도(installing)가 실패한 경우도 같은 이유로 downloaded 로 **되돌린다** —
      // 인스톨러는 디스크에 그대로 있으므로 재시도가 유일하게 합리적인 다음 행동이다.
      if (prev.status === 'downloaded' || prev.status === 'installing') {
        if (prev.status === 'downloaded' && prev.errorKey === event.errorKey) return prev;
        return { ...prev, status: 'downloaded', errorKey: event.errorKey };
      }
      // newVersion 은 보존 — 다운로드 실패 후 사용자가 어떤 버전을 시도했는지 표시하고,
      // 재확인 없이 재시도할 수 있게 한다.
      return { ...prev, status: 'error', percent: 0, errorKey: event.errorKey };

    default:
      return prev;
  }
}

/**
 * 캐시에 staged 된 인스톨러의 최소 정보(`pending/update-info.json` + 파일 실재).
 * sha512 는 electron-updater 가 쓰는 것과 같은 값이라 그대로 대조할 수 있다.
 */
export interface PendingUpdateLike {
  sha512: string;
  filePath: string;
}

/**
 * 지금 제안된 업데이트가 **이미 디스크에 받아져 있는가**.
 *
 * 실기기 검증(2026-08-20)에서 발견: 다운로드를 마친 뒤 설치를 누르지 않고 앱을 종료하면,
 * 다음 기동에서 상태가 처음부터 다시 시작해 **"다운로드" 버튼**이 뜬다. 105MB 짜리 검증된
 * 인스톨러가 `pending/` 에 그대로 있는데도 그렇다 — `downloadedFilePath` 가 `update-downloaded`
 * 이벤트에서만 채워지고, 기동 시 디스크를 보는 경로가 없었기 때문이다.
 *
 * 실제 손해는 없다(electron-updater 의 DownloadedUpdateHelper 가 sha512 를 대조해 캐시를
 * 재사용하므로 다시 눌러도 즉시 끝난다 — 실기기에서 확인). 문제는 **UI 가 필요한 작업량을
 * 과장**한다는 것이다: 종량제 회선이라면 "또 100MB 를 받아야 하나" 하고 주저하게 된다.
 *
 * 판정은 electron-updater 와 같은 기준(sha512 일치)을 쓴다. 파일명에서 버전을 파싱하지 않는다 —
 * 파일명 규칙은 electron-builder 설정에 딸린 것이라 바뀔 수 있고, sha512 가 훨씬 강한 신호다.
 */
export function isPendingUpdateUsable(
  pending: PendingUpdateLike | null | undefined,
  offeredSha512: string | null | undefined,
): boolean {
  if (!pending || !pending.sha512 || !offeredSha512) return false;
  return pending.sha512 === offeredSha512;
}

/**
 * 설치 직전 인스톨러 사전 판정에 쓰는 디스크 관측치.
 *
 * fs 접근은 호출측(index.ts)이 하고 판정만 여기서 한다 — 이 모듈을 순수하게 유지한다.
 */
export interface InstallerProbe {
  exists: boolean;
  /** 바이트 크기. */
  size: number;
  /** 파일 선두 2바이트를 latin1 로 읽은 것(PE 실행 파일이면 'MZ'). 읽지 못했으면 ''. */
  magic: string;
}

/**
 * 정상 NSIS 인스톨러의 하한. 실측 ~105MB 이므로 1MB 는 오검출 여지가 사실상 없는 보수적 값이다.
 */
export const MIN_INSTALLER_BYTES = 1_000_000;

/**
 * 받아둔 인스톨러를 **실행할 수 있는가** 를 종료 전에 판정한다.
 *
 * QA28 실기기 검증(2026-08-27): 종전 가드는 `existsSync` 뿐이라 "존재하면 실행된다" 를 전제했는데
 * 그게 거짓이었다. 인스톨러를 **0바이트로 비우고** 설치를 누르자 가드를 통과한 뒤 quitAndInstall
 * 이 spawn 성공을 가정하고 `app.quit()` 을 예약해 **앱이 조용히 꺼졌다**(spawn 실패는 비동기라
 * 그때는 이미 프로세스가 없고, 15초 백스톱 타이머도 함께 죽어 실패를 표면화할 주체가 사라진다).
 * v1.0.0 이 닫은 것은 "파일이 사라진 경우" 뿐이고, 백신 격리는 삭제 외에 **0바이트/스텁 대체**로도
 * 흔히 일어난다.
 *
 * 해시 재계산은 105MB 를 다시 훑어야 하므로 사전 검사로는 과하다. 크기 하한 + PE 매직 두 가지면
 * 실행 불가 파일을 사실상 전부 거른다(updater 는 win32 패키징에서만 supported 라 PE 로 단정 가능).
 */
export function isInstallerUsable(probe: InstallerProbe | null | undefined): boolean {
  if (!probe || !probe.exists) return false;
  if (probe.magic !== 'MZ') return false;
  return probe.size >= MIN_INSTALLER_BYTES;
}

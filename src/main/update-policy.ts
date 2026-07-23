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

/** 확인을 새로 시작할 수 있는가 — 진행 중(확인/다운로드)이면 재진입 금지. */
export function canCheck(status: UpdateStatus): boolean {
  return status !== 'unsupported' && status !== 'checking' && status !== 'downloading';
}

/** 다운로드를 시작할 수 있는가 — 확인 결과 새 버전이 있는 상태에서만. */
export function canDownload(status: UpdateStatus): boolean {
  return status === 'available';
}

/** 재시작+설치가 가능한가 — 다운로드가 끝난 상태에서만. */
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
 * ai-service / ollama-manager 의 errorKey 는 `errorKey: 'x'` 리터럴이라 i18n drift 가드
 * (i18n.test.ts)가 소스 스캔으로 잡지만, 본 모듈은 분류 함수의 **반환값**이라 그 정규식에
 * 걸리지 않는다. 배열로 export 해 테스트가 런타임으로 대조하게 한다(번역 누락 시 사용자는
 * `mainerr.updateNetwork` 같은 raw 키를 보게 되므로 가드가 필요).
 */
export const UPDATE_ERROR_KEYS = ['updateNetwork', 'updateNoFeed', 'updateChecksum', 'updateUnknown'] as const;
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

  switch (event.type) {
    case 'check-started':
      if (prev.status === 'checking') return prev;
      return { ...prev, status: 'checking', percent: 0, errorKey: null };

    case 'available':
      // 이미 받아둔 버전과 같은 버전의 재확인(수동 확인 등)은 다운로드 완료 상태를 유지한다.
      // 그러지 않으면 "재시작하여 설치" 버튼이 사라지고 사용자가 같은 파일을 다시 받게 된다.
      if (prev.status === 'downloaded' && prev.newVersion === event.version) return prev;
      // 다운로드 중 같은 버전의 available 이 다시 오면(연속 확인) 진행 중인 다운로드를 유지.
      if (prev.status === 'downloading' && prev.newVersion === event.version) return prev;
      return { ...prev, status: 'available', newVersion: event.version, percent: 0, errorKey: null };

    case 'not-available':
      return { ...prev, status: 'not-available', newVersion: null, percent: 0, errorKey: null };

    case 'download-started':
      if (prev.status === 'downloading') return prev;
      return { ...prev, status: 'downloading', percent: 0, errorKey: null };

    case 'progress': {
      // 완료 후 도착한 지각 progress 는 무시 — 'downloaded' 를 되돌리면 설치 버튼이 사라진다.
      if (prev.status === 'downloaded') return prev;
      const percent = normalizePercent(event.percent, prev.percent);
      if (prev.status === 'downloading' && percent === prev.percent) return prev;
      return { ...prev, status: 'downloading', percent, errorKey: null };
    }

    case 'downloaded':
      if (prev.status === 'downloaded' && prev.newVersion === event.version) return prev;
      return { ...prev, status: 'downloaded', newVersion: event.version, percent: 100, errorKey: null };

    case 'error':
      if (prev.status === 'error' && prev.errorKey === event.errorKey) return prev;
      // newVersion 은 보존 — 다운로드 실패 후 사용자가 어떤 버전을 시도했는지 표시하고,
      // 재확인 없이 재시도할 수 있게 한다.
      return { ...prev, status: 'error', percent: 0, errorKey: event.errorKey };

    default:
      return prev;
  }
}

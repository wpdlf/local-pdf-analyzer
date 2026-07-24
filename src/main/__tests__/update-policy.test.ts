import { describe, it, expect } from 'vitest';
import {
  AUTO_CHECK_MIN_INTERVAL_MS,
  canCheck,
  canDownload,
  canInstall,
  classifyUpdateError,
  createInitialState,
  isUpdateSupported,
  nextUpdateState,
  shouldAutoCheck,
} from '../update-policy';
import type { UpdateState } from '../../shared/update-types';

// 자동 업데이트 결정 로직(순수) 검증. window-flush-policy.test 와 동일 성격 —
// 상태 전이·게이트를 electron 없이 전수로 고정해 두면, 배선(updater.ts)이 바뀌어도
// "언제 무엇을 할 수 있는가"는 회귀하지 않는다.

const base = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle',
  currentVersion: '1.0.0',
  newVersion: null,
  percent: 0,
  errorKey: null,
  ...over,
});

describe('isUpdateSupported', () => {
  it('패키징 + win32 에서만 true', () => {
    expect(isUpdateSupported(true, 'win32')).toBe(true);
    expect(isUpdateSupported(false, 'win32')).toBe(false);
    expect(isUpdateSupported(true, 'darwin')).toBe(false);
    expect(isUpdateSupported(true, 'linux')).toBe(false);
  });
});

describe('createInitialState', () => {
  it('미지원 환경은 unsupported 로 시작', () => {
    expect(createInitialState('1.2.3', false)).toEqual({
      status: 'unsupported', currentVersion: '1.2.3', newVersion: null, percent: 0, errorKey: null,
    });
  });

  it('지원 환경은 idle 로 시작', () => {
    expect(createInitialState('1.2.3', true).status).toBe('idle');
  });
});

describe('조작 게이트', () => {
  it('canCheck — 진행 중(확인/다운로드)과 미지원에서 false', () => {
    expect(canCheck('idle')).toBe(true);
    expect(canCheck('not-available')).toBe(true);
    expect(canCheck('available')).toBe(true);
    expect(canCheck('error')).toBe(true);
    expect(canCheck('checking')).toBe(false);
    expect(canCheck('downloading')).toBe(false);
    expect(canCheck('unsupported')).toBe(false);
    // downloaded 는 아래 QA19 케이스에서 별도 고정(설치 대기 보호).
  });

  it('canCheck — downloaded 제외 (QA19: 재확인이 설치 대기 상태를 파괴하던 회귀)', () => {
    expect(canCheck('downloaded')).toBe(false);
  });

  it('canDownload — available, 그리고 버전이 남은 error(재시도)에서 true', () => {
    expect(canDownload('available')).toBe(true);
    expect(canDownload('error', '1.1.0')).toBe(true);
    // 확인된 버전이 없는 error 는 무엇을 받을지 모르므로 불가 — 재확인이 선행돼야 한다.
    expect(canDownload('error', null)).toBe(false);
    for (const s of ['idle', 'checking', 'not-available', 'downloading', 'downloaded', 'unsupported'] as const) {
      expect(canDownload(s, '1.1.0'), s).toBe(false);
    }
  });

  it('canInstall — downloaded 에서만 true', () => {
    expect(canInstall('downloaded')).toBe(true);
    for (const s of ['idle', 'checking', 'available', 'not-available', 'downloading', 'error', 'unsupported'] as const) {
      expect(canInstall(s), s).toBe(false);
    }
  });
});

describe('shouldAutoCheck', () => {
  const ok = { isPackaged: true, platform: 'win32', enabled: true, lastCheckedAt: null, now: 1_000_000 };

  it('설정 ON + 지원 환경 + 최초면 확인한다', () => {
    expect(shouldAutoCheck(ok)).toBe(true);
  });

  it('설정 OFF 면 확인하지 않는다', () => {
    expect(shouldAutoCheck({ ...ok, enabled: false })).toBe(false);
  });

  it('비패키징(dev/E2E)·비-Windows 는 확인하지 않는다 — 네트워크 호출 0', () => {
    expect(shouldAutoCheck({ ...ok, isPackaged: false })).toBe(false);
    expect(shouldAutoCheck({ ...ok, platform: 'darwin' })).toBe(false);
  });

  it('최소 간격 이내 재확인은 건너뛴다', () => {
    const now = 10 * AUTO_CHECK_MIN_INTERVAL_MS;
    expect(shouldAutoCheck({ ...ok, lastCheckedAt: now - 1, now })).toBe(false);
    expect(shouldAutoCheck({ ...ok, lastCheckedAt: now - AUTO_CHECK_MIN_INTERVAL_MS + 1, now })).toBe(false);
  });

  it('최소 간격 경과 후에는 다시 확인한다(경계 포함)', () => {
    const now = 10 * AUTO_CHECK_MIN_INTERVAL_MS;
    expect(shouldAutoCheck({ ...ok, lastCheckedAt: now - AUTO_CHECK_MIN_INTERVAL_MS, now })).toBe(true);
  });
});

describe('classifyUpdateError', () => {
  it('네트워크 계열 → updateNetwork', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('updateNetwork');
    expect(classifyUpdateError(new Error('connect ECONNREFUSED 1.2.3.4:443'))).toBe('updateNetwork');
    expect(classifyUpdateError('socket hang up')).toBe('updateNetwork');
  });

  it('피드 부재(404/latest.yml) → updateNoFeed', () => {
    expect(classifyUpdateError(new Error('HttpError: 404 Not Found'))).toBe('updateNoFeed');
    expect(classifyUpdateError(new Error('Cannot find latest.yml in the latest release'))).toBe('updateNoFeed');
  });

  it('무결성 실패 → updateChecksum', () => {
    expect(classifyUpdateError(new Error('sha512 checksum mismatch'))).toBe('updateChecksum');
  });

  it('그 외 / 비-Error 값 → updateUnknown (throw 하지 않음)', () => {
    expect(classifyUpdateError(new Error('something weird'))).toBe('updateUnknown');
    expect(classifyUpdateError(undefined)).toBe('updateUnknown');
    expect(classifyUpdateError(null)).toBe('updateUnknown');
    expect(classifyUpdateError({ nope: 1 })).toBe('updateUnknown');
  });
});

describe('nextUpdateState — 기본 전이', () => {
  it('check-started → checking (이전 에러 표시 해제)', () => {
    const next = nextUpdateState(base({ status: 'error', errorKey: 'updateNetwork' }), { type: 'check-started' });
    expect(next.status).toBe('checking');
    expect(next.errorKey).toBeNull();
  });

  it('available → 새 버전 기록', () => {
    const next = nextUpdateState(base({ status: 'checking' }), { type: 'available', version: '1.1.0' });
    expect(next).toMatchObject({ status: 'available', newVersion: '1.1.0', percent: 0 });
  });

  it('not-available → newVersion 을 비운다', () => {
    const next = nextUpdateState(base({ status: 'available', newVersion: '1.1.0' }), { type: 'not-available' });
    expect(next).toMatchObject({ status: 'not-available', newVersion: null });
  });

  it('downloaded → percent 100 + 버전 확정', () => {
    const next = nextUpdateState(base({ status: 'downloading', newVersion: '1.1.0', percent: 42 }), { type: 'downloaded', version: '1.1.0' });
    expect(next).toMatchObject({ status: 'downloaded', percent: 100, newVersion: '1.1.0' });
  });

  it('error → newVersion 은 보존(재시도 대상 표시), percent 는 초기화', () => {
    const next = nextUpdateState(base({ status: 'downloading', newVersion: '1.1.0', percent: 42 }), { type: 'error', errorKey: 'updateNetwork' });
    expect(next).toMatchObject({ status: 'error', newVersion: '1.1.0', percent: 0, errorKey: 'updateNetwork' });
  });
});

describe('nextUpdateState — 변화 없음이면 동일 참조 (브로드캐스트 억제)', () => {
  it('같은 percent 의 연속 progress 는 동일 참조', () => {
    const prev = base({ status: 'downloading', percent: 37 });
    expect(nextUpdateState(prev, { type: 'progress', percent: 37.9 })).toBe(prev);
  });

  it('percent 가 실제로 오르면 새 객체', () => {
    const prev = base({ status: 'downloading', percent: 37 });
    const next = nextUpdateState(prev, { type: 'progress', percent: 38.2 });
    expect(next).not.toBe(prev);
    expect(next.percent).toBe(38);
  });

  it('같은 errorKey 의 중복 error 는 동일 참조 — reject + error 이벤트 이중 처리 흡수', () => {
    const prev = base({ status: 'error', errorKey: 'updateNetwork' });
    expect(nextUpdateState(prev, { type: 'error', errorKey: 'updateNetwork' })).toBe(prev);
  });

  it('checking 중 재차 check-started 는 동일 참조', () => {
    const prev = base({ status: 'checking' });
    expect(nextUpdateState(prev, { type: 'check-started' })).toBe(prev);
  });

  it('unsupported 는 어떤 이벤트에도 변하지 않는다', () => {
    const prev = base({ status: 'unsupported' });
    expect(nextUpdateState(prev, { type: 'available', version: '9.9.9' })).toBe(prev);
    expect(nextUpdateState(prev, { type: 'error', errorKey: 'updateNetwork' })).toBe(prev);
  });
});

describe('nextUpdateState — 순서가 뒤바뀐 이벤트 방어', () => {
  it('다운로드 완료 후 지각 progress 는 무시 — 설치 버튼이 사라지지 않는다', () => {
    const prev = base({ status: 'downloaded', newVersion: '1.1.0', percent: 100 });
    expect(nextUpdateState(prev, { type: 'progress', percent: 88 })).toBe(prev);
  });

  it('다운로드 완료 후 같은 버전의 available(수동 재확인)은 downloaded 를 유지', () => {
    const prev = base({ status: 'downloaded', newVersion: '1.1.0', percent: 100 });
    expect(nextUpdateState(prev, { type: 'available', version: '1.1.0' })).toBe(prev);
  });

  // QA19(A·C 수렴): 실제 이벤트 순서는 check-started → available 이다. 이전 테스트는 두
  // 상태를 직접 넣어 검증해 중간의 check-started 를 건너뛰었고, 그래서 "downloaded 유지"
  // 방어가 실전에서 도달 불가능한 것을 놓쳤다. 3단 시퀀스로 고정한다.
  it('downloaded → check-started → available 3단 시퀀스에서 설치 자격이 유지된다', () => {
    const downloaded = base({ status: 'downloaded', newVersion: '1.1.0', percent: 100 });
    const checking = nextUpdateState(downloaded, { type: 'check-started' });
    expect(checking.status, 'check-started 가 downloaded 를 덮어쓰면 설치 버튼이 사라진다').toBe('downloaded');
    const afterAvailable = nextUpdateState(checking, { type: 'available', version: '1.1.0' });
    expect(afterAvailable.status).toBe('downloaded');
    expect(canInstall(afterAvailable.status)).toBe(true);
  });

  it('downloaded 상태에서 error 가 와도 설치 자격은 유지하고 사유만 싣는다', () => {
    const prev = base({ status: 'downloaded', newVersion: '1.1.0', percent: 100 });
    const next = nextUpdateState(prev, { type: 'error', errorKey: 'updateInstallFailed' });
    expect(next.status).toBe('downloaded');
    expect(next.errorKey).toBe('updateInstallFailed');
    expect(canInstall(next.status)).toBe(true);
    // 같은 사유의 반복은 브로드캐스트를 유발하지 않는다.
    expect(nextUpdateState(next, { type: 'error', errorKey: 'updateInstallFailed' })).toBe(next);
  });

  it('다운로드 완료 후 더 새로운 버전이 나오면 available 로 전이', () => {
    const prev = base({ status: 'downloaded', newVersion: '1.1.0', percent: 100 });
    const next = nextUpdateState(prev, { type: 'available', version: '1.2.0' });
    expect(next).toMatchObject({ status: 'available', newVersion: '1.2.0', percent: 0 });
  });

  it('다운로드 중 같은 버전의 available 재수신은 진행을 끊지 않는다', () => {
    const prev = base({ status: 'downloading', newVersion: '1.1.0', percent: 50 });
    expect(nextUpdateState(prev, { type: 'available', version: '1.1.0' })).toBe(prev);
  });

  it('비정상 percent(NaN/음수/100 초과)는 무시하거나 클램프한다', () => {
    const prev = base({ status: 'downloading', percent: 50 });
    expect(nextUpdateState(prev, { type: 'progress', percent: Number.NaN })).toBe(prev);
    expect(nextUpdateState(prev, { type: 'progress', percent: -5 }).percent).toBe(0);
    expect(nextUpdateState(prev, { type: 'progress', percent: 250 }).percent).toBe(100);
  });
});

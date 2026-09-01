import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripJsComments } from '../../../shared/__tests__/helpers/source-scan';
import { selectUpdateBanner, shouldResetDismiss, type UpdateBanner } from '../update-banner';
import type { UpdateState, UpdateStatus } from '../../../shared/update-types';

/**
 * 메인 화면 업데이트 배너 판정 회귀 넷.
 *
 * 배경: 배너가 'downloaded' 일 때만 떴는데 다운로드는 사용자 승인이 있어야 시작되므로,
 * **새 버전이 나왔다는 사실을 설정 화면을 열어야만 알 수 있었다** — 자동 업데이트가 켜져 있어도
 * 설정에 들어가지 않는 사용자는 계속 구버전에 머문다. 세 단계를 모두 표면화하되, 다운로드/설치
 * 승인 정책과 "닫아두면 조용해야 한다"는 성질은 그대로 지킨다.
 */

const state = (status: UpdateStatus, over: Partial<UpdateState> = {}): UpdateState => ({
  status,
  currentVersion: '0.31.38',
  newVersion: status === 'available' || status === 'downloading' || status === 'downloaded' ? '0.31.39' : null,
  percent: 0,
  errorKey: null,
  ...over,
});

describe('selectUpdateBanner — 어떤 상태에서 배너를 띄우는가', () => {
  it('available: 새 버전 알림(다운로드 승인 대기)', () => {
    expect(selectUpdateBanner(state('available'))).toEqual({ kind: 'available', version: '0.31.39' });
  });

  it('downloading: 진행률 알림', () => {
    expect(selectUpdateBanner(state('downloading', { percent: 42 }))).toEqual({ kind: 'downloading', percent: 42 });
  });

  it('downloaded: 설치 준비 알림(종전 동작 보존)', () => {
    expect(selectUpdateBanner(state('downloaded')))
      .toEqual({ kind: 'downloaded', version: '0.31.39', errorKey: null });
  });

  it('installing: 설치 진행을 표시한다 (QA23 — 재클릭이 조용히 폐기되지 않도록)', () => {
    expect(selectUpdateBanner(state('installing'))).toEqual({ kind: 'installing' });
  });

  // QA23(B-MED): 설치 시도가 실패해도 status 는 downloaded 로 유지된다(인스톨러가 디스크에
  // 남아 재시도가 합리적이므로). 그때 errorKey 를 싣지 않으면 배너가 "설치 준비되었습니다"만
  // 반복해 **실패가 완전 무음**이 된다.
  it('downloaded + errorKey: 직전 설치 실패 사유를 함께 싣는다', () => {
    expect(selectUpdateBanner(state('downloaded', { errorKey: 'updateInstallFailed' })))
      .toEqual({ kind: 'downloaded', version: '0.31.39', errorKey: 'updateInstallFailed' });
  });

  // QA23(A-MED): 이전에는 error 에서 null 을 반환해 **배너가 사유 없이 사라졌다** — 다운로드
  // 실패 시 사용자는 끝난 건지 실패한 건지 알 수 없고, 재시도의 유일한 메인 화면 진입점도
  // 사라져 다시 설정을 열어야 했다(이 배너가 없애려던 바로 그 문제).
  it('error: 사유와 재시도 가능 여부를 남긴다', () => {
    expect(selectUpdateBanner(state('error', { errorKey: 'updateNetwork', newVersion: '0.31.39' })))
      .toEqual({ kind: 'error', errorKey: 'updateNetwork', canRetryDownload: true });
  });

  // QA24(B-I3): 위 QA23 수정이 **배경 확인 실패까지** 배너로 끌어올렸다. 오프라인/사내망
  // 사용자는 기동 8초 뒤 자동 확인이 실패해 매 기동 배너를 보는데, newVersion 이 없으니
  // 재시도 버튼도 없다 — 닫기밖에 없고 dismiss 는 컴포넌트 state 라 다음 실행에 또 뜬다.
  // 사유는 보이지만 회복 동작이 없는 배너이므로 띄우지 않는다(설정 패널 표시는 유지).
  it('error + 확인된 버전 없음(배경 확인 실패): 배너를 띄우지 않는다', () => {
    expect(selectUpdateBanner(state('error', { errorKey: 'updateNetwork', newVersion: null })))
      .toBeNull();
  });

  // 회복 수단이 있는 실패는 계속 띄운다 — QA23 이 닫은 "사유 없이 사라짐" 이 되살아나지 않도록.
  it('installer-missing 처럼 버전이 보존된 실패는 재시도와 함께 계속 띄운다', () => {
    expect(selectUpdateBanner(state('error', { errorKey: 'updateInstallerMissing', newVersion: '1.0.2' })))
      .toEqual({ kind: 'error', errorKey: 'updateInstallerMissing', canRetryDownload: true });
  });

  // 아래 상태들에서 배너가 뜨면 매 기동 깜빡이거나(checking) 요청하지 않은 소음이 된다.
  it.each<UpdateStatus>(['unsupported', 'idle', 'checking', 'not-available'])(
    '%s 는 배너를 띄우지 않는다',
    (status) => {
      expect(selectUpdateBanner(state(status))).toBeNull();
    },
  );

  it('상태가 없으면(초기 조회 실패 등) 배너 없음', () => {
    expect(selectUpdateBanner(null)).toBeNull();
    expect(selectUpdateBanner(undefined)).toBeNull();
  });

  it('버전 문자열이 비어도 배너는 뜬다 — 문구만 폴백하도록 null 로 정규화 (QA19 정책)', () => {
    expect(selectUpdateBanner(state('available', { newVersion: '' }))).toEqual({ kind: 'available', version: null });
    expect(selectUpdateBanner(state('downloaded', { newVersion: null })))
      .toEqual({ kind: 'downloaded', version: null, errorKey: null });
  });

  it('진행률은 0~100 정수로 정규화한다 (피드/이벤트 이상값 방어)', () => {
    expect(selectUpdateBanner(state('downloading', { percent: -5 }))).toEqual({ kind: 'downloading', percent: 0 });
    expect(selectUpdateBanner(state('downloading', { percent: 150 }))).toEqual({ kind: 'downloading', percent: 100 });
    expect(selectUpdateBanner(state('downloading', { percent: 42.6 }))).toEqual({ kind: 'downloading', percent: 43 });
    expect(selectUpdateBanner(state('downloading', { percent: NaN }))).toEqual({ kind: 'downloading', percent: 0 });
  });
});

// 배선 가드: 순수 판정이 맞아도 App 이 그것을 쓰지 않으면 사용자에게는 아무 변화가 없다.
// App.tsx 는 앱 전체를 끌고 들어와 행위 테스트 하네스가 없으므로(다른 렌더러 컴포넌트와 달리),
// preload-shape.test 와 같은 **정적 소스 스캔**으로 최소 계약만 못박는다.
describe('App 배선 가드', () => {
  // QA29(D1-2): 주석을 걷고 본다. 이 가드는 "순수 판정이 맞아도 App 이 안 쓰면 무의미하다" 는
  // 이유로 존재하는데(자동 업데이트 체인이 실기기에서 첫 칸에 멈춰 있던 그것), 원본을 보던
  // 동안에는 배선을 통째로 지워도 `update.download()` 를 언급한 설명 주석만 남으면 통과했다.
  const APP_SRC = stripJsComments(readFileSync(resolve(import.meta.dirname, '../../App.tsx'), 'utf-8'));

  it('App 이 배너 판정을 이 모듈에 위임한다', () => {
    expect(APP_SRC).toMatch(/selectUpdateBanner\(/);
    expect(APP_SRC).toMatch(/shouldResetDismiss\(/);
  });

  it("available 배너에 다운로드 조작이 붙어 있다 (알림만 뜨고 진행할 수 없으면 의미가 없다)", () => {
    expect(APP_SRC).toMatch(/update\.download\(\)/);
    expect(APP_SRC).toMatch(/update\.install\(\)/);
  });

  it('설치 버튼만 작업 중 게이트(updateInstallBusy)를 쓴다 — 다운로드는 앱을 종료시키지 않는다', () => {
    // 다운로드 버튼에 게이트가 붙으면 요약 중인 사용자는 업데이트를 받아둘 수조차 없다.
    const installBlock = /update\.install\(\)[\s\S]{0,600}?disabled=\{updateInstallBusy\}/;
    expect(APP_SRC).toMatch(installBlock);
    // QA27(D-MED): 정규식이 빗나가면 `''` 가 되고, 빈 문자열은 아래 **부정 단언을 만족**한다 —
    // 즉 이 가드는 자기가 아무것도 못 찾았을 때 가장 조용히 통과한다. 창(400자)을 넘기거나
    // `disabled=` 를 `onClick` 위로 옮기기만 해도 그렇게 된다. 추출 성공을 먼저 못박는다.
    const downloadBlock = /update\.download\(\)[\s\S]{0,400}?<\/button>/.exec(APP_SRC)?.[0] ?? '';
    expect(downloadBlock, '다운로드 버튼 블록을 추출하지 못했다 — 가드가 무력화된 상태다').not.toBe('');
    expect(downloadBlock).not.toMatch(/disabled=/);
    // 속성 순서에 의존하지 않는 실질 단언: 버튼 요소 자체가 게이트를 달고 있지 않아야 한다.
    const downloadButton = /<button[^>]*onClick=\{\(\) => [^}]*update\.download\(\)[\s\S]{0,400}?<\/button>/.exec(APP_SRC)?.[0] ?? '';
    // QA30(D7): 종전엔 `if (downloadButton) expect(...)` 였다 — 정규식이 빗나가면 단언 자체가
    // 실행되지 않아, 이 가드는 **아무것도 못 찾았을 때 가장 조용히 통과**했다(바로 위 QA27 이
    // 같은 자리에서 닫은 구멍과 같은 모양이 한 줄 아래 남아 있었다). 추출을 먼저 못박는다.
    expect(downloadButton, '다운로드 버튼 요소를 추출하지 못했다 — 가드가 무력화된 상태다').not.toBe('');
    expect(downloadButton).not.toMatch(/disabled=\{updateInstallBusy\}/);
  });
});

describe('shouldResetDismiss — 닫아둔 배너를 다시 띄울 때', () => {
  const avail: UpdateBanner = { kind: 'available', version: '0.31.39' };

  it('같은 단계의 반복 브로드캐스트로는 되살아나지 않는다 (닫으면 조용해야 한다)', () => {
    expect(shouldResetDismiss(avail, { kind: 'available', version: '0.31.39' })).toBe(false);
  });

  it('진행률만 바뀌는 downloading 반복도 되살리지 않는다', () => {
    expect(shouldResetDismiss({ kind: 'downloading', percent: 10 }, { kind: 'downloading', percent: 90 })).toBe(false);
  });

  it('단계가 바뀌면 다시 띄운다 — available 을 닫은 것이 설치 준비 알림까지 버린다는 뜻은 아니다', () => {
    expect(shouldResetDismiss(avail, { kind: 'downloaded', version: '0.31.39', errorKey: null })).toBe(true);
    expect(shouldResetDismiss(avail, { kind: 'downloading', percent: 1 })).toBe(true);
  });

  // QA23(B-MED): 설치 실패는 kind·version 을 바꾸지 않는다(downloaded 유지). 그래서 배너를
  // 닫아둔 사용자는 실패를 영영 볼 수 없었다 — 에러의 유일한 표시처가 설정 패널이라
  // "설정을 열어야만 안다" 로 되돌아간다. 새 실패 사유는 닫아둔 배너를 다시 띄운다.
  it('같은 단계라도 새 실패 사유가 붙으면 다시 띄운다', () => {
    const ready: UpdateBanner = { kind: 'downloaded', version: '0.31.39', errorKey: null };
    expect(shouldResetDismiss(ready, { kind: 'downloaded', version: '0.31.39', errorKey: 'updateInstallFailed' }))
      .toBe(true);
  });

  it('실패 사유가 그대로면 되살리지 않는다 (닫으면 조용해야 한다)', () => {
    const failed: UpdateBanner = { kind: 'downloaded', version: '0.31.39', errorKey: 'updateInstallFailed' };
    expect(shouldResetDismiss(failed, { ...failed })).toBe(false);
  });

  it('실패가 해소되는 전이는 되살리지 않는다 (알릴 새 사실이 없다)', () => {
    const failed: UpdateBanner = { kind: 'downloaded', version: '0.31.39', errorKey: 'updateInstallFailed' };
    expect(shouldResetDismiss(failed, { kind: 'downloaded', version: '0.31.39', errorKey: null })).toBe(false);
  });

  it('같은 단계라도 새 버전이면 다시 띄운다 (이전 버전의 닫기가 다음 알림을 삼키지 않게)', () => {
    expect(shouldResetDismiss(avail, { kind: 'available', version: '0.31.40' })).toBe(true);
  });

  it('배너가 없다가 생기면 띄운다 / 사라지는 전이는 해제하지 않는다', () => {
    expect(shouldResetDismiss(null, avail)).toBe(true);
    expect(shouldResetDismiss(avail, null)).toBe(false);
  });
});

import type { UpdateState } from '../../shared/update-types';

/**
 * 메인 화면 업데이트 배너 판정 — 순수 함수.
 *
 * 도입 배경: 배너가 `status === 'downloaded'` 일 때만 떴다. 그런데 다운로드는 사용자 승인이
 * 있어야 시작되므로(autoDownload=false), **"새 버전이 나왔다"는 사실 자체를 설정 화면을 열어야만
 * 알 수 있었다.** 즉 자동 업데이트가 켜져 있어도 설정에 들어가지 않는 사용자는 영원히 구버전에
 * 머문다 — 확인·다운로드·설치 체인이 첫 칸에서 끊긴 셈이다.
 * 이제 available(승인 대기) → downloading(진행) → downloaded(설치 대기) 세 단계를 모두 배너로
 * 표면화한다. 다운로드는 여전히 사용자가 눌러야 시작되고(종량제 보호), 설치도 종전대로 승인이 필요하다.
 *
 * 표시 결정을 App.tsx 인라인이 아니라 여기 두는 이유: App 은 행위 테스트 하네스가 없어서
 * 인라인 조건은 회귀 넷을 붙일 수 없다(update-policy·window-flush-policy 와 같은 분리).
 */

export type UpdateBanner =
  /** 새 버전 확인됨 — 사용자의 다운로드 승인 대기 */
  | { kind: 'available'; version: string | null }
  /** 다운로드 진행 중 — 진행률만 알린다(조작 버튼 없음) */
  | { kind: 'downloading'; percent: number }
  /** 설치 요청 접수 ~ 종료 대기 — 조작 불가(QA23) */
  | { kind: 'installing' }
  /** 다운로드 완료 — 재시작 설치 대기. `errorKey` 가 있으면 직전 설치 시도가 실패한 것. */
  | { kind: 'downloaded'; version: string | null; errorKey: string | null }
  /** 실패 — 사유와 재시도 수단을 남긴다(QA23) */
  | { kind: 'error'; errorKey: string | null; canRetryDownload: boolean };

/**
 * 표시할 배너. 그 외 상태(unsupported/idle/checking/not-available/error)는 배너를 띄우지 않는다.
 *
 * - checking: 사용자가 요청하지 않은 백그라운드 확인이라 매 기동 깜빡이면 소음이다.
 * - not-available: "최신입니다" 는 수동 확인의 응답이므로 설정 패널 소관.
 * - error: **회복 수단이 있을 때만** 띄운다(아래 QA24 주석). 사유는 항상 설정 패널에 남는다.
 *
 * 버전 문자열이 비어 있어도(피드 이상) 배너 자체는 띄운다 — QA19(D-LOW) 와 동일 정책.
 * 표시 문구만 버전 미포함으로 폴백하도록 null 로 정규화한다.
 */
export function selectUpdateBanner(state: UpdateState | null | undefined): UpdateBanner | null {
  if (!state) return null;
  switch (state.status) {
    case 'available':
      return { kind: 'available', version: state.newVersion || null };
    case 'downloading':
      return { kind: 'downloading', percent: clampPercent(state.percent) };
    case 'installing':
      return { kind: 'installing' };
    case 'downloaded':
      // errorKey 를 함께 싣는다 — 설치 시도가 실패해도 status 는 downloaded 로 유지되므로
      // (인스톨러는 디스크에 남아 재시도가 가능하다) 이걸 표시하지 않으면 배너가 "설치
      // 준비되었습니다" 만 반복해 **실패가 완전 무음**이 된다(QA23 B-MED).
      return { kind: 'downloaded', version: state.newVersion || null, errorKey: state.errorKey || null };
    case 'error':
      // QA23(A-MED): 이전에는 여기서 null 을 반환해 **배너가 사유 없이 사라졌다**. 사용자는
      // 다운로드가 끝난 것인지 실패한 것인지 알 수 없고, 재시도의 유일한 메인 화면 진입점까지
      // 사라져 다시 설정을 열어야 했다 — 이 배너가 없애려던 바로 그 문제다.
      //
      // QA24(B-I3): 단, 그 수정이 **배경 확인 실패까지** 배너로 끌어올렸다. 오프라인·사내망
      // 사용자는 기동 8초 뒤 자동 확인이 실패해 매 기동 "네트워크 오류" 배너를 보는데,
      // newVersion 이 없으므로 재시도 버튼도 없다 — 닫기밖에 할 게 없고 dismiss 는 컴포넌트
      // state 라 다음 실행에서 다시 뜬다. 사유는 보이지만 **회복 동작이 없는 배너**다.
      // newVersion 유무가 곧 "사용자가 시작한 조작의 실패인가"의 대리 지표다: 다운로드·설치
      // 실패는 확인된 버전을 보존하고(installer-missing 포함), 배경 확인 실패만 null 이다.
      // 회복 수단이 없는 실패는 배너를 띄우지 않는다(설정 패널의 사유 표시는 그대로 유지).
      if (!state.newVersion) return null;
      return {
        kind: 'error',
        errorKey: state.errorKey || null,
        // 확인된 버전이 남아 있으면 재확인 없이 다운로드를 다시 시도할 수 있다(canDownload 와 동일 규칙).
        canRetryDownload: true,
      };
    default:
      return null;
  }
}

function clampPercent(percent: unknown): number {
  const n = Number(percent);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 배너를 닫아둔 상태(dismiss)를 해제해야 하는가.
 *
 * 사용자가 "새 버전 있음"을 닫은 것은 **지금 다운로드하지 않겠다**는 뜻이지, 이후 단계까지
 * 보지 않겠다는 뜻이 아니다. 단계가 바뀌면(available→downloading→downloaded, 또는 새 버전이
 * 도착하면) 다시 보여준다. 같은 단계의 반복 브로드캐스트(다운로드 진행률 등)는 해제하지 않는다 —
 * 그러지 않으면 닫아도 즉시 되살아난다.
 */
export function shouldResetDismiss(prev: UpdateBanner | null, next: UpdateBanner | null): boolean {
  if (!next) return false;
  if (!prev) return true;
  if (prev.kind !== next.kind) return true;
  const prevVersion = 'version' in prev ? prev.version : null;
  const nextVersion = 'version' in next ? next.version : null;
  if (prevVersion !== nextVersion) return true;
  // QA23(B-MED): 설치 시도가 실패해도 status 는 downloaded 로 유지되므로 kind·version 이 그대로다.
  // 그 상태에서 배너를 닫아둔 사용자는 **실패를 영영 볼 수 없다**(에러의 유일한 표시처가 설정
  // 패널이라, 이 배너가 없애려던 "설정을 열어야만 안다" 로 되돌아간다). 새 실패 사유는 다시 띄운다.
  const prevError = 'errorKey' in prev ? prev.errorKey : null;
  const nextError = 'errorKey' in next ? next.errorKey : null;
  return prevError !== nextError && nextError !== null;
}

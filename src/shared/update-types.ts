/**
 * 자동 업데이트 상태 — main ↔ preload ↔ renderer 공유 타입 단일 출처.
 *
 * session-types.ts 와 동일 패턴(electron 의존 없는 shared 모듈)이라 세 측이 같은 정의를
 * 참조한다. main 은 update-policy 의 리듀서로 이 객체를 만들고 `update:status` 로 브로드캐스트,
 * renderer 는 그대로 표시한다.
 */

export type UpdateStatus =
  /** 패키징되지 않았거나(dev/preview) 지원 플랫폼이 아님 — 모든 조작 비활성 */
  | 'unsupported'
  /** 아무 것도 진행 중이 아님(앱 시작 직후) */
  | 'idle'
  | 'checking'
  /** 새 버전이 있고 사용자의 다운로드 승인 대기 (autoDownload=false) */
  | 'available'
  /** 최신 버전 사용 중 */
  | 'not-available'
  | 'downloading'
  /** 다운로드 완료 — 재시작 시 설치 */
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** 현재 실행 중인 앱 버전 (app.getVersion) */
  currentVersion: string;
  /** 피드에서 확인된 새 버전. available/downloading/downloaded 외에는 null. */
  newVersion: string | null;
  /** 다운로드 진행률 0~100 정수. downloading 외에는 0. */
  percent: number;
  /**
   * 실패 사유의 구조화 키(i18n). renderer 는 `mainerr.{errorKey}` 로 번역한다 —
   * ai-service / ollama-manager 의 errorKey 규약과 동일(영어 UI 에 한국어 원문 노출 방지).
   */
  errorKey: string | null;
}

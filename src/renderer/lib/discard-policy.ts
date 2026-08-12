import { useAppStore } from './store';
import { t } from './i18n';

/**
 * "저장되지 않은 작업을 파기하는가" 판정 — 문서 교체 경로 전체의 단일 출처.
 *
 * 배경: 세션 영속화가 꺼져 있으면 문서를 바꾸는 순간 현재 요약·Q&A 가 **되돌릴 수 없이**
 * 사라진다(저장할 곳이 없으므로 persistCurrentSession 은 no-op 이고, 새 문서 로드가 store 를
 * 초기화한다). QA23(D-MED)이 이 손실에 확인 대화상자를 붙였는데 `switchToTab` 한 곳에만 붙었다.
 *
 * QA24(A-I1): 근인은 전환이 아니라 **문서 교체**이므로 같은 손실이 나머지 경로에서 그대로
 * 일어나고 있었다 — 탭 닫기(이웃으로 교체), "+"(업로드 화면으로 교체), 드롭·Ctrl+O·최근 문서·
 * 전역 검색(새 문서로 교체). 어떤 조작은 묻고 어떤 조작은 묻지 않는 상태는 오히려 "묻지 않는
 * 조작은 안전하다"는 오해를 만든다.
 *
 * 판정을 여기 순수 함수로 올려 호출 지점을 한 곳에서 세도록 한다 — 이 프로젝트의 최다 결함
 * 클래스가 "같은 판정을 여러 곳에 흩어 놓고 한 곳을 빠뜨리는 것" 이기 때문이다.
 */

/** 파기하면 잃을 것이 있는가. summary(확정)·summaryStream(생성 중)·qaMessages(대화) 세 축. */
export function hasUnsavedWork(s: {
  summary: unknown;
  summaryStream: string;
  qaMessages: readonly unknown[];
}): boolean {
  return !!s.summary || s.summaryStream.trim().length > 0 || s.qaMessages.length > 0;
}

/**
 * 영속화 OFF + 잃을 작업이 있으면 사용자에게 묻는다.
 *
 * @returns 계속 진행해도 되면 true. 영속화 ON 이거나 잃을 것이 없으면 묻지 않고 true.
 */
export function confirmDiscardIfNotPersisted(): boolean {
  const s = useAppStore.getState();
  if (s.settings.persistSessions) return true;
  if (!hasUnsavedWork(s)) return true;
  try {
    return window.confirm(t('tabs.discardOnSwitchConfirm'));
  } catch {
    return true; // confirm 이 없는 환경(테스트 등) — 차단하지 않는다
  }
}

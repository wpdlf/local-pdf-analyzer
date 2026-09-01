/**
 * 짧게 떴다 사라지는 확인 알림.
 *
 * 왜 필요한가: 요약 "복사" 는 성공 시 화면이 전혀 바뀌지 않아 사용자가 눌린 것인지조차
 * 알 수 없었다(실패만 배너로 보였다). v1.2.6 실기기 확인에서 나온 피드백.
 *
 * 표시/숨김 타이밍은 호출부가 소유한다 — 이 컴포넌트는 message 를 받아 그리기만 한다.
 * 자동 소멸 타이머를 여기 두면 같은 문구를 연속으로 띄울 때(빠른 재복사) 타이머가 겹쳐
 * 먼저 뜬 쪽 기준으로 사라진다.
 */
interface ToastProps {
  /** 표시할 문구. null 이면 알림을 감춘다(리전 자체는 남는다 — 아래 참조). */
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  return (
    // role="status" 리전은 message 와 무관하게 **항상 마운트**돼 있어야 한다. 리전을 내용과
    // 함께 삽입하면 스크린리더가 "변경" 을 감지할 대상이 없어 통지를 놓친다.
    // pointer-events-none: 빈 리전이 화면 하단을 덮어 클릭을 가로채지 않도록.
    <div
      role="status"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
    >
      {message && (
        <div className="px-4 py-2 rounded-lg shadow-lg text-sm font-medium bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900">
          {message}
        </div>
      )}
    </div>
  );
}

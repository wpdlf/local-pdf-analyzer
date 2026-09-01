import { useState, useEffect } from 'react';

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
  /** 표시할 문구. null 이면 알림을 감춘다(리전과 알약 자체는 남는다 — 아래 참조). */
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  // 사라지는 동안 문구를 유지한다. message 가 null 이 되는 즉시 글자를 지우면 빈 알약이
  // 페이드아웃해, 부드럽게 사라지는 대신 글자만 "깜빡" 없어지는 것처럼 보인다(v1.3.0 실기기 보고).
  const [lastMessage, setLastMessage] = useState<string | null>(message);
  useEffect(() => {
    if (message !== null) setLastMessage(message);
  }, [message]);

  const visible = message !== null;

  return (
    <>
      {/* 보이는 알약. 페이드를 위해 **항상 마운트**하고 opacity 로만 여닫는다 —
          조건부 렌더로는 사라질 때 트랜지션이 걸릴 요소가 이미 없어 즉시 증발한다(깜빡임).
          pointer-events-none: 상시 떠 있는 fixed 요소가 아래 UI 의 클릭을 가로채지 않도록. */}
      <div
        aria-hidden="true"
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {lastMessage && (
          // 다크에서는 배경(gray-800 계열)보다 한 단계 밝은 gray-700 로 띄운다.
          // 초판은 dark:bg-gray-100 이라 어두운 화면에 흰 알약이 튀었다(v1.3.0 실기기 보고).
          <div className="px-4 py-2 rounded-lg shadow-lg text-sm font-medium bg-gray-900 text-white border border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600">
            {lastMessage}
          </div>
        )}
      </div>
      {/* SR 통지는 시각 요소와 분리한다: 알약은 페이드아웃 동안 문구를 남겨야 하는데,
          라이브 리전은 비었다 채워져야 "변경" 으로 감지된다. 리전 자체는 항상 마운트. */}
      <span role="status" className="sr-only">{message ?? ''}</span>
    </>
  );
}

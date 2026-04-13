/**
 * 테마 적용 유틸리티 — App.tsx와 SettingsPanel.tsx 공용
 *
 * 부가 효과: localStorage('theme') 에 현재 설정값을 캐시한다.
 * index.html 의 FOUC 방지 inline 스크립트가 다음 실행 시 이 값을 읽어
 * React 마운트 전에 다크 클래스를 동기적으로 적용한다.
 *
 * @returns cleanup 함수 (system 모드일 때 리스너 해제)
 */
export function applyTheme(theme: string): (() => void) | undefined {
  const root = document.documentElement;
  // localStorage 캐시 — FOUC 방지 초기화 스크립트가 읽는 값
  try { localStorage.setItem('theme', theme); } catch { /* 접근 실패 무시 */ }
  if (theme === 'dark') {
    root.classList.add('dark');
  } else if (theme === 'light') {
    root.classList.remove('dark');
  } else {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    root.classList.toggle('dark', mq.matches);
    const handler = (e: MediaQueryListEvent) => {
      root.classList.toggle('dark', e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
}

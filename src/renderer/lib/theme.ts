/**
 * 테마 적용 유틸리티 — App.tsx와 SettingsPanel.tsx 공용
 *
 * 부가 효과: localStorage('theme') 에 현재 설정값을 캐시한다.
 * index.html 의 FOUC 방지 inline 스크립트가 다음 실행 시 이 값을 읽어
 * React 마운트 전에 다크 클래스를 동기적으로 적용한다.
 *
 * @returns cleanup 함수. 모든 분기가 동일하게 함수를 반환하므로
 * `useEffect(() => applyTheme(...))` 형태로 안전하게 사용 가능.
 * system 모드는 실제 리스너 해제, light/dark 는 no-op 을 반환.
 */
export function applyTheme(theme: string): () => void {
  const root = document.documentElement;
  // localStorage 캐시 — FOUC 방지 초기화 스크립트가 읽는 값
  try { localStorage.setItem('theme', theme); } catch { /* 접근 실패 무시 */ }
  if (theme === 'dark') {
    root.classList.add('dark');
    return () => { /* no-op: light/dark 는 리스너 없음 */ };
  }
  if (theme === 'light') {
    root.classList.remove('dark');
    return () => { /* no-op */ };
  }
  // system
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  root.classList.toggle('dark', mq.matches);
  const handler = (e: MediaQueryListEvent) => {
    root.classList.toggle('dark', e.matches);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

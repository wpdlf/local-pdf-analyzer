/**
 * 테마 적용 유틸리티 — App.tsx와 SettingsPanel.tsx 공용
 * @returns cleanup 함수 (system 모드일 때 리스너 해제)
 */
export function applyTheme(theme: string): (() => void) | undefined {
  const root = document.documentElement;
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

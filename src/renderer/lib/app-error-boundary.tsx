import { Component, type ReactNode } from 'react';

/**
 * Error 메시지에서 로컬 절대경로를 홈 기호(`~`) 또는 `<system>` 로 치환.
 *
 * v0.18.5 M4: 이전에는 `C:\\Users\\<u>` · `/Users/<u>` · `/home/<u>` 3 패턴만 커버했다.
 * 패키지된 Electron 앱은 에러 메시지를 fallback UI 로 사용자에게 직접 노출하므로,
 * 다음 경로들이 그대로 새어 나갈 수 있었다:
 *  - Windows 드라이브 일반: `D:\\Projects\\...`, `E:\\...`
 *  - Windows UNC: `\\\\server\\share\\...`
 *  - Linux 시스템: `/etc/...`, `/var/...`, `/usr/...`, `/opt/...`
 *  - macOS 시스템: `/private/var/...`, `/tmp/...`
 *
 * 정책:
 *  - 사용자 홈 경로 (Users/home/<name>) → `~` 치환.
 *  - 시스템 디렉토리 → `<system>` 치환 (어떤 디렉토리인지는 노출하지 않음).
 *  - 그 외 Windows 드라이브 경로 → `<path>` 치환 (사용자 정보 + 프로젝트 구조 숨김).
 *  - UNC 서버/공유명 → `<share>` 치환.
 *
 * 순수 함수로 분리한 이유: 커버리지 갭 회귀 방지용 단위 테스트를 가능하게 하기 위함.
 */
export function sanitizeErrorPath(raw: string): string {
  if (!raw) return raw;
  return raw
    // v0.18.5 Round 23 #3: Windows 사용자 홈 — 사용자명 이후 **하위 경로 전체** 도 소비.
    // 이전에는 `C:\Users\alice` 만 `~` 로 바뀌고 `\secrets\api-key.ts` 가 남아 민감
    // 폴더/파일명이 노출됐다. 전체 경로를 `~` 로 일괄 치환해 프로젝트 구조까지 은닉.
    .replace(/[A-Z]:\\Users\\[^\\\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*/gi, '~')
    // macOS/Linux 사용자 홈 — 동일 정책
    .replace(/\/Users\/[^/\s"'<>|?*]+(?:\/[^\s"'<>|?*]+)*/g, '~')
    .replace(/\/home\/[^/\s"'<>|?*]+(?:\/[^\s"'<>|?*]+)*/g, '~')
    // v0.18.5 Round 23 #2: UNC 공유 — `\\server\share` 뒤의 하위 경로(프로젝트 폴더 등)
    // 도 모두 `<share>` 로 흡수. 이전에는 `\\srv\share\a\b\c` 에서 `\a\b\c` 가 남았다.
    .replace(/\\\\[^\\\s"'<>|?*]+\\[^\\\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*/g, '<share>')
    // Linux/macOS 시스템 절대경로 (공백 전 까지)
    .replace(/\/(?:etc|var|usr|opt|tmp|private|boot|sys|proc|dev|run|srv|mnt|media)(?:\/[^\s"'<>|?*]*)?/g, '<system>')
    // 남은 Windows 드라이브 절대경로 (일반화) — 사용자 홈·<share> 치환 이후에만 매치.
    // [^\s"'<>|?*]+ 로 한 토큰 경로만 소비 (에러 메시지 끝까지 과잉 매치 방지).
    .replace(/[A-Z]:\\[^\s"'<>|?*]+/g, '<path>');
}

/**
 * 앱 최상위 Error Boundary — React render-time 예외를 최종 방어.
 *
 * 존재 이유: 패키지된 Electron 앱에서는 DevTools 가 차단되어 있어 render-time 예외로 빈
 * 화면이 나오면 사용자가 원인을 알 수 없고 앱을 강제 종료해야 한다. 이 경계가 fallback
 * UI 를 제공하여 사용자에게 앱 재시작을 안내.
 *
 * 주의: 비동기 에러(Promise rejection, setTimeout), 이벤트 핸들러 에러는 Error Boundary
 * 가 잡지 못한다. 해당 경로는 각 훅/핸들러에서 try/catch 로 처리.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // 개발 모드 콘솔 + Electron 메인 프로세스 로그로 전달 가능
    console.error('[AppErrorBoundary] Render error:', error, info.componentStack);
  }

  handleReload = () => {
    // location.reload 가 안전 — Electron webContents 를 리프레시
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleReset = () => {
    // 일시적 오류(예: 잠깐의 IPC 실패)에 대해 전체 reload 없이 children 만 다시 그려본다.
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      // i18n 사용 불가(렌더 트리 밖) — 한/영 동시 표기로 최소 장벽
      const rawMessage = this.state.error?.message || (this.state.error ? String(this.state.error) : '');
      // v0.18.5 M4: 경로 sanitization 을 pure helper 로 분리 — Windows 드라이브 일반화,
      // UNC, Linux 시스템 경로까지 커버.
      const sanitizedMessage = sanitizeErrorPath(rawMessage);
      const MAX_DISPLAY = 500;
      const truncatedMessage = sanitizedMessage.length > MAX_DISPLAY
        ? sanitizedMessage.slice(0, MAX_DISPLAY) + '…'
        : sanitizedMessage;
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
          <div className="max-w-md text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-xl font-bold mb-2">앱에 오류가 발생했습니다 / Application Error</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              예상치 못한 오류로 화면을 그릴 수 없습니다.
              <br />
              An unexpected error occurred.
            </p>
            {truncatedMessage && (
              <pre className="text-xs text-left bg-gray-100 dark:bg-gray-800 p-3 rounded mb-4 overflow-auto max-h-40 whitespace-pre-wrap">
                {truncatedMessage}
              </pre>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                title="일시적 오류면 이 버튼으로 복구 / Try again without reload"
              >
                다시 시도 / Try again
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                새로고침 / Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

import { Component, type ReactNode } from 'react';

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

  render() {
    if (this.state.hasError) {
      // i18n 사용 불가(렌더 트리 밖) — 한/영 동시 표기로 최소 장벽
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
          <div className="max-w-md text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-xl font-bold mb-2">앱에 오류가 발생했습니다 / Application Error</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              예상치 못한 오류로 화면을 그릴 수 없습니다. 아래 버튼으로 앱을 새로고침하세요.
              <br />
              An unexpected error occurred. Please reload the app.
            </p>
            {this.state.error && (
              <pre className="text-xs text-left bg-gray-100 dark:bg-gray-800 p-3 rounded mb-4 overflow-auto max-h-40 whitespace-pre-wrap">
                {this.state.error.message || String(this.state.error)}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              새로고침 / Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

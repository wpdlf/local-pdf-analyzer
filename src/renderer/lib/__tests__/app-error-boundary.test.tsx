// @vitest-environment happy-dom

// AppErrorBoundary 행위 — 정상 children 통과 / render-time throw 시 fallback UI(한·영) /
// 다시 시도(handleReset → children 재렌더) / 새로고침(handleReload → location.reload) /
// 에러 메시지 sanitize + 500자 절단.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { AppErrorBoundary } from '../app-error-boundary';

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React 가 error boundary 캐치 시 console.error 로 로깅 — 테스트 노이즈 억제
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleSpy.mockRestore();
  cleanup();
});

describe('AppErrorBoundary', () => {
  it('정상 children 은 그대로 렌더', () => {
    render(<AppErrorBoundary><div>정상 콘텐츠</div></AppErrorBoundary>);
    expect(screen.getByText('정상 콘텐츠')).toBeTruthy();
  });

  it('render-time 예외 → fallback UI(한/영 병기) 표시', () => {
    function Boom(): never { throw new Error('렌더 실패'); }
    render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    expect(screen.getByText(/Application Error/)).toBeTruthy();
    expect(screen.getByText(/앱에 오류가 발생했습니다/)).toBeTruthy();
    expect(screen.getByText('렌더 실패')).toBeTruthy();
  });

  it('다시 시도 → handleReset 후 children 재렌더(일시 오류 복구)', () => {
    let shouldThrow = true;
    function Toggle() {
      if (shouldThrow) throw new Error('일시 오류');
      return <div>복구됨</div>;
    }
    render(<AppErrorBoundary><Toggle /></AppErrorBoundary>);
    expect(screen.getByText(/Application Error/)).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByText(/다시 시도/));
    expect(screen.getByText('복구됨')).toBeTruthy();
  });

  it('새로고침 → window.location.reload 호출', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    function Boom(): never { throw new Error('boom'); }
    render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    fireEvent.click(screen.getByText(/새로고침/));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('긴 에러 메시지는 500자 + … 로 절단', () => {
    const long = 'x'.repeat(600);
    function Boom(): never { throw new Error(long); }
    const { container } = render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent?.length).toBe(501); // 500 + '…'
    expect(pre?.textContent?.endsWith('…')).toBe(true);
  });

  it('message 가 빈 에러는 String(error) 폴백으로 표시', () => {
    // error.message 가 falsy 면 `|| String(error)` 경로 — Error('') → 'Error'
    function Boom(): never { throw new Error(''); }
    const { container } = render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    expect(screen.getByText(/Application Error/)).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toBe('Error');
  });
});

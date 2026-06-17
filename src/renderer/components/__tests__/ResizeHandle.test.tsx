// @vitest-environment happy-dom

// ResizeHandle (DR-01) 행위 — separator ARIA 값 / 키보드 조정(Arrow/Home/End, 무관 키 무시) /
// 비율 클램프(0.2~0.8) / 포인터 드래그로 비율 계산. 실제 store(setCitationPanelWidth clamp) 사용.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { ResizeHandle } from '../ResizeHandle';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

// happy-dom 은 pointer capture 미구현 — 핸들러가 호출하므로 스텁
beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function fakeContainer(clientWidth: number) {
  return { current: { clientWidth } as unknown as HTMLDivElement };
}

function renderHandle(clientWidth = 1000) {
  return render(<ResizeHandle containerRef={fakeContainer(clientWidth)} />);
}

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, citationPanelWidth: 0.5 });
});
afterEach(() => cleanup());

describe('ResizeHandle', () => {
  it('separator 역할 + ARIA 값(valuenow/min/max/label)', () => {
    renderHandle();
    const sep = screen.getByRole('separator');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-valuenow')).toBe('50');
    expect(sep.getAttribute('aria-valuemin')).toBe('20');
    expect(sep.getAttribute('aria-valuemax')).toBe('80');
    expect(sep.getAttribute('aria-label')).toMatch(/패널 크기 조정/);
  });

  it('ArrowLeft → 우측 패널 +2%', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.52, 5);
  });

  it('ArrowRight → 우측 패널 -2%', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.48, 5);
  });

  it('Home → 최소(0.2), End → 최대(0.8)', () => {
    renderHandle();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.2, 5);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.8, 5);
  });

  it('무관한 키는 비율을 바꾸지 않는다', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'a' });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });

  it('최대 경계 초과는 0.8 로 클램프', () => {
    useAppStore.setState({ citationPanelWidth: 0.79 });
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }); // 0.81 → clamp 0.8
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.8, 5);
  });

  it('포인터 드래그 — 왼쪽으로 100px 이동 시 우측 패널 +10%', () => {
    renderHandle(1000);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 }); // deltaPx=-100 → +0.1
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.6, 5);
    fireEvent.pointerUp(sep, { clientX: 400, pointerId: 1 });
  });

  it('드래그 시작 전 포인터 이동은 무시된다', () => {
    renderHandle(1000);
    const sep = screen.getByRole('separator');
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });

  it('컨테이너 폭 0 이면 드래그가 비율을 바꾸지 않는다', () => {
    renderHandle(0);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });
});

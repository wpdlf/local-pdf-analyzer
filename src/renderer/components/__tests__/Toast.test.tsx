// @vitest-environment happy-dom

// Toast — role="status" 리전의 상시 마운트(SR 통지 전제) / 페이드를 위한 알약 상시 마운트 /
// 사라질 때 문구 유지 / 다크 팔레트 / 빈 리전의 클릭 통과.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Toast } from '../Toast';

/** 보이는 알약의 컨테이너. 프로덕션 코드에 test 전용 속성을 넣지 않으려고 구조로 찾는다. */
const shell = (c: HTMLElement) => c.querySelector('[aria-hidden="true"]') as HTMLElement;

describe('Toast', () => {
  afterEach(() => cleanup());

  it('message 가 null 이어도 role=status 리전은 마운트돼 있다', () => {
    // 리전을 내용과 함께 삽입하면 스크린리더가 감지할 대상이 없어 통지를 놓친다.
    render(<Toast message={null} />);
    const region = screen.getByRole('status');
    expect(region).not.toBeNull();
    expect(region.textContent).toBe('');
  });

  it('message 가 있으면 문구를 표시하고 리전에도 싣는다', () => {
    const { container } = render(<Toast message="✓ 복사됨" />);
    expect(screen.getByRole('status').textContent).toBe('✓ 복사됨');
    expect(shell(container).textContent).toBe('✓ 복사됨');
  });

  it('알약은 message 가 null 이어도 마운트된 채 opacity 로만 닫힌다', () => {
    // 조건부 렌더로 빼면 사라질 때 트랜지션이 걸릴 요소가 없어 즉시 증발한다(깜빡임).
    const { container } = render(<Toast message={null} />);
    const el = shell(container);
    expect(el).not.toBeNull();
    expect(el.className).toContain('transition-opacity');
    expect(el.className).toContain('opacity-0');
  });

  it('message 가 null 로 바뀌어도 알약의 문구는 남는다(페이드아웃 동안 표시할 내용)', () => {
    const { container, rerender } = render(<Toast message="✓ 복사됨" />);
    expect(shell(container).className).toContain('opacity-100');
    rerender(<Toast message={null} />);
    // 리전은 즉시 비고(다음 통지를 위해), 알약은 문구를 유지한 채 흐려진다.
    expect(screen.getByRole('status').textContent).toBe('');
    expect(shell(container).textContent).toBe('✓ 복사됨');
    expect(shell(container).className).toContain('opacity-0');
  });

  it('다크 모드에서 밝은 배경을 쓰지 않는다', () => {
    // 초판이 dark:bg-gray-100 이라 어두운 화면에 흰 알약이 튀었다(v1.3.0 실기기 보고).
    const { container } = render(<Toast message="✓ 복사됨" />);
    const pill = shell(container).firstElementChild as HTMLElement;
    expect(pill.className).toContain('dark:bg-gray-700');
    expect(pill.className).not.toMatch(/dark:bg-(white|gray-(50|100|200))\b/);
  });

  it('빈 리전이 클릭을 가로채지 않는다(pointer-events-none)', () => {
    const { container } = render(<Toast message={null} />);
    expect(shell(container).className).toContain('pointer-events-none');
  });
});

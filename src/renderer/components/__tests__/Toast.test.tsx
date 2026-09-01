// @vitest-environment happy-dom

// Toast — role="status" 리전의 상시 마운트(SR 통지 전제) / message 표시 / 빈 리전의 클릭 통과.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Toast } from '../Toast';

describe('Toast', () => {
  afterEach(() => cleanup());

  it('message 가 null 이어도 role=status 리전은 마운트돼 있다', () => {
    // 리전을 내용과 함께 삽입하면 스크린리더가 감지할 대상이 없어 통지를 놓친다.
    render(<Toast message={null} />);
    const region = screen.getByRole('status');
    expect(region).not.toBeNull();
    expect(region.textContent).toBe('');
  });

  it('message 가 있으면 문구를 표시한다', () => {
    render(<Toast message="✓ 복사됨" />);
    expect(screen.getByRole('status').textContent).toBe('✓ 복사됨');
  });

  it('빈 리전이 클릭을 가로채지 않는다(pointer-events-none)', () => {
    // 화면 하단에 상시 떠 있는 fixed 요소라, 이게 없으면 아래 UI 를 못 누른다.
    render(<Toast message={null} />);
    expect(screen.getByRole('status').className).toContain('pointer-events-none');
  });
});

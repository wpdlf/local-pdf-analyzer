// @vitest-environment happy-dom

// ProgressBar 행위 — progress 클램핑(0~100) / label prop 우선 / progressInfo phase 라벨
// (image·integrate·summarize: chapter·section·단일) / 남은·경과 시간 라벨 임계.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { ProgressBar } from '../ProgressBar';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';
import type { ProgressInfo } from '../../types';

function info(overrides: Partial<ProgressInfo>): ProgressInfo {
  return { percent: 50, phase: 'summarize', current: 1, total: 1, elapsedMs: 0, ...overrides };
}

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, uiLanguage: 'ko' } });
});
afterEach(() => cleanup());

describe('ProgressBar', () => {
  it('progress 를 0~100 으로 클램핑한다 (aria-valuenow)', () => {
    const { rerender } = render(<ProgressBar progress={150} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    rerender(<ProgressBar progress={-10} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    rerender(<ProgressBar progress={42} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  });

  it('label prop 이 있으면 phase 라벨보다 우선한다', () => {
    render(<ProgressBar progress={10} label="커스텀 라벨" progressInfo={info({ phase: 'image' })} />);
    expect(screen.getByText('커스텀 라벨')).toBeTruthy();
    expect(screen.queryByText('이미지 분석 중')).toBeNull();
  });

  it('label·progressInfo 없으면 퍼센트 처리 라벨', () => {
    render(<ProgressBar progress={37} />);
    expect(screen.getByText(/37% 처리 중/)).toBeTruthy();
  });

  it('phase=image → 이미지 분석 중', () => {
    render(<ProgressBar progress={10} progressInfo={info({ phase: 'image' })} />);
    expect(screen.getByText('이미지 분석 중')).toBeTruthy();
  });

  it('phase=integrate → 통합 요약 생성 중', () => {
    render(<ProgressBar progress={90} progressInfo={info({ phase: 'integrate' })} />);
    expect(screen.getByText('통합 요약 생성 중')).toBeTruthy();
  });

  it('phase=summarize + chapterName → 섹션 + 챕터명', () => {
    render(<ProgressBar progress={50} progressInfo={info({ phase: 'summarize', current: 2, total: 5, chapterName: '서론' })} />);
    expect(screen.getByText(/2\/5 섹션 — 서론/)).toBeTruthy();
  });

  it('phase=summarize + total>1 + chapter 없음 → 섹션 처리 중', () => {
    render(<ProgressBar progress={50} progressInfo={info({ phase: 'summarize', current: 1, total: 3 })} />);
    expect(screen.getByText(/1\/3 섹션 처리 중/)).toBeTruthy();
  });

  it('phase=summarize + total<=1 → 요약 생성 중', () => {
    render(<ProgressBar progress={50} progressInfo={info({ phase: 'summarize', current: 1, total: 1 })} />);
    expect(screen.getByText('요약 생성 중')).toBeTruthy();
  });

  it('estimatedRemainingMs > 2000 → 남은 시간 표시', () => {
    render(<ProgressBar progress={50} progressInfo={info({ estimatedRemainingMs: 5000, elapsedMs: 1000 })} />);
    expect(screen.getByText(/약 5초 남음/)).toBeTruthy();
  });

  it('남은 시간 없고 elapsedMs > 3000 → 경과 시간 표시', () => {
    render(<ProgressBar progress={50} progressInfo={info({ elapsedMs: 4000 })} />);
    expect(screen.getByText(/4초 경과/)).toBeTruthy();
  });

  it('남은 시간 ≤2000 이고 경과 ≤3000 이면 시간 라벨 없음', () => {
    render(<ProgressBar progress={50} progressInfo={info({ estimatedRemainingMs: 1000, elapsedMs: 1000 })} />);
    expect(screen.queryByText(/남음|경과/)).toBeNull();
  });
});

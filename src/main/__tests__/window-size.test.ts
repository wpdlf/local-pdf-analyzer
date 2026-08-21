import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeDefaultWindowSize,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MAX_DEFAULT_WIDTH,
  MAX_DEFAULT_HEIGHT,
} from '../window-size';

/**
 * 기본 창 크기 산출 회귀 넷.
 *
 * 고정 1000×1200 을 대체한 이유가 둘이라 둘 다 가드한다:
 *  - 큰 화면에서 너무 좁음(2단 구성인데 2560px 모니터에서 39%)
 *  - **작은 화면에서 화면 밖으로 나감**(height 1200 > 노트북 작업영역 816) — 창 아래가 잘린다
 */

describe('computeDefaultWindowSize', () => {
  it('큰 모니터(2560×1392 작업영역): 상한까지 키우되 넘지 않는다', () => {
    const s = computeDefaultWindowSize({ width: 2560, height: 1392 });
    expect(s.width).toBe(MAX_DEFAULT_WIDTH);          // 2560×0.7=1792 → 상한 1600
    expect(s.height).toBe(1281);                      // 1392×0.92 (상한 1400 미만)
    expect(s.width).toBeGreaterThan(1000);            // 종전 고정폭보다 넓어야 한다(요구사항)
    expect(s.height).toBeGreaterThan(1200);           // 종전 고정높이보다 커야 한다(요구사항)
  });

  it('1080p(1920×1040 작업영역): 화면 안에 들어온다', () => {
    const s = computeDefaultWindowSize({ width: 1920, height: 1040 });
    expect(s.width).toBeLessThanOrEqual(1920);
    expect(s.height).toBeLessThanOrEqual(1040);
    expect(s.height).toBe(957);
  });

  it('노트북(1536×816 작업영역): 종전 고정 높이 1200 이 잘리던 케이스가 화면 안에 들어온다', () => {
    const s = computeDefaultWindowSize({ width: 1536, height: 816 });
    expect(s.height).toBeLessThanOrEqual(816);
    expect(s.width).toBeLessThanOrEqual(1536);
    expect(s.height).toBe(751);
  });

  it('세로 모니터(1080×1872): 높이는 상한에서 멈추고 폭은 하한 위로 유지된다', () => {
    const s = computeDefaultWindowSize({ width: 1080, height: 1872 });
    expect(s.height).toBe(MAX_DEFAULT_HEIGHT);
    expect(s.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH);
    expect(s.width).toBeLessThanOrEqual(1080);
  });

  it('아주 작은 화면: 하한을 쓰되 작업영역을 넘지 않는다', () => {
    const s = computeDefaultWindowSize({ width: 640, height: 480 });
    expect(s.width).toBeLessThanOrEqual(640);
    expect(s.height).toBeLessThanOrEqual(480);
  });

  it('일반적인 화면에서는 항상 최소 크기 이상이다', () => {
    for (const area of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 3840, height: 2100 }]) {
      const s = computeDefaultWindowSize(area);
      expect(s.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH);
      expect(s.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT);
    }
  });

  it('화면 정보를 못 얻으면(0·NaN·null·undefined) 무난한 기본값으로 폴백', () => {
    const fallback = { width: 1200, height: 900 };
    expect(computeDefaultWindowSize(null)).toEqual(fallback);
    expect(computeDefaultWindowSize(undefined)).toEqual(fallback);
    expect(computeDefaultWindowSize({})).toEqual(fallback);
    expect(computeDefaultWindowSize({ width: 0, height: 0 })).toEqual(fallback);
    expect(computeDefaultWindowSize({ width: Number.NaN, height: 900 })).toEqual(fallback);
    expect(computeDefaultWindowSize({ width: -1920, height: 1040 })).toEqual(fallback);
  });

  it('정수만 반환한다 (BrowserWindow 는 소수 크기를 반올림해 예측 불가한 오차를 만든다)', () => {
    const s = computeDefaultWindowSize({ width: 1367, height: 769 });
    expect(Number.isInteger(s.width)).toBe(true);
    expect(Number.isInteger(s.height)).toBe(true);
  });
});

// 배선 가드: createWindow 는 electron 의존이라 단위 테스트로 못 띄운다(ipc-handlers 하네스도
// BrowserWindow 생성은 다루지 않는다). settings-defaults-drift 와 같은 소스 스캔으로 최소 계약만.
describe('createWindow 배선 가드', () => {
  const MAIN_SRC = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf-8');

  it('창 크기를 window-size 모듈에서 받아 쓴다', () => {
    expect(MAIN_SRC).toMatch(/computeDefaultWindowSize\(\s*screen\.getPrimaryDisplay\(\)\.workAreaSize\s*\)/);
  });

  it('고정 크기로 되돌아가지 않았다 (하드코딩 복귀 차단)', () => {
    // QA27(D-Low): 창이 200자였다 — 옵션 객체 앞쪽 200자를 넘긴 자리에 `width: 1200` 을 넣으면
    // 그대로 통과했다. 생성부 옵션 객체 전체를 보고, 주석은 걷어낸 뒤 판정한다.
    const start = MAIN_SRC.indexOf('new BrowserWindow({');
    expect(start, 'BrowserWindow 생성부를 찾지 못했다 — 가드가 무력화된 상태다').toBeGreaterThan(-1);
    const end = MAIN_SRC.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const code = MAIN_SRC.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code, '창 크기가 다시 하드코딩됐다').not.toMatch(/\bwidth:\s*\d+/);
    expect(code, '창 크기가 다시 하드코딩됐다').not.toMatch(/\bheight:\s*\d+/);
  });
});

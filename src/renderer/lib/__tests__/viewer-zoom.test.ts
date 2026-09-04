// PdfViewer 수동 확대·축소의 순수 계산 — 배율 스텝·clamp·렌더 scale 합성·스크롤 앵커.
// 컴포넌트 밖으로 뺀 이유: happy-dom 은 canvas/레이아웃이 없어 배율 산술을 DOM 으로는 검증할 수
// 없다. 여기서 수치를 못박고, 컴포넌트 테스트는 "이 함수의 결과가 렌더에 반영되는가" 만 본다.

import { describe, it, expect } from 'vitest';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP_BUTTON,
  ZOOM_STEP_WHEEL,
  clampZoom,
  stepZoom,
  composeRenderScale,
  formatZoomPercent,
  findScrollAnchor,
  scrollTopForAnchor,
} from '../viewer-zoom';

describe('clampZoom', () => {
  it('범위 안 값은 그대로, 밖은 상·하한으로', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
  });

  it('숫자가 아니면 1(화면 맞춤) 로 — localStorage 손상값 방어', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('범위는 50%~300% 이고 버튼 25%·휠 10% 스텝이다', () => {
    expect(ZOOM_MIN).toBe(0.5);
    expect(ZOOM_MAX).toBe(3);
    expect(ZOOM_STEP_BUTTON).toBe(0.25);
    expect(ZOOM_STEP_WHEEL).toBe(0.1);
  });
});

describe('stepZoom', () => {
  it('+1 은 스텝만큼 올리고 -1 은 내린다', () => {
    expect(stepZoom(1, 1, ZOOM_STEP_BUTTON)).toBe(1.25);
    expect(stepZoom(1, -1, ZOOM_STEP_BUTTON)).toBe(0.75);
  });

  it('부동소수 누적 오차 없이 소수 둘째 자리로 정리된다 (0.1 스텝 ×3 = 1.3)', () => {
    let z = 1;
    for (let i = 0; i < 3; i++) z = stepZoom(z, 1, ZOOM_STEP_WHEEL);
    expect(z).toBe(1.3);
  });

  it('상·하한에서 더 밀어도 넘지 않는다', () => {
    expect(stepZoom(ZOOM_MAX, 1, ZOOM_STEP_BUTTON)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1, ZOOM_STEP_WHEEL)).toBe(ZOOM_MIN);
  });
});

describe('composeRenderScale', () => {
  it('100% 는 종전 자동 fit 과 픽셀 단위로 동일하다 (0.6~2.0 clamp 유지)', () => {
    expect(composeRenderScale(0.5, 1)).toBe(0.6);   // 좁은 패널 → 하한
    expect(composeRenderScale(1.3, 1)).toBe(1.3);   // 범위 안 → 그대로
    expect(composeRenderScale(2.7, 1)).toBe(2);     // 넓은 패널 → 상한
  });

  it('배율은 fit clamp 뒤에 곱한다 — 좁은 패널에서 200% 는 1.2', () => {
    expect(composeRenderScale(0.5, 2)).toBeCloseTo(1.2, 10);
  });

  it('최종 scale 은 메모리 보호 절대 상한 4.0 을 넘지 않는다 (fit 2.0 × 300%)', () => {
    expect(composeRenderScale(2.7, 3)).toBe(4);
  });
});

describe('formatZoomPercent', () => {
  it('정수 퍼센트 문자열', () => {
    expect(formatZoomPercent(1)).toBe('100%');
    expect(formatZoomPercent(1.25)).toBe('125%');
    expect(formatZoomPercent(0.5)).toBe('50%');
  });

  it('휠 스텝의 부동소수도 반올림된다 (1.1 → 110%, 0.7 → 70%)', () => {
    expect(formatZoomPercent(1.1)).toBe('110%');
    expect(formatZoomPercent(0.7)).toBe('70%');
  });
});

describe('스크롤 앵커 — 배율 변경 전후로 같은 페이지의 같은 지점을 본다', () => {
  // 슬롯 3개: [0,800) [812,1612) [1624,2424) (gap 12)
  const slots = [
    { top: 0, height: 800 },
    { top: 812, height: 800 },
    { top: 1624, height: 800 },
  ];

  it('뷰포트 중앙이 놓인 페이지와 페이지 안 상대 위치를 잡는다', () => {
    // scrollTop 1000, 뷰포트 400 → 중앙 1200 → 2페이지(812~1612) 의 (1200-812)/800 = 0.485
    const a = findScrollAnchor(1000, 400, slots);
    expect(a).toEqual({ index: 1, fraction: 0.485 });
  });

  it('중앙이 슬롯 사이 간격에 떨어지면 직전 페이지의 끝(1.0) 으로 잡는다', () => {
    // 중앙 805 → 1페이지(0~800) 끝을 지난 gap → index 0, fraction 1
    const a = findScrollAnchor(605, 400, slots);
    expect(a).toEqual({ index: 0, fraction: 1 });
  });

  it('문서 맨 위(중앙이 첫 슬롯 앞)는 첫 페이지 0.0', () => {
    // 중앙 200 < 첫 슬롯 top 500 → 음수 fraction 을 0 으로 clamp
    expect(findScrollAnchor(0, 400, [{ top: 500, height: 800 }])).toEqual({ index: 0, fraction: 0 });
  });

  it('슬롯이 없으면 null', () => {
    expect(findScrollAnchor(0, 400, [])).toBeNull();
  });

  it('배율을 2배로 키운 슬롯에서 같은 앵커의 scrollTop 을 되돌린다', () => {
    const doubled = slots.map((s) => ({ top: s.top * 2, height: s.height * 2 }));
    const a = findScrollAnchor(1000, 400, slots)!;
    // 2페이지 top 1624, height 1600 → 1624 + 0.485×1600 − 200 = 2200
    expect(scrollTopForAnchor(a, doubled, 400)).toBe(2200);
  });

  it('되돌린 scrollTop 은 음수가 되지 않는다', () => {
    const a = { index: 0, fraction: 0 };
    expect(scrollTopForAnchor(a, slots, 400)).toBe(0);
  });

  it('앵커 인덱스가 슬롯 범위를 벗어나면(문서 교체) null', () => {
    expect(scrollTopForAnchor({ index: 7, fraction: 0.5 }, slots, 400)).toBeNull();
  });
});

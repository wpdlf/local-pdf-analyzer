/**
 * PdfViewer 수동 확대·축소 — 순수 계산 (v1.6.0).
 *
 * 뷰어는 종전에 패널 너비 기반 자동 fit(0.6~2.0 clamp) 만 있었다. 작은 글씨 논문·스캔 PDF 의
 * 도표 확인에 바로 걸리는 공백이라 배율(zoom)을 얹는다. 산술을 컴포넌트 밖에 두는 이유:
 * happy-dom 에는 canvas/레이아웃이 없어 배율 수치를 DOM 으로 검증할 수 없다 — 여기서 못박고
 * 컴포넌트 테스트는 "결과가 렌더에 반영되는가" 만 본다.
 */

/** 배율 범위 50%~300%. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** 툴바 버튼·Ctrl+키 스텝. */
export const ZOOM_STEP_BUTTON = 0.25;
/** Ctrl+휠 스텝 — 휠 한 눈금마다 25% 는 너무 거칠다. */
export const ZOOM_STEP_WHEEL = 0.1;

/** 종전 자동 fit 의 clamp — 100% 가 이전과 픽셀 단위로 같아야 하므로 값을 유지한다. */
const FIT_SCALE_MIN = 0.6;
const FIT_SCALE_MAX = 2.0;
/**
 * 최종 렌더 scale 의 절대 상한(메모리 보호). fit 2.0 × 300% = 6.0 이면 A4 한 장이
 * 3570×5050px ≈ 72MB 다. 4.0 이면 ≈ 32MB — LRU 윈도우(±2 뷰포트)가 상주 장수를 제한하므로
 * 이 정도가 안전선.
 */
const RENDER_SCALE_ABSOLUTE_MAX = 4.0;

/** 범위 밖·비정상 값 방어. 숫자가 아니면 1(화면 맞춤) — localStorage 손상값이 여기로 온다. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** 한 스텝 이동. 부동소수 누적(0.1×3 = 0.30000000000000004) 을 소수 둘째 자리로 정리한다. */
export function stepZoom(zoom: number, direction: 1 | -1, step: number): number {
  const next = Math.round((zoom + direction * step) * 100) / 100;
  return clampZoom(next);
}

/**
 * 렌더 scale 합성. 배율은 fit 을 **clamp 한 뒤** 곱한다 — 그래야 100% 가 종전 동작과 동일하고,
 * 좁은 패널(fit 하한 0.6)에서 200% 가 1.2 로 예측 가능하다.
 */
export function composeRenderScale(fitScale: number, zoom: number): number {
  const fit = Math.min(FIT_SCALE_MAX, Math.max(FIT_SCALE_MIN, fitScale));
  return Math.min(RENDER_SCALE_ABSOLUTE_MAX, fit * clampZoom(zoom));
}

export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** 페이지 슬롯의 세로 위치 — 컨테이너 기준 offsetTop 과 높이. */
export interface SlotRect {
  top: number;
  height: number;
}

/** 배율 변경 전후로 유지할 지점 — 뷰포트 중앙이 놓인 페이지와 그 페이지 안 상대 위치(0~1). */
export interface ScrollAnchor {
  index: number;
  fraction: number;
}

/**
 * 뷰포트 중앙이 놓인 슬롯을 찾는다. 중앙이 슬롯 사이 간격(gap)에 떨어지면 직전 슬롯의 끝(1.0),
 * 첫 슬롯 앞이면 첫 슬롯의 시작(0.0). 슬롯이 없으면 null.
 */
export function findScrollAnchor(scrollTop: number, viewportHeight: number, slots: readonly SlotRect[]): ScrollAnchor | null {
  if (slots.length === 0) return null;
  const center = scrollTop + viewportHeight / 2;
  let index = 0;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.top <= center) index = i;
    else break;
  }
  const slot = slots[index]!;
  const raw = slot.height > 0 ? (center - slot.top) / slot.height : 0;
  const fraction = Math.min(1, Math.max(0, raw));
  return { index, fraction };
}

/**
 * 새 레이아웃(배율 반영 슬롯)에서 같은 앵커를 뷰포트 중앙에 두는 scrollTop.
 * 앵커 인덱스가 슬롯 범위 밖(문서 교체 등)이면 null — 호출자는 복원을 건너뛴다.
 */
export function scrollTopForAnchor(anchor: ScrollAnchor, slots: readonly SlotRect[], viewportHeight: number): number | null {
  const slot = slots[anchor.index];
  if (!slot) return null;
  const target = slot.top + anchor.fraction * slot.height - viewportHeight / 2;
  return Math.max(0, target);
}

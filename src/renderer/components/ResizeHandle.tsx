// DR-01: 리사이즈 핸들 — 드래그 + 키보드(화살표/Home/End)로 패널 비율 조정.
//
// QA32 후속: 세로 분할(요약 본문 ↔ Q&A)이 추가되면서 **축을 일반화**했다. 복제하면 키보드
// 접근성·포인터 캡처·커서 강제 같은 세부가 한쪽에만 반영되는 형제 누락이 난다(이 저장소의
// 최다 결함 클래스). 값도 store 에서 직접 읽지 않고 props 로 받아, 어떤 비율에도 붙는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import type { TranslationKey } from '../lib/i18n';

interface ResizeHandleProps {
  /** 리사이즈 기준이 되는 외곽 컨테이너 — client 크기 측정에 사용 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 분할 축. horizontal = 좌우 분할(세로 막대) / vertical = 상하 분할(가로 막대) */
  axis?: 'horizontal' | 'vertical';
  /** 현재 비율(0.2~0.8) */
  ratio: number;
  /** 새 비율 — clamp 는 store setter 가 한다 */
  onChange: (ratio: number) => void;
  /**
   * 드래그 방향과 비율의 부호가 반대인가.
   *
   * 좌우 분할의 저장값은 **우측 패널의 몫**이라, 핸들을 왼쪽으로 끌면 값이 **커진다**.
   * 상하 분할의 저장값은 **위 패널의 몫**이라 아래로 끌면 커진다 — 부호가 서로 다르다.
   */
  invert?: boolean;
  /** 스크린리더 라벨 키(i18n) */
  labelKey: TranslationKey;
}

const KEYBOARD_STEP = 0.02; // 2% per arrow press
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

export function ResizeHandle({
  containerRef, axis = 'horizontal', ratio, onChange, invert = false, labelKey,
}: ResizeHandleProps) {
  const t = useT();
  const isVertical = axis === 'vertical';
  const [isDragging, setIsDragging] = useState(false);
  // 드래그 시작 시점의 baseline — 이동 거리를 기반으로 새 비율 계산.
  // 매 pointermove 마다 store 업데이트로 re-render 가 일어나도 부담 없음(zustand + 단일 숫자).
  const startPosRef = useRef<{ pos: number; size: number; startRatio: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const size = isVertical ? container.clientHeight : container.clientWidth;
    startPosRef.current = { pos: isVertical ? e.clientY : e.clientX, size, startRatio: ratio };
    setIsDragging(true);
    // 포인터 캡처로 drag 중 pointer leave 에도 이벤트 수신
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [containerRef, isVertical, ratio]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !startPosRef.current) return;
    const { pos, size, startRatio } = startPosRef.current;
    if (size <= 0) return;
    const deltaPx = (isVertical ? e.clientY : e.clientX) - pos;
    const deltaRatio = (invert ? -deltaPx : deltaPx) / size;
    onChange(startRatio + deltaRatio); // clamp 는 setter 내부
  }, [isDragging, isVertical, invert, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    startPosRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [isDragging]);

  // 키보드 접근성 — 축에 맞는 방향키로 비율 조정
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const [decKey, incKey] = isVertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    let delta = 0;
    // 좌우는 저장값이 반대편 몫이라 부호가 뒤집힌다(invert 와 같은 사유).
    if (e.key === decKey) delta = invert ? KEYBOARD_STEP : -KEYBOARD_STEP;
    else if (e.key === incKey) delta = invert ? -KEYBOARD_STEP : KEYBOARD_STEP;
    // v0.18.19 patch R32 P3: WAI-ARIA separator 관례에 맞춰 Home=MIN, End=MAX 로 정합.
    // 이전엔 invert 되어 있어 스크린리더 사용자가 예상과 반대 동작에 혼란을 겪던 결함.
    else if (e.key === 'Home') {
      e.preventDefault();
      onChange(MIN_RATIO);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(MAX_RATIO);
      return;
    } else {
      return;
    }
    e.preventDefault();
    onChange(ratio + delta);
  }, [isVertical, invert, ratio, onChange]);

  // 드래그 중 커서를 body 에 강제 (모든 요소 위에서도 리사이즈 커서 유지)
  useEffect(() => {
    if (!isDragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isDragging, isVertical]);

  return (
    <div
      role="separator"
      // WAI-ARIA: separator 자신의 방향이다 — 상하를 가르는 것은 **가로** 막대다.
      aria-orientation={isVertical ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-label={t(labelKey)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className={`shrink-0 bg-gray-200 dark:bg-gray-700 hover:bg-blue-400 dark:hover:bg-blue-500 focus:bg-blue-500 dark:focus:bg-blue-400 transition-colors outline-none ${
        isVertical
          ? 'h-1 hover:h-1.5 focus:h-1.5 cursor-row-resize'
          : 'w-1 hover:w-1.5 focus:w-1.5 cursor-col-resize'
      } ${isDragging ? 'bg-blue-500 dark:bg-blue-400' : ''}`}
      style={{ touchAction: 'none' }}
    />
  );
}

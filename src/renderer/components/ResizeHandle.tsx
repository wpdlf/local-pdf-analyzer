// DR-01: 가로 리사이즈 핸들 — SummaryViewer 좌/우 패널 너비를 드래그로 조정.
// 마우스 드래그 + 키보드 (화살표 키) 접근성 모두 지원.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';

interface ResizeHandleProps {
  /** 리사이즈 기준이 되는 외곽 컨테이너 — clientWidth 측정에 사용 */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const KEYBOARD_STEP = 0.02; // 2% per arrow press
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

export function ResizeHandle({ containerRef }: ResizeHandleProps) {
  const t = useT();
  const citationPanelWidth = useAppStore((s) => s.citationPanelWidth);
  const setCitationPanelWidth = useAppStore((s) => s.setCitationPanelWidth);
  const [isDragging, setIsDragging] = useState(false);
  // 드래그 시작 시점의 baseline — 마우스 이동 거리를 기반으로 새 비율 계산.
  // 매 mousemove 마다 store 업데이트로 React re-render 가 일어나 부담 없음 (zustand + 단일 숫자).
  const startPosRef = useRef<{ x: number; width: number; startRatio: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth;
    startPosRef.current = { x: e.clientX, width, startRatio: citationPanelWidth };
    setIsDragging(true);
    // 포인터 캡처로 drag 중 mouse leave 에도 이벤트 수신
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [containerRef, citationPanelWidth]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !startPosRef.current) return;
    const { x, width, startRatio } = startPosRef.current;
    if (width <= 0) return;
    // 우측 패널이 차지하는 비율 — 드래그가 왼쪽으로 가면 우측이 넓어짐
    const deltaPx = e.clientX - x;
    const deltaRatio = -deltaPx / width;
    const newRatio = startRatio + deltaRatio;
    setCitationPanelWidth(newRatio); // 내부에서 clamp
  }, [isDragging, setCitationPanelWidth]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    startPosRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [isDragging]);

  // 키보드 접근성 — 방향키로 패널 비율 조정
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = KEYBOARD_STEP; // 좌측 → 우측 넓어짐
    else if (e.key === 'ArrowRight') delta = -KEYBOARD_STEP;
    else if (e.key === 'Home') {
      e.preventDefault();
      setCitationPanelWidth(MAX_RATIO);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      setCitationPanelWidth(MIN_RATIO);
      return;
    } else {
      return;
    }
    e.preventDefault();
    setCitationPanelWidth(citationPanelWidth + delta);
  }, [citationPanelWidth, setCitationPanelWidth]);

  // 드래그 중 커서를 body 에 강제 (모든 요소 위에서도 리사이즈 커서 유지)
  useEffect(() => {
    if (!isDragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isDragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(citationPanelWidth * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-label={t('pdfviewer.resize')}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className={`shrink-0 w-1 hover:w-1.5 focus:w-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-blue-400 dark:hover:bg-blue-500 focus:bg-blue-500 dark:focus:bg-blue-400 cursor-col-resize transition-colors outline-none ${
        isDragging ? 'bg-blue-500 dark:bg-blue-400' : ''
      }`}
      style={{ touchAction: 'none' }}
    />
  );
}

// Design Ref: §4.3 PdfViewerProps, §5.1 Screen Layout, §6.2 Degraded Modes
// Plan SC: SC-03 인용 클릭 → 정확한 페이지 스크롤
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';

// pdfjs-dist worker 는 이미 pdf-parser.ts 에서 전역 설정됨 (재설정 불필요).
// 이 모듈이 먼저 import 되면 worker 가 설정 안 된 상태일 수 있어 safeguard.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(pdfjsLib.GlobalWorkerOptions.workerSrc as any)) {
  console.warn('[PdfViewer] pdfjs worker not set before mount — pdf-parser 가 먼저 import 되어야 함');
}

interface PdfViewerProps {
  /** 원본 PDF 바이트 (store.pdfBytes) */
  pdfBytes: Uint8Array;
  /** 스크롤할 대상 페이지 (1-based) */
  targetPage: number;
  /** 패널 닫기 */
  onClose: () => void;
}

const MAX_RENDER_SCALE = 2.0; // 고해상도 디스플레이 대응 상한
const MIN_RENDER_SCALE = 0.6; // 너무 작은 패널에서도 가독성 유지

/**
 * PdfViewer — pdfjs canvas 기반 페이지 렌더링.
 * 패널 너비 기반 동적 scale 계산으로 자동 fit.
 * targetPage 변경 시 해당 페이지로 scrollIntoView.
 */
export function PdfViewer({ pdfBytes, targetPage, onClose }: PdfViewerProps) {
  const t = useT();
  // t 는 UI 언어 변경 시 새 참조가 되어 effect 의존성에 두면 고비용 pdfjs 재렌더를 유발한다.
  // 렌더 효과에서는 ref 로만 참조해 언어 변경이 재렌더를 트리거하지 않도록 한다.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const renderedPagesRef = useRef<Set<number>>(new Set());
  // DR-01 리사이즈 재렌더: container 너비가 실제로 변할 때마다 증가 → 렌더 effect 재실행
  const [renderVersion, setRenderVersion] = useState(0);
  // 마지막으로 렌더된 width — 미세한 변동(스크롤바 등)에 반복 재렌더 방지
  const lastRenderedWidthRef = useRef<number>(0);

  // 1. pdfjs 로 문서 로드 (마운트 1회)
  useEffect(() => {
    let cancelled = false;
    let doc: pdfjsLib.PDFDocumentProxy | null = null;

    (async () => {
      try {
        // pdfjs.getDocument 는 전달된 버퍼를 내부적으로 transfer 할 수 있어,
        // store.pdfBytes (원본) 가 detach 되면 이후 재마운트가 실패한다.
        // 매 마운트마다 store 바이트를 보존할 fresh copy 를 1회만 할당한다.
        const copy = pdfBytes.slice();
        const loadingTask = pdfjsLib.getDocument({ data: copy });
        doc = await loadingTask.promise;
        if (cancelled) {
          try { await doc.destroy(); } catch { /* ignore */ }
          return;
        }
        pdfDocRef.current = doc;
        setTotalPages(doc.numPages);
        setLoadState('loaded');
      } catch (err) {
        if (cancelled) return;
        console.error('[PdfViewer] getDocument failed:', err);
        setErrorMessage((err as Error)?.message || 'unknown');
        setLoadState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (pdfDocRef.current) {
        const d = pdfDocRef.current;
        pdfDocRef.current = null;
        d.destroy().catch(() => { /* ignore */ });
      }
    };
  }, [pdfBytes]);

  // 2a. ResizeObserver — 컨테이너 너비가 변하면 renderVersion 증가 → 재렌더 트리거
  //     debounce 200ms 로 드래그 중 과도한 재렌더 방지
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const newWidth = container.clientWidth;
        // 미세 변동(50px 미만) 은 무시 — 동일 scale 이 유지될 가능성 높음
        if (Math.abs(newWidth - lastRenderedWidthRef.current) >= 50) {
          setRenderVersion((v) => v + 1);
        }
      }, 200);
    });
    observer.observe(container);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      observer.disconnect();
    };
  }, []);

  // 2. 각 페이지 canvas 렌더 (totalPages 설정 후 + 너비 변경 시 재렌더)
  //    TODO v0.18: 가상 스크롤 도입. 현재는 마운트 즉시 전체 페이지를 순차 렌더하므로
  //    100+ 페이지 문서에서 렌더 메모리 피크가 커진다 (Design §5.4 Phase 4 목표).
  useEffect(() => {
    if (loadState !== 'loaded' || !pdfDocRef.current || !totalPages) return;
    let cancelled = false;
    const doc = pdfDocRef.current;

    // 패널 너비 기반 동적 scale — 고정 scale 은 좁은 패널에서 확대 표시 문제.
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const availableWidth = Math.max(300, containerWidth - 24);
    lastRenderedWidthRef.current = containerWidth;
    // renderVersion 이 증가하면 기존 canvas 를 모두 제거하고 재렌더
    if (renderVersion > 0) {
      for (const wrapper of pageRefs.current) {
        if (wrapper) wrapper.querySelector('canvas')?.remove();
      }
      renderedPagesRef.current.clear();
    }

    (async () => {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (cancelled) return;
        const wrapper = pageRefs.current[pageNum - 1];
        if (!wrapper) continue;
        if (wrapper.querySelector('canvas')) continue;
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const naturalViewport = page.getViewport({ scale: 1 });
          const fitScale = availableWidth / naturalViewport.width;
          const scale = Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, fitScale));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          canvas.className = 'block shadow';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          wrapper.innerHTML = '';
          wrapper.style.width = `${canvas.width}px`;
          wrapper.style.height = `${canvas.height}px`;
          wrapper.style.minHeight = '';
          wrapper.appendChild(canvas);
          renderedPagesRef.current.add(pageNum);
          try { page.cleanup(); } catch { /* ignore */ }
        } catch (err) {
          if (cancelled) return;
          console.warn(`[PdfViewer] page ${pageNum} render failed:`, err);
          if (wrapper) {
            wrapper.innerHTML = `<div class="text-xs text-red-500 py-8 text-center">${tRef.current('pdfviewer.pageRenderFail')}</div>`;
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadState, totalPages, renderVersion]);

  // 3. targetPage 변경 시 해당 페이지로 scrollIntoView
  //    해당 페이지가 아직 렌더 안됐으면 폴링으로 대기 (최대 3초)
  useEffect(() => {
    if (loadState !== 'loaded' || !totalPages) return;
    if (targetPage < 1 || targetPage > totalPages) return;

    const scrollToPage = () => {
      const wrapper = pageRefs.current[targetPage - 1];
      if (wrapper) {
        wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    if (renderedPagesRef.current.has(targetPage)) {
      scrollToPage();
      return;
    }
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if (renderedPagesRef.current.has(targetPage)) {
        clearInterval(interval);
        scrollToPage();
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        scrollToPage();
      }
    }, 100);
    return () => clearInterval(interval);
  }, [targetPage, loadState, totalPages]);

  // 4. ESC 키로 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="flex flex-col h-full bg-white border-l dark:border-gray-700" role="region" aria-label={t('pdfviewer.title')}>
      {/* 상단 바 */}
      <div className="flex items-center justify-between px-3 py-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {t('pdfviewer.title')}
          {totalPages !== null && (
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
              {t('pdfviewer.pageOf', { current: targetPage, total: totalPages })}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm px-2 py-1"
          aria-label={t('pdfviewer.close')}
        >
          ✕
        </button>
      </div>

      {/* 본문 */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2">
        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500 dark:text-gray-400">
            <svg aria-hidden="true" className="animate-spin h-8 w-8 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm">{t('pdfviewer.loading')}</p>
          </div>
        )}
        {loadState === 'error' && (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
            <div className="text-2xl">⚠️</div>
            <p className="text-sm text-red-600 dark:text-red-400">{t('pdfviewer.renderFail')}</p>
            {errorMessage && (
              <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xs break-words">{errorMessage}</p>
            )}
          </div>
        )}
        {loadState === 'loaded' && totalPages !== null && (
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: totalPages }, (_, i) => (
              <div
                key={i}
                ref={(el) => { pageRefs.current[i] = el; }}
                className="bg-white flex items-center justify-center min-h-[200px]"
              >
                <span className="text-xs text-gray-400">
                  {t('pdfviewer.pageOf', { current: i + 1, total: totalPages })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * store.citationTarget 및 pdfBytes 와 연결된 wrapper.
 * SummaryViewer 에서 이 컴포넌트만 조건부 마운트하면 됨.
 */
export function PdfViewerPanel() {
  const citationTarget = useAppStore((s) => s.citationTarget);
  const pdfBytes = useAppStore((s) => s.pdfBytes);
  const setCitationTarget = useAppStore((s) => s.setCitationTarget);

  if (!citationTarget || !pdfBytes) return null;

  return (
    <PdfViewer
      pdfBytes={pdfBytes}
      targetPage={citationTarget.page}
      onClose={() => setCitationTarget(null)}
    />
  );
}

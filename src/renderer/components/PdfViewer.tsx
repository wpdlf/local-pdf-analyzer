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
  // pdf-parser.ts 가 여전히 primary 설정자. 여기서는 방어적 fallback 만.
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

const MAX_RENDER_SCALE = 1.5;

/**
 * 간이 PdfViewer — pdfjs canvas 기반 페이지 렌더링.
 * 초기 마운트 시 모든 페이지를 canvas 로 렌더(간단함 vs 메모리 trade-off — 500p 상한 가정)
 * targetPage 변경 시 해당 canvas 로 scrollIntoView.
 */
export function PdfViewer({ pdfBytes, targetPage, onClose }: PdfViewerProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // 1. pdfjs 로 문서 로드 (마운트 1회 — pdfBytes 가 같은 document 라이프사이클에서 불변이라고 가정)
  useEffect(() => {
    let cancelled = false;
    let doc: pdfjsLib.PDFDocumentProxy | null = null;

    (async () => {
      try {
        // pdfjs.getDocument 가 Uint8Array 를 소유할 수 있으므로 복사본 전달
        const copy = new Uint8Array(pdfBytes.byteLength);
        copy.set(pdfBytes);
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
      // 언마운트 시 pdfjs 인스턴스 해제 (메모리 회수)
      if (pdfDocRef.current) {
        const d = pdfDocRef.current;
        pdfDocRef.current = null;
        d.destroy().catch(() => { /* ignore */ });
      }
    };
  }, [pdfBytes]);

  // 2. 각 페이지 canvas 렌더 (totalPages 설정 후)
  useEffect(() => {
    if (loadState !== 'loaded' || !pdfDocRef.current || !totalPages) return;
    let cancelled = false;
    const doc = pdfDocRef.current;

    (async () => {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (cancelled) return;
        const wrapper = pageRefs.current[pageNum - 1];
        if (!wrapper) continue;
        // 이미 canvas 가 붙어 있으면 스킵 (재렌더 방지)
        if (wrapper.querySelector('canvas')) continue;
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: MAX_RENDER_SCALE });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          canvas.className = 'max-w-full h-auto shadow';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          wrapper.innerHTML = ''; // placeholder 제거
          wrapper.appendChild(canvas);
          try { page.cleanup(); } catch { /* ignore */ }
        } catch (err) {
          if (cancelled) return;
          console.warn(`[PdfViewer] page ${pageNum} render failed:`, err);
          if (wrapper) {
            wrapper.innerHTML = `<div class="text-xs text-red-500 py-8 text-center">${t('pdfviewer.pageRenderFail')}</div>`;
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadState, totalPages, t]);

  // 3. targetPage 변경 시 해당 페이지로 scrollIntoView
  useEffect(() => {
    if (loadState !== 'loaded' || !totalPages) return;
    if (targetPage < 1 || targetPage > totalPages) return;
    const wrapper = pageRefs.current[targetPage - 1];
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
                className="bg-white flex items-center justify-center min-h-[200px] w-full max-w-2xl"
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

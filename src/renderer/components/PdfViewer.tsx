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

// 모듈 레벨 PDF 문서 캐시 (DR-04).
// PdfViewer 언마운트 시(citationTarget=null) 파싱된 PDFDocumentProxy 를 버리면
// 동일 문서에 대한 재클릭마다 getDocument 가 재실행되어 전체 페이지 재파싱이 일어난다.
// pdfBytes 참조로 키잉하여 같은 문서면 캐시 재사용, 다른 Uint8Array 가 들어오면 stale 파기.
// v0.17.6: 문서 close(store.pdfBytes=null) 시 캐시 즉시 해제 — 50MB PDF 기준 2× 크기 잔류 제거.
let cachedDoc: { bytes: Uint8Array; doc: pdfjsLib.PDFDocumentProxy } | null = null;

// store.pdfBytes 가 null 로 전환되면(resetSummaryState / 문서 close) 캐시된 doc 즉시 해제.
// 모듈 스코프 단일 구독 — 앱 수명과 동일. HMR 리로드 시 dispose 로 리스너 + 캐시 정리.
const unsubscribeCacheCleanup = useAppStore.subscribe((state, prev) => {
  if (prev.pdfBytes && !state.pdfBytes && cachedDoc) {
    const stale = cachedDoc;
    cachedDoc = null;
    stale.doc.destroy().catch(() => { /* ignore */ });
  }
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pdfViewerHot = (import.meta as any).hot;
if (_pdfViewerHot) {
  _pdfViewerHot.dispose(() => {
    unsubscribeCacheCleanup();
    if (cachedDoc) {
      const stale = cachedDoc;
      cachedDoc = null;
      stale.doc.destroy().catch(() => { /* ignore */ });
    }
  });
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

  // 1. pdfjs 로 문서 로드 (pdfBytes 가 바뀔 때마다 재실행)
  useEffect(() => {
    let cancelled = false;

    // v0.18.5 H1 fix: pdfBytes 가 바뀌면(문서 전환) 이전 문서가 렌더했던 페이지 번호가
    // renderedPagesRef 에 잔존한다. 새 doc 의 targetPage 가 같은 번호로 들어오면
    // `has(targetPage) === true` 라 폴링 없이 즉시 scrollIntoView 가 발화되는데, 이때
    // 새 wrapper 는 아직 canvas 가 안 그려졌을 수 있어 빈 placeholder 로 스크롤되는 UX 저하.
    // pageRefs.current 자체는 React 가 unmount 시 ref-callback null 을 호출해 자동 cleanup 하므로
    // 명시 초기화하면 캐시 히트(same bytes) 경로에서 ref 가 비어버린다. 따라서 ref 는 건드리지 않음.
    renderedPagesRef.current.clear();
    lastRenderedWidthRef.current = 0;

    // 캐시 히트 — 동일 pdfBytes 참조면 재파싱 없이 즉시 재사용
    if (cachedDoc && cachedDoc.bytes === pdfBytes) {
      pdfDocRef.current = cachedDoc.doc;
      setTotalPages(cachedDoc.doc.numPages);
      setLoadState('loaded');
      return () => {
        // 언마운트 시에도 캐시된 doc 는 파기하지 않음 — 재마운트에서 재사용
        pdfDocRef.current = null;
      };
    }

    // 다른 bytes — stale 캐시 파기 후 새 파싱
    if (cachedDoc) {
      const stale = cachedDoc;
      cachedDoc = null;
      stale.doc.destroy().catch(() => { /* ignore */ });
    }

    (async () => {
      try {
        // pdfjs.getDocument 는 전달된 버퍼를 내부적으로 transfer 할 수 있어,
        // store.pdfBytes (원본) 가 detach 되면 이후 재마운트가 실패한다.
        // 매 마운트마다 store 바이트를 보존할 fresh copy 를 1회만 할당한다.
        const copy = pdfBytes.slice();
        const loadingTask = pdfjsLib.getDocument({ data: copy });
        const doc = await loadingTask.promise;
        if (cancelled) {
          // 파싱 중 언마운트 — 캐시하지 않고 파기
          try { await doc.destroy(); } catch { /* ignore */ }
          return;
        }
        cachedDoc = { bytes: pdfBytes, doc };
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
      // 파싱 성공 후 언마운트 — 캐시된 doc 는 유지, ref 만 해제
      pdfDocRef.current = null;
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
    // 진행 중인 RenderTask — 언마운트/리사이즈 시 cancel() 호출로 detached canvas 계속 그리는 것 방지
    let currentTask: { promise: Promise<void>; cancel: () => void } | null = null;
    const doc = pdfDocRef.current;

    // 패널 너비 기반 동적 scale — 고정 scale 은 좁은 패널에서 확대 표시 문제.
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const availableWidth = Math.max(300, containerWidth - 24);
    lastRenderedWidthRef.current = containerWidth;
    // v0.18.5 H1 fix: totalPages 가 작아지면 React 가 unmount 한 div 의 ref 는 null 로 정리되지만
    // pageRefs.current.length 자체는 그대로다. 이후 renderVersion>0 wipe 가 high index 를 traverse 할 때
    // 이미 null 인 항목을 건너뛰므로 functional 영향은 없으나, 길이를 totalPages 로 truncate 해
    // 이후 코드/디버깅에서 stale slot 이 보이지 않도록 정리.
    if (pageRefs.current.length > totalPages) {
      pageRefs.current.length = totalPages;
    }
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
          const task = page.render({ canvasContext: ctx, viewport });
          currentTask = task as unknown as { promise: Promise<void>; cancel: () => void };
          await task.promise;
          currentTask = null;
          if (cancelled) return;
          wrapper.innerHTML = '';
          wrapper.style.width = `${canvas.width}px`;
          wrapper.style.height = `${canvas.height}px`;
          wrapper.style.minHeight = '';
          wrapper.appendChild(canvas);
          renderedPagesRef.current.add(pageNum);
          try { page.cleanup(); } catch { /* ignore */ }
        } catch (err) {
          currentTask = null;
          if (cancelled) return;
          // cancel() 호출로 인한 RenderingCancelledException 은 정상 흐름 — 무시하고 다음 페이지로
          if ((err as { name?: string })?.name === 'RenderingCancelledException') return;
          console.warn(`[PdfViewer] page ${pageNum} render failed:`, err);
          if (wrapper) {
            wrapper.innerHTML = '';
            const errDiv = document.createElement('div');
            errDiv.className = 'text-xs text-red-500 py-8 text-center';
            errDiv.textContent = tRef.current('pdfviewer.pageRenderFail');
            wrapper.appendChild(errDiv);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      if (currentTask) {
        try { currentTask.cancel(); } catch { /* ignore */ }
        currentTask = null;
      }
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
  //    v0.18.4 H3 fix: editable 포커스(textarea/input/contenteditable) 에서 ESC 는
  //    입력 롤백·IME 조합 취소 등 관례적 용도로 쓰이므로 가로채지 않고 흘려보낸다.
  //    (QaChat 질문 입력 중 ESC 누르면 인용 패널이 닫히던 UX 이슈 해소)
  //    v0.18.5 L1 fix: Shadow DOM 내부에 포커스가 있을 때 `document.activeElement` 는
  //    shadow 호스트를 반환하므로 단순 체크로는 내부 INPUT/TEXTAREA 를 놓친다.
  //    shadowRoot.activeElement 를 재귀적으로 따라가 실제 포커스 element 를 찾는다.
  //    (현재 코드에 shadow DOM 위젯은 없으나, 서드파티/네이티브 위젯 도입 대비 future-proof.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Shadow DOM walk — shadowRoot 이 있으면 내부 activeElement 로 내려간다.
      let active = document.activeElement as Element | null;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      if (active) {
        const tag = active.tagName;
        const editable = (active as HTMLElement).isContentEditable;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) {
          return;
        }
      }
      e.preventDefault();
      onClose();
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

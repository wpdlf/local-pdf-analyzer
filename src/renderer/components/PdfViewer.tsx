// Design Ref: §4.3 PdfViewerProps, §5.1 Screen Layout, §6.2 Degraded Modes
// Plan SC: SC-03 인용 클릭 → 정확한 페이지 스크롤
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { loadPdfjs, isReReadablePath } from '../lib/pdf-parser';
import { extractOutline, type OutlineNode } from '../lib/pdf-outline';

// pdfjs-dist 는 지연 로딩(성능): 정적 import 를 제거해 콜드스타트 eager 번들에서 제외하고,
// 문서 로드 시 pdf-parser 의 loadPdfjs() 로 동적 로드한다(워커 설정 단일 출처). 로더가 워커를
// idempotent 하게 설정하므로 이전의 "worker 미설정" safeguard 경고는 불필요해 제거.

// 모듈 레벨 PDF 문서 캐시 (DR-04).
// PdfViewer 언마운트 시(citationTarget=null) 파싱된 PDFDocumentProxy 를 버리면
// 동일 문서에 대한 재클릭마다 getDocument 가 재실행되어 전체 페이지 재파싱이 일어난다.
// pdfBytes 참조로 키잉하여 같은 문서면 캐시 재사용, 다른 Uint8Array 가 들어오면 stale 파기.
// v0.17.6: 문서 close(store.pdfBytes=null) 시 캐시 즉시 해제 — 50MB PDF 기준 2× 크기 잔류 제거.
// pdfjs 6.x: PDFDocumentProxy.destroy() 제거 → 파기는 loadingTask.destroy() 로. 캐시 해제 시
// 워커/문서를 함께 끊으려면 loadingTask 참조도 함께 보관해야 한다.
let cachedDoc: {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  loadingTask: PDFDocumentLoadingTask;
} | null = null;

// store.pdfBytes 가 null 로 전환되면(resetSummaryState / 문서 close) 캐시된 doc 즉시 해제.
// 모듈 스코프 단일 구독 — 앱 수명과 동일. HMR 리로드 시 dispose 로 리스너 + 캐시 정리.
// v0.18.19 patch R32 P3 주의: 본 PdfViewer 모듈을 lazy-import 로 전환하면, 사용자가
// 1st PdfViewer 마운트 전에 pdfBytes 가 null 로 떨어지는 케이스에서 본 구독이 아직 등록되지
// 않아 cleanup 누락 가능. 현재는 SummaryViewer 가 정적 import 하므로 latent (Surface 3 P5).
const unsubscribeCacheCleanup = useAppStore.subscribe((state, prev) => {
  if (prev.pdfBytes && !state.pdfBytes && cachedDoc) {
    const stale = cachedDoc;
    cachedDoc = null;
    stale.loadingTask.destroy().catch(() => { /* ignore */ });
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
      stale.loadingTask.destroy().catch(() => { /* ignore */ });
    }
  });
}

interface PdfViewerProps {
  /** 원본 PDF 바이트 (store.pdfBytes) */
  pdfBytes: Uint8Array;
  /** 스크롤할 대상 페이지 (1-based) */
  targetPage: number;
  /**
   * v0.28.1 M1: 점프 nonce. 동일 targetPage 를 다시 지정해도 이 값이 바뀌면 scroll effect
   * 가 재발화해 재스크롤된다. (목차에서 현재 대상 페이지 항목 클릭 no-op 방지)
   */
  jumpNonce?: number;
  /** 패널 닫기 */
  onClose: () => void;
}

const MAX_RENDER_SCALE = 2.0; // 고해상도 디스플레이 대응 상한
const MIN_RENDER_SCALE = 0.6; // 너무 작은 패널에서도 가독성 유지
// 렌더 lookahead 윈도우: 뷰포트 위/아래 1배 분 미리 렌더.
const RENDER_ROOT_MARGIN = '100% 0px';
// canvas 유지(LRU) 윈도우: 뷰포트 위/아래 2배 분까지 canvas 보존, 그 밖은 placeholder 로 해제.
// 렌더 윈도우(±1)보다 1뷰포트 넓어 경계 근처 스크롤 지터에서 렌더↔해제 thrash 를 막는 히스테리시스.
const EVICT_ROOT_MARGIN = '200% 0px';

/**
 * PdfViewer — pdfjs canvas 기반 페이지 렌더링.
 * 패널 너비 기반 동적 scale 계산으로 자동 fit.
 * targetPage 변경 시 해당 페이지로 scrollIntoView.
 */
export function PdfViewer({ pdfBytes, targetPage, jumpNonce = 0, onClose }: PdfViewerProps) {
  const t = useT();
  // t 는 UI 언어 변경 시 새 참조가 되어 effect 의존성에 두면 고비용 pdfjs 재렌더를 유발한다.
  // 렌더 효과에서는 ref 로만 참조해 언어 변경이 재렌더를 트리거하지 않도록 한다.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  // 활성 인용 대상 페이지 — LRU 해제에서 제외하기 위한 ref(렌더 effect 가 targetPage 를 의존성에
  // 두지 않으므로 closure stale 회피). 먼 페이지로 점프할 때 smooth 스크롤 도중 막 렌더한
  // 대상 canvas 가 (아직 윈도우 밖이라) 해제되어 도착 시 빈 화면이 되는 레이스를 막는다.
  const targetPageRef = useRef(targetPage);
  useEffect(() => { targetPageRef.current = targetPage; }, [targetPage]);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const renderedPagesRef = useRef<Set<number>>(new Set());
  // R30 (v0.18.17): targetPage 폴링 / 외부 트리거에서 명시적으로 페이지 렌더를 enqueue
  // 할 수 있도록 ref 로 노출. effect 가 재실행될 때마다 새 enqueue 로 덮어씌워짐.
  const enqueueRenderRef = useRef<((pageNum: number) => void) | null>(null);
  // DR-01 리사이즈 재렌더: container 너비가 실제로 변할 때마다 증가 → 렌더 effect 재실행
  const [renderVersion, setRenderVersion] = useState(0);
  // 목차(아웃라인) — 로드된 doc 에서 pdfjs getOutline 으로 마운트 시 1회 추출. 영속화 안 함.
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [showOutline, setShowOutline] = useState(false);

  // 목차 항목 클릭 → citationTarget 갱신(인용 점프와 동일 경로). PdfViewerPanel 이
  // targetPage 를 다시 내려 effect 3 의 폴링 스크롤이 발화한다.
  const handleOutlineJump = (page: number) => {
    useAppStore.getState().setCitationTarget({ page });
  };
  // 마지막으로 렌더된 width — 미세한 변동(스크롤바 등)에 반복 재렌더 방지
  const lastRenderedWidthRef = useRef<number>(0);

  // 1. pdfjs 로 문서 로드 (pdfBytes 가 바뀔 때마다 재실행)
  useEffect(() => {
    let cancelled = false;
    // QA M1: in-flight getDocument 를 언마운트 시 즉시 취소할 수 있도록 effect 스코프로 hoist.
    // IIFE 내부 const 였을 때는 cleanup 에서 닿지 못해 워커 작업이 promise resolve 까지 잔존했다.
    let loadingTask: PDFDocumentLoadingTask | null = null;

    // v0.18.5 H1 fix: pdfBytes 가 바뀌면(문서 전환) 이전 문서가 렌더했던 페이지 번호가
    // renderedPagesRef 에 잔존한다. 새 doc 의 targetPage 가 같은 번호로 들어오면
    // `has(targetPage) === true` 라 폴링 없이 즉시 scrollIntoView 가 발화되는데, 이때
    // 새 wrapper 는 아직 canvas 가 안 그려졌을 수 있어 빈 placeholder 로 스크롤되는 UX 저하.
    // pageRefs.current 자체는 React 가 unmount 시 ref-callback null 을 호출해 자동 cleanup 하므로
    // 명시 초기화하면 캐시 히트(same bytes) 경로에서 ref 가 비어버린다. 따라서 ref 는 건드리지 않음.
    renderedPagesRef.current.clear();
    lastRenderedWidthRef.current = 0;
    // 캐시 히트 — 동일 pdfBytes 참조면 재파싱 없이 즉시 재사용
    const isCacheHit = cachedDoc != null && cachedDoc.bytes === pdfBytes;
    // 문서 전환 시에만 목차/사이드바 상태 초기화. 동일 bytes 캐시 히트(같은 문서 재진입)에서는
    // 사용자가 열어둔 목차 사이드바를 보존한다. (L-ux: 매 재마운트마다 강제 닫힘 방지)
    if (!isCacheHit) {
      setOutline([]);
      setShowOutline(false);
    }

    if (isCacheHit && cachedDoc) {
      pdfDocRef.current = cachedDoc.doc;
      setTotalPages(cachedDoc.doc.numPages);
      setLoadState('loaded');
      void extractOutline(cachedDoc.doc).then((o) => { if (!cancelled) setOutline(o); });
      return () => {
        // 언마운트 시에도 캐시된 doc 는 파기하지 않음 — 재마운트에서 재사용
        cancelled = true;
        pdfDocRef.current = null;
      };
    }

    // 다른 bytes — stale 캐시 파기 후 새 파싱
    if (cachedDoc) {
      const stale = cachedDoc;
      cachedDoc = null;
      stale.loadingTask.destroy().catch(() => { /* ignore */ });
    }

    (async () => {
      try {
        // pdfjs.getDocument 는 전달된 버퍼를 내부적으로 transfer 할 수 있어,
        // store.pdfBytes (원본) 가 detach 되면 이후 재마운트가 실패한다.
        // 매 마운트마다 store 바이트를 보존할 fresh copy 를 1회만 할당한다.
        const copy = pdfBytes.slice();
        const pdfjs = await loadPdfjs();
        if (cancelled) return; // 동적 로드 중 언마운트 — getDocument 진입 전 조기 종료
        loadingTask = pdfjs.getDocument({ data: copy });
        const doc = await loadingTask.promise;
        if (cancelled) {
          // 파싱 중 언마운트 — 캐시하지 않고 파기 (pdfjs 6.x: loadingTask 로 파기)
          try { await loadingTask.destroy(); } catch { /* ignore */ }
          return;
        }
        cachedDoc = { bytes: pdfBytes, doc, loadingTask };
        pdfDocRef.current = doc;
        setTotalPages(doc.numPages);
        setLoadState('loaded');
        void extractOutline(doc).then((o) => { if (!cancelled) setOutline(o); });
      } catch (err) {
        if (cancelled) return;
        console.error('[PdfViewer] getDocument failed:', err);
        setErrorMessage((err as Error)?.message || 'unknown');
        setLoadState('error');
      }
    })();

    return () => {
      cancelled = true;
      // QA M1: 로딩 중 언마운트면 워커/fetch 파이프라인을 즉시 취소. promise 가 이미
      // resolve 됐으면 위 cancelled 분기에서 doc.destroy() 가 처리하므로 중복 안전.
      loadingTask?.destroy().catch(() => { /* ignore */ });
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

  // 2. 페이지 canvas — on-demand 렌더 + LRU 윈도잉 (v0.18.16 가상화 → 메모리 H1 윈도잉).
  //    이전 구현은 마운트 즉시 모든 페이지를 순차 렌더해 500p 문서에서 메모리 피크가
  //    수백 MB 까지 치솟았다. 이제 IntersectionObserver 로 뷰포트(+ 위/아래 1배 분) 안에
  //    들어오는 페이지만 렌더 큐에 등록하고 worker 가 한 번에 한 페이지씩 처리한다.
  //    추가로(메모리 H1): 한 번 렌더된 canvas 를 영구 보존하면 500p 정독 시 방문 페이지가
  //    전부 쌓여 ~1GB(2MB/page)까지 누적됐다. 이제 별도 eviction IO(±2 뷰포트)로 윈도우를
  //    벗어난 페이지의 canvas 를 placeholder 로 되돌려, 상주 메모리를 방문 페이지 전체가
  //    아닌 "현재 윈도우 크기"(페이지 수와 무관, 뷰포트 면적 × 상수)로 제한한다. 스크롤백
  //    시엔 렌더 IO 가 재진입을 감지해 다시 그리며, 높이 보존으로 스크롤 위치 점프는 없다.
  useEffect(() => {
    if (loadState !== 'loaded' || !pdfDocRef.current || !totalPages) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let currentTask: { promise: Promise<void>; cancel: () => void } | null = null;
    const doc = pdfDocRef.current;

    // 패널 너비 기반 동적 scale — 한 번 계산하고 effect 전체에서 공유.
    const containerWidth = container.clientWidth;
    const availableWidth = Math.max(300, containerWidth - 24);
    lastRenderedWidthRef.current = containerWidth;
    // v0.18.5 H1 fix: totalPages 가 작아지면 unmount 된 ref 는 null 이지만 length 는 유지된다.
    // 길이를 totalPages 로 truncate 해 디버깅 시 stale slot 이 안 보이도록.
    if (pageRefs.current.length > totalPages) {
      pageRefs.current.length = totalPages;
    }
    // R31 (v0.18.18 patch): canvas 재사용 버그 수정.
    // 이전엔 `renderVersion > 0` 일 때만 canvas 를 청소했는데, 새 문서 로드 (pdfBytes 변경)
    // 시 totalPages 가 같으면 React 가 wrapper DOM 을 재사용해 이전 문서의 canvas 가 남아
    // 새 문서에 표시되는 회귀 발생. effect 진입 시점에 무조건 정리하면 회귀 차단 + 비용 미미.
    // (canvas 재할당 비용은 어차피 즉시 enqueue 로 다시 발생하므로 사실상 동일.)
    for (const wrapper of pageRefs.current) {
      if (wrapper) {
        // canvas 뿐 아니라 이전 렌더에서 박힌 "페이지 렌더링 실패" 에러 placeholder 까지 모두 제거.
        // (canvas 만 지우면 문서 교체 후에도 에러 div 가 새 문서 위에 잔존하던 문제 — 빨간 문구 고착)
        wrapper.replaceChildren();
        // 기존에 actual height 가 인라인으로 박혀 있다면 placeholder min-height 로 복귀.
        // 다음 렌더에서 새 scale 의 실제 높이로 다시 박힘.
        wrapper.style.width = '';
        wrapper.style.height = '';
      }
    }
    renderedPagesRef.current.clear();

    // ─── 단일 렌더 큐 ───
    // pdfjs worker 는 단일 스레드이므로 N개 페이지 병렬 요청은 결국 worker 큐로 직렬화된다.
    // JS 측에서 직접 직렬화하면 첫 페이지가 가장 빨리 그려지고 가시성 우선순위 보존이 쉽다.
    const queue: number[] = [];
    let pumping = false;
    const enqueue = (pageNum: number): void => {
      if (cancelled) return;
      if (pageNum < 1 || pageNum > totalPages) return;
      if (renderedPagesRef.current.has(pageNum)) return;
      if (queue.indexOf(pageNum) !== -1) return;
      queue.push(pageNum);
      void pump();
    };
    // R30: targetPage 폴링이 IO 발화에 의존하지 않고 직접 렌더를 요청할 수 있도록 노출.
    enqueueRenderRef.current = enqueue;
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      while (queue.length > 0 && !cancelled) {
        const pageNum = queue.shift()!;
        if (renderedPagesRef.current.has(pageNum)) continue;
        const wrapper = pageRefs.current[pageNum - 1];
        if (!wrapper) continue;
        if (wrapper.querySelector('canvas')) {
          renderedPagesRef.current.add(pageNum);
          continue;
        }
        // QA(메모리): 큐에 적재된 뒤 pump 가 도달하기 전 ±2 뷰포트(EVICT 윈도우)를 벗어난
        // 페이지는 렌더하지 않는다. 중속 스크롤로 통과한 페이지가 윈도우 밖에 canvas 로 박혀
        // (evict IO 는 canvas 부재 시 no-op 으로 흘렸음) LRU 상주 바운드를 무력화하던 누수 방지.
        // 활성 인용 대상은 먼 점프 도중 윈도우 밖이라도 렌더해야 하므로 예외. (happy-dom 은 rect
        // 가 0 이라 cr.height>0 가드로 skip 되지 않음 — 테스트 동작 보존.)
        if (pageNum !== targetPageRef.current) {
          const cr = container.getBoundingClientRect();
          const wr = wrapper.getBoundingClientRect();
          const margin = cr.height * 2;
          if (cr.height > 0 && (wr.bottom < cr.top - margin || wr.top > cr.bottom + margin)) continue;
        }
        // 문서 교체 가드: doc-load effect 가 pdfBytes 변경 시 이 doc 을 파기했을 수 있다
        // (렌더 effect 는 loadState/totalPages 가 갱신될 때까지 재실행 안 됨). 파기된 doc 으로
        // 렌더를 시작하지 않고 종료 — 곧 새 doc 의 렌더 effect 가 인수한다.
        if (pdfDocRef.current !== doc) { pumping = false; return; }
        try {
          const page = await doc.getPage(pageNum);
          try {
            if (cancelled) { pumping = false; return; }
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
            // pdfjs 6.x: render 에 canvas 필수(canvasContext deprecated)
            const task = page.render({ canvas, canvasContext: ctx, viewport });
            currentTask = task as unknown as { promise: Promise<void>; cancel: () => void };
            await task.promise;
            currentTask = null;
            if (cancelled) { pumping = false; return; }
            wrapper.innerHTML = '';
            wrapper.style.width = `${canvas.width}px`;
            wrapper.style.height = `${canvas.height}px`;
            wrapper.style.minHeight = '';
            wrapper.appendChild(canvas);
            renderedPagesRef.current.add(pageNum);
          } finally {
            // QA(low): cancel/error/continue 어느 경로로 빠지든 page 내부 폰트·이미지 리소스 해제 보장.
            // 이전엔 happy-path 에서만 cleanup 되어 취소·에러 누적 시 메모리가 쌓였다.
            try { page.cleanup(); } catch { /* ignore */ }
          }
        } catch (err) {
          currentTask = null;
          if (cancelled) { pumping = false; return; }
          // 문서 교체/파기 레이스: doc-load effect 가 pdfBytes 변경 시 이전 doc 을 destroy 하면
          // 진행 중이던 render 가 'Transport destroyed' 등으로 실패한다. 이는 곧 새 doc 렌더가
          // 인수하므로 에러("페이지 렌더링 실패")를 표시하지 않고 조용히 종료. (교차 문서 인용
          // 클릭으로 탭 전환 시 빨간 문구가 박히던 사용자 버그의 근본 원인)
          if (pdfDocRef.current !== doc) { pumping = false; return; }
          if ((err as { name?: string })?.name === 'RenderingCancelledException') {
            // QA(low): effect 는 살아있는데 pdfjs 내부 사유로 렌더가 취소된 경우, 큐 잔여 항목이
            // 다음 스크롤 발화 전까지 방치(빈 페이지)되지 않도록 즉시 재가동한다.
            pumping = false;
            void pump();
            return;
          }
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
      pumping = false;
    };

    // ─── LRU 해제: 윈도우 밖 페이지 canvas → placeholder 복귀 (메모리 H1) ───
    // 높이를 minHeight 로 보존해 (특히 뷰포트 위쪽 페이지 해제 시) 스크롤 위치가 튀지 않게 한다.
    // renderedPagesRef 에서 제거하므로, 스크롤백으로 다시 윈도우에 들어오면 렌더 IO 가
    // 미렌더 페이지로 보고 재 enqueue → 재렌더한다.
    const evictPage = (pageNum: number): void => {
      if (pageNum === targetPageRef.current) return; // 활성 인용 대상은 점프 레이스 보호로 유지
      const wrapper = pageRefs.current[pageNum - 1];
      if (!wrapper) return;
      const canvas = wrapper.querySelector('canvas');
      if (!canvas) return; // 이미 placeholder — 해제할 것 없음
      const keepHeight = wrapper.style.height || `${canvas.height}px`;
      const placeholder = document.createElement('span');
      placeholder.className = 'text-xs text-gray-500';
      placeholder.textContent = tRef.current('pdfviewer.pageOf', { current: pageNum, total: totalPages });
      wrapper.replaceChildren(placeholder);
      wrapper.style.width = '';
      wrapper.style.height = '';
      wrapper.style.minHeight = keepHeight; // 슬롯 높이 유지 → 레이아웃/스크롤 점프 방지
      renderedPagesRef.current.delete(pageNum);
    };

    // ─── IntersectionObserver 기반 가시성 트리거 ───
    // rootMargin '100% 0px' = 위/아래로 컨테이너 높이 1배 분 미리 감지 → 스크롤 도중에도
    // 다음 페이지가 부드럽게 준비되도록 lookahead. typeof 가드 = jsdom 미설치 노드 환경
    // (또는 일부 vitest 셋업) 대비 안전망 — 환경에 IO 가 없으면 fallback 으로 전체 렌더.
    let observer: IntersectionObserver | null = null;
    let evictObserver: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const target = entry.target as HTMLElement;
            const idx = Number(target.dataset.pageIndex);
            if (!Number.isFinite(idx)) continue;
            enqueue(idx + 1);
          }
        },
        { root: container, rootMargin: RENDER_ROOT_MARGIN, threshold: 0 },
      );
      // 해제 전용 옵저버 — 렌더보다 넓은 ±2 뷰포트. 페이지가 이 윈도우를 벗어나면(교차 해제)
      // canvas 를 placeholder 로 되돌린다. 렌더(±1)와 1뷰포트 간격이 히스테리시스로 작동.
      evictObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) continue; // 윈도우 안 — 유지
            const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
            if (!Number.isFinite(idx)) continue;
            evictPage(idx + 1);
          }
        },
        { root: container, rootMargin: EVICT_ROOT_MARGIN, threshold: 0 },
      );
      for (let i = 0; i < totalPages; i++) {
        const wrapper = pageRefs.current[i];
        if (!wrapper) continue;
        wrapper.dataset.pageIndex = String(i);
        observer.observe(wrapper);
        evictObserver.observe(wrapper);
      }
      // R30 (v0.18.17): renderVersion 증가(리사이즈 등) 후 IO 가 첫 콜백을 비동기로 fire
      // 하기까지 viewport 안 페이지가 잠깐 빈 placeholder 로 남는 race 를 방지하기 위해
      // 현재 컨테이너와 교차하는 wrapper 들을 즉시 enqueue. IO 의 첫 notification 이
      // 곧 도착해 동일 페이지를 다시 enqueue 시도해도 멱등(중복 차단).
      const containerRect = container.getBoundingClientRect();
      // rootMargin '100%' 와 동일하게 위/아래로 컨테이너 높이 1배 분 확장.
      const expandedTop = containerRect.top - containerRect.height;
      const expandedBottom = containerRect.bottom + containerRect.height;
      for (let i = 0; i < totalPages; i++) {
        const wrapper = pageRefs.current[i];
        if (!wrapper) continue;
        const r = wrapper.getBoundingClientRect();
        if (r.bottom >= expandedTop && r.top <= expandedBottom) {
          enqueue(i + 1);
        }
      }
    } else {
      // IO 미지원 환경(테스트) — 안전한 fallback: 모든 페이지 즉시 큐에 (기존 동작 보존).
      for (let i = 1; i <= totalPages; i++) enqueue(i);
    }

    return () => {
      cancelled = true;
      enqueueRenderRef.current = null;
      if (observer) observer.disconnect();
      if (evictObserver) evictObserver.disconnect();
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
    // R30 (v0.18.17): target wrapper 가 IO viewport 범위 밖이면 IO 가 발화하지 않아
    // 폴링이 maxAttempts 까지 헛돌고 placeholder 200px 기준 부정확한 scrollIntoView 로
    // 폴백하던 결함 해결. IO 발화 여부와 무관하게 직접 enqueue.
    enqueueRenderRef.current?.(targetPage);
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      // QA: 폴링 도중 렌더 effect 가 재실행되면(리사이즈→renderVersion↑) 큐·렌더기록이 비워져
      // 대상 페이지가 윈도우 밖이면 재 enqueue 되지 않아 폴링이 타임아웃되던 엣지(canvas LRU
      // 도입으로 노출). 매 틱 멱등 재요청해 큐가 비워져도 대상 렌더를 복구한다.
      enqueueRenderRef.current?.(targetPage);
      if (renderedPagesRef.current.has(targetPage)) {
        clearInterval(interval);
        scrollToPage();
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        scrollToPage();
        // L1: 폴링 소진(렌더 지연/실패) — 빈 placeholder 로 스크롤되므로 무성 실패 대신 안내.
        // QA6-C: tRef 로 참조 — deps 에 t 를 두면 UI 언어 변경(새 함수 참조)만으로 effect 가
        // 재발화해, 다른 페이지를 읽던 중에도 인용 대상 페이지로 원치 않는 재스크롤이 일어났다
        // (렌더 effect 의 tRef 정책과 대칭).
        useAppStore.getState().setNotice({ message: tRef.current('pdfviewer.jumpTimeout') });
      }
    }, 100);
    return () => clearInterval(interval);
    // jumpNonce: 동일 targetPage 재지정 시에도 effect 재실행해 재스크롤 (M1).
  }, [targetPage, jumpNonce, loadState, totalPages]);

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
        <div className="flex items-center gap-2 min-w-0">
          {/* 목차 토글 — 추출된 아웃라인이 있을 때만 노출 */}
          {outline.length > 0 && (
            <button
              type="button"
              onClick={() => setShowOutline((v) => !v)}
              aria-label={t('outline.toggle')}
              aria-pressed={showOutline}
              title={t('outline.title')}
              className={`shrink-0 inline-flex items-center justify-center min-w-[24px] min-h-[24px] text-sm rounded ${showOutline ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            >
              ☰
            </button>
          )}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
            {t('pdfviewer.title')}
            {totalPages !== null && (
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {t('pdfviewer.pageOf', { current: targetPage, total: totalPages })}
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm px-2 py-1 shrink-0"
          aria-label={t('pdfviewer.close')}
        >
          ✕
        </button>
      </div>

      {/* 본문 — 목차 사이드바(옵션) + 페이지 스크롤 영역 */}
      <div className="flex-1 min-h-0 flex">
      {showOutline && outline.length > 0 && (
        <nav
          aria-label={t('outline.title')}
          className="w-56 max-w-[40%] shrink-0 overflow-y-auto border-r dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-2"
        >
          <OutlineTree nodes={outline} onJump={handleOutlineJump} />
        </nav>
      )}
      <div
        ref={containerRef}
        role="region"
        aria-label={t('pdfviewer.title')}
        aria-busy={loadState === 'loading'}
        className="flex-1 min-h-0 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2"
      >
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
                <span className="text-xs text-gray-500">
                  {t('pdfviewer.pageOf', { current: i + 1, total: totalPages })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * 목차 트리 — 재귀 렌더. 페이지가 해석된 항목은 클릭 점프, 미해석 항목은 비클릭 라벨.
 */
function OutlineTree({
  nodes,
  onJump,
  depth = 0,
}: {
  nodes: OutlineNode[];
  onJump: (page: number) => void;
  depth?: number;
}) {
  const t = useT();
  return (
    // QA10(A-LOW): 목차는 상위 <nav aria-label={outline.title}> 랜드마크 안의 중첩 리스트로 계층을
    // 전달한다. 이전엔 role="tree"/"treeitem"+aria-level 을 부여했으나 roving tabindex·화살표
    // 탐색을 구현하지 않아(각 항목이 개별 Tab 스톱) 트리 상호작용 계약을 과선언했다 — SR 이
    // 화살표 탐색을 기대하나 미동작. 평범한 중첩 <ul>/<li> 로 강등해 실제 동작(각 버튼=Tab 스톱)과
    // 시맨틱을 일치시킨다(TabBar 가 nav>ul>li 로 role=tab 을 피한 것과 동일 판단).
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5'}>
      {nodes.map((node, i) => (
        // L-key: 인덱스 단독 대신 page+title 합성 — 동일 제목/페이지 형제도 안정적으로 구분.
        <li key={`${i}-${node.page ?? 'x'}-${node.title}`}>
          {node.page != null ? (
            <button
              type="button"
              onClick={() => onJump(node.page!)}
              // L4: 잘린 제목 전체를 hover 로 확인 가능하게 title 은 제목, 점프 안내는 aria-label.
              title={node.title}
              aria-label={t('outline.jumpToPage', { page: node.page })}
              className="block text-left w-full truncate text-xs text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:underline py-0.5"
            >
              {node.title}
            </button>
          ) : (
            <span title={node.title} className="block truncate text-xs text-gray-500 dark:text-gray-400 py-0.5">{node.title}</span>
          )}
          {node.children.length > 0 && <OutlineTree nodes={node.children} onJump={onJump} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * store.citationTarget 및 pdfBytes 와 연결된 wrapper.
 * SummaryViewer 에서 이 컴포넌트만 조건부 마운트하면 됨.
 *
 * pdfBytes 비상주(메모리 M1): 상주 바이트가 없고(경로 기반 문서) 인용 패널이 열리면 디스크에서
 * 1회 lazy 로드해 store 에 주입한다(이후 동작·캐시는 상주 경로와 동일). 로드 도중엔 스피너,
 * 실패(파일 이동/삭제·재읽기 불가)면 안내. 합성경로 드롭 문서는 파싱 시 이미 상주돼 즉시 렌더.
 */
export function PdfViewerPanel() {
  const t = useT();
  const citationTarget = useAppStore((s) => s.citationTarget);
  const citationJumpNonce = useAppStore((s) => s.citationJumpNonce);
  const pdfBytes = useAppStore((s) => s.pdfBytes);
  const filePath = useAppStore((s) => s.document?.filePath ?? null);
  const docId = useAppStore((s) => s.document?.id ?? null);
  const setCitationTarget = useAppStore((s) => s.setCitationTarget);
  const [loadFailed, setLoadFailed] = useState(false);

  // 상주 바이트가 없고 재읽기 가능한 실경로면 디스크에서 1회 로드 → store 주입.
  const canLazyLoad = !pdfBytes && !!filePath && isReReadablePath(filePath) && !!docId;
  useEffect(() => {
    if (!canLazyLoad || !filePath || !docId) return;
    let cancelled = false;
    setLoadFailed(false);
    (async () => {
      let bytes: Uint8Array | null = null;
      try {
        const res = await window.electronAPI?.file?.openPath(filePath);
        if (res && !('error' in res)) bytes = new Uint8Array(res.data);
      } catch { bytes = null; }
      if (cancelled) return;
      // 로드 도중 문서가 전환됐으면 stale 주입 방지
      if (useAppStore.getState().document?.id !== docId) return;
      if (bytes) useAppStore.getState().setPdfBytes(bytes);
      else setLoadFailed(true);
    })();
    return () => { cancelled = true; };
  }, [canLazyLoad, filePath, docId]);

  if (!citationTarget || !docId) return null; // 문서 없으면 패널 무의미

  // 상주/lazy 바이트가 준비되면 정상 뷰어
  if (pdfBytes) {
    return (
      <PdfViewer
        pdfBytes={pdfBytes}
        targetPage={citationTarget.page}
        jumpNonce={citationJumpNonce}
        onClose={() => setCitationTarget(null)}
      />
    );
  }

  // 바이트 미준비 — lazy 로드 중(스피너) 또는 로드 불가/실패(안내)
  const unrecoverable = loadFailed || !canLazyLoad;
  return (
    <div className="flex flex-col h-full bg-white border-l dark:border-gray-700" role="region" aria-label={t('pdfviewer.title')}>
      <div className="flex items-center justify-between px-3 py-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">{t('pdfviewer.title')}</span>
        <button
          type="button"
          onClick={() => setCitationTarget(null)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm px-2 py-1 shrink-0"
          aria-label={t('pdfviewer.close')}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4 text-center" aria-busy={!unrecoverable}>
        {unrecoverable ? (
          <>
            <div className="text-2xl">⚠️</div>
            <p className="text-sm text-red-600 dark:text-red-400">{t('pdfviewer.renderFail')}</p>
          </>
        ) : (
          <>
            <svg aria-hidden="true" className="animate-spin h-8 w-8 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('pdfviewer.loading')}</p>
          </>
        )}
      </div>
    </div>
  );
}

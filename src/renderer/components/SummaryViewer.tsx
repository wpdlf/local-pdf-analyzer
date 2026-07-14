import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { abortQaPreservingThread } from '../lib/use-qa';
import { abortCollectionGather } from '../lib/use-collection-summary';
import { useT } from '../lib/i18n';
import { SafeMarkdown } from '../lib/safe-markdown';
import { SummaryMindMap } from './SummaryMindMap';
import { setCitationReturnFocus } from '../lib/citation-focus';
import { ProgressBar } from './ProgressBar';
import { QaChat } from './QaChat';
import { PdfViewerPanel } from './PdfViewer';
import { ResizeHandle } from './ResizeHandle';

interface SummaryViewerProps {
  onAbort?: () => void;
}

export function SummaryViewer({ onAbort }: SummaryViewerProps) {
  const document = useAppStore((s) => s.document);
  const summaryStream = useAppStore((s) => s.summaryStream);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const progress = useAppStore((s) => s.progress);
  const progressInfo = useAppStore((s) => s.progressInfo);
  const setError = useAppStore((s) => s.setError);
  // page-citation-viewer: citationTarget 존재 시 우측 패널 슬롯에 PdfViewer 마운트
  const citationTarget = useAppStore((s) => s.citationTarget);
  // DR-01: 사용자 조정 가능한 패널 너비 비율 (우측 PdfViewer 가 차지할 비율)
  const panelRatio = useAppStore((s) => s.citationPanelWidth);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const [debouncedContent, setDebouncedContent] = useState(summaryStream);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // 요약 마인드맵: 텍스트 / 마인드맵 뷰 전환.
  const [viewMode, setViewMode] = useState<'text' | 'mindmap'>('text');
  // QA15(D-LOW): 뷰 전환 시 citation-focus 홀더를 클리어 — 인용 패널이 열린 채 뷰를 바꾸면
  // 홀더가 가리키던(언마운트될) 요소가 무효화돼 패널 닫을 때 포커스가 body 로 유실됐다.
  const switchView = (mode: 'text' | 'mindmap') => {
    setCitationReturnFocus(null);
    setViewMode(mode);
  };
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; } };
  }, []);

  // 스트리밍 렌더 throttle — leading edge + 150ms 윈도우.
  // 이전 구현(debounce): deps 변경마다 timer를 clear/reschedule 해서, store가
  // 50ms 간격으로 flush하면 150ms 타이머가 절대 발화하지 않아 스트리밍 중 content가
  // 완전히 업데이트되지 않는 버그가 있었음(사용자는 완료까지 스피너만 봄).
  // 새 구현: 첫 tick에 즉시 반영 → 150ms 동안 새 업데이트는 타이머 소유권을
  // 유지하며 최종값만 커밋 → ReactMarkdown 재파싱 빈도를 제한.
  useEffect(() => {
    if (!isGenerating) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
      setDebouncedContent(summaryStream);
      return;
    }
    if (timerRef.current) {
      // 윈도우 진행 중 — 타이머가 발화할 때 store에서 최신값을 읽어 커밋
      return;
    }
    // Leading edge: 즉시 반영
    setDebouncedContent(summaryStream);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      // 이 시점의 최신 스트림을 store에서 직접 읽기 — closure 변수는 stale 가능
      setDebouncedContent(useAppStore.getState().summaryStream);
    }, 150);
  }, [summaryStream, isGenerating]);

  useEffect(() => {
    if (isGenerating && contentRef.current) {
      const el = contentRef.current;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [debouncedContent, isGenerating]);

  const handleClose = () => {
    const store = useAppStore.getState();
    // H1(UX): 비파괴적 접기. 이전엔 resetSummaryState() 가 document·summary·qaMessages 를 전부
    // 비워(document:null) 업로드 화면으로 튕기며 사용자의 요약+Q&A 스레드가 통째로 소실됐다.
    // 이제 in-flight 생성/Q&A 는 그대로 중단(토큰 청구 방지)하되 상태는 보존하고 뷰어만 접는다.
    // 문서 화면(block 2)의 "요약 보기 / Q&A 계속" 으로 재진입하며, 완전 닫기는 탭/“다른 파일” ✕ 가 담당.
    if (store.isGenerating) {
      if (onAbort) {
        onAbort();
      } else {
        if (store.currentRequestId) {
          window.electronAPI.ai.abort(store.currentRequestId);
        }
        store.flushStream();
        store.setIsGenerating(false);
      }
    }
    // C5-L(QA cycle5): raw abort → 불변식 보존 중단. 이전엔 qaRequestId 만 끊어 부분 답변이
    // 버려지고 user 메시지가 짝 없이 남아 다음 턴 히스토리를 오염시켰다(use-qa 공유 경로 참조).
    abortQaPreservingThread();
    // QA9(D-MED): 컬렉션 교차요약 gather 단계(isCollectionBusy && !isQaGenerating)는 qaRequestId 가
    // 아직 없어 abortQaPreservingThread 가 no-op 이다. 뷰어를 접으면 QaChat 이 언마운트되며 gather 의
    // 유일한 Stop 컨트롤도 사라지는데, 여기서 gatherAbortController 를 끊지 않으면 gather 가 취소 불가
    // 백그라운드로 고아화돼 최대 10개 멤버 요약이 끝까지 돌며 토큰을 계속 청구했다. gather 미진행 시 no-op.
    abortCollectionGather();
    store.setSummaryCollapsed(true);
  };

  const handleExport = async () => {
    if (!summaryStream) return;
    // `.pdf` 대소문자 무관하게 제거 — "report.PDF" 가 "report.PDF_summary.md" 가 되는 문제 방지
    const defaultName = document
      ? document.fileName.replace(/\.pdf$/i, '') + `_${t('viewer.defaultFilename').replace('.md', '')}.md`
      : t('viewer.defaultFilename');
    try {
      await window.electronAPI.file.save(summaryStream, defaultName);
    } catch {
      setError({ code: 'EXPORT_FAIL', message: t('viewer.saveFail') });
    }
  };

  const handleCopy = async () => {
    if (!summaryStream) return;
    try {
      await navigator.clipboard.writeText(summaryStream);
    } catch {
      setError({ code: 'EXPORT_FAIL', message: t('viewer.copyFail') });
    }
  };

  const handleExportPdf = async () => {
    // 동시 export 가드(빠른 더블클릭) — main 의 temp/창 race 와 별개로 렌더러 측 재진입도 차단.
    if (!summaryStream || isExportingPdf) return;
    setIsExportingPdf(true);
    const baseName = document ? document.fileName.replace(/\.pdf$/i, '') : t('viewer.result');
    const defaultName = `${baseName}_${t('viewer.defaultFilename').replace('.md', '')}.pdf`;
    try {
      // 지연 로드: react-dom/server(renderToStaticMarkup) 를 시작 청크에서 분리 — PDF 내보내기는
      // 드문 on-demand 동작이라 앱 기동 시 ~130KB 서버 렌더러를 끌고 올 이유가 없다.
      const { summaryToHtml } = await import('../lib/export-html');
      const html = summaryToHtml(summaryStream, baseName, useAppStore.getState().settings.summaryLanguage);
      await window.electronAPI.file.exportPdf(html, defaultName);
    } catch {
      setError({ code: 'EXPORT_FAIL', message: t('viewer.pdfFail') });
    } finally {
      setIsExportingPdf(false);
    }
  };

  const showCitationPanel = citationTarget !== null;
  // DR-01: 동적 flex-basis — 좌측은 (1 - panelRatio), 우측은 panelRatio
  const leftFlexBasis = showCitationPanel ? `${(1 - panelRatio) * 100}%` : '100%';
  const rightFlexBasis = showCitationPanel ? `${panelRatio * 100}%` : '0%';

  return (
    <div ref={splitContainerRef} className="flex flex-row h-full">
      <div
        className="flex flex-col h-full min-w-0"
        style={{ flexBasis: leftFlexBasis, flexGrow: 0, flexShrink: 1 }}
      >
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-t-lg">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 min-w-0 truncate">
          {document ? `📎 ${document.fileName} (${document.pageCount}p)` : t('viewer.result')}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {/* 요약 마인드맵: 텍스트/마인드맵 뷰 토글 (요약이 있을 때만) */}
          {debouncedContent && (
            <div role="group" aria-label={t('viewer.viewToggleAria')} className="inline-flex rounded overflow-hidden border border-gray-300 dark:border-gray-600 text-xs">
              <button
                type="button"
                onClick={() => switchView('text')}
                aria-pressed={viewMode === 'text'}
                className={`px-2 py-1 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${viewMode === 'text' ? 'bg-blue-500 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              >
                {t('viewer.viewText')}
              </button>
              <button
                type="button"
                onClick={() => switchView('mindmap')}
                aria-pressed={viewMode === 'mindmap'}
                className={`px-2 py-1 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${viewMode === 'mindmap' ? 'bg-blue-500 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              >
                {t('viewer.viewMindMap')}
              </button>
            </div>
          )}
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label={t('common.close')}
          >
            ✕ {t('common.close')}
          </button>
        </div>
      </div>

      {/* aria-live="polite": 스트리밍 중 스크린 리더에 내용 업데이트를 알림.
          aria-busy: AI 생성 중임을 명시. 스피너 SVG 는 aria-hidden 으로 중복 읽기 방지. */}
      <div
        ref={contentRef}
        role="region"
        aria-live="polite"
        aria-busy={isGenerating}
        aria-label={t('viewer.result')}
        className="flex-1 basis-1/2 min-h-0 overflow-y-auto p-4 prose prose-sm dark:prose-invert max-w-none"
      >
        {isGenerating && !debouncedContent ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <svg aria-hidden="true" className="animate-spin h-12 w-12 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
              {t('viewer.analyzing')}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('viewer.pleaseWait')}
            </p>
          </div>
        ) : debouncedContent ? (
          viewMode === 'mindmap'
            ? <SummaryMindMap markdown={debouncedContent} />
            : <SafeMarkdown content={debouncedContent} />
        ) : null}
      </div>

      {isGenerating && (
        <div className="flex items-center gap-2 px-4 py-2 border-t dark:border-gray-700">
          <div className="flex-1">
            <ProgressBar progress={progress} progressInfo={progressInfo} />
          </div>
          {onAbort && (
            <button
              onClick={onAbort}
              className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors shrink-0"
              aria-label={t('viewer.stopSummary')}
            >
              {t('viewer.stopBtn')}
            </button>
          )}
        </div>
      )}

      {summaryStream && !isGenerating && (
        <div className="flex items-center gap-2 px-4 py-3 border-t dark:border-gray-700">
          <button
            onClick={handleExport}
            className="px-3 py-1.5 text-sm bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
            aria-label={t('viewer.exportAria')}
          >
            {t('viewer.export')}
          </button>
          <button
            onClick={handleExportPdf}
            disabled={isExportingPdf}
            className="px-3 py-1.5 text-sm bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={t('viewer.exportPdfAria')}
          >
            {t('viewer.exportPdf')}
          </button>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            aria-label={t('viewer.copyAria')}
          >
            {t('viewer.copy')}
          </button>
        </div>
      )}

      {summaryStream && !isGenerating && (
        <div className="flex-1 basis-1/2 min-h-0 flex flex-col overflow-hidden">
          <QaChat />
        </div>
      )}
      </div>
      {/* page-citation-viewer: 우측 패널 (citationTarget 활성 시만 마운트) */}
      {/* DR-01: ResizeHandle 로 좌/우 비율 조정 가능 */}
      {showCitationPanel && (
        <>
          <ResizeHandle containerRef={splitContainerRef} />
          <div
            className="min-w-0 h-full"
            style={{ flexBasis: rightFlexBasis, flexGrow: 0, flexShrink: 1 }}
          >
            <PdfViewerPanel />
          </div>
        </>
      )}
    </div>
  );
}

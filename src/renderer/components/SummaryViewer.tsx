import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { REMARK_PLUGINS, safeComponents, MarkdownErrorBoundary } from '../lib/safe-markdown';
import { ProgressBar } from './ProgressBar';
import { QaChat } from './QaChat';

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
  const t = useT();

  const [debouncedContent, setDebouncedContent] = useState(summaryStream);
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
    if (store.isGenerating && onAbort) {
      onAbort();
    } else if (store.isGenerating) {
      if (store.currentRequestId) {
        window.electronAPI.ai.abort(store.currentRequestId);
      }
      store.flushStream();
      store.setIsGenerating(false);
    }
    if (store.qaRequestId) {
      window.electronAPI.ai.abort(store.qaRequestId);
    }
    store.resetSummaryState();
  };

  const handleExport = async () => {
    if (!summaryStream) return;
    const defaultName = document
      ? document.fileName.replace('.pdf', `_${t('viewer.defaultFilename').replace('.md', '')}.md`)
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-t-lg">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {document ? `📎 ${document.fileName} (${document.pageCount}p)` : t('viewer.result')}
        </span>
        <button
          onClick={handleClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label={t('common.close')}
        >
          ✕ {t('common.close')}
        </button>
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
            <p className="text-sm text-gray-400 dark:text-gray-500">
              {t('viewer.pleaseWait')}
            </p>
          </div>
        ) : debouncedContent ? (
          <MarkdownErrorBoundary fallbackText={debouncedContent}>
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{debouncedContent}</ReactMarkdown>
          </MarkdownErrorBoundary>
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
  );
}

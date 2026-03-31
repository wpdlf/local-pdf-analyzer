import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../lib/store';
import { REMARK_PLUGINS, safeComponents } from '../lib/safe-markdown';
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
  const setError = useAppStore((s) => s.setError);

  // 스트리밍 중 Markdown 렌더링 debounce (150ms, useRef 기반 — GC 부하 감소)
  const [debouncedContent, setDebouncedContent] = useState(summaryStream);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  // 언마운트 시 타이머 확실히 정리 (deps 변경과 독립적)
  useEffect(() => {
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; } };
  }, []);

  useEffect(() => {
    if (!isGenerating) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
      setDebouncedContent(summaryStream);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setDebouncedContent(summaryStream);
    }, 150);
    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
    };
  }, [summaryStream, isGenerating]);

  // 스트리밍 중 자동 스크롤 (사용자가 위로 스크롤한 경우 강제 이동하지 않음)
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
    // 요약 중이면 AI 요청 중단 + 생성 상태 해제
    if (store.currentRequestId) {
      window.electronAPI.ai.abort(store.currentRequestId);
    }
    if (store.isGenerating) {
      store.flushStream();
      store.setIsGenerating(false);
    }
    // Q&A 중이면 함께 중단
    if (store.qaRequestId) {
      window.electronAPI.ai.abort(store.qaRequestId);
    }
    store.resetSummaryState(); // Q&A 상태도 함께 초기화됨
  };

  const handleExport = async () => {
    if (!summaryStream) return;
    const defaultName = document
      ? document.fileName.replace('.pdf', '_요약.md')
      : '요약.md';
    try {
      await window.electronAPI.file.save(summaryStream, defaultName);
    } catch {
      setError({ code: 'EXPORT_FAIL', message: '파일 저장에 실패했습니다. 다른 경로를 선택해주세요.' });
    }
  };

  const handleCopy = async () => {
    if (!summaryStream) return;
    try {
      await navigator.clipboard.writeText(summaryStream);
    } catch {
      setError({ code: 'EXPORT_FAIL', message: '클립보드에 복사할 수 없습니다.' });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 문서 정보 + 닫기 */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-t-lg">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {document ? `📎 ${document.fileName} (${document.pageCount}p)` : '📎 요약 결과'}
        </span>
        <button
          onClick={handleClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="닫기"
        >
          ✕ 닫기
        </button>
      </div>

      {/* 요약 내용 — 요약 전용 스크롤 영역 */}
      <div ref={contentRef} className="flex-1 basis-1/2 min-h-0 overflow-y-auto p-4 prose prose-sm dark:prose-invert max-w-none">
        {isGenerating && !debouncedContent ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <svg className="animate-spin h-12 w-12 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
              AI가 자료를 분석하고 있습니다...
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500">
              잠시만 기다려주세요
            </p>
          </div>
        ) : debouncedContent ? (
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{debouncedContent}</ReactMarkdown>
        ) : null}
      </div>

      {/* 진행률 + 중지 버튼 */}
      {isGenerating && (
        <div className="flex items-center gap-2 px-4 py-2 border-t dark:border-gray-700">
          <div className="flex-1">
            <ProgressBar progress={progress} />
          </div>
          {onAbort && (
            <button
              onClick={onAbort}
              className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors shrink-0"
              aria-label="요약 중지"
            >
              ■ 중지
            </button>
          )}
        </div>
      )}

      {/* 액션 버튼 */}
      {summaryStream && !isGenerating && (
        <div className="flex items-center gap-2 px-4 py-3 border-t dark:border-gray-700">
          <button
            onClick={handleExport}
            className="px-3 py-1.5 text-sm bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
            aria-label="마크다운 파일로 내보내기"
          >
            💾 .md 내보내기
          </button>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            aria-label="클립보드에 복사"
          >
            📋 복사
          </button>
        </div>
      )}

      {/* Q&A 채팅 — 요약과 동일 비율로 공간 분배 */}
      {summaryStream && !isGenerating && (
        <div className="flex-1 basis-1/2 min-h-0 flex flex-col overflow-hidden">
          <QaChat />
        </div>
      )}
    </div>
  );
}

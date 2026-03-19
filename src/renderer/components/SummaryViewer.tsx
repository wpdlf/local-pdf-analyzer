import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../lib/store';
import { ProgressBar } from './ProgressBar';

export function SummaryViewer() {
  const { document, summaryStream, isGenerating, progress, setError } = useAppStore();

  // 스트리밍 중 Markdown 렌더링 debounce (150ms)
  const [debouncedContent, setDebouncedContent] = useState(summaryStream);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!isGenerating) {
      // 생성 완료 시 즉시 반영
      setDebouncedContent(summaryStream);
      return;
    }
    // 스트리밍 중에는 150ms 간격으로 업데이트
    timerRef.current = setTimeout(() => {
      setDebouncedContent(summaryStream);
    }, 150);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [summaryStream, isGenerating]);

  const handleClose = () => {
    useAppStore.getState().setDocument(null);
    useAppStore.getState().clearStream();
    useAppStore.getState().setIsGenerating(false);
    useAppStore.getState().setProgress(0);
    useAppStore.getState().setSummary(null);
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

      {/* 요약 내용 */}
      <div className="flex-1 overflow-y-auto p-4 prose prose-sm dark:prose-invert max-w-none">
        {debouncedContent ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{debouncedContent}</ReactMarkdown>
        ) : (
          <p className="text-gray-400 text-center mt-8">
            PDF를 업로드하고 요약을 시작하세요.
          </p>
        )}
      </div>

      {/* 진행률 */}
      {isGenerating && <ProgressBar progress={progress} />}

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
    </div>
  );
}

import { useCallback, useState } from 'react';
import { useAppStore } from '../lib/store';
import { handlePdfData } from '../lib/pdf-parser';

export function PdfUploader() {
  const setError = useAppStore((s) => s.setError);
  const isParsing = useAppStore((s) => s.isParsing);
  const ocrProgress = useAppStore((s) => s.ocrProgress);
  const [isDragging, setIsDragging] = useState(false);

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_SIZE) {
        setError({
          code: 'PDF_PARSE_FAIL',
          message: `파일이 너무 큽니다 (${Math.round(file.size / 1024 / 1024)}MB). 최대 100MB까지 지원합니다.`,
        });
        return;
      }
      const buffer = await file.arrayBuffer();
      await handlePdfData(buffer, file.name, file.name);
    },
    [setError],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (isParsing) return;
      const file = e.dataTransfer.files[0];
      if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
        handleFile(file);
      }
    },
    [handleFile, isParsing],
  );

  const handleFileSelect = useCallback(async () => {
    try {
      const result = await window.electronAPI.file.openPdf();
      if (!result) return;
      if ('error' in result) {
        setError({ code: 'PDF_PARSE_FAIL', message: (result as { error: string }).error });
        return;
      }
      // handlePdfData가 isParsing 상태를 관리
      await handlePdfData(result.data, result.name, result.path);
    } catch (err) {
      const error = err as Error & { code?: string };
      setError({ code: (error.code as 'PDF_PARSE_FAIL') || 'PDF_PARSE_FAIL', message: error.message || 'PDF를 읽을 수 없습니다.' });
    }
  }, [setError]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="PDF 파일 업로드"
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onClick={isParsing ? undefined : handleFileSelect}
      onKeyDown={(e) => {
        if (!isParsing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          handleFileSelect();
        }
      }}
      className={`
        relative border-2 border-dashed rounded-xl p-12 text-center
        transition-colors duration-200
        ${isParsing
          ? 'border-blue-400 bg-blue-50/50 dark:bg-blue-950/30 cursor-wait'
          : isDragging
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 cursor-pointer'
            : 'border-gray-300 dark:border-gray-600 hover:border-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer'
        }
      `}
    >
      {isParsing ? (
        <div className="flex flex-col items-center gap-4">
          <svg className="animate-spin h-12 w-12 text-blue-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {ocrProgress ? (
            <>
              <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
                스캔 PDF 텍스트 인식 중...
              </p>
              <div className="w-full max-w-xs">
                <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mb-1">
                  <span>OCR 진행</span>
                  <span>{ocrProgress.current} / {ocrProgress.total} 페이지</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${ocrProgress.total > 0 ? (ocrProgress.current / ocrProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Vision 모델로 텍스트를 추출하고 있습니다
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
                PDF를 읽고 있습니다...
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                잠시만 기다려주세요
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="text-4xl mb-4">📄</div>
          <p className="text-lg font-medium text-gray-700 dark:text-gray-200">
            PDF 파일을 여기에 드래그하거나
          </p>
          <p className="text-gray-500 dark:text-gray-400 mb-4">클릭하여 선택</p>
          <button
            type="button"
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleFileSelect();
            }}
          >
            파일 선택
          </button>
        </>
      )}
    </div>
  );
}

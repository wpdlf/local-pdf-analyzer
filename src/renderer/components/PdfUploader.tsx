import { useCallback, useState } from 'react';
import { useAppStore } from '../lib/store';
import { parsePdf } from '../lib/pdf-parser';

export function PdfUploader() {
  const { setDocument, setError, isParsing, setIsParsing } = useAppStore();
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setIsParsing(true);
      try {
        const buffer = await file.arrayBuffer();
        const doc = await parsePdf(buffer, file.name, file.name);
        setDocument(doc);
        setError(null);
      } catch (err) {
        const error = err as Error & { code?: string };
        setError({
          code: (error.code as 'PDF_PARSE_FAIL') || 'PDF_PARSE_FAIL',
          message: error.message || 'PDF를 읽을 수 없습니다.',
        });
      } finally {
        setIsParsing(false);
      }
    },
    [setDocument, setError, setIsParsing],
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

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) handleFile(file);
    };
    input.click();
  }, [handleFile]);

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onClick={isParsing ? undefined : handleFileSelect}
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
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 dark:border-gray-700 border-t-blue-500" />
          <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
            PDF를 읽고 있습니다...
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            잠시만 기다려주세요
          </p>
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

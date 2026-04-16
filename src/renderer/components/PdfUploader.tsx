import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { handlePdfData, cancelPdfParse } from '../lib/pdf-parser';
import { MAX_PDF_SIZE_BYTES } from '../../shared/constants';

export function PdfUploader() {
  const setError = useAppStore((s) => s.setError);
  const isParsing = useAppStore((s) => s.isParsing);
  const ocrProgress = useAppStore((s) => s.ocrProgress);
  const t = useT();
  const [isDragging, setIsDragging] = useState(false);
  const dialogOpenRef = useRef(false);

  const MAX_FILE_SIZE = MAX_PDF_SIZE_BYTES;
  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_SIZE) {
        setError({
          code: 'PDF_PARSE_FAIL',
          message: t('uploader.fileTooLarge', { size: Math.round(file.size / 1024 / 1024) }),
        });
        return;
      }
      // 매직바이트 검증을 전체 파일 로드 전에 수행 — 99MB 가짜 PDF 가 renderer 메모리에
      // 전량 materialize 되는 것을 방지. Blob.slice() 는 데이터를 복사하지 않고 뷰만 반환.
      try {
        const headerBuf = await file.slice(0, 5).arrayBuffer();
        const header = new Uint8Array(headerBuf);
        const isPdfMagic = header.length >= 5
          && header[0] === 0x25 && header[1] === 0x50
          && header[2] === 0x44 && header[3] === 0x46
          && header[4] === 0x2D;
        if (!isPdfMagic) {
          setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.notPdf') });
          return;
        }
      } catch {
        setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.cannotRead') });
        return;
      }
      const buffer = await file.arrayBuffer();
      await handlePdfData(buffer, file.name, file.name);
    },
    [setError, t, MAX_FILE_SIZE],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (isParsing) return;
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      const file = files[0];
      if (!file) return;
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.notPdf') });
        return;
      }
      // 다중 파일 드롭 시 첫 번째만 처리하는 것을 사용자에게 알림 (silent drop 방지)
      if (files.length > 1) {
        setError({
          code: 'PDF_PARSE_FAIL',
          message: t('uploader.multipleFiles', { name: file.name }),
        });
      }
      handleFile(file).catch((err) => {
        setError({ code: 'PDF_PARSE_FAIL', message: err instanceof Error ? err.message : String(err) });
      });
    },
    [handleFile, isParsing, setError, t],
  );

  const handleFileSelect = useCallback(async () => {
    if (dialogOpenRef.current) return;
    dialogOpenRef.current = true;
    try {
      const result = await window.electronAPI.file.openPdf();
      if (!result) return;
      if ('error' in result) {
        setError({ code: 'PDF_PARSE_FAIL', message: (result as { error: string }).error });
        return;
      }
      await handlePdfData(result.data, result.name, result.path);
    } catch (err) {
      const error = err as Error & { code?: string };
      setError({ code: (error.code as 'PDF_PARSE_FAIL') || 'PDF_PARSE_FAIL', message: error.message || t('uploader.cannotRead') });
    } finally {
      dialogOpenRef.current = false;
    }
  }, [setError, t]);

  return (
    // 접근성: 외부 div 는 순수 드롭존 + 포인터 단축키.
    // - role="button" 과 role 없는 div+aria-label 둘 다 문제 있음:
    //   전자는 내부 <button> 중첩으로 ARIA nested interactive 규칙 위반,
    //   후자는 aria-label 을 가졌지만 interactive 로 announce 안 되어 혼란.
    // - 선택: 외부 div 는 aria tree 에서 비가시(presentation) 처리하고,
    //   시각적/마우스 UX 는 유지. 키보드·스크린 리더 사용자는 내부 "파일 선택"
    //   버튼을 통해 기능에 접근 (버튼이 전체 UI의 accessible primary control).
    <div
      role="presentation"
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        // dragOver 가 ~60Hz 로 발화 — 이미 true 면 setState 호출을 생략해
        // reconciler bail-out 조차 건너뛰고 스케줄러 부하를 줄인다.
        // 또한 dataTransfer.types 가 Files 인 경우에만 드래그 상태 진입 (텍스트/URL 드래그 무시).
        if (!isDragging && e.dataTransfer.types?.includes('Files')) {
          setIsDragging(true);
        }
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
          <svg aria-hidden="true" className="animate-spin h-12 w-12 text-blue-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {ocrProgress ? (
            <>
              <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
                {t('uploader.ocrProgress')}
              </p>
              <div className="w-full max-w-xs">
                <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mb-1">
                  <span>{t('uploader.ocrLabel')}</span>
                  <span>{ocrProgress.current} / {ocrProgress.total}</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${ocrProgress.total > 0 ? (ocrProgress.current / ocrProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {t('uploader.ocrDesc')}
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-600 dark:text-gray-300">
                {t('uploader.reading')}
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                {t('uploader.wait')}
              </p>
            </>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); cancelPdfParse(); }}
            className="mt-2 px-4 py-1.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            aria-label={t('uploader.cancelParse')}
          >
            {t('uploader.cancelBtn')}
          </button>
        </div>
      ) : (
        <>
          <div className="text-4xl mb-4">📄</div>
          <p className="text-lg font-medium text-gray-700 dark:text-gray-200">
            {t('uploader.dragDrop')}
          </p>
          <p className="text-gray-500 dark:text-gray-400 mb-4">{t('uploader.clickSelect')}</p>
          <button
            type="button"
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleFileSelect();
            }}
          >
            {t('uploader.selectFile')}
          </button>
        </>
      )}
    </div>
  );
}

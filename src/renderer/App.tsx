import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './lib/store';
import { KOREAN_RECOMMENDED_MODELS, INITIAL_INSTALL_MODELS } from './types';
import { t, useT } from './lib/i18n';
import { PdfUploader } from './components/PdfUploader';
import { SummaryViewer } from './components/SummaryViewer';
import { SummaryTypeSelector } from './components/SummaryTypeSelector';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { OllamaSetupWizard } from './components/OllamaSetupWizard';
import { handlePdfData } from './lib/pdf-parser';
import { applyTheme } from './lib/theme';
import { useSummarize } from './lib/use-summarize';
import { useRagBuilder } from './lib/use-qa';
import { MAX_PDF_SIZE_BYTES } from '../shared/constants';
import logoImg from './assets/logo.png';

export default function App() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const document = useAppStore((s) => s.document);
  const setDocument = useAppStore((s) => s.setDocument);
  const summaryStream = useAppStore((s) => s.summaryStream);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const setProgress = useAppStore((s) => s.setProgress);
  const clearStream = useAppStore((s) => s.clearStream);
  const setSummary = useAppStore((s) => s.setSummary);
  const settings = useAppStore((s) => s.settings);
  const setOllamaStatus = useAppStore((s) => s.setOllamaStatus);
  const error = useAppStore((s) => s.error);
  const setError = useAppStore((s) => s.setError);
  const isParsing = useAppStore((s) => s.isParsing);
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const [modelHint, setModelHint] = useState<string | null>(null);
  const [bgModelSync, setBgModelSync] = useState<string | null>(null);
  const [bgModelLoading, setBgModelLoading] = useState(false);
  // Ctrl+O / 파일 다이얼로그 재진입 가드. 진행 중이면 연타 Ctrl+O 를 무시한다.
  // 기존의 "setIsParsing(true) 만 올리는" 힌트 방식은 실제 재진입을 막지 못했음.
  const dialogOpenRef = useRef(false);
  // 렌더 내 번역은 useT() 훅 사용 — uiLanguage 변경 시 즉시 리렌더.
  // (전역 t()는 호출 시점 snapshot만 반환하므로 JSX 내부 사용 시 stale 가능)
  const tr = useT();

  const { handleSummarize, handleAbort } = useSummarize();

  // 문서 로드 시 RAG 인덱스를 요약과 병렬로 빌드 (요약 완료까지 기다리지 않음).
  // 이전에는 QaChat이 마운트되는 시점(요약 완료 후)에야 빌드가 시작되어,
  // 사용자가 Q&A를 할 수 있을 때까지 "요약 시간 + 인덱싱 시간"을 모두 대기해야 했음.
  useRagBuilder();

  // 초기화: 설정 로드 + Ollama 상태 확인
  useEffect(() => {
    let aborted = false;

    const ensureDefaultModels = async (installedModels: string[]) => {
      const missing = INITIAL_INSTALL_MODELS.filter(
        (model) => !installedModels.some((m) => m.startsWith(model)),
      );
      if (missing.length === 0) return;

      setBgModelLoading(true);
      // 실패 시에도 직전까지 성공한 모델 목록을 메시지에 포함해 "부분 성공이 실패 토스트에 가려지는"
      // UX 문제를 해결. 예: gemma3 설치 성공 후 exaone3.5 실패 시
      // "모델 다운로드 실패: exaone3.5 — ... (설치 완료: gemma3)"
      const succeeded: string[] = [];
      for (const model of missing) {
        if (aborted) return;
        setBgModelSync(t('app.downloadingModel', { model }));
        const result = await window.electronAPI.ollama.pullModel(model);
        if (aborted) return;
        if (!result.success) {
          if (aborted) return;
          setBgModelLoading(false);
          // 이전 모델이 성공적으로 설치되었을 수 있으므로 store 갱신
          try {
            const partialStatus = await window.electronAPI.ollama.getStatus();
            if (!aborted) setOllamaStatus(partialStatus);
          } catch { /* 무시 */ }
          if (aborted) return;
          const errorMsg = result.error || t('app.modelDownloadFailDefault');
          const message = succeeded.length > 0
            ? t('app.modelDownloadFailPartial', { model, error: errorMsg, succeeded: succeeded.join(', ') })
            : t('app.modelDownloadFail', { model, error: errorMsg });
          setBgModelSync(message);
          setTimeout(() => { if (!aborted) setBgModelSync(null); }, 5000);
          return;
        }
        succeeded.push(model);
      }
      if (aborted) return;
      setBgModelLoading(false);
      const updatedStatus = await window.electronAPI.ollama.getStatus();
      if (aborted) return;
      setOllamaStatus(updatedStatus);
      setBgModelSync(t('app.modelInstallDone'));
      setTimeout(() => { if (!aborted) setBgModelSync(null); }, 3000);
    };

    const init = async () => {
      await useAppStore.getState().loadSettings();

      try {
        const status = await window.electronAPI.ollama.getStatus();
        if (aborted) return;
        setOllamaStatus(status);
        const currentSettings = useAppStore.getState().settings;
        if (currentSettings.provider === 'ollama' && (!status.installed || !status.running || status.models.length === 0)) {
          setView('setup');
        } else if (status.running) {
          ensureDefaultModels(status.models).catch(() => {
            if (!aborted) setBgModelSync(null);
          });
        }
      } catch {
        if (aborted) return;
        const currentSettings = useAppStore.getState().settings;
        if (currentSettings.provider === 'ollama') {
          setView('setup');
        }
      }
    };
    init();

    return () => { aborted = true; };
  }, [setOllamaStatus, setView]);

  // Main process에서 파일 드롭 수신 (IPC)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onFileDropped(async (file) => {
      await handlePdfData(file.data, file.name, file.path);
    });
    return unsubscribe;
  }, []);

  // 글로벌 드래그 앤 드롭: 앱 어디서든 PDF 파일 드롭 가능 (프로덕션 빌드에서 동작)
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      // capture-phase 에서 stopPropagation 해 PdfUploader 의 React onDrop 중복 발화를 차단.
      // (과거: 동일 드롭 이벤트가 글로벌 핸들러 + PdfUploader 에서 두 번 처리되어
      //  100MB arrayBuffer() 중복 할당 + 첫 파싱이 abort-replace 로 즉시 취소됨)
      e.stopPropagation();
      // isParsing 중에도 handlePdfData 가 abort-replace 패턴으로 새 파일을 받도록 허용.
      // isGenerating/isQaGenerating 은 handlePdfData 내부에서 에러 메시지로 차단됨.
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.notPdf') });
        return;
      }
      // 파일 전체를 arrayBuffer() 로 materialize 하기 전에 크기 + 매직바이트 선검증.
      // 과거: 확장자가 .pdf 로 위장된 100MB 임의 바이너리가 renderer 힙에 전량 로드된 뒤에야
      // pdfjs 에서 거부됐음 — 공격/오조작 모두에서 불필요한 메모리 스파이크 발생.
      if (file.size > MAX_PDF_SIZE_BYTES) {
        useAppStore.getState().setError({
          code: 'PDF_PARSE_FAIL',
          message: t('uploader.fileTooLarge', { size: Math.round(file.size / 1024 / 1024) }),
        });
        return;
      }
      try {
        const headerBuf = await file.slice(0, 5).arrayBuffer();
        const header = new Uint8Array(headerBuf);
        const isPdfMagic = header.length >= 5
          && header[0] === 0x25 && header[1] === 0x50
          && header[2] === 0x44 && header[3] === 0x46
          && header[4] === 0x2D;
        if (!isPdfMagic) {
          useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.notPdf') });
          return;
        }
      } catch {
        useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('uploader.cannotRead') });
        return;
      }
      // 다중 파일 드롭 시 첫 번째만 처리함을 알림 (silent drop 방지)
      if (files.length > 1) {
        useAppStore.getState().setError({
          code: 'PDF_PARSE_FAIL',
          message: t('uploader.multipleFiles', { name: file.name }),
        });
      }
      // file.arrayBuffer() 가 실패(OOM, revoked blob 등)할 수 있으므로 try/catch 로 감싼다.
      // isParsing 선제 마킹은 제거 — handlePdfData 가 내부에서 올리고, 실패 시에도 유출 없음.
      try {
        const buffer = await file.arrayBuffer();
        await handlePdfData(buffer, file.name, file.name);
      } catch (err) {
        useAppStore.getState().setError({
          code: 'PDF_PARSE_FAIL',
          message: (err as Error)?.message || t('uploader.cannotRead'),
        });
      }
    };
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('drop', handleDrop, true);
    return () => {
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('drop', handleDrop, true);
    };
  }, []);

  // Ctrl+O: 파일 열기 단축키
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        // 재진입 가드 — 이미 다이얼로그가 열려 있으면 두 번째 Ctrl+O 무시.
        if (dialogOpenRef.current) return;
        dialogOpenRef.current = true;
        try {
          const result = await window.electronAPI.file.openPdf();
          if (!result) return;
          if ('error' in result) {
            useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: result.error });
            return;
          }
          await handlePdfData(result.data, result.name, result.path);
        } catch (err) {
          // async 이벤트 핸들러 내 throw 는 unhandledrejection 이 되어 ErrorBoundary 도
          // 잡지 못한다. setError 로 전환해 사용자 표시 배너로 수렴.
          useAppStore.getState().setError({
            code: 'PDF_PARSE_FAIL',
            message: (err as Error)?.message || t('uploader.cannotRead'),
          });
        } finally {
          dialogOpenRef.current = false;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 테마 적용
  useEffect(() => {
    return applyTheme(settings.theme);
  }, [settings.theme]);

  // <html lang>과 document.title을 UI 언어에 동기화.
  // 접근성(스크린 리더), 브라우저 번역/맞춤법 검사, 창 제목/Alt-Tab 일관성 확보.
  // App.tsx 내에서 store의 `document`가 전역 document를 섀도잉하므로 window.document 사용.
  useEffect(() => {
    window.document.documentElement.lang = settings.uiLanguage;
    window.document.title = tr('app.title');
  }, [settings.uiLanguage, tr]);

  // 한국어 비율은 문서별로 1회만 계산 — 모델 스왑 시 재계산 방지 (3000자 샘플은 저렴하지만
  // 이 값이 effect deps 에 포함되면 불필요한 재실행이 발생)
  const koreanRatio = useMemo(() => {
    if (!document) return 0;
    const sample = document.extractedText.slice(0, 3000);
    const koreanChars = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
    return koreanChars / Math.max(sample.length, 1);
  }, [document]);

  // PDF 업로드 후 한국어 감지 → 모델 추천
  useEffect(() => {
    if (!document || settings.provider !== 'ollama') {
      setModelHint(null);
      return;
    }

    if (koreanRatio > 0.15) {
      const currentModel = settings.model.split(':')[0];
      const isKoreanModel = KOREAN_RECOMMENDED_MODELS.some(
        (m) => currentModel.startsWith(m),
      );
      if (!isKoreanModel) {
        setModelHint(
          tr('app.modelHint', { model: settings.model, recommended: KOREAN_RECOMMENDED_MODELS.join(', ') }),
        );
      } else {
        setModelHint(null);
      }
    } else {
      setModelHint(null);
    }
  }, [document, settings.provider, settings.model, settings.uiLanguage, tr, koreanRatio]);

  if (view === 'setup') {
    return (
      <div className="h-screen bg-white dark:bg-gray-900">
        <OllamaSetupWizard />
      </div>
    );
  }

  if (view === 'settings') {
    return (
      <div className="h-screen bg-white dark:bg-gray-900 overflow-y-auto">
        <SettingsPanel />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b dark:border-gray-700">
        <h1 className="flex items-center gap-2 text-lg font-bold text-gray-800 dark:text-white">
          <img src={logoImg} alt={tr('app.logo')} className="w-6 h-6 rounded" />
          {tr('app.title')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('settings')}
            disabled={isGenerating || isParsing || isQaGenerating}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={(isGenerating || isQaGenerating) ? tr('app.settingsBlocked') : tr('app.settings')}
            aria-label={tr('app.settings')}
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* 백그라운드 모델 다운로드 알림 */}
      {bgModelSync && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-400">
          {bgModelLoading && (
            <svg aria-hidden="true" className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <span>{bgModelSync}</span>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* 에러 표시 */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start justify-between">
            <p className="text-red-700 dark:text-red-400 text-sm">{error.message}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-600 dark:hover:text-red-300 ml-2 shrink-0"
              aria-label={tr('app.closeError')}
            >
              ✕
            </button>
          </div>
        )}

        {/* 1) PDF 미업로드: 업로드 영역 */}
        {!document && !summaryStream && (
          <PdfUploader />
        )}

        {/* 모델 추천 알림 */}
        {modelHint && !isGenerating && (
          <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg flex items-start justify-between">
            <p className="text-amber-700 dark:text-amber-400 text-sm">{modelHint}</p>
            <button
              onClick={() => setModelHint(null)}
              className="text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 ml-2 shrink-0"
              aria-label={tr('common.close')}
            >
              ✕
            </button>
          </div>
        )}

        {/* 2) PDF 업로드 완료, 요약 대기: 파일 정보 + 요약 유형 + 시작 버튼 */}
        {document && !isGenerating && !summaryStream && (
          <div className="flex flex-col items-center gap-6">
            <div className="w-full flex items-center justify-between px-4 py-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                📎 {document.fileName} ({document.pageCount}p)
                {document.isOcr && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded">
                    OCR
                  </span>
                )}
              </span>
              <button
                onClick={() => {
                  setDocument(null);
                  clearStream();
                  setSummary(null);
                  setProgress(0);
                }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm"
                aria-label={tr('app.removeFile')}
              >
                {tr('app.otherFile')}
              </button>
            </div>
            <SummaryTypeSelector />
            <button
              onClick={handleSummarize}
              className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-lg font-medium transition-colors"
            >
              {tr('app.startSummary')}
            </button>
          </div>
        )}

        {/* 3) 요약 진행 중 또는 완료: 결과 뷰어 */}
        {(isGenerating || summaryStream) && (
          <SummaryViewer onAbort={handleAbort} />
        )}
      </main>

      {/* Status Bar */}
      <StatusBar />
    </div>
  );
}

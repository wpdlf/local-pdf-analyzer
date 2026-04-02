import { useEffect, useState } from 'react';
import { useAppStore } from './lib/store';
import { KOREAN_RECOMMENDED_MODELS, INITIAL_INSTALL_MODELS } from './types';
import { PdfUploader } from './components/PdfUploader';
import { SummaryViewer } from './components/SummaryViewer';
import { SummaryTypeSelector } from './components/SummaryTypeSelector';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { OllamaSetupWizard } from './components/OllamaSetupWizard';
import { handlePdfData } from './lib/pdf-parser';
import { applyTheme } from './lib/theme';
import { useSummarize } from './lib/use-summarize';
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
  const [modelHint, setModelHint] = useState<string | null>(null);
  const [bgModelSync, setBgModelSync] = useState<string | null>(null);

  const { handleSummarize, handleAbort } = useSummarize();

  // 초기화: 설정 로드 + Ollama 상태 확인
  useEffect(() => {
    let aborted = false;

    const ensureDefaultModels = async (installedModels: string[]) => {
      const missing = INITIAL_INSTALL_MODELS.filter(
        (model) => !installedModels.some((m) => m.startsWith(model)),
      );
      if (missing.length === 0) return;

      for (const model of missing) {
        if (aborted) return;
        setBgModelSync(`기본 모델 다운로드 중: ${model}`);
        const result = await window.electronAPI.ollama.pullModel(model);
        if (aborted) return;
        if (!result.success) {
          setBgModelSync(`모델 다운로드 실패: ${model} — ${result.error || '네트워크를 확인해주세요'}`);
          setTimeout(() => { if (!aborted) setBgModelSync(null); }, 5000);
          return;
        }
      }
      if (aborted) return;
      const updatedStatus = await window.electronAPI.ollama.getStatus();
      if (aborted) return;
      setOllamaStatus(updatedStatus);
      setBgModelSync('기본 모델 설치 완료');
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
      // 동기적으로 store 상태를 직접 읽어 경합 조건 방지 (setState 전파 대기 불필요)
      const { isParsing: parsing, isGenerating: generating } = useAppStore.getState();
      if (parsing || generating) return;
      const file = e.dataTransfer?.files[0];
      if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
        const buffer = await file.arrayBuffer();
        await handlePdfData(buffer, file.name, file.name);
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
        const result = await window.electronAPI.file.openPdf();
        if (!result) return;
        if ('error' in result) {
          useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: result.error });
          return;
        }
        await handlePdfData(result.data, result.name, result.path);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 테마 적용
  useEffect(() => {
    return applyTheme(settings.theme);
  }, [settings.theme]);

  // PDF 업로드 후 한국어 감지 → 모델 추천
  useEffect(() => {
    if (!document || settings.provider !== 'ollama') {
      setModelHint(null);
      return;
    }
    const sample = document.extractedText.slice(0, 3000);
    const koreanChars = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
    const koreanRatio = koreanChars / Math.max(sample.length, 1);

    if (koreanRatio > 0.15) {
      const currentModel = settings.model.split(':')[0];
      const isKoreanModel = KOREAN_RECOMMENDED_MODELS.some(
        (m) => currentModel.startsWith(m),
      );
      if (!isKoreanModel) {
        setModelHint(
          `현재 모델(${settings.model})은 한국어 성능이 제한적일 수 있습니다. 설정에서 ${KOREAN_RECOMMENDED_MODELS.join(', ')} 등의 모델로 변경하면 요약 품질이 향상됩니다.`,
        );
      } else {
        setModelHint(null);
      }
    } else {
      setModelHint(null);
    }
  }, [document, settings.provider, settings.model]);

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
          <img src={logoImg} alt="로고" className="w-6 h-6 rounded" />
          PDF 자료 분석기
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('settings')}
            disabled={isGenerating || isParsing}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={isGenerating ? '요약 중에는 설정을 열 수 없습니다' : '설정'}
            aria-label="설정"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* 백그라운드 모델 다운로드 알림 */}
      {bgModelSync && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-400">
          {!bgModelSync.includes('완료') && (
            <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
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
              aria-label="에러 닫기"
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
              aria-label="닫기"
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
                aria-label="현재 파일 제거"
              >
                ✕ 다른 파일
              </button>
            </div>
            <SummaryTypeSelector />
            <button
              onClick={handleSummarize}
              className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-lg font-medium transition-colors"
            >
              📝 요약 시작
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

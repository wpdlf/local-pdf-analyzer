import { useEffect, useRef, useState } from 'react';
import { useAppStore } from './lib/store';
import { AiClient } from './lib/ai-client';
import { chunkText, chunkChapters } from './lib/chunker';
import { KOREAN_RECOMMENDED_MODELS } from './types';
import { PdfUploader } from './components/PdfUploader';
import { SummaryViewer } from './components/SummaryViewer';
import { SummaryTypeSelector } from './components/SummaryTypeSelector';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { OllamaSetupWizard } from './components/OllamaSetupWizard';
import { handlePdfData } from './lib/pdf-parser';
import type { PdfDocument, SummaryType, AppSettings } from './types';

type TrackFn = (text: string, type: SummaryType) => AsyncGenerator<string>;

async function summarizeByChapter(
  doc: PdfDocument, settings: AppSettings, track: TrackFn,
  checkTimeout: () => boolean, isTimedOut: () => boolean,
  append: (s: string) => void, setProgress: (p: number) => void,
) {
  const chaptersData = chunkChapters(doc.chapters, settings.maxChunkSize);
  const total = chaptersData.reduce((sum, c) => sum + c.chunks.length, 0);
  let processed = 0;
  for (const { chapter, chunks } of chaptersData) {
    if (isTimedOut()) break;
    let chapterHeaderPending = `\n## ${chapter.title}\n\n`;
    for (const chunk of chunks) {
      if (isTimedOut()) break;
      for await (const token of track(chunk, 'chapter')) {
        if (checkTimeout()) break;
        if (chapterHeaderPending) {
          append(chapterHeaderPending + token);
          chapterHeaderPending = '';
        } else {
          append(token);
        }
      }
      processed++;
      setProgress((processed / total) * 100);
    }
    append('\n\n---\n');
  }
}

async function summarizeFull(
  doc: PdfDocument, summaryType: SummaryType, settings: AppSettings, track: TrackFn,
  checkTimeout: () => boolean, isTimedOut: () => boolean,
  append: (s: string) => void, setProgress: (p: number) => void,
) {
  const chunks = chunkText(doc.extractedText, settings.maxChunkSize);
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (isTimedOut()) break;
    let chunkResult = '';
    for await (const token of track(chunks[i], summaryType)) {
      if (checkTimeout()) break;
      append(token);
      chunkResult += token;
    }
    chunkSummaries.push(chunkResult);
    setProgress(((i + 1) / chunks.length) * 90);
    if (i < chunks.length - 1) append('\n\n---\n\n');
  }
  if (!isTimedOut() && chunks.length > 1 && summaryType === 'full') {
    append('\n\n---\n\n## 📋 통합 요약\n\n');
    const combined = chunkSummaries.join('\n\n');
    for await (const token of track(
      `다음은 강의자료의 파트별 요약입니다. 이를 하나의 통합 요약으로 정리해주세요.\n\n${combined}`,
      'full',
    )) {
      if (checkTimeout()) break;
      append(token);
    }
    setProgress(100);
  } else {
    setProgress(100);
  }
}

export default function App() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const document = useAppStore((s) => s.document);
  const setDocument = useAppStore((s) => s.setDocument);
  const summaryType = useAppStore((s) => s.summaryType);
  const summaryStream = useAppStore((s) => s.summaryStream);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const setIsGenerating = useAppStore((s) => s.setIsGenerating);
  const setProgress = useAppStore((s) => s.setProgress);
  const appendStream = useAppStore((s) => s.appendStream);
  const clearStream = useAppStore((s) => s.clearStream);
  const flushStream = useAppStore((s) => s.flushStream);
  const setSummary = useAppStore((s) => s.setSummary);
  const settings = useAppStore((s) => s.settings);
  const setOllamaStatus = useAppStore((s) => s.setOllamaStatus);
  const error = useAppStore((s) => s.error);
  const setError = useAppStore((s) => s.setError);
  const isParsing = useAppStore((s) => s.isParsing);
  const clientRef = useRef<AiClient | null>(null);
  const [modelHint, setModelHint] = useState<string | null>(null);

  // 초기화: 설정 로드 + Ollama 상태 확인
  useEffect(() => {
    const init = async () => {
      // 저장된 설정 로드
      await useAppStore.getState().loadSettings();

      // Ollama 상태 확인 (Ollama provider인 경우만 setup wizard 표시)
      try {
        const status = await window.electronAPI.ollama.getStatus();
        setOllamaStatus(status);
        const currentSettings = useAppStore.getState().settings;
        if (currentSettings.provider === 'ollama' && (!status.installed || !status.running || status.models.length === 0)) {
          setView('setup');
        }
      } catch {
        const currentSettings = useAppStore.getState().settings;
        if (currentSettings.provider === 'ollama') {
          setView('setup');
        }
      }
    };
    init();
  }, [setOllamaStatus, setView]);

  // Main process에서 파일 드롭 수신 (IPC)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onFileDropped(async (file) => {
      await handlePdfData(file.data, file.name, file.path);
    });
    return unsubscribe;
  }, []);

  // 테마 적용
  useEffect(() => {
    const root = window.document.documentElement;
    if (settings.theme === 'dark') {
      root.classList.add('dark');
    } else if (settings.theme === 'light') {
      root.classList.remove('dark');
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      root.classList.toggle('dark', mq.matches);
      const handler = (e: MediaQueryListEvent) => {
        root.classList.toggle('dark', e.matches);
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
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
      const currentModel = settings.model.split(':')[0]; // 태그 제거
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

  const handleAbortSummarize = () => {
    const reqId = useAppStore.getState().currentRequestId;
    if (reqId) {
      window.electronAPI.ai.abort(reqId);
    }
    clientRef.current = null;
    useAppStore.getState().setCurrentRequestId(null);
    flushStream();
    setIsGenerating(false);
  };

  const handleSummarize = async () => {
    if (!document || isGenerating) return;

    setIsGenerating(true);
    clearStream();
    setProgress(0);
    setError(null);

    const startTime = Date.now();
    const TIMEOUT_MS = 300000; // 5분 타임아웃
    let timedOut = false;

    // 실제 타이머 기반 타임아웃 — 모델 무응답 시에도 동작
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      handleAbortSummarize();
      setError({
        code: 'GENERATE_TIMEOUT',
        message: '요약 시간이 초과되었습니다. 생성된 부분까지 표시됩니다. 청크 크기를 줄이거나 경량 모델을 사용해보세요.',
      });
    }, TIMEOUT_MS);

    try {
      const client = new AiClient(settings);
      clientRef.current = client;

      const trackSummarize = (text: string, type: typeof summaryType) => {
        const requestId = client.prepareSummarize();
        useAppStore.getState().setCurrentRequestId(requestId);
        return client.summarize(text, type, requestId);
      };
      const available = await client.isAvailable();
      if (!available) {
        const providerMessages: Record<string, string> = {
          ollama: 'Ollama가 실행 중이 아닙니다. 설정을 확인해주세요.',
          claude: 'Claude API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.',
          openai: 'OpenAI API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.',
        };
        setError({ code: settings.provider === 'ollama' ? 'OLLAMA_NOT_RUNNING' : 'API_KEY_MISSING', message: providerMessages[settings.provider] });
        setIsGenerating(false);
        return;
      }

      // ─── 이미지 분석 단계 (이미지가 있고 설정 on인 경우만) ───
      let textForSummary = document.extractedText;
      let enrichedPagesRef: string[] | null = null;
      if (document.images.length > 0 && settings.enableImageAnalysis) {
        // Vision 모델 사전 확인 (첫 이미지로 테스트)
        const preflight = await window.electronAPI.ai.analyzeImage(document.images[0]!.base64);
        if (!preflight.success) {
          setError({ code: 'GENERATE_FAIL', message: preflight.error || '이미지 분석에 실패했습니다.' });
          setIsGenerating(false);
          clearTimeout(timeoutTimer);
          return;
        }

        const imageDescriptions = new Map<number, string[]>();
        // 첫 이미지 결과 저장
        if (preflight.description) {
          const firstImg = document.images[0]!;
          imageDescriptions.set(firstImg.pageIndex, [preflight.description]);
        }

        const BATCH = 3;
        for (let bi = 1; bi < document.images.length && !timedOut; bi += BATCH) {
          if (!useAppStore.getState().isGenerating) break;
          const batch = document.images.slice(bi, bi + BATCH);
          const results = await Promise.allSettled(
            batch.map((img) => client.analyzeImage(img.base64)),
          );
          for (let ri = 0; ri < results.length; ri++) {
            const r = results[ri]!;
            const img = batch[ri]!;
            if (r.status === 'fulfilled' && r.value) {
              const list = imageDescriptions.get(img.pageIndex) || [];
              list.push(r.value);
              imageDescriptions.set(img.pageIndex, list);
            }
          }
          setProgress(Math.min(20, Math.round(((bi + batch.length) / document.images.length) * 20)));
        }

        // 페이지별로 이미지 설명을 텍스트에 삽입 (pageTexts로 정확한 매핑)
        if (imageDescriptions.size > 0) {
          const enrichedPages = [...document.pageTexts];
          for (const [pageIdx, descriptions] of imageDescriptions) {
            if (pageIdx < enrichedPages.length) {
              const desc = descriptions.map((d) => `[이미지 분석: ${d}]`).join('\n');
              enrichedPages[pageIdx] = enrichedPages[pageIdx] + '\n' + desc;
            }
          }
          textForSummary = enrichedPages.join('\n\n');
          enrichedPagesRef = enrichedPages;
        }
      }

      const checkTimeout = () => {
        if (timedOut) return true;
        if (Date.now() - startTime > TIMEOUT_MS) {
          timedOut = true;
          clearTimeout(timeoutTimer);
          return true;
        }
        return false;
      };

      // abort 확인 — 이미지 분석 중 사용자가 취소했으면 요약 시작하지 않음
      if (!useAppStore.getState().isGenerating) return;

      const docWithImages = { ...document, extractedText: textForSummary };
      // chapter 모드: 이미지 설명이 삽입된 페이지로 챕터 텍스트 재구성
      if (enrichedPagesRef) {
        docWithImages.chapters = document.chapters.map((ch) => ({
          ...ch,
          text: enrichedPagesRef!.slice(ch.startPage - 1, ch.endPage).join('\n\n'),
        }));
      }
      if (summaryType === 'chapter' && document.chapters.length > 1) {
        await summarizeByChapter(docWithImages, settings, trackSummarize, checkTimeout, () => timedOut, appendStream, setProgress);
      } else {
        await summarizeFull(docWithImages, summaryType, settings, trackSummarize, checkTimeout, () => timedOut, appendStream, setProgress);
      }

      const durationMs = Date.now() - startTime;
      flushStream();
      const finalContent = useAppStore.getState().summaryStream;
      if (!timedOut && finalContent) {
        setSummary({
          id: crypto.randomUUID(),
          documentId: document.id,
          type: summaryType,
          content: finalContent,
          model: settings.model,
          provider: settings.provider,
          createdAt: new Date(),
          durationMs,
        });
      }
    } catch (err) {
      // 타임아웃이나 사용자 취소로 인한 abort 에러는 이미 적절한 메시지가 설정됨
      if (!timedOut && useAppStore.getState().document) {
        const error = err as Error & { code?: string };
        setError({
          code: (error.code as 'GENERATE_FAIL') || 'GENERATE_FAIL',
          message: error.message || '요약 생성에 실패했습니다.',
        });
      }
    } finally {
      clearTimeout(timeoutTimer);
      // document가 null이면 사용자가 닫기를 눌렀으므로 flush 불필요
      if (useAppStore.getState().document) {
        flushStream();
      }
      setIsGenerating(false);
    }
  };

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
        <h1 className="text-lg font-bold text-gray-800 dark:text-white">
          📄 PDF 자료 요약기
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
          <SummaryViewer />
        )}
      </main>

      {/* Status Bar */}
      <StatusBar />
    </div>
  );
}

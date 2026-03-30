import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { chunkText, chunkChapters } from './chunker';
import type { PdfDocument, SummaryType, AppSettings } from '../types';

type TrackFn = (text: string, type: SummaryType) => AsyncGenerator<string>;

async function analyzeDocumentImages(
  doc: PdfDocument,
  client: { analyzeImage: (base64: string) => Promise<string> },
  setProgress: (p: number) => void,
  isAborted: () => boolean,
): Promise<Map<number, string[]>> {
  const imageDescriptions = new Map<number, string[]>();

  const firstImg = doc.images[0];
  if (!firstImg) return imageDescriptions;

  const preflight = await window.electronAPI.ai.analyzeImage(firstImg.base64);
  if (!preflight.success) {
    throw new Error(preflight.error || '이미지 분석에 실패했습니다.');
  }
  if (preflight.description) {
    imageDescriptions.set(firstImg.pageIndex, [preflight.description]);
  }

  const BATCH = 3;
  for (let bi = 1; bi < doc.images.length && !isAborted(); bi += BATCH) {
    const batch = doc.images.slice(bi, bi + BATCH);
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
    setProgress(Math.min(20, Math.round(((bi + batch.length) / doc.images.length) * 20)));
  }

  return imageDescriptions;
}

function enrichDocumentWithImages(
  doc: PdfDocument,
  imageDescriptions: Map<number, string[]>,
): { textForSummary: string; enrichedPages: string[] | null } {
  if (imageDescriptions.size === 0) return { textForSummary: doc.extractedText, enrichedPages: null };

  const enrichedPages = [...doc.pageTexts];
  for (const [pageIdx, descriptions] of imageDescriptions) {
    if (pageIdx < enrichedPages.length) {
      const desc = descriptions.map((d) => `[이미지 분석: ${d}]`).join('\n');
      enrichedPages[pageIdx] = enrichedPages[pageIdx] + '\n' + desc;
    }
  }
  return { textForSummary: enrichedPages.join('\n\n'), enrichedPages };
}

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
    const charsPerToken = Math.max(1.5, 4 - ((combined.match(/[\uAC00-\uD7AF]/g) || []).length / Math.max(combined.length, 1)) * 2.5);
    const maxCombinedChars = Math.floor(settings.maxChunkSize * charsPerToken);
    const safeCombined = combined.length > maxCombinedChars
      ? combined.slice(0, maxCombinedChars) + '\n\n[... 이하 생략 — 청크 수가 많아 일부만 포함]'
      : combined;
    for await (const token of track(
      `다음은 강의자료의 파트별 요약입니다. 이를 하나의 통합 요약으로 정리해주세요.\n\n${safeCombined}`,
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

export function useSummarize() {
  const document = useAppStore((s) => s.document);
  const summaryType = useAppStore((s) => s.summaryType);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const setIsGenerating = useAppStore((s) => s.setIsGenerating);
  const setProgress = useAppStore((s) => s.setProgress);
  const appendStream = useAppStore((s) => s.appendStream);
  const clearStream = useAppStore((s) => s.clearStream);
  const flushStream = useAppStore((s) => s.flushStream);
  const setSummary = useAppStore((s) => s.setSummary);
  const settings = useAppStore((s) => s.settings);
  const setError = useAppStore((s) => s.setError);
  const clientRef = useRef<AiClient | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAbort = useCallback(() => {
    // 타임아웃 타이머 클리어 — 사용자 수동 abort 시 이중 abort 방지
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    const reqId = useAppStore.getState().currentRequestId;
    if (reqId) {
      window.electronAPI.ai.abort(reqId);
    }
    clientRef.current = null;
    useAppStore.getState().setCurrentRequestId(null);
    flushStream();
    setIsGenerating(false);
  }, [flushStream, setIsGenerating]);

  // 언마운트 시 진행 중인 요약 정리 (타이머 + AI 요청)
  useEffect(() => {
    return () => {
      if (timeoutTimerRef.current) {
        clearTimeout(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }
      const reqId = useAppStore.getState().currentRequestId;
      if (reqId) {
        window.electronAPI.ai.abort(reqId);
      }
    };
  }, []);

  const handleSummarize = async () => {
    if (!document || isGenerating) return;

    setIsGenerating(true);
    clearStream();
    setProgress(0);
    setError(null);

    const startTime = Date.now();
    const TIMEOUT_MS = 300000;
    let timedOut = false;

    timeoutTimerRef.current = setTimeout(() => {
      timedOut = true;
      timeoutTimerRef.current = null;
      handleAbort();
      setError({
        code: 'GENERATE_TIMEOUT',
        message: '요약 시간이 초과되었습니다. 생성된 부분까지 표시됩니다. 청크 크기를 줄이거나 경량 모델을 사용해보세요.',
      });
    }, TIMEOUT_MS);

    try {
      const client = new AiClient(settings);
      clientRef.current = client;

      const trackSummarize = (text: string, type: SummaryType) => {
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

      // 이미지 분석
      let textForSummary = document.extractedText;
      let enrichedPagesRef: string[] | null = null;
      if (document.images.length > 0 && settings.enableImageAnalysis) {
        try {
          const imageDescriptions = await analyzeDocumentImages(
            document, client, setProgress,
            () => timedOut || !useAppStore.getState().isGenerating,
          );
          const enriched = enrichDocumentWithImages(document, imageDescriptions);
          textForSummary = enriched.textForSummary;
          enrichedPagesRef = enriched.enrichedPages;
        } catch (imgErr) {
          setError({ code: 'GENERATE_FAIL', message: (imgErr as Error).message });
          setIsGenerating(false);
          if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; };
          return;
        }
      }

      const checkTimeout = () => {
        if (timedOut) return true;
        if (Date.now() - startTime > TIMEOUT_MS) {
          timedOut = true;
          if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; };
          return true;
        }
        return false;
      };

      if (!useAppStore.getState().isGenerating) return;

      const docWithImages = { ...document, extractedText: textForSummary };
      if (enrichedPagesRef) {
        docWithImages.chapters = document.chapters.map((ch) => ({
          ...ch,
          text: enrichedPagesRef!.slice(ch.startPage - 1, ch.endPage).join('\n\n'),
        }));
      }

      const isCancelled = () => timedOut || !useAppStore.getState().isGenerating;
      if (summaryType === 'chapter' && document.chapters.length > 1) {
        await summarizeByChapter(docWithImages, settings, trackSummarize, checkTimeout, isCancelled, appendStream, setProgress);
      } else {
        await summarizeFull(docWithImages, summaryType, settings, trackSummarize, checkTimeout, isCancelled, appendStream, setProgress);
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
      if (!timedOut && useAppStore.getState().document) {
        const error = err as Error & { code?: string };
        setError({
          code: (error.code as 'GENERATE_FAIL') || 'GENERATE_FAIL',
          message: error.message || '요약 생성에 실패했습니다.',
        });
      }
    } finally {
      if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; };
      if (useAppStore.getState().document) {
        flushStream();
      }
      setIsGenerating(false);
    }
  };

  return { handleSummarize, handleAbort };
}

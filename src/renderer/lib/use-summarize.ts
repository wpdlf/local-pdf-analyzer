import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { chunkText, chunkChapters, estimateCharsPerToken } from './chunker';

/**
 * 페이지별 텍스트 배열을 받아, 각 단락 앞에 `[p.N] ` inline 마커를 붙여 단일 문자열로 반환.
 * LLM 이 각 문장의 정확한 페이지를 알 수 있게 하는 page-citation-viewer 기능의 핵심.
 *
 * 청크 prefix 1개만 붙이는 기존 방식은 LLM 이 범위만 알 수 있어 인용 생성이 희박했음.
 * 단락 단위 inline 마커는 chunkText 가 어디서 분할하든 각 청크의 모든 문단에 라벨 유지.
 */
function labelParagraphsWithPages(pageTexts: string[]): string {
  const labeled: string[] = [];
  pageTexts.forEach((pageText, pageIdx) => {
    if (!pageText || !pageText.trim()) return;
    const label = `[p.${pageIdx + 1}]`;
    const paragraphs = pageText.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      labeled.push(`${label} ${para}`);
    }
  });
  return labeled.join('\n\n');
}
import type { PdfDocument, DefaultSummaryType, AppSettings, ProgressInfo, AppError } from '../types';

// TrackFn은 요약 파이프라인 내부에서만 사용되며 'qa' 타입은 호출되지 않음.
// 'qa'는 use-qa.ts 의 handleAsk 에서 ai-client.summarize 를 직접 호출하는 별도 경로.
type TrackFn = (text: string, type: DefaultSummaryType) => AsyncGenerator<string>;

/** 로컬 LLM이 생성한 대화형 멘트를 후처리로 제거 */
function stripConversationalText(text: string): string {
  // 줄 단위로 처리 — 대화형 패턴이 포함된 줄 제거
  const patterns = [
    // 한국어
    /도움이\s*되[길었]?\s*(바랍|되었|되셨)/,
    /궁금한\s*(점|사항|것|내용)이?\s*(있으시면|있으면)/,
    /추가(로|적인)?\s*(궁금|질문|문의)/,
    /언제든지?\s*(물어|말씀|문의|연락)/,
    /말씀해\s*주세요/,
    /필요하시면\s*(언제|말씀|연락)/,
    /자세한\s*정보가?\s*필요하시면/,
    /요약해\s*드리겠습니다/,
    /설명해\s*드리겠습니다/,
    /정리해\s*드리겠습니다/,
    /알려\s*드리겠습니다/,
    /다루고\s*있습니다.*:?\s*$/,
    /주요\s*내용을?\s*요약/,
    /이상으로\s*.*(마치|끝|정리)/,
    /좋은\s*자료입니다/,
    /잘\s*정리되어/,
    /강점을\s*잘\s*보여/,
    /도움이\s*되(었으면|길)\s*좋겠/,
    // English
    /^(I\s+)?hope\s+this\s+helps/i,
    /feel\s+free\s+to\s+ask/i,
    /let\s+me\s+know\s+if\s+you/i,
    /if\s+you\s+have\s+any\s+(other\s+)?questions/i,
    /I[''\u2019]d\s+be\s+happy\s+to\s+help/i,
    /here[''\u2019]?s?\s+(a\s+)?summary\s+of/i,
    /in\s+conclusion\s*[,.:]/i,
    /to\s+summarize\s*[,.:]/i,
    // 日本語
    /お役に立てれば/,
    /ご質問があれば/,
    /^以上(です|になります|となります)/,
    /お気軽にお聞き/,
    /要約(いた)?します/,
    // 中文
    /希望(对你|这)有(所)?帮助/,
    /如有(任何)?疑问/,
    /^以上(就是|是|为)/,
    /总结如下/,
  ];
  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // 빈 줄 유지
    return !patterns.some((p) => p.test(trimmed));
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function analyzeDocumentImages(
  doc: PdfDocument,
  client: { analyzeImage: (base64: string) => Promise<string | null> },
  setProgress: (p: number) => void,
  setProgressInfo: ((info: ProgressInfo) => void) | null,
  startTime: number,
  isAborted: () => boolean,
): Promise<Map<number, string[]>> {
  const imageDescriptions = new Map<number, string[]>();

  const firstImg = doc.images[0];
  if (!firstImg) return imageDescriptions;

  // preflight도 client를 통해 호출 (일관된 에러 처리 경로)
  const preflightResult = await client.analyzeImage(firstImg.base64);
  if (preflightResult === null) {
    throw new Error('이미지 분석에 실패했습니다. Vision 모델을 확인해주세요.');
  }
  imageDescriptions.set(firstImg.pageIndex, [preflightResult]);

  const BATCH = 3;
  for (let bi = 1; bi < doc.images.length && !isAborted(); bi += BATCH) {
    const batch = doc.images.slice(bi, bi + BATCH);
    const processed = bi + batch.length;
    setProgressInfo?.({
      percent: Math.min(20, Math.round((processed / doc.images.length) * 20)),
      phase: 'image',
      current: Math.min(processed, doc.images.length),
      total: doc.images.length,
      elapsedMs: Date.now() - startTime,
    });
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
    setProgress(Math.min(20, Math.round((processed / doc.images.length) * 20)));
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
  setProgressInfo: (info: ProgressInfo) => void, startTime: number,
  progressOffset: number,
) {
  const progressRange = 100 - progressOffset; // 요약 단계에서 사용할 진행률 범위
  // page-citation-viewer: 챕터의 원래 페이지들을 복원해 단락별 [p.N] 라벨 적용.
  // chapter.text 는 pageTexts.slice(startPage-1, endPage).join('\n\n') 이므로,
  // 같은 slice 에서 labelParagraphsWithPages 를 호출해 per-page 라벨링된 텍스트 생성.
  const hasPageTexts = Array.isArray(doc.pageTexts) && doc.pageTexts.length > 0;
  const labeledChapters = doc.chapters.map((ch) => {
    if (!hasPageTexts) {
      return { ...ch }; // 레거시 경로
    }
    const chapterPageTexts = doc.pageTexts.slice(ch.startPage - 1, ch.endPage);
    // labelParagraphsWithPages 는 0-based index 를 가정 → pageIdx 를 startPage-1 만큼 shift 필요
    const labeled = chapterPageTexts
      .map((pt, i) => {
        if (!pt || !pt.trim()) return '';
        const label = `[p.${ch.startPage + i}]`;
        const paragraphs = pt.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
        return paragraphs.map((para) => `${label} ${para}`).join('\n\n');
      })
      .filter(Boolean)
      .join('\n\n');
    return { ...ch, text: labeled || ch.text };
  });
  const chaptersData = chunkChapters(labeledChapters, settings.maxChunkSize);
  const total = chaptersData.reduce((sum, c) => sum + c.chunks.length, 0);
  // 모든 챕터의 청크가 비어있는 경우 → chunkText가 [] 반환(공백뿐인 텍스트)
  // 사용자에게 무음 실패 대신 명시적 에러 surface
  if (total === 0) {
    throw Object.assign(
      new Error('요약할 내용이 없습니다. PDF에서 유의미한 텍스트를 추출하지 못했습니다.'),
      { code: 'PDF_NO_TEXT' },
    );
  }
  let processed = 0;
  let chapterIdx = 0;
  for (const { chapter, chunks } of chaptersData) {
    if (isTimedOut()) break;
    chapterIdx++;
    let chapterHeaderPending = `\n## ${chapter.title}\n\n`;
    // chunks 는 이미 단락 수준 [p.N] 인라인 마커를 포함 — 추가 prefix 불필요
    for (const chunk of chunks) {
      if (isTimedOut()) break;
      const elapsedMs = Date.now() - startTime;
      const rawPercent = total > 0 ? (processed / total) : 0;
      const percent = Math.min(100, progressOffset + rawPercent * progressRange);
      const estimatedRemainingMs = processed > 0
        ? Math.round((elapsedMs / processed) * (total - processed))
        : undefined;
      setProgressInfo({
        percent,
        phase: 'summarize',
        current: chapterIdx,
        total: chaptersData.length,
        chapterName: chapter.title,
        elapsedMs,
        estimatedRemainingMs,
      });
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
      const completedRaw = total > 0 ? (processed / total) : 1;
      const completedPercent = Math.min(100, progressOffset + completedRaw * progressRange);
      setProgress(completedPercent);
      setProgressInfo({
        percent: completedPercent,
        phase: 'summarize',
        current: chapterIdx,
        total: chaptersData.length,
        chapterName: chapter.title,
        elapsedMs: Date.now() - startTime,
        estimatedRemainingMs: processed < total
          ? Math.round(((Date.now() - startTime) / processed) * (total - processed))
          : 0,
      });
    }
    append('\n\n---\n');
  }
}

async function summarizeFull(
  doc: PdfDocument, summaryType: DefaultSummaryType, settings: AppSettings, track: TrackFn,
  checkTimeout: () => boolean, isTimedOut: () => boolean,
  append: (s: string) => void, setProgress: (p: number) => void,
  setProgressInfo: (info: ProgressInfo) => void, startTime: number,
  progressOffset: number,
) {
  const progressRange = 100 - progressOffset;
  // page-citation-viewer: 페이지 경계마다 inline [p.N] 마커를 **단락 수준** 으로 삽입.
  // 이전 구현(청크 prefix 1개)은 LLM 이 청크 전체가 어느 페이지 "범위" 인지만 알 수 있어
  // 실제 출력에서 인용이 거의 나오지 않는 문제가 있었음.
  // 단락마다 `[p.N] ` 을 붙이면 LLM 이 각 문장의 정확한 페이지를 보게 되어 자연스럽게
  // 여러 인용을 생성. chunkText 가 \n\n 으로 분할해도 각 청크의 모든 문단에 라벨이 있음.
  const hasPageTexts = Array.isArray(doc.pageTexts) && doc.pageTexts.length > 0;
  const labeledText = hasPageTexts
    ? labelParagraphsWithPages(doc.pageTexts)
    : doc.extractedText;
  const chunks = chunkText(labeledText, settings.maxChunkSize);
  // chunkText는 공백/빈 입력 시 []를 반환. 빈 배열로 진입하면 루프 스킵 →
  // 사용자는 스피너가 사라지지만 content/에러가 없는 무음 실패를 겪음.
  if (chunks.length === 0) {
    throw Object.assign(
      new Error('요약할 내용이 없습니다. PDF에서 유의미한 텍스트를 추출하지 못했습니다.'),
      { code: 'PDF_NO_TEXT' },
    );
  }
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (isTimedOut()) break;
    const elapsedMs = Date.now() - startTime;
    const rawPercent = (i / chunks.length) * 0.9; // 90% of summarize range
    const percent = progressOffset + rawPercent * progressRange;
    const estimatedRemainingMs = i > 0
      ? Math.round((elapsedMs / i) * (chunks.length - i))
      : undefined;
    setProgressInfo({
      percent,
      phase: 'summarize',
      current: i + 1,
      total: chunks.length,
      elapsedMs,
      estimatedRemainingMs,
    });
    let chunkResult = '';
    for await (const token of track(chunks[i], summaryType)) {
      if (checkTimeout()) break;
      append(token);
      chunkResult += token;
    }
    chunkSummaries.push(chunkResult);
    setProgress(progressOffset + ((i + 1) / chunks.length) * 0.9 * progressRange);
    if (i < chunks.length - 1) append('\n\n---\n\n');
  }
  if (!isTimedOut() && chunks.length > 1 && summaryType === 'full') {
    setProgressInfo({
      percent: progressOffset + 0.95 * progressRange,
      phase: 'integrate',
      current: chunks.length,
      total: chunks.length,
      elapsedMs: Date.now() - startTime,
    });
    const integrationLabels: Record<string, { heading: string; instruction: string; truncated: string }> = {
      ko: { heading: '📋 통합 요약', instruction: '다음은 문서의 파트별 요약입니다. 이를 하나의 통합 요약으로 정리해주세요.', truncated: '[... 이하 생략 — 청크 수가 많아 일부만 포함]' },
      en: { heading: 'Integrated Summary', instruction: 'The following are per-section summaries of the document. Please consolidate them into a single integrated summary.', truncated: '[... truncated — too many chunks to include all]' },
      ja: { heading: '統合要約', instruction: '以下は文書のセクション別要約です。これらを一つの統合要約にまとめてください。', truncated: '[... 以下省略 — チャンク数が多いため一部のみ含む]' },
      zh: { heading: '综合总结', instruction: '以下是文档各部分的摘要。请将它们整合为一个综合总结。', truncated: '[... 以下省略 — 分块过多仅包含部分]' },
      auto: { heading: 'Integrated Summary', instruction: 'The following are per-section summaries of the document. Consolidate them into a single integrated summary.', truncated: '[... truncated]' },
    };
    const lang = settings.summaryLanguage || 'ko';
    const labels = integrationLabels[lang] || integrationLabels['ko'];
    append(`\n\n---\n\n## ${labels.heading}\n\n`);
    const combined = chunkSummaries.join('\n\n');
    // chunker.ts 와 동일한 추정식을 재사용 — 중복 구현 제거 (유지보수 일관성)
    const charsPerToken = estimateCharsPerToken(combined);
    const maxCombinedChars = Math.floor(settings.maxChunkSize * charsPerToken);
    const safeCombined = combined.length > maxCombinedChars
      ? combined.slice(0, maxCombinedChars) + `\n\n${labels.truncated}`
      : combined;
    for await (const token of track(
      `${labels.instruction}\n\n${safeCombined}`,
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
  const setProgressInfo = useAppStore((s) => s.setProgressInfo);
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
    // stale closure 방지: store에서 최신 상태 직접 읽기
    const currentState = useAppStore.getState();
    if (!currentState.document || currentState.isGenerating || currentState.isQaGenerating) return;
    const currentSettings = currentState.settings;
    const currentSummaryType = currentState.summaryType;
    const doc = currentState.document;

    setIsGenerating(true);
    clearStream();
    setProgress(0);
    setProgressInfo(null);
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
      const client = new AiClient(currentSettings);
      clientRef.current = client;

      const trackSummarize = (text: string, type: DefaultSummaryType) => {
        // clientRef 비교로 stale closure 방지: abort 후 재요약 시 이전 client 토큰 무시.
        // stale 체크를 prepareSummarize / setCurrentRequestId 이전에 수행해야
        // stale 빌드가 store에 고아 requestId를 남기지 않음.
        if (clientRef.current !== client) return (async function*(): AsyncGenerator<string> {})();
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
        setError({ code: currentSettings.provider === 'ollama' ? 'OLLAMA_NOT_RUNNING' : 'API_KEY_MISSING', message: providerMessages[currentSettings.provider] });
        // 중복 cleanup 제거 — outer finally에서 setIsGenerating, flushStream 일괄 처리
        return;
      }

      // 이미지 분석
      let textForSummary = doc.extractedText;
      let enrichedPagesRef: string[] | null = null;
      if (doc.images.length > 0 && currentSettings.enableImageAnalysis) {
        setProgressInfo({
          percent: 0, phase: 'image', current: 0, total: doc.images.length, elapsedMs: 0,
        });
        try {
          const imageDescriptions = await analyzeDocumentImages(
            doc, client, setProgress, setProgressInfo, startTime,
            () => timedOut || !useAppStore.getState().isGenerating,
          );
          const enriched = enrichDocumentWithImages(doc, imageDescriptions);
          textForSummary = enriched.textForSummary;
          enrichedPagesRef = enriched.enrichedPages;
        } catch (imgErr) {
          setError({ code: 'GENERATE_FAIL', message: (imgErr as Error).message });
          // 중복 cleanup 제거 — outer finally에서 flushStream, setIsGenerating, timeout 정리 일괄 처리
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

      const docWithImages = { ...doc, extractedText: textForSummary };
      if (enrichedPagesRef) {
        docWithImages.chapters = doc.chapters.map((ch) => {
          const enrichedText = enrichedPagesRef!.slice(ch.startPage - 1, ch.endPage).join('\n\n');
          // 원본 chapter.text에만 존재하는 pre-chapter 텍스트 보존
          const originalPrefix = ch.text.split('\n')[0] || '';
          const enrichedFirst = enrichedText.split('\n')[0] || '';
          if (originalPrefix !== enrichedFirst && !enrichedText.startsWith(originalPrefix)) {
            return { ...ch, text: originalPrefix + '\n\n' + enrichedText };
          }
          return { ...ch, text: enrichedText };
        });
      }

      const isCancelled = () => timedOut || !useAppStore.getState().isGenerating;
      // 이미지 분석이 진행된 경우 진행률 20%부터 이어서 시작 (역행 방지)
      const progressOffset = (doc.images.length > 0 && currentSettings.enableImageAnalysis) ? 20 : 0;
      if (currentSummaryType === 'chapter' && docWithImages.chapters.length > 1) {
        await summarizeByChapter(docWithImages, currentSettings, trackSummarize, checkTimeout, isCancelled, appendStream, setProgress, setProgressInfo, startTime, progressOffset);
      } else {
        await summarizeFull(docWithImages, currentSummaryType, currentSettings, trackSummarize, checkTimeout, isCancelled, appendStream, setProgress, setProgressInfo, startTime, progressOffset);
      }

      const durationMs = Date.now() - startTime;
      flushStream();
      const rawContent = useAppStore.getState().summaryStream;
      // 후처리: 로컬 LLM이 프롬프트 금지 사항을 무시한 대화형 멘트 제거
      const finalContent = stripConversationalText(rawContent);
      if (finalContent !== rawContent) {
        useAppStore.getState().replaceSummaryStream(finalContent);
      }
      if (!timedOut && finalContent) {
        setSummary({
          id: crypto.randomUUID(),
          documentId: doc.id,
          type: currentSummaryType,
          content: finalContent,
          model: currentSettings.model,
          provider: currentSettings.provider,
          createdAt: new Date(),
          durationMs,
        });
      }
    } catch (err) {
      const rawCode = (err instanceof Error && 'code' in err ? (err as Error & { code?: string }).code : undefined);
      // 사용자 의도적 abort는 에러로 표시하지 않음 (timeout은 별도 메시지 이미 표시됨)
      if (rawCode !== 'ABORTED' && !timedOut && useAppStore.getState().document) {
        // 유효한 AppErrorCode만 허용, 그 외는 GENERATE_FAIL로 매핑
        const validCodes = new Set(['PDF_NO_TEXT', 'GENERATE_TIMEOUT', 'API_KEY_MISSING', 'API_KEY_INVALID', 'OLLAMA_NOT_RUNNING']);
        const code = (rawCode && validCodes.has(rawCode) ? rawCode : 'GENERATE_FAIL') as AppError['code'];
        const message = err instanceof Error ? err.message : String(err);
        setError({
          code,
          message: message || '요약 생성에 실패했습니다.',
        });
      }
    } finally {
      try {
        if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; }
        if (useAppStore.getState().document) {
          flushStream();
        }
      } catch { /* finally 블록 에러 무시 */ }
      setProgressInfo(null);
      setIsGenerating(false);
    }
  };

  return { handleSummarize, handleAbort };
}

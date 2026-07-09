import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { t } from './i18n';
import { PROVIDER_LABELS, isCustomSummaryType } from '../types';
import { AiClient } from './ai-client';
import { chunkText, chunkChapters, estimateCharsPerToken } from './chunker';
import { normalizeCitationPlacement, CITATION_REGEX } from './citation';
import { enrichDocumentWithImages } from './enrich-doc';
import { slicePdfDocumentByPageRange, isFullRange } from './page-range';

/**
 * 페이지별 텍스트 배열을 받아, 각 단락 앞에 `[p.N] ` inline 마커를 붙여 단일 문자열로 반환.
 * LLM 이 각 문장의 정확한 페이지를 알 수 있게 하는 page-citation-viewer 기능의 핵심.
 *
 * 청크 prefix 1개만 붙이는 기존 방식은 LLM 이 범위만 알 수 있어 인용 생성이 희박했음.
 * 단락 단위 inline 마커는 chunkText 가 어디서 분할하든 각 청크의 모든 문단에 라벨 유지.
 *
 * R35: 요약 경로는 설계상 **항상 단일 `[p.N]`** 만 방출한다(범위 라벨 미사용). Q&A 경로
 * (use-qa.ragSearch)가 R35 전까지 범위 라벨 `[p.N-M]` 에 의존하다 인용 소실을 겪은 것과 달리,
 * 요약 경로는 이 함수로 단락마다 단일 라벨을 인라인 삽입해 동일 문제를 원천 회피한다.
 * use-summarize.test.ts 가 이 불변식(범위 미방출 + CITATION_REGEX 재파싱 가능)을 가드한다.
 */
export function labelParagraphsWithPages(pageTexts: string[]): string {
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

/**
 * 멀티청크 통합요약 직전, 청크별 요약 모음을 maxChars 예산에 맞춰 줄인다.
 *
 * 기존 위치기반 절단(`combined.slice(0, maxChars)`)은 앞 청크 요약만 남기고 후반 청크 요약을
 * **통째로 버려** 긴 문서의 뒷부분이 통합요약에서 누락됐다. 대신 각 청크 요약을 길이 비례로
 * 트렁케이트해 모든 청크(=문서 전 구간)가 통합 단계에 대표되도록 한다.
 *
 * - 예산 내면 원본 그대로(join). 초과 시에만 절단.
 * - 배분은 water-filling: 균등 몫(remaining/미확정수)보다 짧은 청크는 온전히 보존하고 남는
 *   예산을 더 긴 청크들에 재분배한다. 따라서 짧은/후반 청크가 통째로 사라지지 않고, 긴 청크만
 *   자기 몫으로 잘리며 말줄임표(…)가 붙는다.
 * - 반환 문자열에는 절단이 일어났음을 알리는 truncatedLabel 을 말미에 덧붙인다(예산 초과 시만).
 */
export function truncateChunkSummariesForIntegration(
  chunkSummaries: string[],
  maxChars: number,
  truncatedLabel: string,
  sep = '\n\n',
): string {
  const combined = chunkSummaries.join(sep);
  if (combined.length <= maxChars) return combined;
  const sepBudget = sep.length * Math.max(0, chunkSummaries.length - 1);
  let remaining = Math.max(0, maxChars - sepBudget);

  // water-filling: 균등 몫에 들어가는 짧은 청크를 확정(온전 보존)하고 남는 예산을 재분배.
  const allot = new Array<number>(chunkSummaries.length).fill(-1); // -1 = 미확정
  let unsettled = chunkSummaries.length;
  let changed = true;
  while (changed && unsettled > 0) {
    changed = false;
    const share = Math.floor(remaining / unsettled);
    for (let i = 0; i < chunkSummaries.length; i++) {
      if (allot[i] !== -1) continue;
      if (chunkSummaries[i]!.length <= share) {
        allot[i] = chunkSummaries[i]!.length;
        remaining -= allot[i]!;
        unsettled -= 1;
        changed = true;
      }
    }
  }
  if (unsettled > 0) {
    const share = Math.floor(remaining / unsettled); // 남은(긴) 청크들에 균등 분배
    for (let i = 0; i < chunkSummaries.length; i++) if (allot[i] === -1) allot[i] = share;
  }

  const parts = chunkSummaries.map((s, i) =>
    s.length > allot[i]! ? s.slice(0, allot[i]!).trimEnd() + '…' : s,
  );
  return parts.join(sep) + `\n\n${truncatedLabel}`;
}
import type { PdfDocument, DefaultSummaryType, AppSettings, ProgressInfo, AppError, SummaryTemplate } from '../types';

// TrackFn은 요약 파이프라인 내부에서만 사용되며 'qa' 타입은 호출되지 않음.
// 'qa'는 use-qa.ts 의 handleAsk 에서 ai-client.summarize 를 직접 호출하는 별도 경로.
type TrackFn = (text: string, type: DefaultSummaryType) => AsyncGenerator<string>;

/**
 * 로컬 LLM이 생성한 대화형 멘트를 후처리로 제거.
 *
 * R37 P6 (v0.18.23): export 로 전환해 단위 테스트 가능화 (QA M4). 이 함수는 ~30개 다국어
 * 정규식으로 구성돼 인라인 주석에 R28~R37 회귀원으로 명시돼 있었으나 회귀 가드가 없었다.
 * use-summarize-strip.test.ts 가 대표 패턴/본문 보존/빈줄·중복개행 정규화를 가드한다.
 */
export function stripConversationalText(text: string): string {
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
    // QA post-v0.31.15: 콜론(인용 리드인)으로 끝날 때만 strip. 이전 `.*:?\s*$` 는 "…를 다루고
    // 있습니다." 같은 실문장도 통째로 삭제했다(아래 인용 가드와 함께 이중 방어).
    /다루고\s*있습니다\s*[:：]\s*$/,
    // 독립 헤딩 라인일 때만 strip (본문 중간의 "주요 내용 요약" 표현 보존).
    /^주요\s*내용을?\s*요약\s*[:：]?\s*$/,
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
    // 짧은 리드인 라인일 때만 strip (본문 문장 "…を要約します。" 보존).
    /^.{0,12}要約(いた)?します[。：:]?\s*$/,
    // 中文
    /希望(对你|这)有(所)?帮助/,
    /如有(任何)?疑问/,
    /^以上(就是|是|为)/,
    // 리드인 "总结如下(:)" 이 라인 끝일 때만 strip — 본문 중간 등장은 보존(끝-앵커).
    /总结如下\s*[：:]?\s*$/,
  ];
  // 인용 [p.N] 을 담은 라인은 실질 본문이므로 대화체 strip 대상에서 제외한다(QA post-v0.31.15).
  // 비앵커드 패턴이 "…를 다루고 있습니다[p.5]." 같은 실문장을 통째로 지워 인용까지 소실하던
  // 결함의 근본 방어. g 플래그 제외본을 써 .test() 가 lastIndex 무상태(라인 간 재사용 안전).
  const citationLine = new RegExp(CITATION_REGEX.source, 'i');
  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // 빈 줄 유지
    if (citationLine.test(trimmed)) return true; // 인용 포함 = 본문, 보존
    return !patterns.some((p) => p.test(trimmed));
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function analyzeDocumentImages(
  doc: PdfDocument,
  client: { analyzeImage: (base64: string, requestId?: string) => Promise<string | null> },
  setProgress: (p: number) => void,
  setProgressInfo: ((info: ProgressInfo) => void) | null,
  startTime: number,
  isAborted: () => boolean,
  provider: 'ollama' | 'claude' | 'openai' | 'gemini' = 'ollama',
  // R30 P2 (v0.18.18): Stop / 문서 전환 시 in-flight Vision 호출을 즉시 abort 하기 위한
  // hook. 호출자(use-summarize 메인 흐름) 가 in-flight requestId 들을 추적해 두면
  // isAborted() 가 true 가 된 직후 abortInFlight() 한 번 호출로 모두 끊을 수 있다.
  registerInFlight?: (requestId: string) => void,
  unregisterInFlight?: (requestId: string) => void,
): Promise<Map<number, string[]>> {
  const imageDescriptions = new Map<number, string[]>();

  const firstImg = doc.images[0];
  if (!firstImg) return imageDescriptions;

  // preflight도 client를 통해 호출 (일관된 에러 처리 경로)
  const preflightRequestId = crypto.randomUUID();
  registerInFlight?.(preflightRequestId);
  let preflightResult: string | null;
  try {
    preflightResult = await client.analyzeImage(firstImg.base64, preflightRequestId);
  } finally {
    unregisterInFlight?.(preflightRequestId);
  }
  if (preflightResult === null) {
    throw new Error(t('ai.imageAnalysisFail'));
  }
  imageDescriptions.set(firstImg.pageIndex, [preflightResult]);

  // R29 (v0.18.15): Provider-aware 동시성 — OCR 가 이미 채택한 패턴 (Ollama 3 / cloud 8)
  // 을 이미지 분석에도 동일 적용. Ollama 는 단일 인스턴스라 3 이상은 의미 없지만,
  // Claude/OpenAI 는 REST 동시 요청을 권장 throughput 까지 허용.
  // 이미지 많은 PDF 의 분석 시간 30~40% 단축 (cloud provider 한정).
  // R44(R43 후속 M5): Gemini 는 무료 티어 분당 한도가 낮아 동시 8 이 429 폭주를 유발 —
  // 3 으로 하향 (429 는 ai-service 의 retryOn429 백오프가 추가 방어 — Vision/임베딩 경로 한정, generate 미적용). pdf-parser OCR 동일.
  const BATCH = provider === 'ollama' || provider === 'gemini' ? 3 : 8;
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
    const batchIds = batch.map(() => crypto.randomUUID());
    batchIds.forEach((id) => registerInFlight?.(id));
    let results: PromiseSettledResult<string | null>[];
    try {
      results = await Promise.allSettled(
        batch.map((img, idx) => client.analyzeImage(img.base64, batchIds[idx])),
      );
    } finally {
      batchIds.forEach((id) => unregisterInFlight?.(id));
    }
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

// v0.18.19 patch R34 P2: enrichDocumentWithImages 는 enrich-doc.ts 로 추출. use-summarize.ts
// 가 무거운 의존성을 가져 vitest 가 본 함수만 단위 테스트하기 어려웠다 — pure 한 부분만
// 별도 모듈로 분리하여 R34 회귀 가드 추가.
// 기존 호출자 (line 523 부근) 는 import 만 바꾸면 시그니처 동일.

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
      new Error(t('ai.noText')),
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
      new Error(t('ai.noText')),
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
    const chunkText = chunks[i];
    if (chunkText === undefined) continue;
    for await (const token of track(chunkText, summaryType)) {
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
    const labels = integrationLabels[lang] || integrationLabels['ko'] || integrationLabels.ko;
    if (!labels) {
      setProgress(100);
      return;
    }
    append(`\n\n---\n\n## ${labels.heading}\n\n`);
    // chunker.ts 와 동일한 추정식을 재사용 — 중복 구현 제거 (유지보수 일관성)
    const charsPerToken = estimateCharsPerToken(chunkSummaries.join('\n\n'));
    const maxCombinedChars = Math.floor(settings.maxChunkSize * charsPerToken);
    // 위치기반 절단(앞 청크만 남고 후반 누락) 대신 청크별 비례 절단으로 전 구간 대표.
    const safeCombined = truncateChunkSummariesForIntegration(
      chunkSummaries,
      maxCombinedChars,
      labels.truncated,
    );
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

// 커스텀 요약 템플릿 단일 패스 문자 예산 — 초과분은 앞부분으로 절단(단일 요청이라 chunk/통합 파이프라인을
// 타지 않음). 커스텀 프롬프트("액션아이템 추출" 등)는 문서 전체 홀리스틱 처리가 의미상 맞기 때문.
const CUSTOM_TEMPLATE_CHAR_BUDGET = 16000;

// 커스텀 템플릿 요약: 페이지 라벨 텍스트를 사용자 프롬프트로 단일 패스 생성. 인용([p.N])은 유지되며,
// 예산 초과 문서는 앞부분으로 절단한다. chunk/chapter/통합 로직을 타지 않아 기존 파이프라인과 격리.
async function summarizeCustom(
  doc: PdfDocument, template: SummaryTemplate,
  runCustom: (text: string, prompt: string) => AsyncGenerator<string>,
  checkTimeout: () => boolean, isTimedOut: () => boolean,
  append: (s: string) => void, setProgress: (p: number) => void,
  setProgressInfo: (info: ProgressInfo) => void, startTime: number, progressOffset: number,
) {
  const progressRange = 100 - progressOffset;
  const hasPageTexts = Array.isArray(doc.pageTexts) && doc.pageTexts.length > 0;
  let text = hasPageTexts ? labelParagraphsWithPages(doc.pageTexts) : doc.extractedText;
  if (!text.trim()) {
    throw Object.assign(new Error(t('ai.noText')), { code: 'PDF_NO_TEXT' });
  }
  if (text.length > CUSTOM_TEMPLATE_CHAR_BUDGET) {
    // QA(②A): 단일 패스라 예산 초과 문서는 앞부분만 요약된다 — 무음 절단은 "문서 전체"라는 기대와
    // 어긋나므로 사용자에게 고지(summarizeFull 의 가시적 통합 절단 라벨과 대칭, imagesSkipped 패턴).
    useAppStore.getState().setNotice({ message: t('summary.customTruncated') });
    text = text.slice(0, CUSTOM_TEMPLATE_CHAR_BUDGET) + '\n\n[...]';
  }
  setProgressInfo({
    percent: progressOffset + 0.1 * progressRange,
    phase: 'summarize', current: 1, total: 1,
    elapsedMs: Date.now() - startTime,
  });
  for await (const token of runCustom(text, template.prompt)) {
    if (checkTimeout()) break;
    append(token);
  }
  if (!isTimedOut()) setProgress(100);
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
    // QA(post-v0.31.14): finally 의 진행상태 정리가 ownership 가드 안으로 들어가면서
    // (clientRef.current === runClient), abort 로 clientRef 를 null 화한 run 은 finally 에서
    // setProgressInfo(null) 을 건너뛴다. abort 시점에 여기서 직접 정리해 진행률 스피너 잔존 방지.
    setProgressInfo(null);
    setIsGenerating(false);
  }, [flushStream, setIsGenerating, setProgressInfo]);

  // 언마운트 시 진행 중인 요약 정리 (타이머 + AI 요청)
  // v0.18.22 R36 P4: cleanup 은 ref (`timeoutTimerRef`) 와 store 의 latest 값
  // (`useAppStore.getState()`) 만 참조하므로 의도된 빈 deps. 향후 reactive 외부 상태가
  // 추가되면 deps 누락이 stale closure 회귀를 유발할 수 있어 명시 disable 로 의도 고정.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // isCollectionBusy: 교차 요약 준비(gather) 중에는 단일 요약도 차단 — race 클로버링 방지(QA R).
    if (!currentState.document || currentState.isGenerating || currentState.isQaGenerating || currentState.isCollectionBusy) return;
    const currentSettings = currentState.settings;
    const currentSummaryType = currentState.summaryType;
    // 페이지 범위 요약: 범위가 일부면 문서를 마스킹된 사본으로 좁힌다(인용 [p.N] 절대번호 보존).
    // 범위 요약 시에는 Vision enriched 를 RAG store 에 공유하지 않아 Q&A 는 전체 문서 컨텍스트를
    // 유지한다(아래 setEnrichedPageTexts 가드). 슬라이스는 ...doc 라 id/fileName 등은 그대로.
    const rawDoc = currentState.document;
    const pageRange = currentState.summaryPageRange;
    const isPartialRange = pageRange != null && !isFullRange(pageRange, rawDoc.pageCount);
    const doc = isPartialRange
      ? slicePdfDocumentByPageRange(rawDoc, pageRange.start, pageRange.end)
      : rawDoc;

    // Vision 토글 일관성: 이미지 분석이 꺼진 채로 재요약할 때 이전 run 의 enrichedPageTexts 가
    // RAG 에 남아 있으면 "Vision 은 꺼졌는데 Q&A 검색 결과에는 이미지 설명이 섞여 나오는"
    // 비대칭 발생. 요약 시작 직전에 명시적으로 raw 상태로 되돌려 useRagBuilder 가
    // raw pageTexts 로 재빌드하도록 유도.
    if (!currentSettings.enableImageAnalysis && currentState.enrichedPageTexts !== null) {
      useAppStore.getState().setEnrichedPageTexts(null);
    }

    setIsGenerating(true);
    clearStream();
    setProgress(0);
    setProgressInfo(null);
    setError(null);

    const startTime = Date.now();
    const TIMEOUT_MS = 300000;
    let timedOut = false;
    // 이 run 의 소유권 토큰. clientRef.current 와 비교해 Stop→재요약 race 에서 stale run 이
    // 새 run 의 timeoutTimer/isGenerating/progressInfo 를 클로버링하는 것을 막는다(use-qa 의
    // finallyStillOurs 패턴을 요약 쌍둥이에 적용). try 블록의 `client` 는 finally 에서 보이지
    // 않으므로(블록 스코프) try 밖에 캡처. QA post-v0.31.14.
    let runClient: AiClient | null = null;

    timeoutTimerRef.current = setTimeout(() => {
      timedOut = true;
      timeoutTimerRef.current = null;
      handleAbort();
      setError({
        code: 'GENERATE_TIMEOUT',
        message: t('ai.summaryTimeout'),
      });
    }, TIMEOUT_MS);

    try {
      const client = new AiClient(currentSettings);
      clientRef.current = client;
      runClient = client;

      // C5-M1(QA cycle5): 취소 술어를 소유권 토큰 기준으로 판정. 이전엔 ambient `!isGenerating`
      // 만 봐서 Stop→즉시 재요약 시 새 run 이 isGenerating 을 true 로 되돌리면 이미지분석 단계의
      // stale run 이 "부활" — Vision 을 계속 호출(이중 과금)하고 구분선/후처리를 새 run 의
      // 스트림에 주입했다. 소유권(clientRef)이 넘어간 run 은 영구 취소 상태가 된다.
      const stillOwns = () => clientRef.current === client;
      const isRunAborted = () => timedOut || !stillOwns() || !useAppStore.getState().isGenerating;
      // 스트림 append 도 소유권 게이트 — store.appendStream 의 입구 게이트(isGenerating)는
      // 새 run 이 다시 켜 두므로 stale run 의 구분선(`\n\n---\n\n`)/통합 헤딩 주입을 막지 못한다.
      const guardedAppend = (s: string) => { if (stillOwns()) appendStream(s); };

      const trackSummarize = (text: string, type: DefaultSummaryType) => {
        // clientRef 비교로 stale closure 방지: abort 후 재요약 시 이전 client 토큰 무시.
        // stale 체크를 prepareSummarize / setCurrentRequestId 이전에 수행해야
        // stale 빌드가 store에 고아 requestId를 남기지 않음.
        if (clientRef.current !== client) return (async function*(): AsyncGenerator<string> {})();
        const requestId = client.prepareSummarize();
        useAppStore.getState().setCurrentRequestId(requestId);
        return client.summarize(text, type, requestId);
      };

      // 커스텀 템플릿 track — type 'custom' + 사용자 프롬프트를 관통(trackSummarize 와 동일 stale 가드).
      const trackCustom = (text: string, prompt: string) => {
        if (clientRef.current !== client) return (async function*(): AsyncGenerator<string> {})();
        const requestId = client.prepareSummarize();
        useAppStore.getState().setCurrentRequestId(requestId);
        return client.summarize(text, 'custom', requestId, prompt);
      };

      const available = await client.isAvailable();
      if (!available) {
        setError({
          code: currentSettings.provider === 'ollama' ? 'OLLAMA_NOT_RUNNING' : 'API_KEY_MISSING',
          message: currentSettings.provider === 'ollama'
            ? t('ai.ollamaNotRunning')
            : t('ai.apiKeyMissing', { provider: PROVIDER_LABELS[currentSettings.provider] ?? 'AI' }),
        });
        // 중복 cleanup 제거 — outer finally에서 setIsGenerating, flushStream 일괄 처리
        return;
      }

      // 이미지 분석
      let textForSummary = doc.extractedText;
      let enrichedPagesRef: string[] | null = null;
      // QA6-D: 파싱 당시 이미지 분석 OFF 로 추출이 스킵된 문서(imagesSkipped)는 지금 ON 이어도
      // 분석할 이미지가 메모리에 없어 무음 no-op 이었다 — 재오픈 안내로 표면화(텍스트-only PDF
      // 의 정당한 images=0 과 마커로 구분).
      if (currentSettings.enableImageAnalysis && doc.images.length === 0 && doc.imagesSkipped) {
        useAppStore.getState().setNotice({ message: t('summary.imagesSkippedNotice') });
      }
      if (doc.images.length > 0 && currentSettings.enableImageAnalysis) {
        setProgressInfo({
          percent: 0, phase: 'image', current: 0, total: doc.images.length, elapsedMs: 0,
        });
        // R30 P2 (v0.18.18): in-flight Vision 호출 추적 — Stop / 문서 전환 / 타임아웃 시
        // 즉시 ai.abort 로 끊어 cloud 토큰 비용 추가 청구를 막는다.
        // R31 P2 (v0.18.19): stopWatch interval 을 try 안으로 이동 + finally 단일 출구화.
        // 이전엔 catch/정상 경로에서 중복 `clearInterval` 호출 + 향후 동기 throw 가 setInterval
        // 호출 직후에 끼면 interval leak 위험이 있었다. try/finally 패턴으로 통일.
        const visionInFlight = new Set<string>();
        const abortAllVisionInFlight = (): void => {
          if (visionInFlight.size === 0) return;
          for (const id of visionInFlight) {
            try { window.electronAPI.ai.abort(id); } catch { /* ignore */ }
          }
          visionInFlight.clear();
        };
        let stopWatch: ReturnType<typeof setInterval> | null = null;
        let imageAnalysisFailed = false;
        try {
          // isGenerating 이 false 가 되는 순간을 폴링으로 감지해 즉시 abort.
          // store.subscribe 도 가능하나 isGenerating 외 다른 필드 변경에도 발화하므로
          // 가벼운 셀프 폴링이 동등 효과 + 의존성 최소.
          stopWatch = setInterval(() => {
            if (isRunAborted()) {
              abortAllVisionInFlight();
              if (stopWatch !== null) { clearInterval(stopWatch); stopWatch = null; }
            }
          }, 250);
          const imageDescriptions = await analyzeDocumentImages(
            doc, client, setProgress, setProgressInfo, startTime,
            isRunAborted,
            currentSettings.provider,
            (id) => visionInFlight.add(id),
            (id) => visionInFlight.delete(id),
          );
          const enriched = enrichDocumentWithImages(doc, imageDescriptions);
          textForSummary = enriched.textForSummary;
          enrichedPagesRef = enriched.enrichedPages;
          // Q&A RAG 가 이미지 분석 결과를 함께 인덱싱하도록 store 에 공유.
          // useRagBuilder 는 이 값이 세팅되면 key 에 enrichment 플래그가 바뀌어 재빌드.
          // C5-M1: enriched 공유도 소유권 게이트 — stale run 의 부분 결과가 RAG 재빌드를
          // 유발해 새 run 과 인덱스 churn 을 일으키는 것을 방지.
          if (enrichedPagesRef && !isPartialRange && stillOwns()) {
            // 범위 요약일 때는 마스킹된(부분) enriched 를 RAG 에 공유하지 않는다 — Q&A 는 전체
            // 문서 컨텍스트(useRagBuilder 의 raw pageTexts)를 유지해야 직관적이기 때문.
            useAppStore.getState().setEnrichedPageTexts(enrichedPagesRef);
          } else if (!isPartialRange && stillOwns() && useAppStore.getState().enrichedPageTexts !== null) {
            // v0.18.19 patch R32 P2: 이미지 분석은 켜져 돌았으나 모든 이미지가 실패하여 결과가
            // null 인 경우, 이전 run 에서 세팅된 enrichedPageTexts 가 그대로 남아 RAG 가 stale
            // enriched 데이터로 검색을 수행하던 결함. raw pageTexts 재빌드를 강제하기 위해 명시적
            // null 세팅. (R32 Surface 1 P3)
            useAppStore.getState().setEnrichedPageTexts(null);
          }
        } catch (imgErr) {
          // QA post-v0.31.15: 두 결함 통합 수정.
          // (1) abort/타임아웃/문서전환 중 이미지 분석이 throw 하면(analyzeImage 가 ABORTED 를
          //     null 로 뭉갬) 이전엔 무조건 GENERATE_FAIL 배너를 띄워, 사용자 Stop 에 스퍼리어스
          //     배너가 뜨거나 타임아웃 콜백이 세팅한 GENERATE_TIMEOUT 을 덮어썼다. → 이 경우
          //     에러를 표시하지 않고 요약만 중단(imageAnalysisFailed=true → 아래 return).
          // (2) 진짜 Vision 실패(예: vision 모델 미설치 — enableImageAnalysis 는 default ON 이라
          //     Ollama 사용자에게 흔함)면 이전엔 전체 요약이 통째로 중단됐다. → 텍스트 전용으로
          //     강등(비차단 notice) 후 계속 진행. textForSummary 는 이미 doc.extractedText(raw),
          //     enrichedPagesRef 는 null 이라 텍스트 요약이 정상 진행된다.
          const aborted = isRunAborted();
          const cur = useAppStore.getState().document;
          const ours = !!cur && cur.id === doc.id;
          if (aborted || !ours) {
            imageAnalysisFailed = true;
          } else {
            useAppStore.getState().setNotice({ message: t('ai.imageAnalysisSkipped') });
            // 이전 run 의 enriched 잔존 방지 — raw pageTexts 재빌드 강제(성공 경로 R32 P2 와 동형).
            if (!isPartialRange && useAppStore.getState().enrichedPageTexts !== null) {
              useAppStore.getState().setEnrichedPageTexts(null);
            }
          }
        } finally {
          if (stopWatch !== null) { clearInterval(stopWatch); stopWatch = null; }
          abortAllVisionInFlight();
        }
        if (imageAnalysisFailed) {
          // abort/타임아웃/문서전환만 여기 도달 — outer finally 에서 flushStream/setIsGenerating/
          // timeout 정리 일괄 처리. (진짜 Vision 실패는 위에서 텍스트 강등 후 계속 진행)
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

      if (isRunAborted()) return;

      const docWithImages = { ...doc, extractedText: textForSummary };
      if (enrichedPagesRef) {
        // pageTexts 를 enriched 로 교체하는 것으로 충분.
        // summarizeByChapter (use-summarize.ts:162-178) 가 doc.pageTexts 에서 챕터별로
        // 재slicing + labelParagraphsWithPages 로 [p.N] 라벨을 재생성하므로, 여기서 별도로
        // docWithImages.chapters[*].text 를 갱신해도 그 값은 아래에서 덮어써지는 dead write.
        // (과거 v0.17.9 의 chapters rewrite 블록은 multi-line prefix 보존 휴리스틱의 잠재 버그도
        //  갖고 있었음 — 단순화해 진실의 원천을 pageTexts 한 곳으로 통일.)
        docWithImages.pageTexts = enrichedPagesRef;
      }

      // C5-M1: isCancelled 도 소유권 포함(isRunAborted) — 이전 ambient 술어는 새 run 시작 시
      // stale run 을 되살렸다.
      const isCancelled = isRunAborted;
      // R31 (v0.18.18 patch): timeoutTimerRef 콜백이 이미 발화해 timedOut=true 가 됐고
      // handleAbort 가 이전 requestId 를 abort 한 상태에서, 이 시점에 도달하면 새 requestId 가
      // 발급되어 abort 가 무력화되는 race 가 가능했다. 이미지 분석 완료 직후 / cancellation
      // 미감지 사이의 짧은 window. 명시적 가드로 즉시 종료.
      if (isRunAborted()) {
        return;
      }
      // 이미지 분석이 진행된 경우 진행률 20%부터 이어서 시작 (역행 방지)
      const progressOffset = (doc.images.length > 0 && currentSettings.enableImageAnalysis) ? 20 : 0;
      if (isCustomSummaryType(currentSummaryType)) {
        // 커스텀 템플릿: settings 에서 id 로 해석 후 단일 패스 생성. 템플릿이 삭제된 경우 안내 후 종료.
        const template = currentSettings.customSummaryTemplates.find((tpl) => `custom:${tpl.id}` === currentSummaryType);
        if (!template) {
          useAppStore.getState().setNotice({ message: t('summary.templateNotFound') });
          return;
        }
        await summarizeCustom(docWithImages, template, trackCustom, checkTimeout, isCancelled, guardedAppend, setProgress, setProgressInfo, startTime, progressOffset);
      } else if (currentSummaryType === 'chapter' && docWithImages.chapters.length > 1) {
        await summarizeByChapter(docWithImages, currentSettings, trackSummarize, checkTimeout, isCancelled, guardedAppend, setProgress, setProgressInfo, startTime, progressOffset);
      } else {
        await summarizeFull(docWithImages, currentSummaryType, currentSettings, trackSummarize, checkTimeout, isCancelled, guardedAppend, setProgress, setProgressInfo, startTime, progressOffset);
      }

      const durationMs = Date.now() - startTime;
      // C5-M1: 후처리(flush→strip→replace)도 소유권 가드 — stale run 이 새 run 의 live 스트림을
      // 조기 strip/치환하던 결함. 비소유 run 은 커밋 없이 종료(표시 정리는 handleAbort/새 run 몫).
      if (!stillOwns()) return;
      flushStream();
      const rawContent = useAppStore.getState().summaryStream;
      // 후처리: (1) 대화형 멘트 제거 → (2) 인용 배치 정규화
      //  - 괄호 감싸기: `([p.5])` → `[p.5]`
      //  - 독립 라인 bullet 인용: `- [p.44]` → 이전 문장 끝에 부착
      //  LLM (특히 로컬 Ollama) 이 프롬프트의 금지 패턴을 완전히 따르지 않을 때의 안전망.
      const strippedContent = stripConversationalText(rawContent);
      const finalContent = normalizeCitationPlacement(strippedContent);
      if (finalContent !== rawContent) {
        useAppStore.getState().replaceSummaryStream(finalContent);
      }
      // ownership 가드: Stop→재요약 race 에서 stale run 이 새 run 의 summary 를 덮어쓰거나,
      // abort 된 부분 콘텐츠를 "완료된" 요약으로 커밋하는 것을 방지(use-qa 의 stillOurs 와 동형).
      if (!timedOut && finalContent && clientRef.current === runClient) {
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
      // v0.18.19 patch R32 P3: docId 비교 추가 — 이전엔 단순 truthy 체크라 사용자가 mid-summarize
      // 에 문서를 전환하면 old run 의 streamInterrupted 같은 non-ABORTED 에러가 새 문서 banner
      // 에 표시되던 ownership leak (R32 Surface 1 P4).
      const currentDoc = useAppStore.getState().document;
      if (rawCode !== 'ABORTED' && !timedOut && currentDoc && currentDoc.id === doc.id) {
        // 유효한 AppErrorCode만 허용, 그 외는 GENERATE_FAIL로 매핑
        const validCodes = new Set(['PDF_NO_TEXT', 'GENERATE_TIMEOUT', 'API_KEY_MISSING', 'API_KEY_INVALID', 'OLLAMA_NOT_RUNNING']);
        const code = (rawCode && validCodes.has(rawCode) ? rawCode : 'GENERATE_FAIL') as AppError['code'];
        const message = err instanceof Error ? err.message : String(err);
        setError({
          code,
          message: message || t('ai.generateFail'),
        });
      }
    } finally {
      // ownership 가드(use-qa C25-M2 finallyStillOurs 와 동형): 이 run 이 여전히 hook 을
      // 소유할 때(clientRef.current === runClient)만 공유 상태(timeoutTimer/stream/progress/
      // isGenerating)를 정리한다. Stop→재요약 race 에서 stale run 의 finally 가 새 run 의
      // timeoutTimer 를 clear 하고 isGenerating 을 false 로 클로버링해 재요약이 빈 결과로
      // 끝나던 결함을 차단. abort 로 clientRef 가 null 화된 run 은 handleAbort 가 이미 정리.
      if (clientRef.current === runClient) {
        try {
          if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; }
          if (useAppStore.getState().document) {
            flushStream();
          }
        } catch { /* finally 블록 에러 무시 */ }
        setProgressInfo(null);
        setIsGenerating(false);
        clientRef.current = null;
      }
    }
  };

  return { handleSummarize, handleAbort };
}

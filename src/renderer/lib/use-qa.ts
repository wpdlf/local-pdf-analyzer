import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { chunkText, chunkTextWithOverlap, chunkTextWithOverlapByPage } from './chunker';
import { formatPageLabel, normalizeCitationPlacement } from './citation';
import { t } from './i18n';
import type { QaMessage } from '../types';

const MAX_QUESTION_LENGTH = 1000;
const MAX_QA_CONTEXT_CHARS = 8000;
const RAG_CHUNK_SIZE = 500;       // RAG 청크 토큰 수 (작은 청크)
const RAG_BATCH_SIZE = 50;        // 임베딩 배치 크기
const RAG_TOP_K = 5;              // 검색 상위 K개 청크
const RAG_MIN_SCORE = 0.3;        // 최소 유사도 점수
const RAG_BATCH_TIMEOUT_MS = 120000; // 배치당 타임아웃 2분

// ─── 답변 검증(Hallucination 감지) 파라미터 ───
// 초안 답변의 각 문장을 RAG 인덱스와 대조해 "근거 없는 주장" 을 자동 감지한다.
// 감지된 경우 refine 프롬프트로 한 번 더 호출해 사용자에게는 정확도가 개선된 최종 답변만 표시.
/** 이 값 미만의 cosine 유사도를 가진 문장은 "약한 근거" 로 분류 */
const VERIFY_WEAK_SCORE = 0.5;
/** 문장별 최대 유사도의 평균이 이 값 미만이면 전체적으로 refine 대상 */
const VERIFY_AVG_SCORE = 0.65;
/** 검증에서 제외할 최소 문장 길이 (너무 짧으면 인용만 있거나 noise) */
const VERIFY_MIN_SENTENCE_CHARS = 15;
/** 답변당 검증할 최대 문장 수 — 매우 긴 답변의 비용/지연 상한 */
const VERIFY_MAX_SENTENCES = 100;

/**
 * 프롬프트 구분자 인젝션 방어: 사용자 입력에서 splitPrompt 구분자(---\n\n)와
 * 프롬프트 구조 마커([질문], [이전 대화] 등)를 이스케이프하여
 * system/user 분리 및 컨텍스트 구조가 오염되지 않도록 보호.
 *
 * 앞뒤 공백 허용(`\s*`)으로 `" ---"` / `"[질문] "` 같은 whitespace padding 우회 차단.
 */
export function sanitizePromptInput(text: string): string {
  return text
    .replace(/^\s*---\s*$/gm, '\\-\\-\\-')
    .replace(/^\s*\[질문\]/gm, '\\[질문\\]')
    .replace(/^\s*\[이전 대화\]/gm, '\\[이전 대화\\]')
    .replace(/^\s*\[요약 내용\]/gm, '\\[요약 내용\\]')
    .replace(/^\s*\[원문 관련 부분\]/gm, '\\[원문 관련 부분\\]');
}

// 한국어 불용어 (키워드 매칭에서 제외)
const STOPWORDS = new Set([
  '은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로',
  '과', '와', '도', '만', '부터', '까지', '보다', '처럼', '같은',
  '그', '저', '이것', '그것', '저것', '것', '수', '등', '및',
  '하다', '되다', '있다', '없다', '않다', '대해', '대한', '통해',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at',
  'to', 'for', 'of', 'with', 'by', 'from', 'as', 'and', 'or', 'not',
  'that', 'this', 'it', 'be', 'has', 'have', 'had', 'do', 'does',
  'what', 'which', 'how', 'why', 'when', 'where', 'who',
]);

/** 질문에서 의미 있는 키워드 추출 */
export function extractKeywords(question: string): string[] {
  return question
    .replace(/[?？!！.,;:'"()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** 질문 키워드 기반 관련 청크 선별 (TF 스코어링) — RAG fallback용 */
export function selectRelevantChunks(
  question: string,
  fullText: string,
  maxChunkSize: number,
): string {
  if (fullText.length <= MAX_QA_CONTEXT_CHARS) {
    return fullText;
  }

  const chunks = chunkText(fullText, maxChunkSize);
  if (chunks.length <= 1) return fullText.slice(0, MAX_QA_CONTEXT_CHARS);

  const keywords = extractKeywords(question);
  if (keywords.length === 0) {
    return [chunks[0], chunks[chunks.length - 1]].join('\n\n').slice(0, MAX_QA_CONTEXT_CHARS);
  }

  const scored = chunks.map((chunk, idx) => {
    const lower = chunk.toLowerCase();
    const score = keywords.reduce((sum, kw) =>
      sum + (lower.split(kw).length - 1), 0);
    return { chunk, score, idx };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: { chunk: string; idx: number }[] = [];
  let totalLen = 0;
  for (const item of scored) {
    if (item.score === 0) break;
    if (totalLen + item.chunk.length > MAX_QA_CONTEXT_CHARS) break;
    selected.push(item);
    totalLen += item.chunk.length;
  }

  if (selected.length === 0) {
    return [chunks[0], chunks[chunks.length - 1]].join('\n\n').slice(0, MAX_QA_CONTEXT_CHARS);
  }

  selected.sort((a, b) => a.idx - b.idx);
  return selected.map((s) => s.chunk).join('\n\n');
}

/**
 * 대화 이력을 프롬프트 텍스트로 변환 (사용자 입력은 구분자 이스케이프 적용).
 *
 * v0.18.6 D4 fix: 취소 placeholder(`meta='cancelled'`) 메시지는 LLM 컨텍스트에서 제외.
 * 이전에는 `(답변이 취소되었습니다)` 같은 i18n 안내문이 그대로 history 라인에 들어가
 * 다음 턴 답변에 "이전에 취소된 답변" 이라는 가상 컨텍스트가 주입돼 모델 응답이 흐려졌다.
 *
 * v0.18.7 R26-C1 fix: 단순 filter 만으로는 user→cancelled assistant 쌍에서 user 가
 * orphan 으로 남아 LLM history 에 `[Q:Q1, Q:Q2, A:A2]` 처럼 답변 없는 연속 Q 라인이
 * 만들어졌다. addQaMessage(store.ts:285-300) 의 짝수쌍 FIFO 불변과 어긋나는 프롬프트 투영.
 * pair 단위 skip 으로 user + cancelled-assistant 쌍을 통째로 제외해 invariant 유지.
 */
export function formatHistory(messages: QaMessage[]): string {
  if (messages.length === 0) return '';
  const useable: QaMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // user → 다음이 cancelled assistant 면 쌍 통째로 skip (orphan Q 방지)
    if (m.role === 'user' && messages[i + 1]?.meta === 'cancelled') {
      i++; // 다음(cancelled) 도 함께 skip
      continue;
    }
    // 페어 없이 떠있는 cancelled (예: 첫 메시지가 cancelled) — 본 페어 로직에서는 발생 불가하나 방어
    if (m.meta === 'cancelled') continue;
    useable.push(m);
  }
  if (useable.length === 0) return '';
  const lines = useable.map((m) =>
    m.role === 'user' ? `Q: ${sanitizePromptInput(m.content)}` : `A: ${m.content}`,
  );
  return `\n[이전 대화]\n${lines.join('\n')}\n`;
}

// ─── RAG 인덱스 빌드 ───

// 현재 활성 빌드의 AbortController. 새 빌드가 시작되거나 cleanup 시점에 abort() 호출.
// v0.17.12: 배치별 requestId 를 발급해 ai:abort IPC 로 in-flight HTTP 까지 진짜 취소.
// 과거에는 signal.aborted 로 "다음 배치 전 조기 종료"만 가능해 OpenAI 배치 중도 취소가 안 됐음.
let activeBuildController: AbortController | null = null;

function generateBatchRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `rag-${crypto.randomUUID()}`;
    }
  } catch { /* fallthrough */ }
  return `rag-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 배치 임베딩 호출 + 타임아웃 래퍼.
 * signal 이 넘어오면 abort 시 main 에 ai:abort 를 보내 HTTP 소켓을 즉시 해제 —
 * OpenAI 사용자의 불필요한 토큰 과금 방지.
 */
function embedWithTimeout(texts: string[], signal?: AbortSignal): Promise<{
  success: boolean;
  embeddings?: number[][];
  model?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const requestId = generateBatchRequestId();
    let settled = false;
    const safeResolve = (v: { success: boolean; embeddings?: number[][]; model?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    };

    const timer = setTimeout(() => {
      // 타임아웃 시에도 main 의 활성 등록 해제 시도 (idempotent)
      window.electronAPI.ai.abort(requestId).catch(() => {});
      safeResolve({ success: false, error: 'RAG 임베딩 배치 타임아웃' });
    }, RAG_BATCH_TIMEOUT_MS);

    const onAbort = () => {
      // main 에 진행 중 HTTP 소켓 파괴 요청 — generateEmbeddings 가 Aborted 로 reject,
      // ai:embed 핸들러가 success:false/error:'Aborted' 반환.
      window.electronAPI.ai.abort(requestId).catch(() => {});
      safeResolve({ success: false, error: 'Aborted' });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    window.electronAPI.ai.embed(texts, requestId).then((result) => {
      safeResolve(result);
    }).catch(() => {
      safeResolve({ success: false, error: '임베딩 요청 실패' });
    });
  });
}

/**
 * 문서의 벡터 인덱스를 빌드.
 * 임베딩 불가 시 false 반환 (keyword fallback 사용).
 * signal.aborted 를 통해 문서 전환/언마운트 시 이전 빌드를 즉시 취소.
 *
 * page-citation-viewer 기능: pageTexts 가 있으면 page-aware 청커로 전환하여
 * 각 청크에 pageStart/pageEnd 메타데이터를 부착한다. 없으면 기존 동작 그대로.
 */
async function buildRagIndex(
  extractedText: string,
  docId: string,
  signal: AbortSignal,
  pageTexts?: string[],
): Promise<boolean> {
  const store = useAppStore.getState();

  // 임베딩 모델 사용 가능 여부 확인
  const embedCheck = await window.electronAPI.ai.checkEmbedModel();
  if (signal.aborted) return false;
  if (!embedCheck.available) {
    store.setRagState({ isAvailable: false, model: null });
    return false;
  }

  // 오버랩 청킹 — page-aware 가능하면 사용, 아니면 기존 경로
  const usePageAware = Array.isArray(pageTexts) && pageTexts.length > 0;
  const pageChunks = usePageAware
    ? chunkTextWithOverlapByPage(pageTexts!, RAG_CHUNK_SIZE)
    : [];
  const chunks = usePageAware
    ? pageChunks.map((c) => c.text)
    : chunkTextWithOverlap(extractedText, RAG_CHUNK_SIZE);
  const total = chunks.length;

  store.setRagState({
    isIndexing: true,
    isAvailable: true,
    model: embedCheck.model || null,
    progress: { current: 0, total },
    chunkCount: 0,
  });

  const ragIndex = store.ragIndex;
  ragIndex.clear();
  if (embedCheck.model) ragIndex.setModel(embedCheck.model);

  try {
    // 배치 임베딩
    for (let i = 0; i < chunks.length; i += RAG_BATCH_SIZE) {
      // 문서 전환/언마운트 체크 — 이전 빌드 즉시 중단
      // aborted 분기에서는 인덱스/state를 건드리지 않음 (새 build가 소유)
      if (signal.aborted) return false;

      const batch = chunks.slice(i, i + RAG_BATCH_SIZE);
      const result = await embedWithTimeout(batch, signal);

      // 빌드 도중 문서 전환 재확인
      if (signal.aborted) return false;

      if (!result.success || !result.embeddings) {
        ragIndex.clear();
        store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null });
        return false;
      }

      // 임베딩 개수 검증 — API가 부분 결과를 반환한 경우 방어
      if (result.embeddings.length !== batch.length) {
        ragIndex.clear();
        store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null });
        return false;
      }

      for (let j = 0; j < result.embeddings.length; j++) {
        // page-aware 모드면 page 메타데이터 동반 — SearchResult 로 전파되어 LLM 프롬프트 라벨링에 사용
        const meta = usePageAware
          ? { pageStart: pageChunks[i + j]?.pageStart, pageEnd: pageChunks[i + j]?.pageEnd }
          : undefined;
        ragIndex.addChunk(batch[j], result.embeddings[j], i + j, meta);
      }

      store.setRagState({ progress: { current: Math.min(i + RAG_BATCH_SIZE, total), total } });
    }

    // 최종 문서 일치 확인 — stale이면 새 build가 소유하므로 건드리지 않음
    if (signal.aborted || useAppStore.getState().document?.id !== docId) {
      return false;
    }

    store.setRagState({
      isIndexing: false,
      chunkCount: ragIndex.size,
      progress: null,
    });
    return true;
  } catch {
    // 자신이 아직 active한 경우에만 정리 — 새 build의 상태를 덮어쓰지 않음
    if (!signal.aborted) {
      ragIndex.clear();
      store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null });
    }
    return false;
  }
}

/**
 * RAG 시맨틱 검색으로 관련 컨텍스트 추출.
 * 질문을 임베딩하고 벡터 스토어에서 유사 청크 검색.
 *
 * v0.18.4 M1: signal 을 전달받아 pre-draft 임베딩 호출이 abortable 해졌다.
 * 이전에는 raw `window.electronAPI.ai.embed` 를 requestId 없이 호출해
 * 사용자가 Stop 을 눌러도 OpenAI 소켓이 완료까지 돌아 불필요 과금 원인이었다.
 * embedWithTimeout 을 재사용해 v0.17.12 abort 인프라와 일관성 확보.
 */
async function ragSearch(question: string, signal?: AbortSignal): Promise<string | null> {
  const ragIndex = useAppStore.getState().ragIndex;
  if (ragIndex.size === 0) return null;

  try {
    const result = await embedWithTimeout([question], signal);
    if (!result.success || !result.embeddings || result.embeddings.length === 0) {
      return null;
    }

    const queryEmbedding = result.embeddings[0];
    const results = ragIndex.search(queryEmbedding, RAG_TOP_K, RAG_MIN_SCORE);

    if (results.length === 0) return null;

    // 원본 순서로 정렬하여 문맥 흐름 유지
    results.sort((a, b) => a.index - b.index);

    // 키워드 경로와 동일한 컨텍스트 크기 제한 적용
    const parts: string[] = [];
    let totalLen = 0;
    for (const r of results) {
      // page-citation-viewer: page 메타데이터가 있으면 [p.N] 라벨을 앞에 붙여
      // LLM 이 해당 페이지를 인용하도록 유도. 기존 청크도 label 없이 그대로 폴백.
      const label = formatPageLabel(r.pageStart, r.pageEnd);
      const segment = label ? `${label}\n${r.text}` : r.text;
      if (totalLen + segment.length > MAX_QA_CONTEXT_CHARS) break;
      parts.push(segment);
      totalLen += segment.length;
    }
    return parts.join('\n\n');
  } catch {
    return null;
  }
}

// ─── 답변 검증 (v0.18.0) ───

/**
 * 답변 텍스트를 문장 단위로 분할. 한국어/중국어/일본어/영어 종결 구두점 지원.
 * 너무 짧은 문장(인용만 있는 라인, 단일 키워드 등) 은 검증에서 제외 — noise 방지.
 *
 * 주의: 인용 토큰 `[p.N]` 끝의 마침표는 citation 정규식 소속이 아니라 문장 종결이므로
 * 정상적으로 split 된다. 코드블록/테이블 안의 점은 가끔 오탐하지만 검증은 fail-safe
 * (needsRefine=false 로 수렴) 이므로 무해.
 */
export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  // v0.18.5 C-M1 / v0.18.6 C25-M1 fix: CJK 종결부호(`。！？`) 뒤가 공백이거나 즉시 다음 문자 든 모두 분할.
  // 이전 정규식은 `\s+` 필수 → `"입니다。다음으로…"` 같은 공백 없는 케이스 처리 못함 (v0.18.5 fix 영역).
  // v0.18.5 fix 후에도 `(?=\S)` 만 있어 `"문장1。 문장2"` 처럼 CJK 종결부호 + 공백 케이스에선
  // 두 분기 모두 미적중하여 단일 문장 처리되던 잔여 갭이 있었다 (Round 25 C25-M1 발견).
  // 새 분기 `(?<=[。！？])\s*(?=\S)` 는 공백 0+개를 허용해 zero-width 와 whitespace-padded 케이스를 모두 커버.
  // Latin 분기는 여전히 `\s+` 필수 (소수점 "3.14" / 약어 "Mr." 오탐 방지).
  const sentences = normalized.split(/(?<=[.!?])\s+(?=\S)|(?<=[。！？])\s*(?=\S)/);
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length >= VERIFY_MIN_SENTENCE_CHARS);
}

/**
 * 답변 초안의 각 문장을 RAG 인덱스에 대조해 신뢰도 평가.
 * - 문장 배열을 한 번에 배치 임베딩 → IPC 왕복 최소화.
 * - 각 문장에 대해 VectorStore.search 로 top-1 cosine 을 구함.
 * - weak 문장 1개+ 또는 평균 < AVG_SCORE 이면 refine 대상.
 *
 * Fail-safe: 임베딩 실패/RAG 비활성/인덱스 빈 경우 needsRefine=false 반환 → 초안 그대로 사용.
 */
export async function verifyAnswerSentences(
  answer: string,
  signal?: AbortSignal,
): Promise<{ needsRefine: boolean; avgScore: number; weakCount: number; totalSentences: number }> {
  const ragIndex = useAppStore.getState().ragIndex;
  if (ragIndex.size === 0) {
    return { needsRefine: false, avgScore: 1, weakCount: 0, totalSentences: 0 };
  }

  const sentences = splitIntoSentences(answer).slice(0, VERIFY_MAX_SENTENCES);
  if (sentences.length === 0) {
    return { needsRefine: false, avgScore: 1, weakCount: 0, totalSentences: 0 };
  }

  // 문장 전체를 단일 배치로 임베딩 (ai:embed IPC 가 200개까지 허용).
  // VERIFY_MAX_SENTENCES=100 이므로 항상 한 배치로 처리된다.
  const result = await embedWithTimeout(sentences, signal);
  if (!result.success || !result.embeddings || result.embeddings.length !== sentences.length) {
    // 검증 자체 실패 → 안전하게 draft 그대로 사용 (refine 강제하지 않음)
    return { needsRefine: false, avgScore: 1, weakCount: 0, totalSentences: sentences.length };
  }

  let totalScore = 0;
  let weakCount = 0;
  for (let i = 0; i < result.embeddings.length; i++) {
    if (signal?.aborted) break;
    // minScore=0 으로 호출 — top-1 의 실제 유사도가 해당 문장의 최대 근거 점수.
    const hits = ragIndex.search(result.embeddings[i], 1, 0);
    const maxScore = hits.length > 0 ? hits[0].score : 0;
    totalScore += maxScore;
    if (maxScore < VERIFY_WEAK_SCORE) weakCount++;
  }

  const avgScore = totalScore / sentences.length;
  // v0.18.3: 단일 약문장(boilerplate/연결어) 한 개로 refine 이 강제 트리거되어
  // 대부분의 답변이 두 번째 LLM 호출 비용을 치르던 문제를 완화.
  // 약문장 2개 이상 또는 전체 비율이 20% 초과이거나, 평균 점수가 임계 미만이면 refine.
  const weakRatio = weakCount / sentences.length;
  const needsRefine = weakCount >= 2 || weakRatio > 0.2 || avgScore < VERIFY_AVG_SCORE;
  return { needsRefine, avgScore, weakCount, totalSentences: sentences.length };
}

/**
 * Refine 스트림 수집기 (v0.18.4 H1 fix 대상).
 *
 * refine LLM 의 토큰 스트림을 돌면서 onToken 사이드이펙트(qaStream append) 를 수행하고
 * 전체 답변을 누적한다. 스트림이 0 토큰 반환하면(Ollama silent timeout, 공백만, done:true only 등)
 * `draft` 를 fallback 으로 사용해 draft 유실을 방지한다.
 *
 * 순수 함수로 분리한 이유: 원래 `handleAsk` 훅 클로저 안에 인라인돼 있어 단위 테스트가 불가능했다.
 * 동일 로직 그대로 유지하되 외부에서 주입 가능한 계약으로 노출 → fallback 불변식 회귀 테스트 가능.
 */
export async function collectRefineAnswer(
  stream: AsyncIterable<string>,
  draft: string,
  isActive: () => boolean,
  onToken: (token: string) => void,
): Promise<string> {
  let answer = '';
  for await (const token of stream) {
    if (!isActive()) break;
    onToken(token);
    answer += token;
  }
  // refine 이 빈 응답 → draft 그대로 사용. 사용자 abort 도 여기로 오지만 stillOurs 체크에서 걸러짐.
  return answer.trim() ? answer : draft;
}

/**
 * Refine 프롬프트. 초안 + 원문 컨텍스트를 주고 "근거 있는 내용만" 을 남기도록 유도.
 * 스타일/구조는 유지, 환각 주장만 제거 — 사용자에게는 "한 번의 답변" 으로 보여야 함.
 *
 * 주의: LLM 이 refine 지시를 무시하면 초안과 거의 같은 답변이 나올 수 있음.
 * 그 경우에도 사용자 경험상 정상(동일 답변) 이므로 무해.
 */
export function buildRefinePrompt(question: string, draft: string, context: string): string {
  return `${context}

[질문]
${question}

[초안 답변]
${draft}

위 초안 답변 중 원문(컨텍스트) 에서 근거를 찾을 수 있는 내용만 남기고 다시 작성하세요.
규칙:
- 원문에 명시되지 않은 주장은 제거하거나 "문서에서 확인되지 않음" 으로 표시
- 문체와 구조(문단/목록 형식) 는 초안을 그대로 유지
- [p.N] 인용은 근거 페이지를 찾으면 그대로, 찾을 수 없으면 제거
- 새 정보를 추가하지 말고 초안의 정확성만 개선`;
}

// ─── Hooks ───

/**
 * 문서 로드 시 / provider 변경 시 RAG 인덱스 자동 빌드.
 * App.tsx 최상위에서 호출하여 **요약과 병렬로** RAG 빌드를 시작 →
 * 사용자 대기 시간 단축 (이전에는 QaChat 마운트 후에야 빌드 시작).
 *
 * provider가 바뀌면 임베딩 모델 차원이 달라질 수 있으므로 재빌드 필요.
 * (예: Ollama nomic-embed-text 768차원 → OpenAI text-embedding-3-small 1536차원)
 *
 * 언마운트/deps 변경 시 cleanup이 activeBuildId를 무효화하여
 * 진행 중이던 빌드가 다음 stale check에서 조기 종료됨 (OpenAI 비용 절감).
 */
export function useRagBuilder(): void {
  const document = useAppStore((s) => s.document);
  const provider = useAppStore((s) => s.settings.provider);
  // Vision 이미지 분석으로 enrich 된 page-level 텍스트. 존재하면 이것을 우선 사용해
  // RAG 인덱스에 이미지 설명이 함께 들어가도록 한다 — "요약에는 이미지 설명이 있지만
  // Q&A 검색은 못 보는" UX 비대칭 해소.
  const enrichedPageTexts = useAppStore((s) => s.enrichedPageTexts);
  const prevKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!document) {
      // 문서 unload 시 prevKey 초기화 — 같은 문서 재로드 시 올바르게 rebuild 트리거
      prevKeyRef.current = null;
      return;
    }
    // key 에 enrichment 플래그 포함 — raw→enriched 전이 시 자동 재빌드.
    // enrichedPageTexts 는 setEnrichedPageTexts 가 새 배열로 교체할 때마다 identity 가 바뀌므로
    // 길이를 fingerprint 로 사용해 한 문서 내 여러 번의 enrichment 도 감지 (실무상 1회지만 방어).
    const enrichTag = enrichedPageTexts ? `e${enrichedPageTexts.length}` : 'r';
    const key = `${document.id}:${provider}:${enrichTag}`;
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    const docId = document.id;

    // 이전 빌드가 아직 활성 상태라면 즉시 abort (새 빌드로 교체)
    activeBuildController?.abort();
    const controller = new AbortController();
    activeBuildController = controller;

    // 이전 인덱스 즉시 초기화 (다른 문서/모델의 인덱스가 남아있지 않도록)
    const store = useAppStore.getState();
    store.ragIndex.clear();
    store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null, model: null });

    // 이미지 분석 결과가 있으면 enriched 페이지 텍스트로 인덱싱, 없으면 원본 사용.
    // extractedText 도 동일하게 enriched 버전으로 교체 — selectRelevantChunks fallback 경로도
    // 이미지 설명을 볼 수 있도록 일관성 유지.
    const pageTextsForRag = enrichedPageTexts ?? document.pageTexts;
    const textForRag = enrichedPageTexts ? enrichedPageTexts.join('\n\n') : document.extractedText;

    // 비동기로 인덱스 빌드 (UI 블로킹 없음, 요약과 병렬 실행).
    // 내부 try/catch가 있지만 예기치 않은 동기 throw(예: store 접근 중 null)가
    // unhandled rejection으로 전파되는 것을 최종 방어.
    // page-citation-viewer: pageTexts 를 전달하여 각 청크에 page 메타데이터 부착.
    buildRagIndex(textForRag, docId, controller.signal, pageTextsForRag).catch((err) => {
      console.error('[useRagBuilder] buildRagIndex failed:', err);
    });

    // Cleanup: deps 변경/언마운트 시 진행 중인 빌드 무효화.
    // 이미 전송된 IPC 임베딩 배치는 취소 불가이지만, 다음 signal.aborted 체크에서 return함.
    return () => {
      controller.abort();
      // 자기 자신이 여전히 active일 때만 null 할당 (새 빌드 덮어쓰기 방지)
      if (activeBuildController === controller) {
        activeBuildController = null;
      }
    };
  }, [document, provider, enrichedPageTexts]);
}

export function useQa() {
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const qaMessages = useAppStore((s) => s.qaMessages);
  const qaStream = useAppStore((s) => s.qaStream);
  const ragState = useAppStore((s) => s.ragState);
  const clientRef = useRef<AiClient | null>(null);
  const abortedRef = useRef(false);
  // verify 단계 embedding 중단용 — qaRequestId 는 draft/refine LLM 호출만 커버하므로
  // verifyAnswerSentences 내부의 배치 임베딩(rag-*)은 별도 signal 로 abort 해야 한다.
  const verifyAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      const reqId = useAppStore.getState().qaRequestId;
      if (reqId) window.electronAPI.ai.abort(reqId);
      verifyAbortRef.current?.abort();
    };
  }, []);

  const handleQaAbort = useCallback(() => {
    // v0.18.5 Round 23 #1: 중복 호출 방어 — 이미 비생성 상태면 no-op.
    // (UI 버튼이 isQaGenerating 조건부 렌더라 현재는 중복 호출이 어렵지만
    // 프로그램 경로로 호출될 가능성 대비 + 빈 placeholder 중복 주입 방지.)
    if (!useAppStore.getState().isQaGenerating) return;
    abortedRef.current = true;
    const reqId = useAppStore.getState().qaRequestId;
    if (reqId) window.electronAPI.ai.abort(reqId);
    verifyAbortRef.current?.abort();
    clientRef.current = null;
    const store = useAppStore.getState();
    // 검증 단계에서 abort 하면 draft 는 내부 변수라 qaStream 은 비어있음 — partial 없음.
    // refine 단계에서 abort 하면 qaStream 에 부분 답변이 있어 저장 대상.
    store.flushQaStream();
    const partial = useAppStore.getState().qaStream;
    if (partial) {
      store.addQaMessage({ role: 'assistant', content: partial });
    } else {
      // v0.18.5 Round 23 #1: verify/draft 단계 abort 는 qaStream 이 비어있어
      // assistant 가 추가되지 않고 user 만 홀로 남았다. 이후 다음 handleAsk 가
      // 또 user 를 append 하면 [..., u_orphan, u_new] 연속 user 상태가 되고,
      // M3 짝수 FIFO drop 이 그 쌍을 함께 제거해 윈도우 선두가 assistant 로
      // 시작하는 orphan 을 만들 수 있었다. placeholder assistant 를 명시 주입해
      // "user→assistant 짝" 불변식을 전 경로에서 유지.
      // v0.18.6 D4: meta='cancelled' 표식으로 formatHistory 에서 LLM 컨텍스트 제외.
      store.addQaMessage({ role: 'assistant', content: t('qa.answerCancelled'), meta: 'cancelled' });
    }
    store.clearQaStream();
    store.setIsQaGenerating(false);
    store.setQaRequestId(null);
    // 검증 인디케이터도 항상 해제 — draft 도중 abort 시 스피너가 남는 것 방지
    store.setQaVerifying(false);
  }, []);

  const handleAsk = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) return;

    const state = useAppStore.getState();
    if (state.isGenerating || state.isQaGenerating || !state.document) return;
    // RAG 인덱싱 중에는 질문 차단 — 부분 인덱스로 답변해 정확도가 떨어지는 문제 방지
    // (RAG가 unavailable인 경우에는 isIndexing=false이므로 keyword fallback은 허용됨)
    if (state.ragState.isIndexing) return;

    const settings = state.settings;
    const doc = state.document;

    abortedRef.current = false;
    // 이전 호출의 verify signal 정리 후 새 컨트롤러 준비 — handleAsk 진입마다 fresh 신호.
    verifyAbortRef.current?.abort();
    verifyAbortRef.current = new AbortController();
    state.addQaMessage({ role: 'user', content: trimmed });
    state.setIsQaGenerating(true);
    state.clearQaStream();

    let completed = false;
    // catch 블록에서 소유권 체크 시 참조하기 위해 try 바깥에 선언.
    // try 스코프 내 const 로 두면 catch 가 접근 불가하여 ReferenceError (TS2552) 발생.
    let requestId: string | null = null;
    try {
      const client = new AiClient(settings);
      clientRef.current = client;

      // 요약 결과를 우선 컨텍스트로 포함
      const summaryText = useAppStore.getState().summaryStream || '';

      // RAG 시맨틱 검색 시도 → 실패 시 키워드 기반 fallback.
      // v0.18.4 M1: verifyAbortRef.signal 을 넘겨 draft 이전 embedding 도 Stop 즉시 취소.
      let relevantChunks: string;
      const ragResult = await ragSearch(trimmed, verifyAbortRef.current?.signal);
      if (ragResult) {
        relevantChunks = ragResult;
      } else {
        relevantChunks = selectRelevantChunks(trimmed, doc.extractedText, settings.maxChunkSize);
      }
      // PDF 원문 컨텍스트에 프롬프트 인젝션 방어 적용 (RAG/키워드 양쪽 모두)
      relevantChunks = sanitizePromptInput(relevantChunks);

      const contextParts = [];
      if (summaryText) contextParts.push(`[요약 내용]\n${summaryText.slice(0, 3000)}`);
      contextParts.push(`[원문 관련 부분]\n${relevantChunks}`);
      const context = contextParts.join('\n\n');

      const freshMessages = useAppStore.getState().qaMessages;
      const history = formatHistory(freshMessages.slice(0, -1)).slice(0, 4000);

      const promptText = `${context}${history}\n[질문]\n${sanitizePromptInput(trimmed)}`;

      requestId = client.prepareSummarize();
      useAppStore.getState().setQaRequestId(requestId);

      // 2-pass 검증 파이프라인 사용 여부 결정:
      //  - 설정이 OFF 거나
      //  - RAG 가 unavailable 하거나 인덱스가 비어있으면
      //  → 기존 단일 pass 스트리밍 fast path.
      const useVerification = settings.enableAnswerVerification !== false
        && useAppStore.getState().ragState.isAvailable
        && useAppStore.getState().ragIndex.size > 0;

      let answer = '';
      if (!useVerification) {
        // fast path: 이전 동작 그대로 — 토큰이 도착하는 대로 qaStream 에 append.
        for await (const token of client.summarize(promptText, 'qa', requestId)) {
          if (!useAppStore.getState().isQaGenerating) break;
          useAppStore.getState().appendQaStream(token);
          answer += token;
        }
      } else {
        // ─── 2-pass: Draft → Verify → (Refine or Flush) ───
        // Step 1. Draft 를 내부 변수에만 수집 (qaStream 은 건드리지 않음). UI 는 qaVerifying=true
        //         로 "답변 준비 중..." 스피너 표시. 사용자에게는 검증된 최종 답변만 보임.
        useAppStore.getState().setQaVerifying(true);

        let draft = '';
        for await (const token of client.summarize(promptText, 'qa', requestId)) {
          if (!useAppStore.getState().isQaGenerating) break;
          draft += token;
        }

        // 사용자 abort 또는 empty draft → 그대로 종료.
        // v0.18.7 R26-C2 fix: 명시적 setQaVerifying(false) 제거 — finally 의 ownership gate 가
        // 처리. stale 핸들러가 ungated 호출로 새 세션 스피너를 끄던 race 방지.
        if (!useAppStore.getState().isQaGenerating || !draft.trim()) {
          answer = draft;
        } else {
          // Step 2. 문장 단위 RAG 대조 (내부 임베딩 호출).
          // signal 을 전달해 사용자가 "멈춤" 을 누르면 OpenAI embedding 소켓을 즉시 파괴
          // (v0.17.12 embed abort 인프라와 연결) — 불필요 토큰 과금 방지.
          const verification = await verifyAnswerSentences(draft, verifyAbortRef.current?.signal);

          // abort 재확인 — 검증 중 사용자가 취소했을 수 있음. finally 가 qaVerifying 해제.
          if (!useAppStore.getState().isQaGenerating) {
            answer = draft;
          } else if (verification.needsRefine) {
            // Step 3b. Refine — 새 requestId 로 두번째 호출. 스트리밍으로 qaStream 에 바로 표시.
            //         qaVerifying=false 로 전환하여 UI 가 스피너 → 스트리밍 답변으로 자연스럽게 이동.
            // v0.18.7 R26-C2 fix: ownership 체크 — stale 핸들러가 새 세션의 검증 스피너를
            // mid-stream 에 끄는 것 방지. 이 setter 만 finally 외부에서 즉시 실행 필요한 (UX 전환).
            const verifyState = useAppStore.getState();
            const verifyOurs = verifyState.document?.id === doc.id && verifyState.qaRequestId === requestId;
            if (verifyOurs) verifyState.setQaVerifying(false);
            const refineRequestId = client.prepareSummarize();
            useAppStore.getState().setQaRequestId(refineRequestId);
            requestId = refineRequestId; // 소유권 체크를 위해 갱신
            // v0.18.3 H1 fix: draft 경로(line 581)는 question 을 sanitizePromptInput 으로 이스케이프하지만
            // refine 경로는 raw trimmed 를 썼기 때문에, `---` / `[질문]` / `[이전 대화]` 마커가 포함된
            // 질문이 프롬프트 구조를 오염시킬 수 있었다 (v0.18.0 회귀). 두 경로 모두 동일하게 정화.
            const sanitizedQuestion = sanitizePromptInput(trimmed);
            const refinePrompt = buildRefinePrompt(sanitizedQuestion, draft, `${context}${history}`);
            // v0.18.4 H1 fix: 이전에는 for-await 가 인라인되어 있었고 refine 이 0 토큰을 반환하면
            // answer='' → 바깥 `if (answer)` 가드에 걸려 draft 가 통째로 유실됐다.
            // collectRefineAnswer 헬퍼가 빈 응답 시 draft 로 fallback 시켜 불변식 보장.
            answer = await collectRefineAnswer(
              client.summarize(refinePrompt, 'qa', refineRequestId),
              draft,
              () => useAppStore.getState().isQaGenerating,
              (token) => useAppStore.getState().appendQaStream(token),
            );
          } else {
            // Step 3a. 초안이 충분히 근거 있음 → draft 를 answer 로 사용.
            //          v0.18.3 M2: 기존의 appendQaStream(draft) 는 직후에 동기적으로 실행되는
            //          clearQaStream() (line ~665) 로 인해 React 가 렌더하지 못하는 dead code.
            //          최종 답변은 공통 경로의 addQaMessage(normalized) 로만 표시된다.
            // v0.18.7 R26-C2 fix: 명시적 setQaVerifying(false) 제거 — finally 의 ownership gate 처리.
            answer = draft;
          }
        }
      }

      // 소유권 체크: SummaryViewer.handleClose → resetSummaryState 가 외부에서
      // 상태를 초기화한 경우, abortedRef 는 set 되지 않지만 문서·requestId 가
      // 교체되어 이 핸들러의 결과물이 stale. 고아 assistant 메시지를 비워진
      // qaMessages 에 주입하면 새 PDF 열 때 이전 Q&A 가 섞여 보인다.
      const postState = useAppStore.getState();
      const stillOurs = !abortedRef.current
        && postState.document?.id === doc.id
        && postState.qaRequestId === requestId;

      if (stillOurs) {
        postState.flushQaStream();
        postState.clearQaStream();
        if (answer) {
          // 인용 배치 정규화 — 괄호/독립 라인 후처리 (use-summarize 와 동일)
          const normalized = normalizeCitationPlacement(answer);
          postState.addQaMessage({ role: 'assistant', content: normalized });
        }
        completed = true;
      }
    } catch (err) {
      const code = (err instanceof Error && 'code' in err ? (err as Error & { code?: string }).code : undefined);
      // 소유권 체크(try 블록 완료 경로와 동일): 에러 발생 시 이미 문서·requestId 가
      // 교체되어 이 핸들러가 stale 이면 새 세션에 에러 배너를 주입하지 않음.
      // requestId 가 아직 할당되지 않은 상태(prepareSummarize 이전 throw)에서는
      // doc 소유권만 체크 — 에러는 보고되어야 함.
      const errState = useAppStore.getState();
      const docStillOurs = errState.document?.id === doc.id;
      const requestStillOurs = requestId === null || errState.qaRequestId === requestId;
      const stillOurs = docStillOurs && requestStillOurs;
      // 사용자 의도적 abort는 에러로 표시하지 않음
      if (code !== 'ABORTED' && !abortedRef.current && stillOurs) {
        const message = err instanceof Error ? err.message : String(err);
        errState.setError({
          code: 'GENERATE_FAIL',
          message: message || 'Q&A 답변 생성에 실패했습니다.',
        });
      }
    } finally {
      clientRef.current = null;
      // v0.18.6 C25-M2 fix: stillOurs 체크를 finally 에도 적용.
      // 이전: 무조건 setIsQaGenerating(false)/setQaRequestId(null)/setQaVerifying(false) 실행.
      // 시나리오: Stop+resume 레이스에서 stale 핸들러의 for-await 루프가 다음 토큰까지
      // 도달했을 때 새 handleAsk 가 isQaGenerating=true 로 세팅한 직후 stale 핸들러의
      // finally 가 false 로 클로버링하여 새 세션의 UI 가 mid-stream 에 꺼짐.
      // 새 동작: 현재 store 의 qaRequestId 와 document 가 우리 것일 때만 글로벌 UI 상태를 리셋.
      // stale 한 핸들러는 자기 로컬 cleanup(clientRef, qaStream flush) 만 수행한다.
      const finalState = useAppStore.getState();
      const finallyStillOurs = finalState.document?.id === doc.id
        && (requestId === null || finalState.qaRequestId === requestId);
      if (!completed && !abortedRef.current && finallyStillOurs) {
        useAppStore.getState().flushQaStream();
        useAppStore.getState().clearQaStream();
      }
      if (finallyStillOurs) {
        useAppStore.getState().setIsQaGenerating(false);
        useAppStore.getState().setQaRequestId(null);
        // 검증 인디케이터는 ownership 일 때만 해제 — stale 핸들러가 새 세션의 검증 스피너를 끄는 것 방지.
        useAppStore.getState().setQaVerifying(false);
      }
    }
  }, []);

  const qaVerifying = useAppStore((s) => s.qaVerifying);
  return { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating, qaVerifying, ragState };
}

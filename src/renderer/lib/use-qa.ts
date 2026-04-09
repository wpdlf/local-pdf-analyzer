import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { chunkText, chunkTextWithOverlap } from './chunker';
import type { QaMessage } from '../types';

const MAX_QUESTION_LENGTH = 1000;
const MAX_QA_CONTEXT_CHARS = 8000;
const RAG_CHUNK_SIZE = 500;       // RAG 청크 토큰 수 (작은 청크)
const RAG_BATCH_SIZE = 50;        // 임베딩 배치 크기
const RAG_TOP_K = 5;              // 검색 상위 K개 청크
const RAG_MIN_SCORE = 0.3;        // 최소 유사도 점수
const RAG_BATCH_TIMEOUT_MS = 120000; // 배치당 타임아웃 2분

/**
 * 프롬프트 구분자 인젝션 방어: 사용자 입력에서 splitPrompt 구분자(---\n\n)와
 * 프롬프트 구조 마커([질문], [이전 대화] 등)를 이스케이프하여
 * system/user 분리 및 컨텍스트 구조가 오염되지 않도록 보호
 */
function sanitizePromptInput(text: string): string {
  return text
    .replace(/^---$/gm, '\\-\\-\\-')
    .replace(/^\[질문\]/gm, '\\[질문\\]')
    .replace(/^\[이전 대화\]/gm, '\\[이전 대화\\]')
    .replace(/^\[요약 내용\]/gm, '\\[요약 내용\\]')
    .replace(/^\[원문 관련 부분\]/gm, '\\[원문 관련 부분\\]');
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
function extractKeywords(question: string): string[] {
  return question
    .replace(/[?？!！.,;:'"()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** 질문 키워드 기반 관련 청크 선별 (TF 스코어링) — RAG fallback용 */
function selectRelevantChunks(
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

/** 대화 이력을 프롬프트 텍스트로 변환 (사용자 입력은 구분자 이스케이프 적용) */
function formatHistory(messages: QaMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) =>
    m.role === 'user' ? `Q: ${sanitizePromptInput(m.content)}` : `A: ${m.content}`,
  );
  return `\n[이전 대화]\n${lines.join('\n')}\n`;
}

// ─── RAG 인덱스 빌드 ───

// 동시 빌드 방지용 — 새 빌드 시작 시 이전 빌드를 무효화
let activeBuildId: string | null = null;

/** 배치 임베딩 호출 + 타임아웃 래퍼 */
function embedWithTimeout(texts: string[]): Promise<{
  success: boolean;
  embeddings?: number[][];
  model?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: 'RAG 임베딩 배치 타임아웃' });
    }, RAG_BATCH_TIMEOUT_MS);

    window.electronAPI.ai.embed(texts).then((result) => {
      clearTimeout(timer);
      resolve(result);
    }).catch(() => {
      clearTimeout(timer);
      resolve({ success: false, error: '임베딩 요청 실패' });
    });
  });
}

/**
 * 문서의 벡터 인덱스를 빌드.
 * 임베딩 불가 시 false 반환 (keyword fallback 사용).
 * docId를 통해 문서 전환 시 이전 빌드를 즉시 취소.
 */
async function buildRagIndex(extractedText: string, docId: string): Promise<boolean> {
  const buildId = crypto.randomUUID();
  activeBuildId = buildId;

  const store = useAppStore.getState();

  // 임베딩 모델 사용 가능 여부 확인
  const embedCheck = await window.electronAPI.ai.checkEmbedModel();
  if (!embedCheck.available) {
    store.setRagState({ isAvailable: false, model: null });
    return false;
  }
  // 빌드 도중 문서 전환 체크
  if (activeBuildId !== buildId) return false;

  // 오버랩 청킹
  const chunks = chunkTextWithOverlap(extractedText, RAG_CHUNK_SIZE);
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
      // 문서 전환 체크 — 이전 빌드 즉시 중단
      if (activeBuildId !== buildId) {
        ragIndex.clear();
        return false;
      }

      const batch = chunks.slice(i, i + RAG_BATCH_SIZE);
      const result = await embedWithTimeout(batch);

      // 빌드 도중 문서 전환 재확인
      if (activeBuildId !== buildId) {
        ragIndex.clear();
        return false;
      }

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
        ragIndex.addChunk(batch[j], result.embeddings[j], i + j);
      }

      store.setRagState({ progress: { current: Math.min(i + RAG_BATCH_SIZE, total), total } });
    }

    // 최종 문서 일치 확인
    if (activeBuildId !== buildId || useAppStore.getState().document?.id !== docId) {
      ragIndex.clear();
      return false;
    }

    store.setRagState({
      isIndexing: false,
      chunkCount: ragIndex.size,
      progress: null,
    });
    return true;
  } catch {
    ragIndex.clear();
    store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null });
    return false;
  }
}

/**
 * RAG 시맨틱 검색으로 관련 컨텍스트 추출.
 * 질문을 임베딩하고 벡터 스토어에서 유사 청크 검색.
 */
async function ragSearch(question: string): Promise<string | null> {
  const ragIndex = useAppStore.getState().ragIndex;
  if (ragIndex.size === 0) return null;

  try {
    const result = await window.electronAPI.ai.embed([question]);
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
      if (totalLen + r.text.length > MAX_QA_CONTEXT_CHARS) break;
      parts.push(r.text);
      totalLen += r.text.length;
    }
    return parts.join('\n\n');
  } catch {
    return null;
  }
}

// ─── Hook ───

export function useQa() {
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const qaMessages = useAppStore((s) => s.qaMessages);
  const qaStream = useAppStore((s) => s.qaStream);
  const ragState = useAppStore((s) => s.ragState);
  const clientRef = useRef<AiClient | null>(null);
  const abortedRef = useRef(false);

  useEffect(() => {
    return () => {
      const reqId = useAppStore.getState().qaRequestId;
      if (reqId) window.electronAPI.ai.abort(reqId);
    };
  }, []);

  // 문서 로드 시 RAG 인덱스 자동 빌드
  const document = useAppStore((s) => s.document);
  const prevDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!document || document.id === prevDocIdRef.current) return;
    prevDocIdRef.current = document.id;
    const docId = document.id;

    // 이전 인덱스 즉시 초기화 (다른 문서의 인덱스가 남아있지 않도록)
    const store = useAppStore.getState();
    store.ragIndex.clear();
    store.setRagState({ isIndexing: false, isAvailable: false, chunkCount: 0, progress: null, model: null });

    // 비동기로 인덱스 빌드 (UI 블로킹 없음)
    buildRagIndex(document.extractedText, docId);
  }, [document]);

  const handleQaAbort = useCallback(() => {
    abortedRef.current = true;
    const reqId = useAppStore.getState().qaRequestId;
    if (reqId) window.electronAPI.ai.abort(reqId);
    clientRef.current = null;
    const store = useAppStore.getState();
    store.flushQaStream();
    const partial = useAppStore.getState().qaStream;
    if (partial) {
      store.addQaMessage({ role: 'assistant', content: partial });
    }
    store.clearQaStream();
    store.setIsQaGenerating(false);
    store.setQaRequestId(null);
  }, []);

  const handleAsk = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) return;

    const state = useAppStore.getState();
    if (state.isGenerating || state.isQaGenerating || !state.document) return;

    const settings = state.settings;
    const doc = state.document;

    abortedRef.current = false;
    state.addQaMessage({ role: 'user', content: trimmed });
    state.setIsQaGenerating(true);
    state.clearQaStream();

    let completed = false;
    try {
      const client = new AiClient(settings);
      clientRef.current = client;

      // 요약 결과를 우선 컨텍스트로 포함
      const summaryText = useAppStore.getState().summaryStream || '';

      // RAG 시맨틱 검색 시도 → 실패 시 키워드 기반 fallback
      let relevantChunks: string;
      const ragResult = await ragSearch(trimmed);
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

      const requestId = client.prepareSummarize();
      useAppStore.getState().setQaRequestId(requestId);

      let answer = '';
      for await (const token of client.summarize(promptText, 'qa', requestId)) {
        if (!useAppStore.getState().isQaGenerating) break;
        useAppStore.getState().appendQaStream(token);
        answer += token;
      }

      if (!abortedRef.current) {
        useAppStore.getState().flushQaStream();
        useAppStore.getState().clearQaStream();
        if (answer) {
          useAppStore.getState().addQaMessage({ role: 'assistant', content: answer });
        }
        completed = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAppStore.getState().setError({
        code: 'GENERATE_FAIL',
        message: message || 'Q&A 답변 생성에 실패했습니다.',
      });
    } finally {
      clientRef.current = null;
      if (!completed && !abortedRef.current) {
        useAppStore.getState().flushQaStream();
        useAppStore.getState().clearQaStream();
      }
      useAppStore.getState().setIsQaGenerating(false);
      useAppStore.getState().setQaRequestId(null);
    }
  }, []);

  return { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating, ragState };
}

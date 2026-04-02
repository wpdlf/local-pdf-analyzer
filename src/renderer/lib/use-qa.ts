import { useRef, useEffect, useCallback } from 'react';
import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { chunkText } from './chunker';
import type { QaMessage } from '../types';

const MAX_QUESTION_LENGTH = 1000;
const MAX_QA_CONTEXT_CHARS = 8000;

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

/** 질문 키워드 기반 관련 청크 선별 (TF 스코어링) */
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
    // 키워드 없으면 첫 + 마지막 청크 (서론 + 결론)
    return [chunks[0], chunks[chunks.length - 1]].join('\n\n').slice(0, MAX_QA_CONTEXT_CHARS);
  }

  // 각 청크별 키워드 출현 빈도 합산 (split 카운팅 — RegExp 불필요)
  const scored = chunks.map((chunk, idx) => {
    const lower = chunk.toLowerCase();
    const score = keywords.reduce((sum, kw) =>
      sum + (lower.split(kw).length - 1), 0);
    return { chunk, score, idx };
  });

  // 스코어 높은 순 정렬
  scored.sort((a, b) => b.score - a.score);

  // maxChars 이내까지 청크 추가 (원본 순서 유지)
  const selected: { chunk: string; idx: number }[] = [];
  let totalLen = 0;
  for (const item of scored) {
    if (item.score === 0) break;
    if (totalLen + item.chunk.length > MAX_QA_CONTEXT_CHARS) break;
    selected.push(item);
    totalLen += item.chunk.length;
  }

  // 매칭 없으면 fallback
  if (selected.length === 0) {
    return [chunks[0], chunks[chunks.length - 1]].join('\n\n').slice(0, MAX_QA_CONTEXT_CHARS);
  }

  // 원본 순서로 정렬하여 문맥 유지
  selected.sort((a, b) => a.idx - b.idx);
  return selected.map((s) => s.chunk).join('\n\n');
}

/** 대화 이력을 프롬프트 텍스트로 변환 */
function formatHistory(messages: QaMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) =>
    m.role === 'user' ? `Q: ${m.content}` : `A: ${m.content}`,
  );
  return `\n[이전 대화]\n${lines.join('\n')}\n`;
}

export function useQa() {
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const qaMessages = useAppStore((s) => s.qaMessages);
  const qaStream = useAppStore((s) => s.qaStream);
  const clientRef = useRef<AiClient | null>(null);
  // abort/완료 레이스 컨디션 방지: 양쪽 경로에서 동시에 addQaMessage 호출되지 않도록 보호
  const abortedRef = useRef(false);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      const reqId = useAppStore.getState().qaRequestId;
      if (reqId) window.electronAPI.ai.abort(reqId);
    };
  }, []);

  const handleQaAbort = useCallback(() => {
    abortedRef.current = true;
    const reqId = useAppStore.getState().qaRequestId;
    if (reqId) window.electronAPI.ai.abort(reqId);
    clientRef.current = null;
    const store = useAppStore.getState();
    store.flushQaStream();
    // 스트리밍 중이던 답변을 메시지에 추가
    const partial = useAppStore.getState().qaStream;
    if (partial) {
      store.addQaMessage({ role: 'assistant', content: partial });
    }
    store.clearQaStream();
    store.setIsQaGenerating(false);
    store.setQaRequestId(null);
  }, []);

  // deps=[] 의도적: 모든 상태를 useAppStore.getState()로 명령적 읽기하므로 클로저 캡처 불필요
  const handleAsk = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) return;

    const state = useAppStore.getState();
    if (state.isGenerating || state.isQaGenerating || !state.document) return;

    const settings = state.settings;
    const doc = state.document;

    // 질문 메시지 추가
    abortedRef.current = false;
    state.addQaMessage({ role: 'user', content: trimmed });
    state.setIsQaGenerating(true);
    state.clearQaStream();

    try {
      const client = new AiClient(settings);
      clientRef.current = client;

      // 요약 결과를 우선 컨텍스트로 포함 — stale 방지를 위해 최신 상태에서 읽기
      const summaryText = useAppStore.getState().summaryStream || '';
      // 원본 PDF에서 관련 청크 추가 선별
      const relevantChunks = selectRelevantChunks(trimmed, doc.extractedText, settings.maxChunkSize);
      // 요약 + 원본 관련 부분 결합 (중복은 AI가 자연스럽게 처리)
      const contextParts = [];
      if (summaryText) contextParts.push(`[요약 내용]\n${summaryText.slice(0, 3000)}`);
      contextParts.push(`[원문 관련 부분]\n${relevantChunks}`);
      const context = contextParts.join('\n\n');

      // 대화 이력: async 경계 이후 최신 상태에서 읽어 stale 참조 방지
      const freshMessages = useAppStore.getState().qaMessages;
      const history = formatHistory(freshMessages).slice(0, 4000);

      // 프롬프트 조립: 컨텍스트 + 이력 + 질문
      const promptText = `${context}${history}\n[질문]\n${trimmed}`;

      // AI 생성 요청
      const requestId = client.prepareSummarize();
      useAppStore.getState().setQaRequestId(requestId);

      let answer = '';
      for await (const token of client.summarize(promptText, 'qa', requestId)) {
        if (!useAppStore.getState().isQaGenerating) break;
        useAppStore.getState().appendQaStream(token);
        answer += token;
      }

      // abort되지 않은 경우에만 완성된 답변 추가 (abort 시 handleQaAbort에서 partial 추가됨)
      // abortedRef를 단일 가드로 사용하여 TOCTOU 레이스 방지
      if (!abortedRef.current) {
        useAppStore.getState().flushQaStream();
        if (answer) {
          useAppStore.getState().addQaMessage({ role: 'assistant', content: answer });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAppStore.getState().setError({
        code: 'GENERATE_FAIL',
        message: message || 'Q&A 답변 생성에 실패했습니다.',
      });
    } finally {
      clientRef.current = null;
      // flushQaStream → clearQaStream 순서로 호출하여 pending flush 타이머에 의한 ghost text 방지
      useAppStore.getState().flushQaStream();
      useAppStore.getState().clearQaStream();
      useAppStore.getState().setIsQaGenerating(false);
      useAppStore.getState().setQaRequestId(null);
    }
  }, []);

  return { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating };
}

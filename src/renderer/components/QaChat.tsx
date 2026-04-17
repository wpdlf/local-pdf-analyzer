import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useQa } from '../lib/use-qa';
import { useT } from '../lib/i18n';
import { REMARK_PLUGINS, safeComponents, MarkdownErrorBoundary } from '../lib/safe-markdown';

export function QaChat() {
  const { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating, qaVerifying, ragState } = useQa();
  const t = useT();
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  // 새 메시지/스트리밍 시 자동 스크롤 (near-bottom 가드 + rAF로 jank 방지).
  // 이전 구현은 cleanup 에서 cancelAnimationFrame 을 호출해 — 밀집 스트리밍 시 매 effect
  // 재실행마다 이전 RAF 가 취소되어 실제 스크롤이 거의 안 일어나는 문제가 있었음.
  // 개선: pending ref 로 "이미 예약됨" 만 체크해 중복 예약을 막고, 취소는 하지 않음.
  useEffect(() => {
    if (!chatEndRef.current) return;
    const container = chatEndRef.current.parentElement;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (!isNearBottom) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [qaMessages.length, qaStream]);

  // 언마운트 시에는 pending RAF 제거
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const MAX_QUESTION_LENGTH = 1000;

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isQaGenerating) return;
    if (trimmed.length > MAX_QUESTION_LENGTH) return;
    // RAG 인덱싱 중에는 전송 차단 — 부분 인덱스로 답변해 정확도가 떨어지는 문제 방지
    if (ragState.isIndexing) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    handleAsk(trimmed);
  };

  const isOverLimit = input.trim().length > MAX_QUESTION_LENGTH;

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 조합 중(한글/일본어/중국어)의 Enter는 조합 확정용이므로 제출 차단
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full border-t dark:border-gray-700">
      {/* 헤더 */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b dark:border-gray-700 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('qa.header')}
        </span>
        {ragState.isIndexing ? (
          <span className="text-xs text-amber-500 flex items-center gap-1">
            <svg aria-hidden="true" className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            {t('qa.indexing')}{ragState.progress ? ` ${ragState.progress.current}/${ragState.progress.total}` : '...'}
          </span>
        ) : ragState.chunkCount > 0 ? (
          <span className="text-xs text-green-500" title={t('qa.chunkTooltip', { model: ragState.model || '?', count: ragState.chunkCount })}>
            RAG
          </span>
        ) : null}
      </div>

      {/* 빈 상태 안내 */}
      {qaMessages.length === 0 && !qaStream && (
        <div className="px-4 py-3 text-center text-sm text-gray-400 dark:text-gray-500">
          {ragState.chunkCount > 0 ? t('qa.ragActive') : t('qa.emptyHint')}
        </div>
      )}

      {/* 대화 목록 — aria-live="polite"로 새 메시지/스트리밍 토큰을 스크린 리더에 알림 */}
      {(qaMessages.length > 0 || qaStream) && (
        <div
          role="log"
          aria-live="polite"
          aria-busy={isQaGenerating}
          aria-label={t('qa.header')}
          className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-3"
        >
          {qaMessages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none'
              }`}>
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <MarkdownErrorBoundary fallbackText={msg.content}>
                    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{msg.content}</ReactMarkdown>
                  </MarkdownErrorBoundary>
                )}
              </div>
            </div>
          ))}

          {qaStream && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none">
                <MarkdownErrorBoundary fallbackText={qaStream}>
                  <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{qaStream}</ReactMarkdown>
                </MarkdownErrorBoundary>
              </div>
            </div>
          )}

          {isQaGenerating && !qaStream && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-400 flex items-center gap-2">
                {qaVerifying && (
                  <svg aria-hidden="true" className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                )}
                {qaVerifying ? t('qa.verifying') : t('qa.generating')}
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      )}

      {isOverLimit && (
        <div className="px-4 py-1 text-xs text-red-500">
          {t('qa.charLimit', { max: MAX_QUESTION_LENGTH, current: input.trim().length })}
        </div>
      )}

      {ragState.isIndexing && (
        <div className="px-4 py-1 text-xs text-amber-600 dark:text-amber-400">
          {t('qa.waitIndexing')}
        </div>
      )}

      {/* 입력 영역 */}
      <div className="flex items-end gap-2 px-4 py-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={t('qa.placeholder')}
          disabled={isQaGenerating || ragState.isIndexing}
          rows={1}
          className="flex-1 resize-none rounded-lg border dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 placeholder:text-gray-400"
          aria-label={t('qa.inputAria')}
        />
        {isQaGenerating ? (
          <button
            onClick={handleQaAbort}
            className="px-3 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shrink-0"
            aria-label={t('qa.stopAria')}
          >
            {t('viewer.stopBtn')}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isOverLimit || ragState.isIndexing}
            className="px-3 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            aria-label={t('qa.sendAria')}
          >
            {t('common.send')}
          </button>
        )}
      </div>
    </div>
  );
}

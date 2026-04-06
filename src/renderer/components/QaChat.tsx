import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useQa } from '../lib/use-qa';
import { REMARK_PLUGINS, safeComponents } from '../lib/safe-markdown';

export function QaChat() {
  const { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating } = useQa();
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 새 ��시지/스트리밍 시 자동 스크롤 (near-bottom 가드 + rAF로 jank 방지)
  useEffect(() => {
    if (!chatEndRef.current) return;
    const container = chatEndRef.current.parentElement;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (!isNearBottom) return;
    const id = requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [qaMessages.length, qaStream]);

  const MAX_QUESTION_LENGTH = 1000;

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isQaGenerating) return;
    if (trimmed.length > MAX_QUESTION_LENGTH) return;
    setInput('');
    // 높이 리셋
    if (inputRef.current) inputRef.current.style.height = 'auto';
    handleAsk(trimmed);
  };

  const isOverLimit = input.trim().length > MAX_QUESTION_LENGTH;

  // textarea 자동 높이 조절 (최대 6줄)
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px'; // 144px ≈ 6줄
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full border-t dark:border-gray-700">
      {/* 헤더 */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b dark:border-gray-700">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          문서에 대해 질문하세요
        </span>
      </div>

      {/* 빈 상태 안내 */}
      {qaMessages.length === 0 && !qaStream && (
        <div className="px-4 py-3 text-center text-sm text-gray-400 dark:text-gray-500">
          요약된 내용이나 원문에 대해 궁금한 점을 질문해보세요
        </div>
      )}

      {/* 대화 목록 — flex-1로 남은 공간 차지, 스크롤 */}
      {(qaMessages.length > 0 || qaStream) && (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-3">
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
                  <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{msg.content}</ReactMarkdown>
                )}
              </div>
            </div>
          ))}

          {/* 스트리밍 중인 답변 */}
          {qaStream && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{qaStream}</ReactMarkdown>
              </div>
            </div>
          )}

          {/* 생성 중 로딩 표시 */}
          {isQaGenerating && !qaStream && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-400">
                답변 생성 중...
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      )}

      {/* 글자 수 초과 경고 */}
      {isOverLimit && (
        <div className="px-4 py-1 text-xs text-red-500">
          질문은 {MAX_QUESTION_LENGTH}자까지 입력 가능합니다 ({input.trim().length}/{MAX_QUESTION_LENGTH})
        </div>
      )}

      {/* 입력 영역 */}
      <div className="flex items-end gap-2 px-4 py-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="질문을 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)"
          disabled={isQaGenerating}
          rows={1}
          className="flex-1 resize-none rounded-lg border dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 placeholder:text-gray-400"
          aria-label="질문 입력"
        />
        {isQaGenerating ? (
          <button
            onClick={handleQaAbort}
            className="px-3 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shrink-0"
            aria-label="답변 중지"
          >
            ■ 중지
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isOverLimit}
            className="px-3 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            aria-label="질문 전송"
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}

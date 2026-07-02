import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useQa } from '../lib/use-qa';
import { abortCollectionGather } from '../lib/use-collection-summary';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { SafeMarkdown } from '../lib/safe-markdown';
import { CollectionBar } from './CollectionBar';

// 어시스턴트 답변 본문 — React.memo 로 완료 메시지의 markdown 재파싱을 차단.
// QaChat 은 qaStream 을 구독하므로 스트리밍 중 store 의 50ms flush 마다 전체 리렌더되는데,
// content 가 불변인 완료 메시지까지 매 틱 markdown(remark/react-markdown)을 재파싱하던 비용을
// 메모로 제거한다. props(id/content/degraded/copied/onCopy)가 스트리밍 중 모두 안정적이라
// 완료 메시지는 skip 된다(live qaStream 메시지만 재파싱 — 본질적으로 동적이라 불가피).
interface AssistantMessageProps {
  id: string;
  content: string;
  degraded?: boolean;
  copied: boolean;
  onCopy: (id: string, content: string) => void;
}
const AssistantMessage = memo(function AssistantMessage({ id, content, degraded, copied, onCopy }: AssistantMessageProps) {
  const t = useT();
  return (
    <>
      <SafeMarkdown content={content} />
      {/* M3: 컬렉션 강등 답변이면 바로 아래 인라인 안내 (이전엔 전역 단일 슬롯 notice 배너) */}
      {degraded && (
        <p className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800/50 text-xs text-amber-600 dark:text-amber-400 not-prose">
          ⚠️ {t('collection.degradedNotice')}
        </p>
      )}
      {/* M4: 어시스턴트 답변 hover 복사 버튼 */}
      <button
        onClick={() => void onCopy(id, content)}
        className="absolute -top-2 -right-2 px-1.5 py-0.5 text-xs rounded bg-white dark:bg-gray-700 border dark:border-gray-600 shadow-sm opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity not-prose"
        aria-label={copied ? t('qa.copied') : t('qa.copyAnswer')}
        title={copied ? t('qa.copied') : t('qa.copyAnswer')}
      >
        {copied ? '✓' : '📋'}
      </button>
    </>
  );
});

export function QaChat() {
  const { handleAsk, handleQaAbort, qaMessages, qaStream, isQaGenerating, qaVerifying, ragState } = useQa();
  // 교차 요약 준비(gather) 중에는 입력 차단 — isQaGenerating 세팅 전 창의 race 방지(QA R).
  const isCollectionBusy = useAppStore((s) => s.isCollectionBusy);
  const t = useT();
  const [input, setInput] = useState('');
  // M4(UX): 답변별 복사 — 복사 직후 짧게 ✓ 피드백. (요약엔 복사가 있었지만 Q&A 답변엔 없어
  // 스트리밍 컨테이너에서 수동 선택해야 했다.) React 18+ 는 unmounted setState 경고가 없어 안전.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // useCallback 으로 안정 참조 유지 — AssistantMessage memo 가 스트리밍 중 깨지지 않도록.
  const handleCopyMsg = useCallback(async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch { /* 클립보드 거부 시 무시 — 답변 자체는 화면에 남아 있음 */ }
  }, []);
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
          // a11y L5: 인덱싱 상태를 SR 에 polite 통지. 진행 숫자(N/M)는 빠르게 바뀌어 과통지되므로
          // aria-hidden 으로 라이브 영역에서 제외하고, 안정적인 라벨만 읽히게 한다.
          <span role="status" className="text-xs text-amber-500 flex items-center gap-1">
            <svg aria-hidden="true" className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            {t('qa.indexing')}<span aria-hidden="true">{ragState.progress ? ` ${ragState.progress.current}/${ragState.progress.total}` : '...'}</span>
          </span>
        ) : ragState.chunkCount > 0 ? (
          <span className="text-xs text-green-500" title={t('qa.chunkTooltip', { model: ragState.model || '?', count: ragState.chunkCount })}>
            RAG
          </span>
        ) : null}
      </div>

      {/* 다중 문서 컬렉션 Q&A (multi-doc Phase 2) — 열린 문서 2개 이상일 때만 노출 */}
      <CollectionBar />

      {/* 빈 상태 안내 */}
      {qaMessages.length === 0 && !qaStream && (
        <div className="px-4 py-3 text-center text-sm text-gray-600 dark:text-gray-400">
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
            <div key={msg.id} className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`relative max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none'
              }`}>
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <AssistantMessage
                    id={msg.id}
                    content={msg.content}
                    degraded={msg.degraded}
                    copied={copiedId === msg.id}
                    onCopy={handleCopyMsg}
                  />
                )}
              </div>
            </div>
          ))}

          {qaStream && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none">
                <SafeMarkdown content={qaStream} />
              </div>
            </div>
          )}

          {isQaGenerating && !qaStream && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 flex items-center gap-2">
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

      {isCollectionBusy && (
        <div className="px-4 py-1 text-xs text-blue-600 dark:text-blue-400">
          {t('collection.preparing')}
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
          disabled={isQaGenerating || ragState.isIndexing || isCollectionBusy}
          rows={1}
          className="flex-1 resize-none rounded-lg border dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 placeholder:text-gray-400"
          aria-label={t('qa.inputAria')}
        />
        {isQaGenerating || isCollectionBusy ? (
          // C5-M5(QA cycle5): gather 단계(isCollectionBusy && !isQaGenerating)에도 중지 버튼 노출.
          // 이전엔 중지가 isQaGenerating 조건부라 인라인 멤버 요약(최대 10건, 분 단위) 동안 모든
          // 탈출 경로가 busy 게이트에 막혀 취소 수단이 전무했다. reduce 스트리밍은 기존 handleQaAbort.
          <button
            onClick={isQaGenerating ? handleQaAbort : abortCollectionGather}
            className="px-3 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shrink-0"
            aria-label={t('qa.stopAria')}
          >
            {t('viewer.stopBtn')}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isOverLimit || ragState.isIndexing || isCollectionBusy}
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

import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { switchToTab, closeTab, openNewTabView } from '../lib/tabs';

/**
 * 다중 문서 탭바 (multi-doc Phase 1).
 * 열린 문서가 1개 이상일 때 헤더 아래에 표시. 활성 탭 = document.filePath 파생.
 * 생성/파싱 중에는 전환·닫기·새 탭을 비활성화 (handlePdfData 내부 가드의 사전 차단판).
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activePath = useAppStore((s) => s.document?.filePath ?? null);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const isParsing = useAppStore((s) => s.isParsing);
  const t = useT();

  if (openTabs.length === 0) return null;
  const blocked = isGenerating || isQaGenerating || isParsing;

  // a11y M4: 이전엔 <div role="tab"> 안에 전환·닫기 버튼 2개를 중첩해 ARIA nested-interactive 를
  // 위반했고, role="tab" 자체는 비포커스이며 roving tabindex/화살표키·tabpanel 연결도 없어 불완전한
  // 탭 패턴이었다. 닫기 버튼이 달린 브라우저식 탭은 ARIA Tabs 보다 "탐색 목록"이 정합적이므로
  // <nav><ul><li> + 활성 표시 aria-current="page" 로 재구성(중첩 위반 제거, 시맨틱 정확).
  return (
    <nav
      aria-label={t('tabs.label')}
      className="flex items-center gap-1 px-2 py-1 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 overflow-x-auto"
    >
      <ul role="list" className="flex items-center gap-1 m-0 p-0 list-none">
        {openTabs.map((tab) => {
          const isActive = tab.filePath === activePath;
          return (
            <li
              key={tab.filePath}
              className={`group flex items-center gap-1 max-w-48 shrink-0 rounded-t px-2 py-1 text-xs border-b-2 transition-colors ${
                isActive
                  ? 'border-blue-500 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-medium'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <button
                onClick={() => { if (!blocked) void switchToTab(tab.filePath); }}
                disabled={blocked && !isActive}
                aria-current={isActive ? 'page' : undefined}
                className="truncate disabled:cursor-not-allowed"
                title={`${tab.fileName} (${tab.pageCount}p)`}
              >
                📄 {tab.fileName}
              </button>
              {/* 비활성 탭 닫기는 목록 제거뿐이라 생성 중에도 안전 — 활성 탭만 차단 (closeTab 내부 가드와 일치) */}
              <button
                onClick={() => { void closeTab(tab.filePath); }}
                disabled={blocked && isActive}
                aria-label={t('tabs.close', { name: tab.fileName })}
                className="shrink-0 rounded px-0.5 text-gray-400 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed opacity-60 group-hover:opacity-100"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={() => { if (!blocked) void openNewTabView(); }}
        disabled={blocked || activePath === null}
        aria-label={t('tabs.newTab')}
        title={t('tabs.newTab')}
        className="shrink-0 rounded px-2 py-1 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ＋
      </button>
    </nav>
  );
}

// 요약 마인드맵 — 요약 마크다운의 heading 계층을 수평 트리로 시각화. 노드 접기/펼치기 +
// 페이지 배지 클릭 시 인용 뷰어로 점프(기존 citationTarget 인프라 재사용). 외부 의존 0.
import { useMemo, useState, useCallback } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { setCitationReturnFocus } from '../lib/citation-focus';
import { parseSummaryToTree, type SummaryTreeNode } from '../lib/summary-tree';

export function SummaryMindMap({ markdown }: { markdown: string }) {
  const t = useT();
  const roots = useMemo(() => parseSummaryToTree(markdown), [markdown]);

  if (roots.length === 0) {
    return (
      <div role="note" className="not-prose text-sm text-gray-500 dark:text-gray-400 p-4">
        {t('mindmap.empty')}
      </div>
    );
  }
  return (
    <div className="not-prose">
      <ul role="tree" aria-label={t('mindmap.title')} className="text-sm">
        {roots.map((n) => (
          <MindMapNode key={n.id} node={n} level={1} isRoot />
        ))}
      </ul>
    </div>
  );
}

function MindMapNode({ node, level, isRoot }: { node: SummaryTreeNode; level: number; isRoot?: boolean }) {
  const t = useT();
  const setCitationTarget = useAppStore((s) => s.setCitationTarget);
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);

  const jump = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (node.page == null) return;
    // 닫힘 시 이 배지로 포커스 반환(인용 뷰어 포커스 정책과 정합).
    setCitationReturnFocus(e.currentTarget);
    setCitationTarget({ page: node.page });
  }, [node.page, setCitationTarget]);

  return (
    <li role="treeitem" aria-level={level} aria-expanded={hasChildren ? expanded : undefined}>
      <div className="flex items-center gap-1.5 py-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t('mindmap.collapse') : t('mindmap.expand')}
            className="shrink-0 w-4 h-4 inline-flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4 inline-flex items-center justify-center text-gray-300 dark:text-gray-600" aria-hidden="true">·</span>
        )}
        <span
          className={`inline-block px-2 py-0.5 rounded ${
            isRoot
              ? 'font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'
          }`}
        >
          {node.title || t('mindmap.untitled')}
        </span>
        {node.page != null && (
          <button
            type="button"
            onClick={jump}
            aria-label={t('mindmap.jumpAria', { page: String(node.page) })}
            title={t('mindmap.jumpAria', { page: String(node.page) })}
            className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1"
          >
            [p.{node.page}]
          </button>
        )}
      </div>
      {hasChildren && expanded && (
        <ul role="group" className="ml-3 pl-3 border-l border-gray-200 dark:border-gray-700">
          {node.children.map((c) => (
            <MindMapNode key={c.id} node={c} level={level + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

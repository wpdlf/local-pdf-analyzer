// 요약 마인드맵 — 요약 마크다운의 heading 계층을 수평 트리로 시각화. 노드 접기/펼치기 +
// 페이지 배지 클릭 시 인용 뷰어로 점프. 외부 의존 0.
//
// QA15(C-MED): role="tree"/treeitem 은 화살표 키 내비를 구현해야 하는 계약인데 미구현이라
// SR 사용자를 오도했다. 이 앱은 OutlineTree(PdfViewer)에서 같은 이유로 role=tree 를 nested
// ul/li 로 다운그레이드한 전례가 있어 동일하게 처리 — 각 인터랙션 요소(토글·인용배지)가 Tab 스톱.
// QA15(B/D-MED): 페이지 점프는 bespoke 버튼 대신 CitationButton 을 재사용해 clampCitationPage
// 범위검증·교차문서 라우팅(탭 전환)·닫힌문서 비활성·포커스 반환을 텍스트뷰와 동일하게 얻는다.
import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n';
import { parseSummaryToTree, type SummaryTreeNode } from '../lib/summary-tree';
import { CitationButton } from './CitationButton';
import { stripMathDelimiters } from '../lib/math-normalize';

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
  // QA28(B2-Low): 노드 id 가 등장 순서(`mm-N`)라 요약이 바뀌어도 React 가 같은 key 의 인스턴스를
  // 재사용해 접어 둔 상태가 전혀 다른 heading 에 붙었다(탭 전환·재요약 시 하위 노드가 이유 없이
  // 숨음). 요약 텍스트가 바뀌면 트리를 새로 마운트해 접힘 상태를 그 요약에 귀속시킨다.
  const treeKey = useMemo(() => `${markdown.length}:${roots.map((r) => r.title).join('|')}`, [markdown, roots]);
  return (
    <nav aria-label={t('mindmap.title')} className="not-prose text-sm">
      <ul key={treeKey}>
        {roots.map((n) => (
          <MindMapNode key={n.id} node={n} isRoot />
        ))}
      </ul>
    </nav>
  );
}

function MindMapNode({ node, isRoot }: { node: SummaryTreeNode; isRoot?: boolean }) {
  const t = useT();
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);
  // QA16(A-LOW): 토글이 제어하는 하위 목록을 aria-controls 로 연결(디스클로저 시맨틱 명확화).
  const childListId = `mm-children-${node.id}`;

  return (
    <li>
      <div className="flex items-center gap-1.5 py-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={childListId}
            aria-label={`${node.title || t('mindmap.untitled')} — ${expanded ? t('mindmap.collapse') : t('mindmap.expand')}`}
            className="shrink-0 w-4 h-4 inline-flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4 inline-flex items-center justify-center text-gray-400 dark:text-gray-500" aria-hidden="true">·</span>
        )}
        <span
          className={`inline-block px-2 py-0.5 rounded ${
            isRoot
              ? 'font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'
          }`}
        >
          {node.title ? stripMathDelimiters(node.title) : t('mindmap.untitled')}
        </span>
        {node.page != null && (
          <CitationButton page={node.page} docName={node.docName ?? undefined} />
        )}
      </div>
      {hasChildren && expanded && (
        <ul id={childListId} className="ml-3 pl-3 border-l border-gray-200 dark:border-gray-700">
          {node.children.map((c) => (
            <MindMapNode key={c.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

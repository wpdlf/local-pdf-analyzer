// Design Ref: §5.3, §5.5 — 인라인 인용 버튼
// Plan SC: SC-02 (인용 토큰 → 클릭 가능), SC-03 (클릭 → 뷰어 스크롤)
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { clampCitationPage } from '../lib/citation';
import { switchToTab } from '../lib/tabs';

interface CitationButtonProps {
  page: number;
  /** 컬렉션 Q&A 교차 문서 인용의 출처 문서명 (`[문서명 p.N]`). 현재 문서와 다르면 클릭 시 탭 전환. */
  docName?: string;
}

/**
 * 인라인 인용 버튼.
 * 클릭 시 store.citationTarget 을 설정하여 SummaryViewer 가 PdfViewer 패널을 마운트/스크롤.
 *
 * multi-doc Phase 2: docName 이 있고 현재 문서와 다르면, 클릭 시 해당 문서 탭으로 먼저 전환한 뒤
 * 페이지로 점프한다. 페이지 유효성은 (전환 대상이면) 그 탭의 pageCount 로 검증한다.
 * 매칭되는 열린 탭이 없으면(닫힌 문서 인용) 비활성으로 렌더.
 */
export function CitationButton({ page, docName }: CitationButtonProps) {
  const t = useT();
  const setCitationTarget = useAppStore((s) => s.setCitationTarget);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeFilePath = useAppStore((s) => s.document?.filePath ?? null);
  const activeFileName = useAppStore((s) => s.document?.fileName ?? null);
  const activePageCount = useAppStore((s) => s.document?.pageCount ?? 0);

  // docName 이 현재 문서와 같으면 교차 문서가 아님(단일 문서 인용처럼 동작).
  const isCrossDoc = docName !== undefined && docName !== activeFileName;
  // 교차 문서면 출처 탭을 찾아 그 pageCount 로 검증·전환. 못 찾으면 targetTab=undefined.
  const targetTab = isCrossDoc ? openTabs.find((tb) => tb.fileName === docName) : undefined;
  const pageCount = isCrossDoc ? (targetTab?.pageCount ?? 0) : activePageCount;

  const validPage = clampCitationPage(page, pageCount);
  const isActive = useAppStore(
    (s) => validPage !== null && !isCrossDoc && s.citationTarget?.page === validPage
  );

  // 라벨: 교차 문서는 출처를 함께 표기 (`[문서명 p.N]`), 단일 문서는 기존 `[p.N]`
  const label = isCrossDoc && docName ? `[${docName} p.${page}]` : `[p.${page}]`;

  // 교차 문서인데 해당 탭이 닫혀 있거나 범위를 벗어나면 클릭 불가
  if (validPage === null || (isCrossDoc && !targetTab)) {
    return (
      <span
        className="inline-block px-1 mx-0.5 text-xs text-gray-400 dark:text-gray-500 border border-dashed border-gray-300 dark:border-gray-600 rounded cursor-not-allowed"
        title={isCrossDoc && !targetTab ? t('citation.docClosed', { name: docName ?? '' }) : t('citation.invalid', { page })}
        aria-disabled="true"
      >
        {label}
      </span>
    );
  }

  const handleClick = async (e: React.MouseEvent) => {
    // 마크다운 안의 링크 등 다른 interactive 요소로 이벤트가 bubble 되지 않도록 차단
    e.preventDefault();
    e.stopPropagation();
    // 교차 문서면 먼저 해당 탭으로 전환(세션 우선 복원, 즉시) 후 페이지 점프
    if (isCrossDoc && targetTab && targetTab.filePath !== activeFilePath) {
      await switchToTab(targetTab.filePath);
    }
    setCitationTarget({ page: validPage });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={isCrossDoc && docName ? t('citation.crossTooltip', { name: docName, page: validPage }) : t('citation.tooltip', { page: validPage })}
      aria-label={isCrossDoc && docName ? t('citation.crossAria', { name: docName, page: validPage }) : t('citation.aria', { page: validPage })}
      className={`inline px-1 mx-0.5 text-xs font-medium rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        isActive
          ? 'bg-blue-200 dark:bg-blue-800 border-blue-300 dark:border-blue-700 text-blue-900 dark:text-blue-100'
          : 'bg-transparent border-transparent text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:underline'
      }`}
    >
      {label}
    </button>
  );
}

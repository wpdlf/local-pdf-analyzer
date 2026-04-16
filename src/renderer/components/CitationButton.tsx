// Design Ref: §5.3, §5.5 — 인라인 인용 버튼
// Plan SC: SC-02 (인용 토큰 → 클릭 가능), SC-03 (클릭 → 뷰어 스크롤)
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { clampCitationPage } from '../lib/citation';

interface CitationButtonProps {
  page: number;
}

/**
 * 인라인 인용 버튼.
 * 클릭 시 store.citationTarget 을 설정하여 SummaryViewer 가 PdfViewer 패널을 마운트/스크롤.
 * 현재 문서의 페이지 범위를 벗어난 인용은 disabled 로 렌더 (클릭 차단 + 툴팁 안내).
 */
export function CitationButton({ page }: CitationButtonProps) {
  const t = useT();
  const setCitationTarget = useAppStore((s) => s.setCitationTarget);
  // pageCount 는 store 의 document 에서 직접 읽음 — 렌더 시점 최신값
  const pageCount = useAppStore((s) => s.document?.pageCount ?? 0);

  const validPage = clampCitationPage(page, pageCount);
  // 이 버튼 자신의 활성 여부만 boolean 으로 구독 → citationTarget 변경 시 다른 페이지 버튼은
  // zustand Object.is 비교로 리렌더 skip. N개 인용 버튼에서 N회 → 영향받는 1~2회로 축소.
  const isActive = useAppStore(
    (s) => validPage !== null && s.citationTarget?.page === validPage
  );

  if (validPage === null) {
    // 범위 초과 — 클릭 불가, 툴팁으로 이유 안내, 시각적으로 구분
    return (
      <span
        className="inline-block px-1 mx-0.5 text-xs text-gray-400 dark:text-gray-500 border border-dashed border-gray-300 dark:border-gray-600 rounded cursor-not-allowed"
        title={t('citation.invalid', { page })}
        aria-disabled="true"
      >
        [p.{page}]
      </span>
    );
  }

  const handleClick = (e: React.MouseEvent) => {
    // 마크다운 안의 링크 등 다른 interactive 요소로 이벤트가 bubble 되지 않도록 차단
    e.preventDefault();
    e.stopPropagation();
    setCitationTarget({ page: validPage });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={t('citation.tooltip', { page: validPage })}
      aria-label={t('citation.aria', { page: validPage })}
      className={`inline px-1 mx-0.5 text-xs font-medium rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        isActive
          ? 'bg-blue-200 dark:bg-blue-800 border-blue-300 dark:border-blue-700 text-blue-900 dark:text-blue-100'
          : 'bg-transparent border-transparent text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:underline'
      }`}
    >
      [p.{validPage}]
    </button>
  );
}

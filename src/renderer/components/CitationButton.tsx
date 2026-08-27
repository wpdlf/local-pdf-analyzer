// Design Ref: §5.3, §5.5 — 인라인 인용 버튼
// Plan SC: SC-02 (인용 토큰 → 클릭 가능), SC-03 (클릭 → 뷰어 스크롤)
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { clampCitationPage, sanitizeDocLabelName } from '../lib/citation';
import { setCitationReturnFocus } from '../lib/citation-focus';
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

  // QA21(D-MED): 라벨은 sanitizeDocLabelName 을 거친 값이므로 **탭 이름도 같은 함수로 정규화해
  // 비교**해야 한다. 이전엔 가공 전 원본 fileName 과 정확 일치를 요구해, 파일명에 `[ ] |`·연속
  // 공백이 있거나 110자를 넘으면 그 문서로의 인용이 전부 "문서 닫힘" 으로 비활성화됐다.
  const matchesDoc = (name: string | null): boolean =>
    name !== null && docName !== undefined && sanitizeDocLabelName(name) === docName;
  const isCrossDoc = docName !== undefined && !matchesDoc(activeFileName);
  // 교차 문서면 출처 탭을 찾아 그 pageCount 로 검증·전환.
  // QA21(D-MED): **동명 문서 모호성**을 조용히 넘기지 않는다. 다른 폴더의 같은 이름
  // (`report.pdf` 둘)이 열려 있으면 이전 코드는 `find` 로 앞의 것을 집었고, 활성 문서까지 같은
  // 이름이면 isCrossDoc=false 가 되어 **활성 문서의 그 페이지로 점프**했다 — 사용자는 다른
  // 문서를 보고 있다는 사실을 알 수 없었다(조용한 오답). 후보가 2개 이상이면 어느 쪽인지
  // 알 방법이 없으므로 비활성 + 전용 안내로 표면화한다. 잘못된 곳으로 확신을 갖고 점프하는
  // 것보다 "판단 불가" 를 보여주는 편이 낫다.
  const candidates = docName !== undefined ? openTabs.filter((tb) => matchesDoc(tb.fileName)) : [];
  const ambiguous = candidates.length > 1;
  const targetTab = isCrossDoc && !ambiguous ? candidates[0] : undefined;
  const pageCount = isCrossDoc ? (targetTab?.pageCount ?? 0) : activePageCount;

  const validPage = clampCitationPage(page, pageCount);
  const isActive = useAppStore(
    (s) => validPage !== null && !isCrossDoc && s.citationTarget?.page === validPage
  );

  // 라벨: 교차 문서는 출처를 함께 표기 (`[문서명 p.N]`), 단일 문서는 기존 `[p.N]`
  const label = isCrossDoc && docName ? `[${docName} p.${page}]` : `[p.${page}]`;

  // 교차 문서인데 해당 탭이 닫혀 있거나 모호하거나 범위를 벗어나면 클릭 불가.
  // ambiguous 는 활성 문서와 이름이 겹치는 경우도 포함하므로 isCrossDoc 과 독립적으로 검사한다
  // (동명 두 문서 중 하나가 활성이면 isCrossDoc=false 로 판정돼 그냥 통과했었다).
  if (validPage === null || ambiguous || (isCrossDoc && !targetTab)) {
    const title = ambiguous
      ? t('citation.ambiguousDoc', { name: docName ?? '' })
      : isCrossDoc && !targetTab
        ? t('citation.docClosed', { name: docName ?? '' })
        : t('citation.invalid', { page });
    return (
      <span
        className="inline-block px-1 mx-0.5 text-xs text-gray-400 dark:text-gray-500 border border-dashed border-gray-300 dark:border-gray-600 rounded cursor-not-allowed"
        title={title}
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
    // QA28(B-MED): React 는 리스너 반환 직후 event.currentTarget 을 null 로 되돌리므로 아래
    // await 를 건넌 뒤에는 null 이다 — 교차 문서 경로만 포커스 반환이 항상 실패해 패널을 닫으면
    // 포커스가 <body> 로 갔다(QA14 가 단일 문서 경로에서 고친 것의 형제). 첫 await 전에 캡처.
    const trigger = e.currentTarget as HTMLElement;
    // 교차 문서면 먼저 해당 탭으로 전환(세션 우선 복원, 즉시) 후 페이지 점프
    if (isCrossDoc && targetTab && targetTab.filePath !== activeFilePath) {
      await switchToTab(targetTab.filePath);
      // QA: 전환이 차단(생성 중)되거나 파일 못 찾아 실패하면 활성 문서가 대상이 아니다 —
      // 이때 대상 탭 기준으로 산출한 validPage 를 엉뚱한 현재 문서에 적용하지 않는다(범위 초과
      // 점프 방지). switchToTab 이 실패 시 자체적으로 에러 배너를 띄운다.
      if (useAppStore.getState().document?.filePath !== targetTab.filePath) return;
    }
    // QA14(D-MED): 패널 닫힘 시 포커스를 이 버튼으로 반환하도록 트리거를 기록.
    setCitationReturnFocus(trigger);
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

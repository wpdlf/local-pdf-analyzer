import { useEffect } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import type { ActiveSummaryType } from '../types';
import { SUMMARY_LANGUAGES, isCustomSummaryType } from '../types';

// 한국어 특화 모델 — 다른 언어 출력 시 품질이 낮을 수 있음
const KOREAN_ONLY_MODELS = ['exaone'];

export function SummaryTypeSelector() {
  const summaryType = useAppStore((s) => s.summaryType);
  const setSummaryType = useAppStore((s) => s.setSummaryType);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const pageCount = useAppStore((s) => s.document?.pageCount ?? 0);
  const pageRange = useAppStore((s) => s.summaryPageRange);
  const setPageRange = useAppStore((s) => s.setSummaryPageRange);
  const t = useT();

  // 페이지 범위 입력 — 1~pageCount 로 클램프. start>end 는 요약 시 슬라이스가 스왑 처리하지만
  // UI 에서도 즉시 클램프해 직관성 유지.
  const clampPage = (n: number) => Math.max(1, Math.min(Math.floor(n) || 1, pageCount));
  const updateRange = (patch: Partial<{ start: number; end: number }>) => {
    const base = pageRange ?? { start: 1, end: pageCount };
    setPageRange({ start: clampPage(patch.start ?? base.start), end: clampPage(patch.end ?? base.end) });
  };

  // 커스텀 요약 템플릿을 기본 3종 뒤에 라디오 옵션으로 노출. value 는 `custom:<id>`(요약 실행·세션 키).
  // 이름/프롬프트가 빈 미완성 템플릿은 제외 — main sanitize 가 저장 시 드롭하므로(재시작 후 사라짐)
  // 선택기에 빈 라벨/비동작 라디오가 뜨는 렌더러-디스크 divergence 를 원천 차단(③MED-1).
  const customTemplates = settings.customSummaryTemplates ?? [];
  const validTemplates = customTemplates.filter((tpl) => tpl.name.trim() && tpl.prompt.trim());
  const options: { value: ActiveSummaryType; label: string }[] = [
    { value: 'full', label: t('selector.full') },
    { value: 'chapter', label: t('selector.chapter') },
    { value: 'keywords', label: t('selector.keywords') },
    ...validTemplates.map((tpl) => ({ value: `custom:${tpl.id}` as ActiveSummaryType, label: tpl.name })),
  ];

  // 활성 커스텀 유형이 유효 템플릿을 가리키지 않으면(삭제·sanitize 드롭·복원 고아) 'full' 로 폴백 —
  // 선택기가 아무것도 선택 안 된 blank 상태로 남는 것 방지(②B/③LOW-1). 선택기는 문서 로드 후
  // 마운트돼 settings 로드 이후이므로 초기 [] 로 인한 오리셋 없음. customTemplates 는 store ref 로 안정.
  useEffect(() => {
    if (isCustomSummaryType(summaryType)
      && !customTemplates.some((tpl) => tpl.name.trim() && tpl.prompt.trim() && `custom:${tpl.id}` === summaryType)) {
      setSummaryType('full');
    }
  }, [summaryType, customTemplates, setSummaryType]);

  const lang = settings.summaryLanguage || 'ko';
  const modelBase = settings.model.split(':')[0] ?? '';
  const isKoreanOnlyModel = settings.provider === 'ollama'
    && KOREAN_ONLY_MODELS.some((m) => modelBase.startsWith(m));
  const showModelWarning = lang !== 'ko' && isKoreanOnlyModel;

  return (
    <div className="inline-flex flex-col items-start gap-3">
      <div className="flex items-center gap-4">
        {/* QA14(D-LOW): 가시 라벨을 radiogroup 접근명으로 연결 — SR 이 각 옵션의 그룹 맥락을 안내. */}
        <span id="selector-summary-type-label" className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.summaryType')}</span>
        <div className="flex gap-3" role="radiogroup" aria-labelledby="selector-summary-type-label">
          {options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="summaryType"
                value={opt.value}
                checked={summaryType === opt.value}
                onChange={() => setSummaryType(opt.value)}
                className="accent-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center gap-4">
          <span id="selector-page-range-label" className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.pageRange')}</span>
          <div className="flex items-center gap-3 flex-wrap" role="radiogroup" aria-labelledby="selector-page-range-label">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="pageRangeMode"
                checked={pageRange === null}
                onChange={() => setPageRange(null)}
                className="accent-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('selector.pageRangeAll')}</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="pageRangeMode"
                checked={pageRange !== null}
                onChange={() => setPageRange({ start: 1, end: pageCount })}
                className="accent-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('selector.pageRangeCustom')}</span>
            </label>
            {pageRange !== null && (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={pageRange.start}
                  aria-label={t('selector.pageRangeAria')}
                  onChange={(e) => updateRange({ start: e.target.valueAsNumber })}
                  className="w-16 px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
                <span className="text-sm text-gray-500 dark:text-gray-400">~</span>
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={pageRange.end}
                  aria-label={t('selector.pageRangeAriaEnd')}
                  onChange={(e) => updateRange({ end: e.target.valueAsNumber })}
                  className="w-16 px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
                <span className="text-xs text-gray-600 dark:text-gray-400">{t('selector.pageRangeTotal', { count: pageCount })}</span>
              </span>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-4">
        <span className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.summaryLang')}</span>
        <select
          value={lang}
          aria-label={t('selector.summaryLang')}
          onChange={(e) => {
            // store 에서 최신 settings 를 직접 읽어 다른 컴포넌트(SettingsPanel)가
            // 동시에 저장한 변경을 덮어쓰지 않도록 한다. rendered closure 의 settings 는
            // 리렌더 이전 snapshot 일 수 있어 stale 필드로 concurrent update 를 롤백하는
            // 데이터 손실이 발생할 수 있음.
            const latest = useAppStore.getState().settings;
            const value = e.target.value as typeof settings.summaryLanguage;
            updateSettings({ ...latest, summaryLanguage: value });
          }}
          className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          {SUMMARY_LANGUAGES.map((l) => (
            // 'auto' 만 i18n(영어 UI 에 한글 "원문 유지" 노출 방지). 나머지는 언어명 자체라 그대로.
            <option key={l.value} value={l.value}>{l.value === 'auto' ? t('selector.langAuto') : l.label}</option>
          ))}
        </select>
      </div>
      {showModelWarning && (
        <div className="max-w-sm px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-400">
          {t('selector.modelWarning', { model: settings.model })}
        </div>
      )}
    </div>
  );
}

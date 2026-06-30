import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import type { DefaultSummaryType } from '../types';
import { SUMMARY_LANGUAGES } from '../types';

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

  const options: { value: DefaultSummaryType; label: string }[] = [
    { value: 'full', label: t('selector.full') },
    { value: 'chapter', label: t('selector.chapter') },
    { value: 'keywords', label: t('selector.keywords') },
  ];

  const lang = settings.summaryLanguage || 'ko';
  const modelBase = settings.model.split(':')[0] ?? '';
  const isKoreanOnlyModel = settings.provider === 'ollama'
    && KOREAN_ONLY_MODELS.some((m) => modelBase.startsWith(m));
  const showModelWarning = lang !== 'ko' && isKoreanOnlyModel;

  return (
    <div className="inline-flex flex-col items-start gap-3">
      <div className="flex items-center gap-4">
        <span className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.summaryType')}</span>
        <div className="flex gap-3">
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
          <span className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.pageRange')}</span>
          <div className="flex items-center gap-3 flex-wrap">
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

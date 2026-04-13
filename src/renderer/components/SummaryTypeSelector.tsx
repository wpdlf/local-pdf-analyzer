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
  const t = useT();

  const options: { value: DefaultSummaryType; label: string }[] = [
    { value: 'full', label: t('selector.full') },
    { value: 'chapter', label: t('selector.chapter') },
    { value: 'keywords', label: t('selector.keywords') },
  ];

  const lang = settings.summaryLanguage || 'ko';
  const modelBase = settings.model.split(':')[0];
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
      <div className="flex items-center gap-4">
        <span className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-600 dark:text-gray-300">{t('selector.summaryLang')}</span>
        <select
          value={lang}
          onChange={(e) => updateSettings({ ...settings, summaryLanguage: e.target.value as typeof settings.summaryLanguage })}
          className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          {SUMMARY_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
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

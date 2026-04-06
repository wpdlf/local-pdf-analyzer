import { useAppStore } from '../lib/store';
import type { SummaryType } from '../types';
import { SUMMARY_LANGUAGES } from '../types';

const options: { value: SummaryType; label: string }[] = [
  { value: 'full', label: '전체 요약' },
  { value: 'chapter', label: '챕터별' },
  { value: 'keywords', label: '키워드 추출' },
];

// 한국어 특화 모델 — 다른 언어 출력 시 품질이 낮을 수 있음
const KOREAN_ONLY_MODELS = ['exaone'];

export function SummaryTypeSelector() {
  const summaryType = useAppStore((s) => s.summaryType);
  const setSummaryType = useAppStore((s) => s.setSummaryType);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const lang = settings.summaryLanguage || 'ko';
  const modelBase = settings.model.split(':')[0];
  const isKoreanOnlyModel = settings.provider === 'ollama'
    && KOREAN_ONLY_MODELS.some((m) => modelBase.startsWith(m));
  const showModelWarning = lang !== 'ko' && isKoreanOnlyModel;

  return (
    <div className="inline-flex flex-col items-start gap-3">
      <div className="flex items-center gap-4">
        <span className="w-16 shrink-0 text-sm font-medium text-gray-600 dark:text-gray-300">요약 유형</span>
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
        <span className="w-16 shrink-0 text-sm font-medium text-gray-600 dark:text-gray-300">요약 언어</span>
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
          {settings.model}은 한국어 특화 모델이라 다른 언어 출력이 제한적입니다.
          설정에서 gemma3 또는 qwen2.5로 변경하면 더 나은 결과를 얻을 수 있습니다.
        </div>
      )}
    </div>
  );
}

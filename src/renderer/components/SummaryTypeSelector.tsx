import { useAppStore } from '../lib/store';
import type { SummaryType } from '../types';

const options: { value: SummaryType; label: string }[] = [
  { value: 'full', label: '전체 요약' },
  { value: 'chapter', label: '챕터별' },
  { value: 'keywords', label: '키워드 추출' },
];

export function SummaryTypeSelector() {
  const summaryType = useAppStore((s) => s.summaryType);
  const setSummaryType = useAppStore((s) => s.setSummaryType);

  return (
    <div className="flex items-center gap-4">
      <span className="text-sm font-medium text-gray-600 dark:text-gray-300">요약 유형:</span>
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
  );
}

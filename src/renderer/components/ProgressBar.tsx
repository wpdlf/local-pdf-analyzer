interface ProgressBarProps {
  progress: number;
  label?: string;
}

export function ProgressBar({ progress, label }: ProgressBarProps) {
  const safeProgress = Math.min(100, Math.max(0, progress || 0));
  return (
    <div className="px-4 py-2">
      <div
        className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2"
        role="progressbar"
        aria-valuenow={Math.round(safeProgress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || '요약 생성 진행률'}
      >
        <div
          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
          style={{ width: `${safeProgress}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1 text-center">
        {label || `${Math.round(safeProgress)}% 처리 중...`}
      </p>
    </div>
  );
}

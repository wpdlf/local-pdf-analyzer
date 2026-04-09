import type { ProgressInfo } from '../types';
import { t } from '../lib/i18n';

interface ProgressBarProps {
  progress: number;
  progressInfo?: ProgressInfo | null;
  label?: string;
}

function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return t('progress.seconds', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0
    ? t('progress.minutes', { m: minutes, s: remaining })
    : t('progress.minutesOnly', { m: minutes });
}

function getPhaseLabel(info: ProgressInfo): string {
  switch (info.phase) {
    case 'image':
      return t('progress.imagePhase');
    case 'integrate':
      return t('progress.integratePhase');
    case 'summarize':
      if (info.chapterName) {
        return t('progress.chapterPhase', { current: info.current, total: info.total, name: info.chapterName });
      }
      return info.total > 1
        ? t('progress.sectionPhase', { current: info.current, total: info.total })
        : t('progress.summarizing');
  }
}

export function ProgressBar({ progress, progressInfo, label }: ProgressBarProps) {
  const safeProgress = Math.min(100, Math.max(0, progress || 0));

  const displayLabel = label || (progressInfo ? getPhaseLabel(progressInfo) : t('progress.processing', { percent: Math.round(safeProgress) }));
  const timeLabel = progressInfo?.estimatedRemainingMs && progressInfo.estimatedRemainingMs > 2000
    ? t('progress.remaining', { time: formatTime(progressInfo.estimatedRemainingMs) })
    : progressInfo && progressInfo.elapsedMs > 3000
      ? t('progress.elapsed', { time: formatTime(progressInfo.elapsedMs) })
      : null;

  return (
    <div className="px-4 py-2">
      <div
        className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2"
        role="progressbar"
        aria-valuenow={Math.round(safeProgress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={displayLabel}
      >
        <div
          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
          style={{ width: `${safeProgress}%` }}
        />
      </div>
      <div className="flex justify-between items-center mt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {displayLabel}
        </p>
        {timeLabel && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {timeLabel}
          </p>
        )}
      </div>
    </div>
  );
}

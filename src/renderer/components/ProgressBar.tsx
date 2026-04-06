import type { ProgressInfo } from '../types';

interface ProgressBarProps {
  progress: number;
  progressInfo?: ProgressInfo | null;
  label?: string;
}

function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}분 ${remaining}초` : `${minutes}분`;
}

function getPhaseLabel(info: ProgressInfo): string {
  switch (info.phase) {
    case 'image':
      return '이미지 분석 중';
    case 'integrate':
      return '통합 요약 생성 중';
    case 'summarize':
      if (info.chapterName) {
        return `${info.current}/${info.total} 섹션 — ${info.chapterName}`;
      }
      return info.total > 1
        ? `${info.current}/${info.total} 섹션 처리 중`
        : '요약 생성 중';
  }
}

export function ProgressBar({ progress, progressInfo, label }: ProgressBarProps) {
  const safeProgress = Math.min(100, Math.max(0, progress || 0));

  const displayLabel = label || (progressInfo ? getPhaseLabel(progressInfo) : `${Math.round(safeProgress)}% 처리 중...`);
  const timeLabel = progressInfo?.estimatedRemainingMs && progressInfo.estimatedRemainingMs > 2000
    ? `약 ${formatTime(progressInfo.estimatedRemainingMs)} 남음`
    : progressInfo && progressInfo.elapsedMs > 3000
      ? `${formatTime(progressInfo.elapsedMs)} 경과`
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

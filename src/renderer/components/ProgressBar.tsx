import type { ProgressInfo } from '../types';
import { useT } from '../lib/i18n';

interface ProgressBarProps {
  progress: number;
  progressInfo?: ProgressInfo | null;
  label?: string;
}

// R28 P2 (v0.18.12): translator 함수를 인자로 받도록 변경.
// 이전 구현은 모듈 레벨 `t()` (store 비구독) 를 사용해, 사용자가 진행 중에 언어를 전환하면
// ProgressBar 가 다음 progress 업데이트가 발생할 때까지 stale 한 라벨을 표시했다.
// `useT()` 가 store 를 구독하므로 컴포넌트는 언어 변경 시 즉시 재렌더된다.
type Translator = ReturnType<typeof useT>;

function formatTime(ms: number, tr: Translator): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return tr('progress.seconds', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0
    ? tr('progress.minutes', { m: minutes, s: remaining })
    : tr('progress.minutesOnly', { m: minutes });
}

function getPhaseLabel(info: ProgressInfo, tr: Translator): string {
  switch (info.phase) {
    case 'image':
      return tr('progress.imagePhase');
    case 'integrate':
      return tr('progress.integratePhase');
    case 'summarize':
      if (info.chapterName) {
        return tr('progress.chapterPhase', { current: info.current, total: info.total, name: info.chapterName });
      }
      return info.total > 1
        ? tr('progress.sectionPhase', { current: info.current, total: info.total })
        : tr('progress.summarizing');
  }
}

export function ProgressBar({ progress, progressInfo, label }: ProgressBarProps) {
  const tr = useT();
  const safeProgress = Math.min(100, Math.max(0, progress || 0));

  const displayLabel = label || (progressInfo ? getPhaseLabel(progressInfo, tr) : tr('progress.processing', { percent: Math.round(safeProgress) }));
  const timeLabel = progressInfo?.estimatedRemainingMs && progressInfo.estimatedRemainingMs > 2000
    ? tr('progress.remaining', { time: formatTime(progressInfo.estimatedRemainingMs, tr) })
    : progressInfo && progressInfo.elapsedMs > 3000
      ? tr('progress.elapsed', { time: formatTime(progressInfo.elapsedMs, tr) })
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
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {timeLabel}
          </p>
        )}
      </div>
    </div>
  );
}

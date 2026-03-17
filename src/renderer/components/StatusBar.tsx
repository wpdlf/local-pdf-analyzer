import { useAppStore } from '../lib/store';

export function StatusBar() {
  const { ollamaStatus, settings } = useAppStore();

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 text-sm">
      <div className="flex items-center gap-2">
        <span>Ollama:</span>
        {ollamaStatus.running ? (
          <span className="text-green-600 dark:text-green-400">
            ✅ Running ({settings.model})
          </span>
        ) : ollamaStatus.installed ? (
          <span className="text-yellow-600 dark:text-yellow-400">⚠️ 중지됨</span>
        ) : (
          <span className="text-red-600 dark:text-red-400">❌ 미설치</span>
        )}
      </div>
      {ollamaStatus.version && (
        <span className="text-gray-400 text-xs">{ollamaStatus.version}</span>
      )}
    </div>
  );
}

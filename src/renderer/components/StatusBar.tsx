import { useAppStore } from '../lib/store';

export function StatusBar() {
  const ollamaStatus = useAppStore((s) => s.ollamaStatus);
  const settings = useAppStore((s) => s.settings);

  const providerStatus = () => {
    if (settings.provider === 'ollama') {
      if (ollamaStatus.running) {
        return <span className="text-green-600 dark:text-green-400">✅ Running ({settings.model})</span>;
      } else if (ollamaStatus.installed) {
        return <span className="text-yellow-600 dark:text-yellow-400">⚠️ 중지됨</span>;
      }
      return <span className="text-red-600 dark:text-red-400">❌ 미설치</span>;
    }
    return <span className="text-green-600 dark:text-green-400">✅ {settings.model}</span>;
  };

  const providerLabel = settings.provider === 'ollama'
    ? 'Ollama'
    : settings.provider === 'claude' ? 'Claude' : 'OpenAI';

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 text-sm">
      <div className="flex items-center gap-2">
        <span>{providerLabel}:</span>
        {providerStatus()}
      </div>
      <div className="flex items-center gap-3">
        {settings.provider === 'ollama' && ollamaStatus.version && (
          <span className="text-gray-400 text-xs">{ollamaStatus.version}</span>
        )}
        <span className="text-gray-400 text-xs">copyright 2026. JJW.</span>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';

export function SettingsPanel() {
  const { settings, updateSettings, ollamaStatus, setOllamaStatus, setView } = useAppStore();
  const [models, setModels] = useState<string[]>(ollamaStatus.models);
  const [pullModelName, setPullModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);

  useEffect(() => {
    window.electronAPI.ollama.listModels().then(setModels);
  }, []);

  const handlePullModel = async () => {
    if (!pullModelName.trim()) return;
    setIsPulling(true);
    const result = await window.electronAPI.ollama.pullModel(pullModelName.trim());
    setIsPulling(false);
    if (result.success) {
      const updated = await window.electronAPI.ollama.listModels();
      setModels(updated);
      setPullModelName('');
    }
  };

  const handleRestartOllama = async () => {
    await window.electronAPI.ollama.stop();
    await window.electronAPI.ollama.start();
    const status = await window.electronAPI.ollama.getStatus();
    setOllamaStatus(status);
  };

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white">설정</h2>
        <button
          onClick={() => setView('main')}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          ✕ 닫기
        </button>
      </div>

      {/* AI 모델 설정 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">AI 모델 설정</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Provider</label>
            <select
              value={settings.provider}
              onChange={(e) => updateSettings({ provider: e.target.value as 'ollama' | 'claude' | 'openai' })}
              className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              <option value="ollama">Ollama (로컬)</option>
              <option value="claude" disabled>Claude API (추후 지원)</option>
              <option value="openai" disabled>OpenAI API (추후 지원)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Model</label>
            <select
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Ollama URL</label>
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              onChange={(e) => updateSettings({ ollamaBaseUrl: e.target.value })}
              className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
        </div>
      </section>

      {/* Ollama 관리 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">Ollama 관리</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          상태: {ollamaStatus.running ? '✅ Running' : '⚠️ 중지됨'}
          {ollamaStatus.version && ` (${ollamaStatus.version})`}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          설치된 모델: {models.join(', ') || '없음'}
        </p>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            placeholder="모델명 (예: phi3)"
            value={pullModelName}
            onChange={(e) => setPullModelName(e.target.value)}
            className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
          <button
            onClick={handlePullModel}
            disabled={isPulling}
            className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            {isPulling ? '다운로드 중...' : '모델 추가'}
          </button>
        </div>
        <button
          onClick={handleRestartOllama}
          className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        >
          Ollama 재시작
        </button>
      </section>

      {/* 테마 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">테마</h3>
        <div className="flex gap-4">
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <label key={theme} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="theme"
                checked={settings.theme === theme}
                onChange={() => updateSettings({ theme })}
                className="accent-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">
                {theme === 'light' ? '라이트' : theme === 'dark' ? '다크' : '시스템'}
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 청크 크기 */}
      <section className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">청크 크기</h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={settings.maxChunkSize}
            onChange={(e) => updateSettings({ maxChunkSize: Number(e.target.value) })}
            min={1000}
            max={16000}
            step={500}
            className="w-24 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
          <span className="text-sm text-gray-500">tokens</span>
        </div>
      </section>
    </div>
  );
}

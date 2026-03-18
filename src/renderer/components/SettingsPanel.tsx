import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import type { AppSettings } from '../types';

export function SettingsPanel() {
  const { settings, updateSettings, ollamaStatus, setOllamaStatus, setView } = useAppStore();

  // 로컬 편집용 복사본 (저장 전까지 store에 반영하지 않음)
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [models, setModels] = useState<string[]>(ollamaStatus.models);
  const [pullModelName, setPullModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);
  const [saved, setSaved] = useState(false);

  // 설정이 변경되었는지 확인
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(settings);

  useEffect(() => {
    window.electronAPI.ollama.listModels().then(setModels);
  }, []);

  // 테마는 미리보기로 즉시 적용
  useEffect(() => {
    const root = window.document.documentElement;
    if (draft.theme === 'dark') {
      root.classList.add('dark');
    } else if (draft.theme === 'light') {
      root.classList.remove('dark');
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      root.classList.toggle('dark', mq.matches);
    }
  }, [draft.theme]);

  const updateDraft = (partial: Partial<AppSettings>) => {
    setDraft((prev) => ({ ...prev, ...partial }));
    setSaved(false);
  };

  const handleSave = () => {
    updateSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleCancel = () => {
    // 테마 미리보기 되돌리기
    const root = window.document.documentElement;
    if (settings.theme === 'dark') {
      root.classList.add('dark');
    } else if (settings.theme === 'light') {
      root.classList.remove('dark');
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      root.classList.toggle('dark', mq.matches);
    }
    setView('main');
  };

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
          onClick={handleCancel}
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
              value={draft.provider}
              onChange={(e) => updateDraft({ provider: e.target.value as 'ollama' | 'claude' | 'openai' })}
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
              value={draft.model}
              onChange={(e) => updateDraft({ model: e.target.value })}
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
              value={draft.ollamaBaseUrl}
              onChange={(e) => updateDraft({ ollamaBaseUrl: e.target.value })}
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
                checked={draft.theme === theme}
                onChange={() => updateDraft({ theme })}
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
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">청크 크기</h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={draft.maxChunkSize}
            onChange={(e) => updateDraft({ maxChunkSize: Number(e.target.value) })}
            min={1000}
            max={16000}
            step={500}
            className="w-24 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
          <span className="text-sm text-gray-500">tokens</span>
        </div>
      </section>

      {/* 저장 버튼 */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!hasChanges && !saved}
          className={`flex-1 py-2.5 rounded-lg font-medium transition-colors ${
            saved
              ? 'bg-green-500 text-white'
              : hasChanges
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed'
          }`}
        >
          {saved ? '✅ 저장되었습니다' : hasChanges ? '설정 저장' : '변경 사항 없음'}
        </button>
      </div>
    </div>
  );
}

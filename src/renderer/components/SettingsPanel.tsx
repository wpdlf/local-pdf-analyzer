import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import type { AppSettings, AiProviderType } from '../types';
import { PROVIDER_MODELS } from '../types';

export function SettingsPanel() {
  const { settings, updateSettings, ollamaStatus, setOllamaStatus, setView } = useAppStore();

  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [ollamaModels, setOllamaModels] = useState<string[]>(ollamaStatus.models);
  const [pullModelName, setPullModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState('');
  const [saved, setSaved] = useState(false);

  // API 키 관련 상태
  const [claudeKey, setClaudeKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [claudeKeyStored, setClaudeKeyStored] = useState(false);
  const [openaiKeyStored, setOpenaiKeyStored] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');

  // keyMessage 자동 해제 (cleanup 포함)
  useEffect(() => {
    if (!keyMessage) return;
    const timer = setTimeout(() => setKeyMessage(''), 2000);
    return () => clearTimeout(timer);
  }, [keyMessage]);

  // saved 자동 해제 (cleanup 포함)
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(settings);

  useEffect(() => {
    window.electronAPI.ollama.listModels().then(setOllamaModels);
    // 저장된 API 키 존재 여부 확인 (키 자체는 반환하지 않음)
    window.electronAPI.apiKey.has('claude').then(setClaudeKeyStored);
    window.electronAPI.apiKey.has('openai').then(setOpenaiKeyStored);
  }, []);

  // 테마 미리보기
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

  // Provider 변경 시 모델 자동 선택 (ollamaModels 변경 시에는 리셋하지 않음)
  const prevProviderRef = useRef(draft.provider);
  useEffect(() => {
    const providerChanged = prevProviderRef.current !== draft.provider;
    prevProviderRef.current = draft.provider;
    if (!providerChanged) return;

    if (draft.provider === 'claude') {
      setDraft((d) => ({ ...d, model: PROVIDER_MODELS.claude[0].value }));
    } else if (draft.provider === 'openai') {
      setDraft((d) => ({ ...d, model: PROVIDER_MODELS.openai[0].value }));
    } else if (draft.provider === 'ollama' && ollamaModels.length > 0) {
      setDraft((d) => ({ ...d, model: ollamaModels[0] }));
    }
  }, [draft.provider, ollamaModels]);

  const updateDraft = (partial: Partial<AppSettings>) => {
    setDraft((prev) => ({ ...prev, ...partial }));
    setSaved(false);
  };

  const handleSaveApiKey = async (provider: 'claude' | 'openai') => {
    const key = provider === 'claude' ? claudeKey : openaiKey;
    if (!key.trim()) return;
    await window.electronAPI.apiKey.save(provider, key.trim());
    if (provider === 'claude') {
      setClaudeKeyStored(true);
      setClaudeKey('');
    } else {
      setOpenaiKeyStored(true);
      setOpenaiKey('');
    }
    setKeyMessage(`${provider === 'claude' ? 'Claude' : 'OpenAI'} API 키가 저장되었습니다.`);
  };

  const handleDeleteApiKey = async (provider: 'claude' | 'openai') => {
    await window.electronAPI.apiKey.delete(provider);
    if (provider === 'claude') {
      setClaudeKeyStored(false);
      // provider가 claude였으면 ollama로 전환
      if (draft.provider === 'claude') updateDraft({ provider: 'ollama' });
    } else {
      setOpenaiKeyStored(false);
      if (draft.provider === 'openai') updateDraft({ provider: 'ollama' });
    }
    setKeyMessage('API 키가 삭제되었습니다.');
  };

  const handleSave = async () => {
    // provider가 API 키 필요한 경우 키 존재 확인
    if (draft.provider === 'claude' && !claudeKeyStored) {
      setKeyMessage('Claude API 키를 먼저 저장해주세요.');
      return;
    }
    if (draft.provider === 'openai' && !openaiKeyStored) {
      setKeyMessage('OpenAI API 키를 먼저 저장해주세요.');
      return;
    }

    // API 키는 Main 프로세스에서만 관리 — store에는 provider/model 등만 저장
    updateSettings(draft);
    setSaved(true);
  };

  const handleCancel = () => {
    const root = window.document.documentElement;
    if (settings.theme === 'dark') root.classList.add('dark');
    else if (settings.theme === 'light') root.classList.remove('dark');
    else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      root.classList.toggle('dark', mq.matches);
    }
    setView('main');
  };

  const handlePullModel = async () => {
    if (!pullModelName.trim()) return;
    setIsPulling(true);
    setPullProgress('다운로드 준비 중...');
    const unsubscribe = window.electronAPI.onSetupProgress((message) => {
      setPullProgress(message);
    });
    try {
      const result = await window.electronAPI.ollama.pullModel(pullModelName.trim());
      if (result.success) {
        const updated = await window.electronAPI.ollama.listModels();
        setOllamaModels(updated);
        setPullModelName('');
        setPullProgress('');
      } else {
        setPullProgress(result.error || '다운로드 실패');
      }
    } finally {
      unsubscribe();
      setIsPulling(false);
    }
  };

  const handleRestartOllama = async () => {
    await window.electronAPI.ollama.stop();
    await window.electronAPI.ollama.start();
    const status = await window.electronAPI.ollama.getStatus();
    setOllamaStatus(status);
  };

  // 현재 provider에 맞는 모델 목록
  const modelOptions = (() => {
    if (draft.provider !== 'ollama') return PROVIDER_MODELS[draft.provider];
    const models = ollamaModels.map((m) => ({ label: m, value: m }));
    // 현재 선택된 모델이 목록에 없으면 추가
    if (draft.model && !ollamaModels.includes(draft.model)) {
      models.unshift({ label: `${draft.model} (미설치)`, value: draft.model });
    }
    return models;
  })();

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white">설정</h2>
        <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          ✕ 닫기
        </button>
      </div>

      {/* 메시지 */}
      {keyMessage && (
        <div className="mb-4 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-700 dark:text-blue-400 text-center">
          {keyMessage}
        </div>
      )}

      {/* AI Provider 선택 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">AI Provider</h3>
        <div className="space-y-2">
          {([
            { value: 'ollama' as AiProviderType, label: 'Ollama (로컬, 무료)', desc: '인터넷 불필요, 개인 자료 보안' },
            { value: 'claude' as AiProviderType, label: 'Claude API', desc: '높은 요약 품질, API 키 필요 (유료)' },
            { value: 'openai' as AiProviderType, label: 'OpenAI API', desc: 'GPT-4o 기반 요약, API 키 필요 (유료)' },
          ]).map((opt) => {
            const needsKey = opt.value !== 'ollama';
            const hasKey = opt.value === 'claude' ? claudeKeyStored : opt.value === 'openai' ? openaiKeyStored : true;
            return (
              <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                draft.provider === opt.value
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}>
                <input
                  type="radio"
                  name="provider"
                  checked={draft.provider === opt.value}
                  onChange={() => updateDraft({ provider: opt.value })}
                  className="accent-blue-500 mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{opt.label}</span>
                  {needsKey && !hasKey && (
                    <span className="ml-2 text-xs text-orange-500">아래에서 API 키를 입력하세요</span>
                  )}
                  {needsKey && hasKey && (
                    <span className="ml-2 text-xs text-green-500">키 등록됨</span>
                  )}
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* 모델 선택 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">모델</h3>
        <select
          value={draft.model}
          onChange={(e) => updateDraft({ model: e.target.value })}
          className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          {modelOptions.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {draft.provider !== 'ollama' && (
          <p className="text-xs text-gray-500 mt-2">
            API 사용량에 따라 요금이 부과됩니다.
          </p>
        )}
        {draft.provider === 'ollama' && ollamaModels.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            Ollama에 설치된 모델이 없습니다. 아래에서 모델을 추가해주세요.
          </p>
        )}
        {draft.provider === 'ollama' && ollamaModels.length > 0 && (
          <p className="text-xs text-gray-500 mt-2">
            한국어 요약에는 gemma3, qwen2.5 모델을 권장합니다.
          </p>
        )}
      </section>

      {/* API 키 관리 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">API 키 관리</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">API 키는 암호화되어 로컬에 저장됩니다.</p>

        {/* Claude API Key */}
        <div className="mb-4">
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Claude API 키 {claudeKeyStored && <span className="text-green-500 ml-1">저장됨</span>}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder={claudeKeyStored ? '••••••••••••' : 'sk-ant-...'}
              value={claudeKey}
              onChange={(e) => setClaudeKey(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
            {claudeKey ? (
              <button onClick={() => handleSaveApiKey('claude')} className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">
                저장
              </button>
            ) : claudeKeyStored ? (
              <button onClick={() => handleDeleteApiKey('claude')} className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors">
                삭제
              </button>
            ) : null}
          </div>
        </div>

        {/* OpenAI API Key */}
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            OpenAI API 키 {openaiKeyStored && <span className="text-green-500 ml-1">저장됨</span>}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder={openaiKeyStored ? '••••••••••••' : 'sk-...'}
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
            {openaiKey ? (
              <button onClick={() => handleSaveApiKey('openai')} className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">
                저장
              </button>
            ) : openaiKeyStored ? (
              <button onClick={() => handleDeleteApiKey('openai')} className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors">
                삭제
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/* Ollama 관리 (Ollama 선택 시에만) */}
      {draft.provider === 'ollama' && (
        <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">Ollama 관리</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            상태: {ollamaStatus.running ? '✅ Running' : '⚠️ 중지됨'}
            {ollamaStatus.version && ` (${ollamaStatus.version})`}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            설치된 모델: {ollamaModels.join(', ') || '없음'}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">추천 모델 (클릭하여 설치):</p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[
              { name: 'gemma3', desc: '한국어 우수' },
              { name: 'qwen2.5', desc: '다국어 강점' },
              { name: 'exaone3.5', desc: '한국어 특화' },
              { name: 'llama3.2', desc: '범용 경량' },
              { name: 'phi3', desc: '초경량' },
            ].filter((m) => !ollamaModels.some((om) => om.startsWith(m.name))).map((m) => (
              <button
                key={m.name}
                onClick={() => { setPullModelName(m.name); }}
                disabled={isPulling}
                className="px-2 py-1 text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors"
              >
                {m.name} <span className="text-gray-400">({m.desc})</span>
              </button>
            ))}
          </div>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              placeholder="모델명 (예: gemma3)"
              value={pullModelName}
              onChange={(e) => setPullModelName(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
            <button
              onClick={handlePullModel}
              disabled={isPulling || !pullModelName.trim()}
              className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
            >
              {isPulling ? '다운로드 중...' : '모델 추가'}
            </button>
          </div>
          {isPulling && pullProgress && (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <svg className="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-xs text-blue-600 dark:text-blue-400 truncate">{pullProgress}</p>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={handleRestartOllama} className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">
              Ollama 재시작
            </button>
          </div>
          <div className="mt-3">
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Ollama URL</label>
            <input
              type="text"
              value={draft.ollamaBaseUrl}
              onChange={(e) => updateDraft({ ollamaBaseUrl: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
        </section>
      )}

      {/* 테마 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">테마</h3>
        <div className="flex gap-4">
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <label key={theme} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="theme" checked={draft.theme === theme} onChange={() => updateDraft({ theme })} className="accent-blue-500" />
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
            min={1000} max={16000} step={500}
            className="w-24 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
          <span className="text-sm text-gray-500">tokens</span>
        </div>
      </section>

      {/* 이미지 분석 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">이미지 분석</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.enableImageAnalysis}
            onChange={(e) => updateDraft({ enableImageAnalysis: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm text-gray-700 dark:text-gray-200">PDF 이미지 자동 분석</span>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              Vision 지원 모델 필요 (llava, Claude, GPT-4o 등)
            </p>
          </div>
        </label>
      </section>

      {/* 저장 버튼 */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!hasChanges && !saved}
          className={`flex-1 py-2.5 rounded-lg font-medium transition-colors ${
            saved ? 'bg-green-500 text-white'
              : hasChanges ? 'bg-blue-500 text-white hover:bg-blue-600'
              : 'bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed'
          }`}
        >
          {saved ? '✅ 저장되었습니다' : hasChanges ? '설정 저장' : '변경 사항 없음'}
        </button>
      </div>
    </div>
  );
}

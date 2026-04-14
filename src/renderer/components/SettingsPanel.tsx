import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import type { AppSettings, AiProviderType } from '../types';
import { PROVIDER_MODELS, UI_LANGUAGES, DEFAULT_SETTINGS } from '../types';
import { applyTheme } from '../lib/theme';

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const ollamaStatus = useAppStore((s) => s.ollamaStatus);
  const setOllamaStatus = useAppStore((s) => s.setOllamaStatus);
  const setView = useAppStore((s) => s.setView);
  const setError = useAppStore((s) => s.setError);
  const t = useT();

  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  // 사용자가 직접 편집했는지 추적 — 외부(store) 변경을 draft에 반영할 때 in-progress 편집 보호용.
  const userEditedRef = useRef(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>(ollamaStatus.models);
  const [pullModelName, setPullModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState('');
  const pullUnsubRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const [saved, setSaved] = useState(false);

  const [claudeKey, setClaudeKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [claudeKeyStored, setClaudeKeyStored] = useState(false);
  const [openaiKeyStored, setOpenaiKeyStored] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  // 청크 크기는 로컬 string state 로 관리 — 한 글자씩 타이핑 중 범위 벗어난 중간값 허용.
  // onChange 에서 즉시 거부하면 "2000" 타이핑 중 "2" 가 거부되어 입력 불가. blur 시 clamp + 커밋.
  const [chunkSizeInput, setChunkSizeInput] = useState(String(draft.maxChunkSize));
  const [chunkSizeError, setChunkSizeError] = useState(false);

  useEffect(() => {
    if (!keyMessage) return;
    const timer = setTimeout(() => setKeyMessage(''), 2000);
    return () => clearTimeout(timer);
  }, [keyMessage]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  // draft와 settings 양쪽 키를 모두 비교 — 새 설정 키가 나중에 추가되어도 포착.
  const hasChanges = (() => {
    const allKeys = new Set<keyof AppSettings>([
      ...(Object.keys(draft) as (keyof AppSettings)[]),
      ...(Object.keys(settings) as (keyof AppSettings)[]),
    ]);
    for (const key of allKeys) {
      if (draft[key] !== settings[key]) return true;
    }
    return false;
  })();

  // settings가 외부(loadSettings 지연 완료, 다른 컴포넌트의 저장)에서 변경된 경우,
  // 사용자가 편집하지 않은 상태라면 draft를 새 settings로 동기화.
  // 사용자 편집 중이라면 덮어쓰지 않고 유지 (데이터 손실 방지).
  useEffect(() => {
    if (!userEditedRef.current) {
      setDraft({ ...settings });
      setChunkSizeInput(String(settings.maxChunkSize));
    }
  }, [settings]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      pullUnsubRef.current?.();
    };
  }, []);

  useEffect(() => {
    // mountedRef 체크 — 사용자가 결과 도착 전 설정 패널을 닫으면 unmounted setState 방지
    window.electronAPI.ollama.listModels()
      .then((models) => { if (mountedRef.current) setOllamaModels(models); })
      .catch(() => {});
    window.electronAPI.apiKey.has('claude')
      .then((has) => { if (mountedRef.current) setClaudeKeyStored(has); })
      .catch(() => {});
    window.electronAPI.apiKey.has('openai')
      .then((has) => { if (mountedRef.current) setOpenaiKeyStored(has); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return applyTheme(draft.theme);
  }, [draft.theme]);

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
    userEditedRef.current = true;
  };

  const handleSaveApiKey = async (provider: 'claude' | 'openai') => {
    const key = provider === 'claude' ? claudeKey : openaiKey;
    if (!key.trim()) {
      // 공백만 입력한 경우 무음 실패 대신 명시적 피드백 — 사용자가 "저장" 버튼 반응 없음으로 혼란
      setKeyMessage(t('settings.keyEmpty'));
      return;
    }
    try {
      const result = await window.electronAPI.apiKey.save(provider, key.trim());
      if (!result.success) {
        // Main이 구조화된 에러 반환 (예: safeStorage 불가)
        setKeyMessage(result.error || t('settings.keySaveFail'));
        return;
      }
      if (provider === 'claude') {
        setClaudeKeyStored(true);
        setClaudeKey('');
      } else {
        setOpenaiKeyStored(true);
        setOpenaiKey('');
      }
      setKeyMessage(t('settings.keySaved', { provider: provider === 'claude' ? 'Claude' : 'OpenAI' }));
    } catch {
      setKeyMessage(t('settings.keySaveFail'));
    }
  };

  const handleDeleteApiKey = async (provider: 'claude' | 'openai') => {
    try {
      const result = await window.electronAPI.apiKey.delete(provider);
      if (!result.success) {
        setKeyMessage(result.error || t('settings.keyDeleteFail'));
        return;
      }
      // 키 삭제 후 해당 provider 가 선택되어 있으면 Ollama 로 강제 전환 + 모델 명시 리셋.
      // provider-change 훅은 ollamaModels 가 비어 있으면 모델을 건드리지 않기 때문에
      // Claude/OpenAI 모델 id 가 draft 에 남아 저장 시 "Ollama + claude-sonnet-4" 같은
      // 잘못된 조합이 StatusBar/AI client 로 전파되는 문제를 사전에 방지.
      const needsProviderFlip =
        (provider === 'claude' && draft.provider === 'claude') ||
        (provider === 'openai' && draft.provider === 'openai');
      if (provider === 'claude') {
        setClaudeKeyStored(false);
      } else {
        setOpenaiKeyStored(false);
      }
      if (needsProviderFlip) {
        const fallbackModel = ollamaModels.length > 0 ? ollamaModels[0] : DEFAULT_SETTINGS.model;
        updateDraft({ provider: 'ollama', model: fallbackModel });
      }
      setKeyMessage(t('settings.keyDeleted'));
    } catch {
      setKeyMessage(t('settings.keyDeleteFail'));
    }
  };

  const handleSave = async () => {
    if (draft.provider === 'claude' && !claudeKeyStored) {
      setKeyMessage(t('settings.saveKeyFirst', { provider: 'Claude' }));
      return;
    }
    if (draft.provider === 'openai' && !openaiKeyStored) {
      setKeyMessage(t('settings.saveKeyFirst', { provider: 'OpenAI' }));
      return;
    }
    updateSettings(draft);
    setSaved(true);
    // 저장 후 편집 플래그 해제 — 이후의 외부 변경은 draft에 재동기화됨.
    userEditedRef.current = false;
  };

  const handleCancel = () => {
    // draft.theme가 settings.theme와 다르면 동기적으로 저장된 테마를 직접 적용.
    // setDraft + setView('main')으로는 언마운트 중 새 useEffect가 실행되지 않아
    // 프리뷰 테마가 DOM에 남는 문제 방지.
    if (draft.theme !== settings.theme) {
      applyTheme(settings.theme);
    }
    setView('main');
  };

  const handlePullModel = async () => {
    if (!pullModelName.trim()) return;
    setIsPulling(true);
    setPullProgress(t('setup.downloadReady'));
    const unsubscribe = window.electronAPI.onSetupProgress((message) => {
      if (mountedRef.current) setPullProgress(message);
    });
    pullUnsubRef.current = unsubscribe;
    try {
      const result = await window.electronAPI.ollama.pullModel(pullModelName.trim());
      if (!mountedRef.current) return;
      if (result.success) {
        const updated = await window.electronAPI.ollama.listModels();
        if (!mountedRef.current) return;
        setOllamaModels(updated);
        const status = await window.electronAPI.ollama.getStatus();
        if (!mountedRef.current) return;
        setOllamaStatus(status);
        setPullModelName('');
        setPullProgress('');
      } else {
        setPullProgress(result.error || t('setup.modelDownloadFail', { model: pullModelName }));
      }
    } finally {
      unsubscribe();
      pullUnsubRef.current = null;
      if (mountedRef.current) setIsPulling(false);
    }
  };

  const handleRestartOllama = async () => {
    try {
      await window.electronAPI.ollama.stop();
      if (!mountedRef.current) return;
      await window.electronAPI.ollama.start();
      if (!mountedRef.current) return;
      const status = await window.electronAPI.ollama.getStatus();
      if (!mountedRef.current) return;
      setOllamaStatus(status);
    } catch {
      if (!mountedRef.current) return;
      setError({ code: 'OLLAMA_NOT_RUNNING', message: t('settings.restartFail') });
    }
  };

  const modelOptions = (() => {
    if (draft.provider !== 'ollama') return PROVIDER_MODELS[draft.provider];
    const models = ollamaModels.map((m) => ({ label: m, value: m }));
    if (draft.model && !ollamaModels.includes(draft.model)) {
      models.unshift({ label: `${draft.model} (${t('settings.notInstalled')})`, value: draft.model });
    }
    return models;
  })();

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white">{t('settings.title')}</h2>
        <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          ✕ {t('common.close')}
        </button>
      </div>

      {keyMessage && (
        <div className="mb-4 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-700 dark:text-blue-400 text-center">
          {keyMessage}
        </div>
      )}

      {/* AI Provider */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.provider')}</h3>
        <div className="space-y-2">
          {([
            { value: 'ollama' as AiProviderType, label: t('settings.ollamaLabel'), desc: t('settings.ollamaDesc') },
            { value: 'claude' as AiProviderType, label: t('settings.claudeLabel'), desc: t('settings.claudeDesc') },
            { value: 'openai' as AiProviderType, label: t('settings.openaiLabel'), desc: t('settings.openaiDesc') },
          ]).map((opt) => {
            const needsKey = opt.value !== 'ollama';
            const hasKey = opt.value === 'claude' ? claudeKeyStored : opt.value === 'openai' ? openaiKeyStored : true;
            return (
              <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                draft.provider === opt.value
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}>
                <input type="radio" name="provider" checked={draft.provider === opt.value} onChange={() => updateDraft({ provider: opt.value })} className="accent-blue-500 mt-0.5" />
                <div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{opt.label}</span>
                  {needsKey && !hasKey && <span className="ml-2 text-xs text-orange-500">{t('settings.enterApiKey')}</span>}
                  {needsKey && hasKey && <span className="ml-2 text-xs text-green-500">{t('settings.keyRegistered')}</span>}
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* 모델 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.model')}</h3>
        <select value={draft.model} onChange={(e) => updateDraft({ model: e.target.value })} className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white">
          {modelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {draft.provider !== 'ollama' && <p className="text-xs text-gray-500 mt-2">{t('settings.apiBilling')}</p>}
        {draft.provider === 'ollama' && ollamaModels.length === 0 && <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">{t('settings.noModels')}</p>}
        {draft.provider === 'ollama' && ollamaModels.length > 0 && <p className="text-xs text-gray-500 mt-2">{t('settings.modelRecommend')}</p>}
      </section>

      {/* API 키 관리 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.apiKeyMgmt')}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('settings.apiKeyEncrypted')}</p>

        <div className="mb-4">
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Claude API {claudeKeyStored && <span className="text-green-500 ml-1">{t('common.saved')}</span>}
          </label>
          <div className="flex gap-2">
            <input type="password" autoComplete="off" spellCheck={false} maxLength={200} placeholder={claudeKeyStored ? t('settings.apiKeyMasked') : t('settings.apiKeyPlaceholder')} value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            {claudeKey ? (
              <button onClick={() => handleSaveApiKey('claude')} className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">{t('common.save')}</button>
            ) : claudeKeyStored ? (
              <button onClick={() => handleDeleteApiKey('claude')} className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors">{t('common.delete')}</button>
            ) : null}
          </div>
        </div>

        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            OpenAI API {openaiKeyStored && <span className="text-green-500 ml-1">{t('common.saved')}</span>}
          </label>
          <div className="flex gap-2">
            <input type="password" autoComplete="off" spellCheck={false} maxLength={200} placeholder={openaiKeyStored ? t('settings.apiKeyMasked') : t('settings.apiKeyPlaceholder')} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            {openaiKey ? (
              <button onClick={() => handleSaveApiKey('openai')} className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">{t('common.save')}</button>
            ) : openaiKeyStored ? (
              <button onClick={() => handleDeleteApiKey('openai')} className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors">{t('common.delete')}</button>
            ) : null}
          </div>
        </div>
      </section>

      {/* Ollama 관리 */}
      {draft.provider === 'ollama' && (
        <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.ollamaMgmt')}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            {t('settings.ollamaStatus')}: {ollamaStatus.running ? t('settings.ollamaRunning') : t('settings.ollamaStopped')}
            {ollamaStatus.version && ` (${ollamaStatus.version})`}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            {t('settings.installedModels')}: {ollamaModels.join(', ') || t('common.none')}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('settings.recommendedModels')}</p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[
              { name: 'gemma3', desc: t('settings.koreanGood') },
              { name: 'qwen2.5', desc: t('settings.multilingual') },
              { name: 'exaone3.5', desc: t('settings.koreanSpecial') },
              { name: 'llama3.2', desc: t('settings.generalLight') },
              { name: 'phi3', desc: t('settings.ultraLight') },
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
            <input type="text" placeholder={t('settings.modelPlaceholder')} value={pullModelName} onChange={(e) => setPullModelName(e.target.value)} className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            <button onClick={handlePullModel} disabled={isPulling || !pullModelName.trim()} className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors">
              {isPulling ? t('settings.downloading') : t('settings.addModel')}
            </button>
          </div>
          {isPulling && pullProgress && (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <svg aria-hidden="true" className="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-xs text-blue-600 dark:text-blue-400 truncate">{pullProgress}</p>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={handleRestartOllama} className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">
              {t('settings.restartOllama')}
            </button>
          </div>
          <div className="mt-3">
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Ollama URL</label>
            <input type="text" value={draft.ollamaBaseUrl} onChange={(e) => updateDraft({ ollamaBaseUrl: e.target.value })} className="w-full px-3 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </div>
        </section>
      )}

      {/* 테마 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.theme')}</h3>
        <div className="flex gap-4">
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <label key={theme} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="theme" checked={draft.theme === theme} onChange={() => updateDraft({ theme })} className="accent-blue-500" />
              <span className="text-sm text-gray-700 dark:text-gray-200">
                {theme === 'light' ? t('settings.themeLight') : theme === 'dark' ? t('settings.themeDark') : t('settings.themeSystem')}
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 언어 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.language')}</h3>
        <div className="flex gap-4">
          {UI_LANGUAGES.map((lang) => (
            <label key={lang.value} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="uiLanguage" checked={draft.uiLanguage === lang.value} onChange={() => updateDraft({ uiLanguage: lang.value })} className="accent-blue-500" />
              <span className="text-sm text-gray-700 dark:text-gray-200">{lang.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* 청크 크기 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.chunkSize')}</h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={chunkSizeInput}
            onChange={(e) => {
              setChunkSizeInput(e.target.value);
              const v = Number(e.target.value);
              const valid = Number.isFinite(v) && v >= 1000 && v <= 16000;
              setChunkSizeError(!valid && e.target.value !== '');
              if (valid) updateDraft({ maxChunkSize: v });
            }}
            onBlur={(e) => {
              // blur 시 범위 바깥이면 clamp 후 commit — 사용자가 잘못된 값을 남기지 않도록 보정.
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) {
                setChunkSizeInput(String(draft.maxChunkSize));
                setChunkSizeError(false);
                return;
              }
              const clamped = Math.min(16000, Math.max(1000, Math.round(v)));
              setChunkSizeInput(String(clamped));
              setChunkSizeError(false);
              updateDraft({ maxChunkSize: clamped });
            }}
            min={1000}
            max={16000}
            step={500}
            className={`w-24 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white ${chunkSizeError ? 'border-red-500' : ''}`}
            aria-invalid={chunkSizeError}
          />
          <span className="text-sm text-gray-500">tokens</span>
          {chunkSizeError && (
            <span className="text-xs text-red-500">1000–16000</span>
          )}
        </div>
      </section>

      {/* 이미지 분석 */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.imageAnalysis')}</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={draft.enableImageAnalysis} onChange={(e) => updateDraft({ enableImageAnalysis: e.target.checked })} className="w-4 h-4 rounded" />
          <div>
            <span className="text-sm text-gray-700 dark:text-gray-200">{t('settings.imageAnalysisLabel')}</span>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{t('settings.imageAnalysisDesc')}</p>
          </div>
        </label>
      </section>

      {/* 스캔 PDF OCR */}
      <section className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <h3 className="font-medium mb-3 text-gray-700 dark:text-gray-200">{t('settings.ocrTitle')}</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={draft.enableOcrFallback} onChange={(e) => updateDraft({ enableOcrFallback: e.target.checked })} className="w-4 h-4 rounded" />
          <div>
            <span className="text-sm text-gray-700 dark:text-gray-200">{t('settings.ocrLabel')}</span>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{t('settings.ocrDesc')}</p>
          </div>
        </label>
      </section>

      {/* 저장 */}
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
          {saved ? t('settings.savedBtn') : hasChanges ? t('settings.saveBtn') : t('settings.noChanges')}
        </button>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import type { AppErrorCode } from '../types';
import { INITIAL_INSTALL_MODELS } from '../types';

type SetupStep = 'welcome' | 'progress' | 'done' | 'error';

interface SetupItem {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export function OllamaSetupWizard() {
  const setOllamaStatus = useAppStore((s) => s.setOllamaStatus);
  const setView = useAppStore((s) => s.setView);
  const setError = useAppStore((s) => s.setError);
  const t = useT();
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 사용자가 진행 중 취소를 요청하면 true. 각 await 뒤에서 체크되어 다음 단계 진입을 차단.
  // 이미 전송된 install/pullModel IPC 는 Main 에서 계속 실행되지만, UI 는 사용자를
  // 즉시 설정 화면으로 이동시켜 다른 provider 선택이 가능하도록 함.
  const cancelledRef = useRef(false);
  const [step, setStep] = useState<SetupStep>('welcome');
  const [progressMessage, setProgressMessage] = useState('');
  const [errorCode, setErrorCode] = useState<AppErrorCode | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [items, setItems] = useState<SetupItem[]>([
    { label: t('setup.ollamaCheck'), status: 'pending' },
    { label: t('setup.ollamaStart'), status: 'pending' },
    ...INITIAL_INSTALL_MODELS.map((m) => ({
      label: m === 'nomic-embed-text' ? t('setup.downloadEmbed', { model: m }) : t('setup.downloadKorean', { model: m }),
      status: 'pending' as const,
    })),
  ]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((message) => {
      if (cancelledRef.current) return;
      setProgressMessage(message);
    });
    return () => {
      unsubscribe();
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, []);

  const handleCancel = () => {
    cancelledRef.current = true;
    setProgressMessage(t('setup.cancelling'));
    // 설정 화면으로 이동 — 사용자가 다른 provider (Claude/OpenAI) 선택 가능
    setView('settings');
  };

  const updateItem = (index: number, status: SetupItem['status']) => {
    setItems((prev) => prev.map((item, i) => i === index ? { ...item, status } : item));
  };

  const handleError = (code: AppErrorCode, msg: string) => {
    setStep('error');
    setErrorCode(code);
    setErrorMsg(msg);
    setError({ code, message: msg });
  };

  const startSetup = async () => {
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = undefined; }
    cancelledRef.current = false;
    setStep('progress');
    setErrorCode(null);
    setErrorMsg('');
    setItems((prev) => prev.map((item) => ({ ...item, status: 'pending' as const })));

    try {
      updateItem(0, 'running');
      setProgressMessage(t('setup.checkingOllama'));
      const status = await window.electronAPI.ollama.getStatus();
      if (cancelledRef.current) return;

      if (!status.installed) {
        setProgressMessage(t('setup.installingOllama'));
        const installResult = await window.electronAPI.ollama.install();
        if (cancelledRef.current) return;
        if (!installResult.success) {
          updateItem(0, 'error');
          handleError('OLLAMA_INSTALL_FAIL', installResult.error || t('setup.ollamaInstallFail'));
          return;
        }
      }
      updateItem(0, 'done');

      updateItem(1, 'running');
      setProgressMessage(t('setup.startingOllama'));
      await window.electronAPI.ollama.start();
      if (cancelledRef.current) return;

      const recheckStatus = await window.electronAPI.ollama.getStatus();
      if (cancelledRef.current) return;
      if (!recheckStatus.running) {
        updateItem(1, 'error');
        handleError('OLLAMA_NOT_RUNNING', t('setup.ollamaStartFail'));
        return;
      }
      updateItem(1, 'done');

      const existingModels = await window.electronAPI.ollama.listModels();
      if (cancelledRef.current) return;

      for (let i = 0; i < INITIAL_INSTALL_MODELS.length; i++) {
        if (cancelledRef.current) return;
        const modelName = INITIAL_INSTALL_MODELS[i];
        const itemIndex = 2 + i;
        updateItem(itemIndex, 'running');

        const alreadyInstalled = existingModels.some((m) => m.startsWith(modelName));
        if (alreadyInstalled) {
          updateItem(itemIndex, 'done');
          continue;
        }

        const modelLabel = modelName === 'nomic-embed-text'
          ? t('setup.downloadingModelLabel.embed', { model: modelName })
          : t('setup.downloadingModelLabel.korean', { model: modelName });
        setProgressMessage(t('setup.downloadingModel', { label: modelLabel }));
        const pullResult = await window.electronAPI.ollama.pullModel(modelName);
        if (cancelledRef.current) return;
        if (!pullResult.success) {
          updateItem(itemIndex, 'error');
          handleError('MODEL_PULL_FAIL', pullResult.error || t('setup.modelDownloadFail', { model: modelName }));
          return;
        }
        updateItem(itemIndex, 'done');
      }

      const finalModels = await window.electronAPI.ollama.listModels();
      if (cancelledRef.current) return;
      if (finalModels.length === 0) {
        updateItem(2, 'error');
        handleError('MODEL_NOT_FOUND', t('setup.noModels'));
        return;
      }

      const finalStatus = await window.electronAPI.ollama.getStatus();
      if (cancelledRef.current) return;
      setOllamaStatus(finalStatus);
      setError(null);
      setStep('done');

      doneTimerRef.current = setTimeout(() => setView('main'), 1500);
    } catch (err) {
      if (cancelledRef.current) return;
      handleError(
        'OLLAMA_NOT_FOUND',
        err instanceof Error ? err.message : t('setup.unknownError'),
      );
    }
  };

  const errorHints: Record<string, string> = {
    OLLAMA_NOT_FOUND: t('setup.hint.notFound'),
    OLLAMA_INSTALL_FAIL: t('setup.hint.installFail'),
    OLLAMA_NOT_RUNNING: t('setup.hint.notRunning'),
    MODEL_NOT_FOUND: t('setup.hint.modelNotFound'),
    MODEL_PULL_FAIL: t('setup.hint.pullFail'),
  };

  const statusIcon = (status: SetupItem['status']) => {
    switch (status) {
      case 'pending': return '\u2B1C';
      case 'running': return '\uD83D\uDD04';
      case 'done': return '\u2705';
      case 'error': return '\u274C';
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <h1 className="text-2xl font-bold mb-6 text-gray-800 dark:text-white">
        {t('setup.title')}
      </h1>

      {step === 'welcome' && (
        <div className="text-center">
          <p className="text-gray-600 dark:text-gray-300 mb-2">{t('setup.desc')}</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">{t('setup.autoInstall')}</p>
          <div className="text-left mb-6 space-y-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
                <span>{statusIcon(item.status)}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <button onClick={startSetup} className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-lg transition-colors">
            {t('setup.start')}
          </button>
        </div>
      )}

      {step === 'progress' && (
        <div className="w-full max-w-md">
          <div className="space-y-3 mb-6">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className={item.status === 'running' ? 'animate-spin' : ''}>{statusIcon(item.status)}</span>
                <span className={`text-sm ${
                  item.status === 'running' ? 'text-blue-600 dark:text-blue-400 font-medium' :
                  item.status === 'done' ? 'text-green-600 dark:text-green-400' :
                  'text-gray-500 dark:text-gray-400'
                }`}>{item.label}</span>
              </div>
            ))}
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-sm text-center mb-4">{progressMessage}</p>
          <div className="flex justify-center">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              {t('setup.cancel')}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="text-center">
          <div className="text-4xl mb-4">{'\u2705'}</div>
          <p className="text-green-600 dark:text-green-400 text-lg">{t('setup.done')}</p>
          <div className="mt-4 space-y-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
                <span>{'\u2705'}</span><span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {step === 'error' && (
        <div className="w-full max-w-md">
          <div className="space-y-2 mb-4">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span>{statusIcon(item.status)}</span>
                <span className={
                  item.status === 'error' ? 'text-red-600 dark:text-red-400' :
                  item.status === 'done' ? 'text-green-600 dark:text-green-400' :
                  'text-gray-400'
                }>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="text-center">
            <p className="text-red-600 dark:text-red-400 mb-2">{errorMsg}</p>
            {errorCode && errorHints[errorCode] && (
              <p className="text-gray-500 text-sm mb-4">{errorHints[errorCode]}</p>
            )}
            <p className="text-gray-500 text-sm mb-4">
              {t('setup.manualInstall')}{' '}
              <button onClick={() => window.electronAPI.openExternal('https://ollama.com')} className="underline text-blue-500 cursor-pointer bg-transparent border-none p-0">
                https://ollama.com
              </button>
            </p>
            <div className="flex gap-3 justify-center">
              <button onClick={startSetup} className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">
                {t('common.retry')}
              </button>
              <button onClick={() => setView('settings')} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">
                {t('setup.otherProvider')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

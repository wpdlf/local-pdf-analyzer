import { useState, useEffect } from 'react';
import { useAppStore } from '../lib/store';
import type { AppErrorCode } from '../types';

type SetupStep = 'welcome' | 'progress' | 'done' | 'error';

interface SetupItem {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export function OllamaSetupWizard() {
  const { setOllamaStatus, setView, setError, settings } = useAppStore();
  const [step, setStep] = useState<SetupStep>('welcome');
  const [progressMessage, setProgressMessage] = useState('');
  const [errorCode, setErrorCode] = useState<AppErrorCode | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [items, setItems] = useState<SetupItem[]>([
    { label: 'Ollama 설치 확인', status: 'pending' },
    { label: 'Ollama 서비스 시작', status: 'pending' },
    { label: `AI 모델 다운로드 (${settings.model})`, status: 'pending' },
  ]);

  // main process에서 보내는 진행 상태 수신
  useEffect(() => {
    window.electronAPI.onSetupProgress((message) => {
      setProgressMessage(message);
    });
  }, []);

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
    setStep('progress');
    setErrorCode(null);
    setErrorMsg('');
    setItems((prev) => prev.map((item) => ({ ...item, status: 'pending' as const })));

    try {
      // ── Step 1: Ollama 설치 확인/설치 ──
      updateItem(0, 'running');
      setProgressMessage('Ollama 설치 여부를 확인하고 있습니다...');
      const status = await window.electronAPI.ollama.getStatus();

      if (!status.installed) {
        setProgressMessage('Ollama를 다운로드하고 설치합니다. 관리자 권한 팝업이 나타나면 승인해주세요.');
        const installResult = await window.electronAPI.ollama.install();
        if (!installResult.success) {
          updateItem(0, 'error');
          handleError('OLLAMA_INSTALL_FAIL', installResult.error || 'Ollama 설치에 실패했습니다.');
          return;
        }
      }
      updateItem(0, 'done');

      // ── Step 2: Ollama 서비스 시작 ──
      updateItem(1, 'running');
      setProgressMessage('Ollama 서비스를 시작하고 있습니다...');
      await window.electronAPI.ollama.start();

      const recheckStatus = await window.electronAPI.ollama.getStatus();
      if (!recheckStatus.running) {
        updateItem(1, 'error');
        handleError('OLLAMA_NOT_RUNNING', 'Ollama 서비스를 시작할 수 없습니다. PC를 재시작하거나 수동으로 Ollama를 실행해주세요.');
        return;
      }
      updateItem(1, 'done');

      // ── Step 3: AI 모델 다운로드 ──
      updateItem(2, 'running');
      const models = await window.electronAPI.ollama.listModels();
      if (models.length === 0) {
        setProgressMessage(`AI 모델(${settings.model})을 다운로드하고 있습니다. 모델 크기에 따라 수 분이 소요됩니다...`);
        const pullResult = await window.electronAPI.ollama.pullModel(settings.model);
        if (!pullResult.success) {
          updateItem(2, 'error');
          handleError('MODEL_PULL_FAIL', pullResult.error || '모델 다운로드에 실패했습니다.');
          return;
        }
      }

      const finalModels = await window.electronAPI.ollama.listModels();
      if (finalModels.length === 0) {
        updateItem(2, 'error');
        handleError('MODEL_NOT_FOUND', '설치된 모델이 없습니다. 네트워크를 확인 후 다시 시도해주세요.');
        return;
      }
      updateItem(2, 'done');

      // ── 완료 ──
      const finalStatus = await window.electronAPI.ollama.getStatus();
      setOllamaStatus(finalStatus);
      setError(null);
      setStep('done');

      setTimeout(() => setView('main'), 1500);
    } catch (err) {
      handleError(
        'OLLAMA_NOT_FOUND',
        err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.',
      );
    }
  };

  const errorHints: Record<string, string> = {
    OLLAMA_NOT_FOUND: 'Ollama를 찾을 수 없습니다.',
    OLLAMA_INSTALL_FAIL: '설치 중 오류가 발생했습니다. 관리자 권한 승인 여부와 네트워크를 확인하세요.',
    OLLAMA_NOT_RUNNING: 'Ollama 서비스가 시작되지 않았습니다. PC 재시작 후 다시 시도하세요.',
    MODEL_NOT_FOUND: '모델을 찾을 수 없습니다. 네트워크 연결 후 다시 시도하세요.',
    MODEL_PULL_FAIL: '모델 다운로드 실패. 디스크 공간(최소 4GB)과 네트워크를 확인하세요.',
  };

  const statusIcon = (status: SetupItem['status']) => {
    switch (status) {
      case 'pending': return '⬜';
      case 'running': return '🔄';
      case 'done': return '✅';
      case 'error': return '❌';
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <h1 className="text-2xl font-bold mb-6 text-gray-800 dark:text-white">
        PDF 자료 요약기 설정
      </h1>

      {/* 환영 화면 */}
      {step === 'welcome' && (
        <div className="text-center">
          <p className="text-gray-600 dark:text-gray-300 mb-2">
            이 앱은 로컬 AI(Ollama)를 사용하여 강의자료를 요약합니다.
          </p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
            아래 항목이 자동으로 설치됩니다:
          </p>
          <div className="text-left mb-6 space-y-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
                <span>{statusIcon(item.status)}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <button
            onClick={startSetup}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-lg transition-colors"
          >
            설정 시작
          </button>
        </div>
      )}

      {/* 진행 화면 */}
      {step === 'progress' && (
        <div className="w-full max-w-md">
          <div className="space-y-3 mb-6">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className={item.status === 'running' ? 'animate-spin' : ''}>
                  {statusIcon(item.status)}
                </span>
                <span className={`text-sm ${
                  item.status === 'running' ? 'text-blue-600 dark:text-blue-400 font-medium' :
                  item.status === 'done' ? 'text-green-600 dark:text-green-400' :
                  'text-gray-500 dark:text-gray-400'
                }`}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-sm text-center">{progressMessage}</p>
        </div>
      )}

      {/* 완료 */}
      {step === 'done' && (
        <div className="text-center">
          <div className="text-4xl mb-4">✅</div>
          <p className="text-green-600 dark:text-green-400 text-lg">모든 설정이 완료되었습니다!</p>
          <div className="mt-4 space-y-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
                <span>✅</span><span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 에러 */}
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
              수동 설치:{' '}
              <button
                onClick={() => window.electronAPI.openExternal('https://ollama.com')}
                className="underline text-blue-500 cursor-pointer bg-transparent border-none p-0"
              >
                https://ollama.com
              </button>
            </p>
            <button
              onClick={startSetup}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              다시 시도
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

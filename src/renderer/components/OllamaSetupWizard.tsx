import { useState, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../lib/store';
import { useT, t as translate, translateMainProgress, translateMainError } from '../lib/i18n';
import type { MainProgressEvent } from '../lib/i18n';
import type { AppErrorCode } from '../types';
import { INITIAL_INSTALL_MODELS, OPTIONAL_KOREAN_MODEL, matchesModel } from '../types';

type SetupStep = 'welcome' | 'progress' | 'done' | 'error';

type SetupItemStatus = 'pending' | 'running' | 'done' | 'error';

// R44(R43 후속 F8): 진행 메시지를 완성 문자열이 아닌 키/이벤트로 보관 — 렌더 시점에
// 현재 UI 언어로 번역해, 진행 중 언어 토글 시 이전 언어 스냅샷이 잔존하지 않도록 한다.
type ProgressDisplay =
  | { type: 'key'; key: Parameters<typeof translate>[0] }
  | { type: 'model'; labelKey: Parameters<typeof translate>[0]; model: string }
  | { type: 'main'; ev: MainProgressEvent };

export function OllamaSetupWizard() {
  const setOllamaStatus = useAppStore((s) => s.setOllamaStatus);
  const setView = useAppStore((s) => s.setView);
  const setError = useAppStore((s) => s.setError);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const t = useT();

  // 설치 화면은 헤더 없이 단독 렌더되므로 설정 패널의 언어 라디오에 접근할 수 없다.
  // OS 로캘 감지(localeAwareDefaults)가 틀렸을 때의 탈출구로 토글을 직접 제공.
  const switchLanguage = (lang: 'ko' | 'en') => {
    if (settings.uiLanguage === lang) return;
    // R43 F2: 첫 실행 컨텍스트에서 요약 언어가 UI 언어와 짝(로캘 기본값)이라면 함께 전환 —
    // 영문 OS 의 한국어 사용자가 토글 후 "UI 한국어 + 요약 영어"로 갈리는 문제 방지.
    // 사용자가 요약 언어를 명시적으로 다르게 설정한 경우(ja 등)는 보존.
    const syncSummary = settings.summaryLanguage === settings.uiLanguage;
    updateSettings({
      ...settings,
      uiLanguage: lang,
      ...(syncSummary ? { summaryLanguage: lang } : {}),
    });
  };
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 사용자가 진행 중 취소를 요청하면 true. 각 await 뒤에서 체크되어 다음 단계 진입을 차단.
  // R44(R43 후속 F9): 진행 중인 모델 다운로드는 cancelPull IPC 로 실제 중단한다 —
  // Ollama 가 부분 레이어를 캐시하므로 다음 pull 에서 이어받아 중단 비용이 거의 없고,
  // orphan pull 이 설정 화면의 수동 pull 을 '이미 진행 중' 으로 차단하던 문제가 사라진다.
  // (Ollama 인스톨러 자체의 install IPC 는 외부 프로세스라 기존대로 계속 진행)
  const cancelledRef = useRef(false);
  const [step, setStep] = useState<SetupStep>('welcome');
  const [progress, setProgress] = useState<ProgressDisplay | null>(null);
  // 렌더 시점 번역 — 언어 토글이 진행 메시지에도 즉시 반영 (R44 F8)
  const progressMessage = !progress ? ''
    : progress.type === 'key' ? t(progress.key)
    : progress.type === 'model' ? t('setup.downloadingModel', { label: t(progress.labelKey, { model: progress.model }) })
    : translateMainProgress(progress.ev);
  const [errorCode, setErrorCode] = useState<AppErrorCode | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  // 한국어 특화 모델(exaone3.5, 약 4.8GB) 선택 설치 — 기본 해제로 첫 설치 용량을 줄인다.
  // 체크박스는 welcome 단계에서만 노출되므로 진행 중 설치 목록이 바뀌지 않는다.
  const [includeKorean, setIncludeKorean] = useState(false);
  const installModels = useMemo<string[]>(
    () => (includeKorean ? [...INITIAL_INSTALL_MODELS, OPTIONAL_KOREAN_MODEL] : [...INITIAL_INSTALL_MODELS]),
    [includeKorean],
  );
  // 상태만 state 로 관리하고 label 은 매 렌더 시 t 로 계산 — UI 언어 전환이 즉시 반영됨.
  // 길이는 startSetup 진입 시 installModels 기준으로 채워지고, 그 전에는 ?? 'pending' fallback.
  const [itemStatuses, setItemStatuses] = useState<SetupItemStatus[]>([]);
  const modelItemLabel = (m: string) => {
    if (m === 'nomic-embed-text') return t('setup.downloadEmbed', { model: m });
    if (m === OPTIONAL_KOREAN_MODEL) return t('setup.downloadKorean', { model: m });
    return t('setup.downloadBase', { model: m });
  };
  // noUncheckedIndexedAccess: itemStatuses[N] 은 T|undefined 로 좁혀지므로 'pending' fallback.
  const items = [
    { label: t('setup.ollamaCheck'), status: itemStatuses[0] ?? 'pending' },
    { label: t('setup.ollamaStart'), status: itemStatuses[1] ?? 'pending' },
    ...installModels.map((m, i) => ({
      label: modelItemLabel(m),
      status: itemStatuses[2 + i] ?? 'pending',
    })),
  ];

  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((ev) => {
      if (cancelledRef.current) return;
      setProgress({ type: 'main', ev });
    });
    return () => {
      unsubscribe();
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, []);

  const handleCancel = () => {
    cancelledRef.current = true;
    // R44 F6: 이전의 "취소 중..." 진행 메시지는 setView 동기 언마운트로 0프레임 표시되던
    // dead state 였고, 문구("백그라운드에서 완료됩니다")도 실제 중단 동작과 모순이라 제거.
    // R44 F9: 진행 중인 모델 다운로드 실제 중단 (best-effort — pull 미진행 시 no-op)
    window.electronAPI.ollama.cancelPull().catch(() => { /* 무시 */ });
    // 설정 화면으로 이동 — 사용자가 다른 provider (Claude/OpenAI) 선택 가능
    setView('settings');
  };

  const updateItem = (index: number, status: SetupItemStatus) => {
    setItemStatuses((prev) => prev.map((s, i) => (i === index ? status : s)));
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
    setItemStatuses(Array.from({ length: 2 + installModels.length }, () => 'pending' as SetupItemStatus));

    try {
      updateItem(0, 'running');
      setProgress({ type: 'key', key: 'setup.checkingOllama' });
      const status = await window.electronAPI.ollama.getStatus();
      if (cancelledRef.current) return;

      if (!status.installed) {
        setProgress({ type: 'key', key: 'setup.installingOllama' });
        const installResult = await window.electronAPI.ollama.install();
        if (cancelledRef.current) return;
        if (!installResult.success) {
          updateItem(0, 'error');
          handleError('OLLAMA_INSTALL_FAIL', translateMainError(installResult, t('setup.ollamaInstallFail')));
          return;
        }
      }
      updateItem(0, 'done');

      updateItem(1, 'running');
      setProgress({ type: 'key', key: 'setup.startingOllama' });
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

      for (let i = 0; i < installModels.length; i++) {
        if (cancelledRef.current) return;
        const modelName = installModels[i];
        // noUncheckedIndexedAccess: 인덱스 가드 — i < length 이미 검사했으나 컴파일러 좁힘 안됨.
        if (!modelName) continue;
        const itemIndex = 2 + i;
        updateItem(itemIndex, 'running');

        // R43 F1: 콜론 경계 매칭 — startsWith 는 'gemma3' 가 'gemma3n:e4b' 와 오매칭
        const alreadyInstalled = existingModels.some((m) => matchesModel(m, modelName));
        if (alreadyInstalled) {
          updateItem(itemIndex, 'done');
          continue;
        }

        const labelKey = modelName === 'nomic-embed-text'
          ? 'setup.downloadingModelLabel.embed' as const
          : modelName === OPTIONAL_KOREAN_MODEL
            ? 'setup.downloadingModelLabel.korean' as const
            : 'setup.downloadingModelLabel.base' as const;
        setProgress({ type: 'model', labelKey, model: modelName });
        const pullResult = await window.electronAPI.ollama.pullModel(modelName);
        if (cancelledRef.current) return;
        if (!pullResult.success) {
          updateItem(itemIndex, 'error');
          handleError('MODEL_PULL_FAIL', translateMainError(pullResult, t('setup.modelDownloadFail', { model: modelName })));
          return;
        }
        updateItem(itemIndex, 'done');
      }

      // R43 F4: listModels 는 일시적 통신 오류 시 빈 배열로 resolve 하므로, 방금 pull 이
      // 모두 성공했는데 빈 결과가 오면 1회 재조회로 거짓 MODEL_NOT_FOUND 를 걸러낸다.
      // 특정 모델 행(updateItem 매직 인덱스)을 error 로 마킹하지 않음 — 설치 실패가 아니라
      // 최종 확인 실패이므로 멀쩡한 항목을 빨갛게 표시하던 오표시 제거.
      let finalModels = await window.electronAPI.ollama.listModels();
      if (cancelledRef.current) return;
      if (finalModels.length === 0) {
        finalModels = await window.electronAPI.ollama.listModels();
        if (cancelledRef.current) return;
      }
      if (finalModels.length === 0) {
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

  const statusIcon = (status: SetupItemStatus) => {
    switch (status) {
      case 'pending': return '\u2B1C';
      case 'running': return '\uD83D\uDD04';
      case 'done': return '\u2705';
      case 'error': return '\u274C';
    }
  };

  // a11y M3: emoji \uC544\uC774\uCF58\uC740 SR \uC5D0\uC11C "white large square" \uB4F1\uC73C\uB85C \uC77D\uD600 \uB2E8\uACC4 \uC0C1\uD0DC\uB97C \uC804\uB2EC\uD558\uC9C0 \uBABB\uD55C\uB2E4.
  // \uC544\uC774\uCF58\uC740 aria-hidden \uCC98\uB9AC\uD558\uACE0 \uAC01 \uD56D\uBAA9\uC5D0 visually-hidden \uC0C1\uD0DC \uD14D\uC2A4\uD2B8\uB97C \uBD80\uC5EC\uD55C\uB2E4.
  const statusText = (status: SetupItemStatus): string => {
    switch (status) {
      case 'pending': return t('setup.statusPending');
      case 'running': return t('setup.statusRunning');
      case 'done': return t('setup.statusDone');
      case 'error': return t('setup.statusError');
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center h-full p-8">
      <div className="absolute top-4 right-4 flex items-center gap-1 text-sm" role="group" aria-label="Language">
        {(['ko', 'en'] as const).map((lang, i) => (
          <span key={lang} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-300 dark:text-gray-600">|</span>}
            <button
              onClick={() => switchLanguage(lang)}
              aria-pressed={settings.uiLanguage === lang}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                settings.uiLanguage === lang
                  ? 'font-semibold text-blue-600 dark:text-blue-400'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
              }`}
            >
              {lang === 'ko' ? '한국어' : 'English'}
            </button>
          </span>
        ))}
      </div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800 dark:text-white">
        {t('setup.title')}
      </h1>

      {step === 'welcome' && (
        <div className="text-center">
          <p className="text-gray-600 dark:text-gray-300 mb-2">{t('setup.desc')}</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">{t('setup.autoInstall')}</p>
          <div className="text-left mb-4 space-y-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
                <span aria-hidden="true">{statusIcon(item.status)}</span>
                <span>{item.label}</span>
                <span className="sr-only">— {statusText(item.status)}</span>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-left mb-6 max-w-md mx-auto p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={includeKorean}
              onChange={(e) => setIncludeKorean(e.target.checked)}
              className="mt-1 accent-blue-500"
            />
            <span>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                {t('setup.koreanOption', { model: OPTIONAL_KOREAN_MODEL })}
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('setup.koreanOptionDesc')}
              </span>
            </span>
          </label>
          <button onClick={startSetup} className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-lg transition-colors">
            {t('setup.start')}
          </button>
        </div>
      )}

      {step === 'progress' && (
        <div className="w-full max-w-md">
          {/* a11y M3: 수 분짜리 설치 진행/단계 상태를 SR 에 polite 통지 */}
          <div className="space-y-3 mb-6" role="status" aria-live="polite">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-3">
                <span aria-hidden="true" className={item.status === 'running' ? 'animate-spin' : ''}>{statusIcon(item.status)}</span>
                <span className={`text-sm ${
                  item.status === 'running' ? 'text-blue-600 dark:text-blue-400 font-medium' :
                  item.status === 'done' ? 'text-green-600 dark:text-green-400' :
                  'text-gray-500 dark:text-gray-400'
                }`}>{item.label}</span>
                <span className="sr-only">— {statusText(item.status)}</span>
              </div>
            ))}
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-sm text-center mb-4" role="status">{progressMessage}</p>
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
          <div className="text-4xl mb-4" aria-hidden="true">{'\u2705'}</div>
          <p className="text-green-600 dark:text-green-400 text-lg" role="status">{t('setup.done')}</p>
          <div className="mt-4 space-y-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
                <span aria-hidden="true">{'\u2705'}</span><span>{item.label}</span>
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
                <span aria-hidden="true">{statusIcon(item.status)}</span>
                <span className={
                  item.status === 'error' ? 'text-red-600 dark:text-red-400' :
                  item.status === 'done' ? 'text-green-600 dark:text-green-400' :
                  'text-gray-400'
                }>{item.label}</span>
                <span className="sr-only">— {statusText(item.status)}</span>
              </div>
            ))}
          </div>
          <div className="text-center">
            {/* a11y M3: 설치 실패를 SR 에 즉시 통지 */}
            <p className="text-red-600 dark:text-red-400 mb-2" role="alert">{errorMsg}</p>
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

import type { UiLanguage } from '../types';
import { useAppStore } from './store';

// ─── 번역 사전 ───

const translations = {
  // ─── 공통 ───
  'common.close': { ko: '닫기', en: 'Close' },
  'common.save': { ko: '저장', en: 'Save' },
  'common.delete': { ko: '삭제', en: 'Delete' },
  'common.cancel': { ko: '취소', en: 'Cancel' },
  'common.retry': { ko: '다시 시도', en: 'Retry' },
  'common.stop': { ko: '중지', en: 'Stop' },
  'common.send': { ko: '전송', en: 'Send' },
  'common.none': { ko: '없음', en: 'None' },
  'common.saved': { ko: '저장됨', en: 'Saved' },

  // ─── App ───
  'app.title': { ko: 'PDF 자료 분석기', en: 'PDF Analyzer' },
  'app.logo': { ko: '로고', en: 'Logo' },
  'app.settings': { ko: '설정', en: 'Settings' },
  'app.settingsBlocked': { ko: '요약 중에는 설정을 열 수 없습니다', en: 'Cannot open settings while summarizing' },
  'app.closeError': { ko: '에러 닫기', en: 'Close error' },
  'app.removeFile': { ko: '현재 파일 제거', en: 'Remove current file' },
  'app.otherFile': { ko: '✕ 다른 파일', en: '✕ Other file' },
  'app.startSummary': { ko: '📝 요약 시작', en: '📝 Summarize' },
  'app.downloadingModel': { ko: '기본 모델 다운로드 중: {model}', en: 'Downloading model: {model}' },
  'app.modelDownloadFail': { ko: '모델 다운로드 실패: {model} — {error}', en: 'Model download failed: {model} — {error}' },
  'app.modelDownloadFailDefault': { ko: '네트워크를 확인해주세요', en: 'Please check your network' },
  'app.modelInstallDone': { ko: '기본 모델 설치 완료', en: 'Model installation complete' },
  'app.modelHint': {
    ko: '현재 모델({model})은 한국어 성능이 제한적일 수 있습니다. 설정에서 {recommended} 등의 모델로 변경하면 요약 품질이 향상됩니다.',
    en: 'Current model ({model}) may have limited Korean performance. Switch to {recommended} in settings for better quality.',
  },

  // ─── PdfUploader ───
  'uploader.fileTooLarge': { ko: '파일이 너무 큽니다 ({size}MB). 최대 100MB까지 지원합니다.', en: 'File too large ({size}MB). Maximum 100MB supported.' },
  'uploader.cannotRead': { ko: 'PDF를 읽을 수 없습니다.', en: 'Cannot read PDF.' },
  'uploader.ariaLabel': { ko: 'PDF 파일 업로드', en: 'Upload PDF file' },
  'uploader.ocrProgress': { ko: '스캔 PDF 텍스트 인식 중...', en: 'Recognizing scanned PDF text...' },
  'uploader.ocrLabel': { ko: 'OCR 진행', en: 'OCR progress' },
  'uploader.ocrDesc': { ko: 'Vision 모델로 텍스트를 추출하고 있습니다', en: 'Extracting text with Vision model' },
  'uploader.reading': { ko: 'PDF를 읽고 있습니다...', en: 'Reading PDF...' },
  'uploader.wait': { ko: '잠시만 기다려주세요', en: 'Please wait' },
  'uploader.dragDrop': { ko: 'PDF 파일을 여기에 드래그하거나', en: 'Drag PDF file here or' },
  'uploader.clickSelect': { ko: '클릭하여 선택', en: 'click to select' },
  'uploader.selectFile': { ko: '파일 선택', en: 'Select file' },

  // ─── SummaryTypeSelector ───
  'selector.full': { ko: '전체 요약', en: 'Full summary' },
  'selector.chapter': { ko: '챕터별', en: 'By chapter' },
  'selector.keywords': { ko: '키워드 추출', en: 'Keywords' },
  'selector.summaryType': { ko: '요약 유형', en: 'Summary type' },
  'selector.summaryLang': { ko: '요약 언어', en: 'Output language' },
  'selector.modelWarning': {
    ko: '{model}은 한국어 특화 모델이라 다른 언어 출력이 제한적입니다. 설정에서 gemma3 또는 qwen2.5로 변경하면 더 나은 결과를 얻을 수 있습니다.',
    en: '{model} is a Korean-specialized model with limited multilingual output. Switch to gemma3 or qwen2.5 in settings for better results.',
  },

  // ─── SummaryViewer ───
  'viewer.defaultFilename': { ko: '요약.md', en: 'summary.md' },
  'viewer.saveFail': { ko: '파일 저장에 실패했습니다. 다른 경로를 선택해주세요.', en: 'Failed to save file. Please choose a different path.' },
  'viewer.copyFail': { ko: '클립보드에 복사할 수 없습니다.', en: 'Cannot copy to clipboard.' },
  'viewer.result': { ko: '📎 요약 결과', en: '📎 Summary result' },
  'viewer.analyzing': { ko: 'AI가 자료를 분석하고 있습니다...', en: 'AI is analyzing the document...' },
  'viewer.pleaseWait': { ko: '잠시만 기다려주세요', en: 'Please wait' },
  'viewer.stopSummary': { ko: '요약 중지', en: 'Stop summary' },
  'viewer.stopBtn': { ko: '■ 중지', en: '■ Stop' },
  'viewer.export': { ko: '💾 .md 내보내기', en: '💾 Export .md' },
  'viewer.exportAria': { ko: '마크다운 파일로 내보내기', en: 'Export as markdown file' },
  'viewer.copy': { ko: '📋 복사', en: '📋 Copy' },
  'viewer.copyAria': { ko: '클립보드에 복사', en: 'Copy to clipboard' },

  // ─── QaChat ───
  'qa.header': { ko: '문서에 대해 질문하세요', en: 'Ask about the document' },
  'qa.indexing': { ko: 'RAG 인덱싱', en: 'RAG indexing' },
  'qa.chunkTooltip': { ko: '임베딩 모델: {model} | {count}개 청크', en: 'Embedding model: {model} | {count} chunks' },
  'qa.ragActive': { ko: 'RAG 시맨틱 검색이 활성화되었습니다. 문서에 대해 질문해보세요.', en: 'RAG semantic search is active. Ask a question about the document.' },
  'qa.emptyHint': { ko: '요약된 내용이나 원문에 대해 궁금한 점을 질문해보세요', en: 'Ask questions about the summary or original document' },
  'qa.generating': { ko: '답변 생성 중...', en: 'Generating answer...' },
  'qa.charLimit': { ko: '질문은 {max}자까지 입력 가능합니다 ({current}/{max})', en: 'Question limited to {max} characters ({current}/{max})' },
  'qa.placeholder': { ko: '질문을 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)', en: 'Type your question... (Enter: send, Shift+Enter: newline)' },
  'qa.inputAria': { ko: '질문 입력', en: 'Question input' },
  'qa.stopAria': { ko: '답변 중지', en: 'Stop answer' },
  'qa.sendAria': { ko: '질문 전송', en: 'Send question' },

  // ─── ProgressBar ───
  'progress.seconds': { ko: '{s}초', en: '{s}s' },
  'progress.minutes': { ko: '{m}분 {s}초', en: '{m}m {s}s' },
  'progress.minutesOnly': { ko: '{m}분', en: '{m}m' },
  'progress.imagePhase': { ko: '이미지 분석 중', en: 'Analyzing images' },
  'progress.integratePhase': { ko: '통합 요약 생성 중', en: 'Generating integrated summary' },
  'progress.chapterPhase': { ko: '{current}/{total} 섹션 — {name}', en: '{current}/{total} sections — {name}' },
  'progress.sectionPhase': { ko: '{current}/{total} 섹션 처리 중', en: 'Processing {current}/{total} sections' },
  'progress.summarizing': { ko: '요약 생성 중', en: 'Summarizing' },
  'progress.processing': { ko: '{percent}% 처리 중...', en: '{percent}% processing...' },
  'progress.remaining': { ko: '약 {time} 남음', en: '~{time} remaining' },
  'progress.elapsed': { ko: '{time} 경과', en: '{time} elapsed' },

  // ─── StatusBar ───
  'status.stopped': { ko: '중지됨', en: 'Stopped' },
  'status.notInstalled': { ko: '미설치', en: 'Not installed' },

  // ─── SettingsPanel ───
  'settings.title': { ko: '설정', en: 'Settings' },
  'settings.provider': { ko: 'AI Provider', en: 'AI Provider' },
  'settings.ollamaLabel': { ko: 'Ollama (로컬, 무료)', en: 'Ollama (local, free)' },
  'settings.ollamaDesc': { ko: '인터넷 불필요, 개인 자료 보안', en: 'No internet required, data stays private' },
  'settings.claudeLabel': { ko: 'Claude API', en: 'Claude API' },
  'settings.claudeDesc': { ko: '높은 요약 품질, API 키 필요 (유료)', en: 'High quality summaries, API key required (paid)' },
  'settings.openaiLabel': { ko: 'OpenAI API', en: 'OpenAI API' },
  'settings.openaiDesc': { ko: 'GPT-4o 기반 요약, API 키 필요 (유료)', en: 'GPT-4o based summaries, API key required (paid)' },
  'settings.enterApiKey': { ko: '아래에서 API 키를 입력하세요', en: 'Enter API key below' },
  'settings.keyRegistered': { ko: '키 등록됨', en: 'Key registered' },
  'settings.model': { ko: '모델', en: 'Model' },
  'settings.apiBilling': { ko: 'API 사용량에 따라 요금이 부과됩니다.', en: 'Charges apply based on API usage.' },
  'settings.noModels': { ko: 'Ollama에 설치된 모델이 없습니다. 아래에서 모델을 추가해주세요.', en: 'No models installed in Ollama. Please add a model below.' },
  'settings.modelRecommend': { ko: '한국어 요약에는 gemma3, qwen2.5 모델을 권장합니다.', en: 'gemma3 and qwen2.5 are recommended for Korean summaries.' },
  'settings.apiKeyMgmt': { ko: 'API 키 관리', en: 'API Key Management' },
  'settings.apiKeyEncrypted': { ko: 'API 키는 암호화되어 로컬에 저장됩니다.', en: 'API keys are encrypted and stored locally.' },
  'settings.keySaved': { ko: '{provider} API 키가 저장되었습니다.', en: '{provider} API key saved.' },
  'settings.keySaveFail': { ko: 'API 키 저장에 실패했습니다. 다시 시도해주세요.', en: 'Failed to save API key. Please try again.' },
  'settings.keyDeleted': { ko: 'API 키가 삭제되었습니다.', en: 'API key deleted.' },
  'settings.keyDeleteFail': { ko: 'API 키 삭제에 실패했습니다. 다시 시도해주세요.', en: 'Failed to delete API key. Please try again.' },
  'settings.saveKeyFirst': { ko: '{provider} API 키를 먼저 저장해주세요.', en: 'Please save {provider} API key first.' },
  'settings.ollamaMgmt': { ko: 'Ollama 관리', en: 'Ollama Management' },
  'settings.ollamaStatus': { ko: '상태', en: 'Status' },
  'settings.ollamaRunning': { ko: '✅ Running', en: '✅ Running' },
  'settings.ollamaStopped': { ko: '⚠️ 중지됨', en: '⚠️ Stopped' },
  'settings.installedModels': { ko: '설치된 모델', en: 'Installed models' },
  'settings.recommendedModels': { ko: '추천 모델 (클릭하여 설치):', en: 'Recommended models (click to install):' },
  'settings.koreanGood': { ko: '한국어 우수', en: 'Good Korean' },
  'settings.multilingual': { ko: '다국어 강점', en: 'Multilingual' },
  'settings.koreanSpecial': { ko: '한국어 특화', en: 'Korean specialized' },
  'settings.generalLight': { ko: '범용 경량', en: 'General lightweight' },
  'settings.ultraLight': { ko: '초경량', en: 'Ultra light' },
  'settings.modelPlaceholder': { ko: '모델명 (예: gemma3)', en: 'Model name (e.g., gemma3)' },
  'settings.downloading': { ko: '다운로드 중...', en: 'Downloading...' },
  'settings.addModel': { ko: '모델 추가', en: 'Add model' },
  'settings.restartOllama': { ko: 'Ollama 재시작', en: 'Restart Ollama' },
  'settings.restartFail': { ko: 'Ollama 재시작에 실패했습니다. 수동으로 시작해주세요.', en: 'Failed to restart Ollama. Please start it manually.' },
  'settings.theme': { ko: '테마', en: 'Theme' },
  'settings.themeLight': { ko: '라이트', en: 'Light' },
  'settings.themeDark': { ko: '다크', en: 'Dark' },
  'settings.themeSystem': { ko: '시스템', en: 'System' },
  'settings.language': { ko: '언어', en: 'Language' },
  'settings.chunkSize': { ko: '청크 크기', en: 'Chunk size' },
  'settings.imageAnalysis': { ko: '이미지 분석', en: 'Image Analysis' },
  'settings.imageAnalysisLabel': { ko: 'PDF 이미지 자동 분석', en: 'Auto-analyze PDF images' },
  'settings.imageAnalysisDesc': { ko: 'Vision 지원 모델 필요 (llava, Claude, GPT-4o 등)', en: 'Requires Vision model (llava, Claude, GPT-4o, etc.)' },
  'settings.ocrTitle': { ko: '스캔 PDF OCR', en: 'Scanned PDF OCR' },
  'settings.ocrLabel': { ko: '스캔 PDF 자동 텍스트 인식 (OCR)', en: 'Auto text recognition for scanned PDFs (OCR)' },
  'settings.ocrDesc': {
    ko: '텍스트를 추출할 수 없는 스캔 PDF에서 Vision 모델로 텍스트를 인식합니다. 페이지 수에 따라 시간과 API 비용이 증가할 수 있습니다.',
    en: 'Recognizes text in scanned PDFs using Vision models. Time and API costs increase with page count.',
  },
  'settings.savedBtn': { ko: '✅ 저장되었습니다', en: '✅ Saved' },
  'settings.saveBtn': { ko: '설정 저장', en: 'Save settings' },
  'settings.noChanges': { ko: '변경 사항 없음', en: 'No changes' },
  'settings.notInstalled': { ko: '미설치', en: 'Not installed' },

  // ─── OllamaSetupWizard ───
  'setup.title': { ko: 'PDF 자료 분석기 설정', en: 'PDF Analyzer Setup' },
  'setup.desc': { ko: '이 앱은 로컬 AI(Ollama)를 사용하여 PDF 자료를 요약합니다.', en: 'This app uses local AI (Ollama) to summarize PDF documents.' },
  'setup.autoInstall': { ko: '아래 항목이 자동으로 설치됩니다:', en: 'The following will be installed automatically:' },
  'setup.start': { ko: '설정 시작', en: 'Start setup' },
  'setup.done': { ko: '모든 설정이 완료되었습니다!', en: 'Setup complete!' },
  'setup.otherProvider': { ko: '다른 AI Provider 사용', en: 'Use other AI Provider' },
  'setup.ollamaCheck': { ko: 'Ollama 설치 확인', en: 'Check Ollama installation' },
  'setup.ollamaStart': { ko: 'Ollama 서비스 시작', en: 'Start Ollama service' },
  'setup.downloadKorean': { ko: '한국어 AI 모델 다운로드 ({model})', en: 'Download Korean AI model ({model})' },
  'setup.downloadEmbed': { ko: 'RAG 임베딩 모델 다운로드 ({model})', en: 'Download RAG embedding model ({model})' },
  'setup.checkingOllama': { ko: 'Ollama 설치 여부를 확인하고 있습니다...', en: 'Checking Ollama installation...' },
  'setup.installingOllama': { ko: 'Ollama를 다운로드하고 설치합니다. 관리자 권한 팝업이 나타나면 승인해주세요.', en: 'Downloading and installing Ollama. Please approve the admin prompt if it appears.' },
  'setup.ollamaInstallFail': { ko: 'Ollama 설치에 실패했습니다.', en: 'Failed to install Ollama.' },
  'setup.startingOllama': { ko: 'Ollama 서비스를 시작하고 있습니다...', en: 'Starting Ollama service...' },
  'setup.ollamaStartFail': { ko: 'Ollama 서비스를 시작할 수 없습니다. PC를 재시작하거나 수동으로 Ollama를 실행해주세요.', en: 'Cannot start Ollama service. Restart PC or start Ollama manually.' },
  'setup.downloadingModel': { ko: '{label}을 다운로드하고 있습니다. 모델 크기에 따라 수 분이 소요됩니다...', en: 'Downloading {label}. This may take a few minutes depending on model size...' },
  'setup.downloadingModelLabel.korean': { ko: '한국어 AI 모델({model})', en: 'Korean AI model ({model})' },
  'setup.downloadingModelLabel.embed': { ko: 'RAG 임베딩 모델({model})', en: 'RAG embedding model ({model})' },
  'setup.modelDownloadFail': { ko: '{model} 모델 다운로드에 실패했습니다.', en: 'Failed to download {model} model.' },
  'setup.noModels': { ko: '설치된 모델이 없습니다. 네트워크를 확인 후 다시 시도해주세요.', en: 'No models installed. Check network and try again.' },
  'setup.unknownError': { ko: '알 수 없는 오류가 발생했습니다.', en: 'An unknown error occurred.' },
  'setup.hint.notFound': { ko: 'Ollama를 찾을 수 없습니다.', en: 'Ollama not found.' },
  'setup.hint.installFail': { ko: '설치 중 오류가 발생했습니다. 관리자 권한 승인 여부와 네트워크를 확인하세요.', en: 'Installation error. Check admin permissions and network.' },
  'setup.hint.notRunning': { ko: 'Ollama 서비스가 시작되지 않았습니다. PC 재시작 후 다시 시도하세요.', en: 'Ollama service failed to start. Restart PC and try again.' },
  'setup.hint.modelNotFound': { ko: '모델을 찾을 수 없습니다. 네트워크 연결 후 다시 시도하세요.', en: 'Model not found. Check network and try again.' },
  'setup.hint.pullFail': { ko: '모델 다운로드 실패. 디스크 공간(최소 4GB)과 네트워크를 확인하세요.', en: 'Model download failed. Check disk space (min 4GB) and network.' },
  'setup.downloadReady': { ko: '다운로드 준비 중...', en: 'Preparing download...' },
  'setup.manualInstall': { ko: '수동 설치:', en: 'Manual install:' },
} as const;

type TranslationKey = keyof typeof translations;

// ─── 템플릿 치환 ───

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

// ─── 번역 함수 ───

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const lang = useAppStore.getState().settings.uiLanguage || 'ko';
  const entry = translations[key];
  if (!entry) return key;
  return interpolate(entry[lang] || entry['ko'], params);
}

// ─── React 훅 ───

export function useT(): (key: TranslationKey, params?: Record<string, string | number>) => string {
  const lang = useAppStore((s) => s.settings.uiLanguage);
  return (key: TranslationKey, params?: Record<string, string | number>) => {
    const entry = translations[key];
    if (!entry) return key;
    return interpolate(entry[lang] || entry['ko'], params);
  };
}

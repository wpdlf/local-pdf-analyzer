import { useMemo } from 'react';
import type { UiLanguage } from '../types';
import { useAppStore } from './store';

// ─── 번역 사전 ───

/**
 * 번역 엔트리 맵. v0.18.5 T2: runtime parity/품질 검증을 위해 `_translations` 로 export.
 * 프로덕션 코드는 `t()` / `useT()` 만 사용해야 하며 이 객체를 직접 참조하지 말 것
 * (키 오타가 타입 체크를 통과해버린다). 테스트/디버깅 전용 접근 채널.
 */
export const _translations = {
  // ─── 공통 ───
  'common.close': { ko: '닫기', en: 'Close' },
  // ─── 다중 문서 탭 (multi-doc Phase 1) ───
  'tabs.label': { ko: '열린 문서', en: 'Open documents' },
  'tabs.close': { ko: '{name} 탭 닫기', en: 'Close tab {name}' },
  'tabs.newTab': { ko: '새 문서 열기', en: 'Open a new document' },
  'tabs.switchFail': { ko: '원본 PDF 파일을 찾을 수 없어 탭을 전환할 수 없습니다. 파일이 이동/삭제되었다면 다시 열어주세요.', en: 'Could not switch tabs because the original PDF file was not found. If it was moved or deleted, please open it again.' },
  'common.renderError': { ko: '렌더링 오류가 발생했습니다.', en: 'A rendering error occurred.' },
  'common.imagePlaceholder': { ko: '[이미지]', en: '[image]' },
  'common.blockedLink': { ko: '차단된 링크 (지원하지 않는 URL 형식)', en: 'Blocked link (unsupported URL scheme)' },

  // ─── Page citation / PDF viewer (page-citation-viewer) ───
  'citation.aria': { ko: '{page} 페이지 원문 열기', en: 'Open source page {page}' },
  'citation.tooltip': { ko: '클릭하여 {page} 페이지 원문 확인', en: 'Click to view source on page {page}' },
  'citation.invalid': { ko: '유효하지 않은 페이지 ({page})', en: 'Invalid page ({page})' },
  // 컬렉션 Q&A 교차 문서 인용 (multi-doc Phase 2)
  'citation.crossTooltip': { ko: '클릭하여 {name} {page}페이지로 이동', en: 'Click to open {name} on page {page}' },
  'citation.crossAria': { ko: '{name} {page}페이지 원문 열기', en: 'Open {name} page {page}' },
  'citation.docClosed': { ko: '{name} 문서가 열려 있지 않아 이동할 수 없습니다', en: 'Cannot navigate — {name} is not open' },
  'pdfviewer.title': { ko: '원문 보기', en: 'Source Viewer' },
  'pdfviewer.close': { ko: '뷰어 닫기', en: 'Close viewer' },
  'pdfviewer.loading': { ko: 'PDF 로드 중...', en: 'Loading PDF...' },
  'pdfviewer.renderFail': { ko: 'PDF 뷰어 로드 실패', en: 'Failed to load PDF viewer' },
  'pdfviewer.pageOf': { ko: '{current} / {total} 페이지', en: 'Page {current} of {total}' },
  'pdfviewer.pageRenderFail': { ko: '페이지 렌더링 실패', en: 'Failed to render page' },
  'pdfviewer.resize': { ko: '패널 크기 조정 (화살표 키 또는 드래그)', en: 'Resize panel (arrow keys or drag)' },
  'ai.generateFail': { ko: '요약 생성에 실패했습니다.', en: 'Failed to generate summary.' },
  'ai.requestFail': { ko: '요약 요청에 실패했습니다.', en: 'Failed to send summary request.' },
  'ai.streamInterrupted': { ko: 'AI 응답 수신이 중단되었습니다. 네트워크 연결과 AI 서비스 상태를 확인해주세요.', en: 'AI response stream interrupted. Please check your network connection and AI service status.' },
  'common.save': { ko: '저장', en: 'Save' },
  'common.delete': { ko: '삭제', en: 'Delete' },
  'common.cancel': { ko: '취소', en: 'Cancel' },
  'common.retry': { ko: '다시 시도', en: 'Retry' },
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
  'app.modelDownloadFailPartial': {
    ko: '모델 다운로드 실패: {model} — {error} (설치 완료: {succeeded})',
    en: 'Model download failed: {model} — {error} (installed: {succeeded})',
  },
  'app.modelDownloadFailDefault': { ko: '네트워크를 확인해주세요', en: 'Please check your network' },
  'app.modelInstallDone': { ko: '기본 모델 설치 완료', en: 'Model installation complete' },
  'app.modelHint': {
    ko: '현재 모델({model})은 한국어 성능이 제한적일 수 있습니다. 설정에서 {recommended} 등의 모델로 변경하면 요약 품질이 향상됩니다.',
    en: 'Current model ({model}) may have limited Korean performance. Switch to {recommended} in settings for better quality.',
  },

  // ─── PdfUploader ───
  'uploader.fileTooLarge': { ko: '파일이 너무 큽니다 ({size}MB). 최대 100MB까지 지원합니다.', en: 'File too large ({size}MB). Maximum 100MB supported.' },
  'uploader.cannotRead': { ko: 'PDF를 읽을 수 없습니다.', en: 'Cannot read PDF.' },
  'uploader.multipleFiles': { ko: '한 번에 하나의 PDF만 처리할 수 있습니다. 첫 번째 파일({name})만 열었습니다.', en: 'Only one PDF can be processed at a time. Opening the first file ({name}) only.' },
  'uploader.notPdf': { ko: 'PDF 파일만 지원됩니다.', en: 'Only PDF files are supported.' },
  'uploader.tooManyPages': { ko: '페이지 수가 너무 많습니다 ({pages}p). 최대 {max}페이지까지 지원합니다. 문서를 분할해주세요.', en: 'Too many pages ({pages}p). Maximum {max} pages supported. Please split the document.' },
  'uploader.cancelParse': { ko: 'PDF 처리 취소', en: 'Cancel PDF processing' },
  'uploader.cancelBtn': { ko: '■ 취소', en: '■ Cancel' },
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
    ko: '{model}은 한국어 특화 모델이라 다른 언어 출력이 제한적입니다. 설정에서 gemma3 또는 qwen3.5로 변경하면 더 나은 결과를 얻을 수 있습니다.',
    en: '{model} is a Korean-specialized model with limited multilingual output. Switch to gemma3 or qwen3.5 in settings for better results.',
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
  'qa.verifying': { ko: '답변 준비 중 (근거 확인)...', en: 'Preparing answer (checking sources)...' },
  'qa.waitIndexing': { ko: 'RAG 인덱싱 중입니다. 잠시 후 다시 시도해주세요.', en: 'RAG is indexing. Please wait a moment and try again.' },
  'qa.charLimit': { ko: '질문은 {max}자까지 입력 가능합니다 ({current}/{max})', en: 'Question limited to {max} characters ({current}/{max})' },
  'qa.placeholder': { ko: '질문을 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)', en: 'Type your question... (Enter: send, Shift+Enter: newline)' },
  'qa.inputAria': { ko: '질문 입력', en: 'Question input' },
  'qa.stopAria': { ko: '답변 중지', en: 'Stop answer' },
  'qa.answerCancelled': { ko: '(답변이 취소되었습니다)', en: '(Answer cancelled)' },
  'qa.sendAria': { ko: '질문 전송', en: 'Send question' },
  // ─── 다중 문서 컬렉션 Q&A (multi-doc Phase 2) ───
  'collection.toggle': { ko: '여러 문서에 걸쳐 질문', en: 'Ask across documents' },
  'collection.toggleHint': { ko: '열어둔 문서들을 묶어 함께 검색합니다', en: 'Search the open documents together' },
  'collection.members': { ko: '검색 대상 문서', en: 'Documents to search' },
  'collection.activeBadge': { ko: '현재', en: 'active' },
  'collection.statusModelMismatch': { ko: '임베딩 모델 불일치 — 제외됨', en: 'embedding model mismatch — excluded' },
  'collection.statusNoIndex': { ko: '인덱스 없음 (요약/Q&A 먼저 필요) — 제외됨', en: 'no index (summarize/Q&A first) — excluded' },
  'collection.statusMissing': { ko: '저장된 세션 없음 — 제외됨', en: 'no saved session — excluded' },
  'collection.noneSearchable': { ko: '검색 가능한 문서가 없어 현재 문서만으로 답변합니다.', en: 'No searchable documents — answering from the current document only.' },
  'collection.searchingCount': { ko: '{count}개 문서에서 검색', en: 'Searching {count} documents' },
  'collection.degradedNotice': { ko: '컬렉션 교차 검색이 제한되어 일부 문서로만 답변했습니다 (위 목록의 제외 사유 확인).', en: 'Cross-document search was limited — answered from fewer documents (see exclusion reasons above).' },
  // 컬렉션 저장/목록 (multi-doc Phase 3 module-2)
  'collection.save': { ko: '컬렉션 저장', en: 'Save collection' },
  'collection.saveNamePlaceholder': { ko: '컬렉션 이름', en: 'Collection name' },
  'collection.saveConfirm': { ko: '저장', en: 'Save' },
  'collection.saveCancel': { ko: '취소', en: 'Cancel' },
  'collection.saved': { ko: '컬렉션을 저장했습니다.', en: 'Collection saved.' },
  'collection.saveFail': { ko: '컬렉션 저장에 실패했습니다.', en: 'Failed to save collection.' },
  'collection.savedTitle': { ko: '저장된 컬렉션', en: 'Saved collections' },
  'collection.savedEmpty': { ko: '저장된 컬렉션이 없습니다.', en: 'No saved collections.' },
  'collection.savedEmptyHint': { ko: '여러 PDF를 탭으로 열고 요약한 뒤 "여러 문서에 걸쳐 질문"을 켜면 묶음을 컬렉션으로 저장할 수 있습니다.', en: 'Open several PDFs as tabs, summarize, then turn on "Ask across documents" to save the set as a collection.' },
  'collection.docCount': { ko: '문서 {count}개', en: '{count} documents' },
  'collection.open': { ko: '열기', en: 'Open' },
  'collection.delete': { ko: '삭제', en: 'Delete' },
  'collection.openFail': { ko: '컬렉션을 열 수 없습니다.', en: 'Could not open the collection.' },
  'collection.busy': { ko: '생성/분석이 진행 중입니다. 끝난 뒤 다시 시도하세요.', en: 'A generation/analysis is in progress. Try again when it finishes.' },
  'collection.partialOpen': { ko: '{total}개 중 {opened}개 문서만 복원되었습니다 (나머지는 세션이 없음).', en: 'Restored {opened} of {total} documents (the rest have no saved session).' },
  // 교차 문서 요약/비교 (multi-doc Phase 3 module-3)
  'collection.unified': { ko: '📑 통합 요약', en: '📑 Unified summary' },
  'collection.compare': { ko: '⚖ 비교 분석', en: '⚖ Compare' },
  'collection.unifiedRequest': { ko: '선택한 문서들의 통합 요약을 작성해줘', en: 'Write a unified summary of the selected documents' },
  'collection.compareRequest': { ko: '선택한 문서들을 비교 분석해줘', en: 'Compare and contrast the selected documents' },
  'collection.summaryNeedsMembers': { ko: '교차 요약은 검색 가능한 문서가 2개 이상일 때 가능합니다.', en: 'Cross-document summary needs at least 2 searchable documents.' },
  'collection.preparingMember': { ko: '요약 준비 중: {name}…', en: 'Preparing summary: {name}…' },
  'collection.summaryFail': { ko: '교차 요약 생성에 실패했습니다.', en: 'Failed to generate the cross-document summary.' },
  'collection.unifiedResultTitle': { ko: '📑 통합 요약 ({count}개 문서)', en: '📑 Unified summary ({count} documents)' },
  'collection.compareResultTitle': { ko: '⚖ 비교 분석 ({count}개 문서)', en: '⚖ Comparison ({count} documents)' },

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
  'settings.geminiLabel': { ko: 'Google Gemini API', en: 'Google Gemini API' },
  'settings.geminiDesc': { ko: 'Gemini 기반 요약·Vision·임베딩, API 키 필요 (무료 티어 제공)', en: 'Gemini summaries · Vision · embeddings, API key required (free tier available)' },
  'settings.enterApiKey': { ko: '아래에서 API 키를 입력하세요', en: 'Enter API key below' },
  'settings.keyRegistered': { ko: '키 등록됨', en: 'Key registered' },
  'settings.model': { ko: '모델', en: 'Model' },
  'settings.apiBilling': { ko: 'API 사용량에 따라 요금이 부과됩니다.', en: 'Charges apply based on API usage.' },
  'settings.noModels': { ko: 'Ollama에 설치된 모델이 없습니다. 아래에서 모델을 추가해주세요.', en: 'No models installed in Ollama. Please add a model below.' },
  'settings.modelRecommend': { ko: '한국어 요약에는 gemma3, qwen3.5 모델을 권장합니다.', en: 'gemma3 and qwen3.5 are recommended for Korean summaries.' },
  'settings.dismissPullError': { ko: '오류 메시지 닫기', en: 'Dismiss error message' },
  'settings.closePanel': { ko: '설정 패널 닫기', en: 'Close settings panel' },
  'settings.apiKeyMgmt': { ko: 'API 키 관리', en: 'API Key Management' },
  'settings.apiKeyEncrypted': { ko: 'API 키는 암호화되어 로컬에 저장됩니다.', en: 'API keys are encrypted and stored locally.' },
  'settings.apiKeyPlaceholder': { ko: 'API 키를 입력하세요', en: 'Enter API key' },
  'settings.apiKeyMasked': { ko: '••••••••••••', en: '••••••••••••' },
  'settings.keySaved': { ko: '{provider} API 키가 저장되었습니다.', en: '{provider} API key saved.' },
  'settings.keySaveFail': { ko: 'API 키 저장에 실패했습니다. 다시 시도해주세요.', en: 'Failed to save API key. Please try again.' },
  'settings.keyDeleted': { ko: 'API 키가 삭제되었습니다.', en: 'API key deleted.' },
  'settings.keyDeleteFail': { ko: 'API 키 삭제에 실패했습니다. 다시 시도해주세요.', en: 'Failed to delete API key. Please try again.' },
  'settings.saveKeyFirst': { ko: '{provider} API 키를 먼저 저장해주세요.', en: 'Please save {provider} API key first.' },
  'settings.keyEmpty': { ko: 'API 키를 입력해주세요.', en: 'Please enter an API key.' },
  'settings.ollamaMgmt': { ko: 'Ollama 관리', en: 'Ollama Management' },
  'settings.ollamaStatus': { ko: '상태', en: 'Status' },
  'settings.ollamaRunning': { ko: '✅ Running', en: '✅ Running' },
  'settings.ollamaStopped': { ko: '⚠️ 중지됨', en: '⚠️ Stopped' },
  'settings.installedModels': { ko: '설치된 모델', en: 'Installed models' },
  'settings.recommendedModels': { ko: '추천 모델 (클릭하여 설치):', en: 'Recommended models (click to install):' },
  'settings.koreanGood': { ko: '한국어 우수 (약 3.3GB)', en: 'Good Korean (~3.3GB)' },
  'settings.multilingual': { ko: '다국어·멀티모달 (약 3.4GB)', en: 'Multilingual · multimodal (~3.4GB)' },
  'settings.koreanSpecial': { ko: '한국어 특화 (약 4.8GB)', en: 'Korean specialized (~4.8GB)' },
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
  'settings.imageAnalysisDesc': { ko: 'Vision 지원 모델 필요 (llava, Claude, GPT-4o, Gemini 등)', en: 'Requires Vision model (llava, Claude, GPT-4o, Gemini, etc.)' },
  'settings.ocrTitle': { ko: '스캔 PDF OCR', en: 'Scanned PDF OCR' },
  'settings.ocrLabel': { ko: '스캔 PDF 자동 텍스트 인식 (OCR)', en: 'Auto text recognition for scanned PDFs (OCR)' },
  'settings.ocrDesc': {
    ko: '텍스트를 추출할 수 없는 스캔 PDF에서 Vision 모델로 텍스트를 인식합니다. 페이지 수에 따라 시간과 API 비용이 증가할 수 있습니다.',
    en: 'Recognizes text in scanned PDFs using Vision models. Time and API costs increase with page count.',
  },
  'settings.answerVerificationTitle': { ko: 'Q&A 답변 검증', en: 'Q&A Answer Verification' },
  'settings.answerVerificationLabel': { ko: '답변 근거 자동 확인', en: 'Auto-verify answer sources' },
  'settings.answerVerificationDesc': {
    ko: '답변 초안을 원문에 대조해 환각(근거 없는 주장) 이 감지되면 자동으로 한 번 더 다듬어 정확도를 높입니다. 답변 시간이 약간 길어지고 임베딩 호출이 추가됩니다. (OpenAI 사용자는 소폭 비용 증가)',
    en: 'Cross-checks draft answers against the source and silently refines if hallucinations are detected. Slightly longer response time and extra embedding calls (minor OpenAI cost increase).',
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
  'setup.downloadBase': { ko: '기본 AI 모델 다운로드 ({model})', en: 'Download base AI model ({model})' },
  'setup.downloadKorean': { ko: '한국어 특화 AI 모델 다운로드 ({model})', en: 'Download Korean-specialized AI model ({model})' },
  'setup.downloadEmbed': { ko: 'RAG 임베딩 모델 다운로드 ({model})', en: 'Download RAG embedding model ({model})' },
  'setup.koreanOption': { ko: '한국어 특화 모델 함께 설치 ({model}, 약 4.8GB)', en: 'Also install the Korean-specialized model ({model}, ~4.8GB)' },
  'setup.koreanOptionDesc': { ko: '한국어 기반 자료를 주로 분석한다면 함께 설치하는 것을 권장합니다. 기본 모델(gemma3)도 한국어를 지원하지만, 한국어 요약 품질은 이 모델이 더 좋습니다. 나중에 설정 → 모델 관리에서 언제든 추가할 수 있습니다.', en: 'Recommended if you mainly analyze Korean documents. The base model (gemma3) also supports Korean, but this model produces better Korean summaries. You can add it anytime later in Settings → Model Management.' },
  'setup.checkingOllama': { ko: 'Ollama 설치 여부를 확인하고 있습니다...', en: 'Checking Ollama installation...' },
  'setup.installingOllama': { ko: 'Ollama를 다운로드하고 설치합니다. 관리자 권한 팝업이 나타나면 승인해주세요.', en: 'Downloading and installing Ollama. Please approve the admin prompt if it appears.' },
  'setup.ollamaInstallFail': { ko: 'Ollama 설치에 실패했습니다.', en: 'Failed to install Ollama.' },
  'setup.startingOllama': { ko: 'Ollama 서비스를 시작하고 있습니다...', en: 'Starting Ollama service...' },
  'setup.ollamaStartFail': { ko: 'Ollama 서비스를 시작할 수 없습니다. PC를 재시작하거나 수동으로 Ollama를 실행해주세요.', en: 'Cannot start Ollama service. Restart PC or start Ollama manually.' },
  'setup.downloadingModel': { ko: '{label}을 다운로드하고 있습니다. 모델 크기에 따라 수 분이 소요됩니다...', en: 'Downloading {label}. This may take a few minutes depending on model size...' },
  'setup.downloadingModelLabel.base': { ko: '기본 AI 모델({model})', en: 'base AI model ({model})' },
  'setup.downloadingModelLabel.korean': { ko: '한국어 특화 AI 모델({model})', en: 'Korean-specialized AI model ({model})' },
  'setup.downloadingModelLabel.embed': { ko: 'RAG 임베딩 모델({model})', en: 'RAG embedding model ({model})' },
  'setup.modelDownloadFail': { ko: '{model} 모델 다운로드에 실패했습니다.', en: 'Failed to download {model} model.' },
  'setup.noModels': { ko: '설치된 모델이 없습니다. 네트워크를 확인 후 다시 시도해주세요.', en: 'No models installed. Check network and try again.' },
  'setup.unknownError': { ko: '알 수 없는 오류가 발생했습니다.', en: 'An unknown error occurred.' },
  'setup.hint.notFound': { ko: 'Ollama를 찾을 수 없습니다.', en: 'Ollama not found.' },
  'setup.hint.installFail': { ko: '설치 중 오류가 발생했습니다. 관리자 권한 승인 여부와 네트워크를 확인하세요.', en: 'Installation error. Check admin permissions and network.' },
  'setup.hint.notRunning': { ko: 'Ollama 서비스가 시작되지 않았습니다. PC 재시작 후 다시 시도하세요.', en: 'Ollama service failed to start. Restart PC and try again.' },
  'setup.hint.modelNotFound': { ko: '모델을 찾을 수 없습니다. 네트워크 연결 후 다시 시도하세요.', en: 'Model not found. Check network and try again.' },
  'setup.hint.pullFail': { ko: '모델 다운로드 실패. 디스크 공간(기본 구성 최소 4GB, 한국어 특화 모델 포함 시 약 9GB)과 네트워크를 확인하세요.', en: 'Model download failed. Check disk space (min 4GB for the default setup, ~9GB with the Korean-specialized model) and network.' },
  'setup.downloadReady': { ko: '다운로드 준비 중...', en: 'Preparing download...' },
  // ─── main 프로세스 구조화 진행 이벤트 (R44: R43 후속 F3/F8) — translateMainProgress 가 매핑 ───
  'mainprog.downloadingInstaller': { ko: 'Ollama 인스톨러 다운로드 중...', en: 'Downloading the Ollama installer...' },
  'mainprog.verifyingDownload': { ko: '다운로드 무결성 검증 중...', en: 'Verifying download integrity...' },
  'mainprog.installerWindow': { ko: 'Ollama 설치 창이 열립니다. 설치를 완료해주세요...', en: 'The Ollama installer window will open. Please complete the installation...' },
  'mainprog.confirmingInstall': { ko: '설치 완료 확인 중...', en: 'Confirming installation...' },
  'mainprog.installingBrew': { ko: 'Ollama 설치 중 (Homebrew)...', en: 'Installing Ollama (Homebrew)...' },
  'mainprog.brewFallback': { ko: 'Homebrew 실패. 직접 다운로드 시도 중...', en: 'Homebrew failed. Trying direct download...' },
  'mainprog.pulling': { ko: '모델 다운로드 중... {percent}', en: 'Downloading model... {percent}' },
  'mainprog.pullingManifest': { ko: '모델 정보 확인 중...', en: 'Checking model info...' },
  'mainprog.verifying': { ko: '무결성 검증 중...', en: 'Verifying integrity...' },
  'mainprog.writing': { ko: '설치 마무리 중...', en: 'Finalizing installation...' },
  'mainprog.success': { ko: '다운로드 완료!', en: 'Download complete!' },
  'mainprog.preparing': { ko: '모델 다운로드 준비 중...', en: 'Preparing model download...' },
  // ─── main 프로세스 구조화 에러 (pullModel errorKey) — translateMainError 가 매핑 ───
  'mainerr.pullInProgress': { ko: '다른 모델 다운로드가 이미 진행 중입니다. 완료 후 다시 시도해주세요.', en: 'Another model download is already in progress. Please try again after it finishes.' },
  'mainerr.pullTimeout': { ko: '모델 다운로드 타임아웃 (30분). 네트워크를 확인 후 다시 시도해주세요.', en: 'Model download timed out (30 min). Check your network and try again.' },
  'mainerr.pullFailed': { ko: '모델 다운로드 실패: {detail}', en: 'Model download failed: {detail}' },
  'mainerr.pullCancelled': { ko: '모델 다운로드가 취소되었습니다.', en: 'Model download was cancelled.' },
  // R45(R44 후속): install 계열 에러도 errorKey 이행 — 영어 UI 에 한국어 설치 에러가 남던 잔존 경로
  'mainerr.unsupportedOs': { ko: '지원하지 않는 운영체제입니다.', en: 'Unsupported operating system.' },
  'mainerr.installerTooSmall': { ko: '다운로드 파일이 비정상적으로 작습니다 ({size} bytes). 네트워크를 확인 후 다시 시도해주세요.', en: 'The downloaded file is abnormally small ({size} bytes). Check your network and try again.' },
  'mainerr.signatureInvalid': { ko: 'Ollama 인스톨러 서명 검증에 실패했습니다 ({reason}). 안전을 위해 설치가 중단되었습니다. https://ollama.com 에서 직접 다운로드 후 수동 설치해주세요.', en: 'Ollama installer signature verification failed ({reason}). Installation was stopped for safety. Please download and install manually from https://ollama.com.' },
  'mainerr.installedButNotFound': { ko: 'Ollama 설치가 완료되었지만 실행 파일을 찾을 수 없습니다. PC를 재시작하거나 https://ollama.com 에서 수동 설치해주세요.', en: 'Ollama was installed but the executable could not be found. Restart your PC or install manually from https://ollama.com.' },
  'mainerr.installFailed': { ko: '설치 실패: {detail}. https://ollama.com 에서 수동 설치해주세요.', en: 'Installation failed: {detail}. Please install manually from https://ollama.com.' },
  'setup.manualInstall': { ko: '수동 설치:', en: 'Manual install:' },
  'setup.cancel': { ko: '취소하고 다른 Provider 사용', en: 'Cancel and use another provider' },

  // ─── 세션 영속화 (session-persistence) ───
  'recent.title': { ko: '최근 문서', en: 'Recent Documents' },
  'recent.empty': { ko: '저장된 세션이 없습니다. PDF를 분석하면 여기에 나타납니다.', en: 'No saved sessions yet. Analyzed PDFs will appear here.' },
  'recent.open': { ko: '열기', en: 'Open' },
  'recent.delete': { ko: '세션 삭제', en: 'Delete session' },
  'recent.pages': { ko: '{count}페이지', en: '{count} pages' },
  'recent.indexed': { ko: '인덱스 {count}청크', en: '{count} chunks indexed' },
  'recent.openFail': { ko: '문서를 열 수 없습니다. 원본 파일이 이동/삭제되었을 수 있습니다.', en: 'Could not open the document. The original file may have been moved or deleted.' },
  'recent.deleteFail': { ko: '세션을 삭제하지 못했습니다. 잠시 후 다시 시도하세요.', en: 'Could not delete the session. Please try again.' },
  'settings.dataSection': { ko: '세션 데이터', en: 'Session Data' },
  'settings.persistToggle': { ko: '세션·캐시 저장', en: 'Save sessions & cache' },
  'settings.persistDesc': { ko: '문서별 요약·Q&A·검색 인덱스를 저장해 다시 열 때 복원합니다 (재요약·재임베딩 없음).', en: 'Save summaries, Q&A, and the search index per document to restore them on reopen (no re-summarize/re-embed).' },
  'settings.storageUsage': { ko: '저장: 문서 {count}개 · {size}', en: 'Stored: {count} documents · {size}' },
  'settings.storageLocation': { ko: '위치: {dir}', en: 'Location: {dir}' },
  'settings.clearSessions': { ko: '전체 비우기', en: 'Clear all' },
  'settings.clearConfirm': { ko: '저장된 모든 세션을 삭제할까요? 되돌릴 수 없습니다.', en: 'Delete all saved sessions? This cannot be undone.' },
} as const;

type TranslationKey = keyof typeof _translations;

// ─── 템플릿 치환 ───

// 개발 중 누락 키/파라미터를 즉시 탐지하기 위한 dev-only 경고 (프로덕션 번들에서는 제거됨).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _isDev = typeof (import.meta as any)?.env?.DEV === 'boolean' ? (import.meta as any).env.DEV : false;
const _warnedMissingKeys = new Set<string>();
const _warnedMissingParams = new Set<string>();

function warnOnce(bucket: Set<string>, id: string, message: string): void {
  if (!_isDev) return;
  if (bucket.has(id)) return;
  bucket.add(id);
  console.warn(message);
}

function interpolate(template: string, params?: Record<string, string | number>, key?: string): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    // v0.18.19 patch R32 P3: `params[name] === undefined` 는 inherited 속성에 대해 false 인데,
    // `params['toString']` 같은 prototype 속성은 함수로 떨어져 `String(...)` 으로 함수 소스가
    // 템플릿에 주입되는 UI 오염 경로가 있었음. `Object.prototype.hasOwnProperty.call` 로
    // own property 만 카운트하여 prototype 누출 차단 (Surface 3 P4).
    //
    // v0.18.19 patch R34 P2 (R33 회귀 fix): hasOwnProperty 만 검사하면 own property 의 값이
    // `undefined` 인 경우 `String(undefined)` = `"undefined"` 가 UI 에 박혀 사용자가 missing
    // param 임을 식별 못함. 두 가드를 AND 로 결합 (Surface 3 P4).
    if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) {
      warnOnce(_warnedMissingParams, `${key ?? ''}:${name}`, `[i18n] missing param "${name}" for key "${key ?? '?'}"`);
      return `{${name}}`;
    }
    return String(params[name]);
  });
}

// ─── 번역 함수 ───

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const lang = useAppStore.getState().settings.uiLanguage || 'ko';
  const entry = _translations[key];
  if (!entry) {
    warnOnce(_warnedMissingKeys, key, `[i18n] missing translation key "${key}"`);
    // v0.18.19 patch R32 P3: production 에서도 raw 키가 UI 에 노출되던 결함 보완.
    // 미정의 키는 키 자체로 fallback 하되, 적어도 dot-segment 의 마지막 부분만 노출하여
    // 사용자가 `app.modelHint` 같은 내부 식별자 전체를 보는 경험을 약화. dev/prod 동일 동작.
    return key.split('.').pop() ?? key;
  }
  return interpolate(entry[lang] || entry['ko'], params, key);
}

// ─── main 프로세스 구조화 메시지 번역 (R44: R43 후속 F3/F8) ───

/** main 이 setup:progress 로 보내는 구조화 진행 이벤트 (ollama-pull-progress.ts 와 동형) */
export interface MainProgressEvent {
  key: string;
  params?: Record<string, string>;
  /** R45: 발신원 — 수신자가 자기 작업(install vs 특정 모델 pull)의 이벤트만 필터링 */
  source?: 'install' | 'pull';
  model?: string;
}

/**
 * 구조화 진행 이벤트 → 현재 UI 언어 문자열.
 * 'raw' 는 매핑 불가 원문 passthrough. 미지 키는 t() 의 missing-key 정책을 따른다.
 */
export function translateMainProgress(ev: MainProgressEvent): string {
  if (!ev || typeof ev !== 'object' || typeof ev.key !== 'string') return '';
  if (ev.key === 'raw') return ev.params?.text ?? '';
  return t(`mainprog.${ev.key}` as TranslationKey, ev.params);
}

/**
 * main 의 errorKey 동반 실패 결과 → 현재 UI 언어 에러 문자열.
 * errorKey 가 없으면(구버전/미매핑) main 의 error 원문 → 호출자 fallback 순.
 */
export function translateMainError(
  result: { error?: string; errorKey?: string; errorParams?: Record<string, string> },
  fallback: string,
): string {
  if (result.errorKey) return t(`mainerr.${result.errorKey}` as TranslationKey, result.errorParams);
  return result.error || fallback;
}

// ─── React 훅 ───

/**
 * 컴포넌트 내에서 반응형으로 번역을 읽는 훅.
 *
 * 반환 함수는 `lang` 이 변경될 때만 새 참조를 만든다 (useMemo 안정화).
 * 이 덕분에 `useEffect([..., tr])` 에 tr 를 포함해도 매 렌더 재실행되지 않는다.
 * 일반적으로 JSX 안에서 직접 `tr('key')` 로 사용하거나, effect deps 에 tr 를 포함시킨다.
 */
export function useT(): (key: TranslationKey, params?: Record<string, string | number>) => string {
  const lang = useAppStore((s) => s.settings.uiLanguage);
  return useMemo(() => {
    return (key: TranslationKey, params?: Record<string, string | number>) => {
      const entry = _translations[key];
      if (!entry) {
        warnOnce(_warnedMissingKeys, key, `[i18n] missing translation key "${key}"`);
        // R32 P3 (위 t() 와 동일 정책): 마지막 segment 만 fallback.
        return key.split('.').pop() ?? key;
      }
      return interpolate(entry[lang] || entry['ko'], params, key);
    };
  }, [lang]);
}

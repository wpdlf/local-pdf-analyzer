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
  'pdfviewer.jumpTimeout': { ko: '페이지 렌더링이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.', en: 'Page rendering is taking longer than expected. Please try again in a moment.' },
  'outline.title': { ko: '목차', en: 'Contents' },
  'outline.toggle': { ko: '목차 열기/닫기', en: 'Toggle contents' },
  'outline.jumpToPage': { ko: '{page}쪽으로 이동', en: 'Jump to page {page}' },
  'ai.generateFail': { ko: '요약 생성에 실패했습니다.', en: 'Failed to generate summary.' },
  'ai.requestFail': { ko: '요약 요청에 실패했습니다.', en: 'Failed to send summary request.' },
  'ai.streamInterrupted': { ko: 'AI 응답 수신이 중단되었습니다. 네트워크 연결과 AI 서비스 상태를 확인해주세요.', en: 'AI response stream interrupted. Please check your network connection and AI service status.' },
  // QA: use-summarize 가 직접 setError/throw 하던 하드코딩 한국어 → i18n(영어 UI 미번역 해소)
  'ai.imageAnalysisFail': { ko: '이미지 분석에 실패했습니다. Vision 모델을 확인해주세요.', en: 'Image analysis failed. Please check your Vision model.' },
  // QA6-D: 이미지 분석 OFF 로 파싱된 문서를 ON 전환 후 재요약 — 무음 no-op 대신 재오픈 안내
  'summary.imagesSkippedNotice': { ko: '이 문서는 이미지 분석이 꺼진 상태로 열려 이미지가 추출되지 않았습니다. 이미지 분석을 적용하려면 문서를 다시 열어주세요.', en: 'This document was opened with image analysis turned off, so no images were extracted. Reopen the document to apply image analysis.' },
  'summary.templateNotFound': { ko: '선택한 커스텀 요약 템플릿을 찾을 수 없습니다. 설정에서 삭제되었을 수 있어요.', en: 'The selected custom summary template was not found. It may have been deleted in settings.' },
  'summary.customTruncated': { ko: '문서가 길어 앞부분만으로 커스텀 요약을 생성했습니다. 뒷부분 내용은 포함되지 않았을 수 있어요.', en: 'The document is long, so the custom summary was generated from the beginning only. Later content may not be included.' },
  // Vision 실패 시 전체 요약을 막지 않고 텍스트 전용으로 강등할 때의 비차단 안내.
  'ai.imageAnalysisSkipped': { ko: '이미지 분석을 건너뛰고 텍스트만 요약했습니다 (Vision 모델 없음/실패 — llava 등 설치 시 이미지 포함).', en: 'Skipped image analysis and summarized text only (no/failed Vision model — install e.g. llava to include images).' },
  'ai.summaryTimeout': { ko: '요약 시간이 초과되었습니다. 생성된 부분까지 표시됩니다. 청크 크기를 줄이거나 경량 모델을 사용해보세요.', en: 'Summary timed out. The portion generated so far is shown. Try reducing chunk size or using a lighter model.' },
  'ai.ollamaNotRunning': { ko: 'Ollama가 실행 중이 아닙니다. 설정을 확인해주세요.', en: 'Ollama is not running. Please check your settings.' },
  'ai.apiKeyMissing': { ko: '{provider} API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.', en: '{provider} API key is not set. Please enter it in Settings.' },
  'ai.serviceUnavailable': { ko: 'AI 서비스를 사용할 수 없습니다.', en: 'AI service is unavailable.' },
  'ai.noText': { ko: '요약할 내용이 없습니다. PDF에서 유의미한 텍스트를 추출하지 못했습니다.', en: 'Nothing to summarize. No meaningful text could be extracted from the PDF.' },
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
  'app.removeFile': { ko: '현재 문서 닫기', en: 'Close current document' },
  'app.otherFile': { ko: '✕ 문서 닫기', en: '✕ Close document' },
  'app.startSummary': { ko: '📝 요약 시작', en: '📝 Summarize' },
  'app.openPdf': { ko: 'PDF 열기', en: 'Open PDF' },
  'app.openPdfHint': { ko: 'PDF 열기 (Ctrl+O)', en: 'Open PDF (Ctrl+O)' },
  'app.viewSummary': { ko: '📄 요약 보기 / Q&A 계속', en: '📄 View summary / Continue Q&A' },
  'app.reSummarize': { ko: '🔄 다시 요약', en: '🔄 Re-summarize' },
  'app.ollamaNotReady': { ko: 'Ollama가 실행 중이 아니거나 설치된 모델이 없습니다.', en: 'Ollama is not running or has no installed models.' },
  'app.openSettings': { ko: '설정 열기', en: 'Open settings' },
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
  // ─── handlePdfData 진입 가드(모든 파일 열기 경로 공통) ───
  'pdf.busyGenerating': { ko: '요약 진행 중에는 새 파일을 열 수 없습니다.', en: 'Cannot open a new file while summarizing.' },
  'pdf.busyQa': { ko: 'Q&A 답변 생성 중에는 새 파일을 열 수 없습니다.', en: 'Cannot open a new file while answering Q&A.' },
  'pdf.busyCollection': { ko: '컬렉션 요약 진행 중에는 새 파일을 열 수 없습니다.', en: 'Cannot open a new file while summarizing a collection.' },
  'pdf.busyCollectionOpen': { ko: '컬렉션을 여는 중에는 새 파일을 열 수 없습니다.', en: 'Cannot open a new file while opening a collection.' },
  'pdf.invalidFile': { ko: '유효한 PDF 파일이 아닙니다.', en: 'Not a valid PDF file.' },
  'pdf.encrypted': { ko: '암호로 보호된 PDF입니다. 암호를 해제한 후 다시 시도해주세요.', en: 'This PDF is password-protected. Please remove the password and try again.' },
  'uploader.tooManyPages': { ko: '페이지 수가 너무 많습니다 ({pages}p). 최대 {max}페이지까지 지원합니다. 문서를 분할해주세요.', en: 'Too many pages ({pages}p). Maximum {max} pages supported. Please split the document.' },
  // QA7(D-MED): 파싱 에러 3종 i18n 이행 — tooManyPages 와 동일 패턴(영어 UI 한국어 노출 해소)
  'uploader.emptyPdf': { ko: 'PDF에 페이지가 없습니다.', en: 'The PDF has no pages.' },
  'uploader.noText': { ko: 'PDF에서 텍스트를 추출할 수 없습니다. 설정에서 "스캔 PDF OCR"을 활성화하면 이미지 기반 PDF를 분석할 수 있습니다.', en: 'No text could be extracted from the PDF. Enable "Scanned PDF OCR" in Settings to analyze image-based PDFs.' },
  'uploader.ocrFail': { ko: 'OCR로도 텍스트를 추출할 수 없습니다. PDF 품질을 확인해주세요.', en: 'Text could not be extracted even with OCR. Please check the PDF quality.' },
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
  'uploader.orShortcut': { ko: '또는 Ctrl+O', en: 'or press Ctrl+O' },

  // ─── SummaryTypeSelector ───
  'selector.full': { ko: '전체 요약', en: 'Full summary' },
  'selector.chapter': { ko: '챕터별', en: 'By chapter' },
  'selector.keywords': { ko: '키워드 추출', en: 'Keywords' },
  'selector.summaryType': { ko: '요약 유형', en: 'Summary type' },
  'selector.summaryLang': { ko: '요약 언어', en: 'Output language' },
  // 출력언어 드롭다운의 'auto' 옵션. 나머지(한국어/English/日本語/中文)는 언어명 자체라 비번역.
  'selector.langAuto': { ko: '원문 유지', en: 'Keep original' },
  'selector.pageRange': { ko: '페이지 범위', en: 'Page range' },
  'selector.pageRangeAll': { ko: '전체', en: 'All' },
  'selector.pageRangeCustom': { ko: '범위 지정', en: 'Custom' },
  'selector.pageRangeTotal': { ko: '/ 총 {count}쪽', en: '/ {count} pages' },
  'selector.pageRangeAria': { ko: '시작 페이지', en: 'Start page' },
  'selector.pageRangeAriaEnd': { ko: '끝 페이지', en: 'End page' },
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
  'viewer.exportPdf': { ko: '📄 PDF', en: '📄 PDF' },
  'viewer.exportPdfAria': { ko: 'PDF 파일로 내보내기', en: 'Export as PDF file' },
  // 요약 마인드맵 — 텍스트/마인드맵 뷰 토글 + 마인드맵 UI
  'viewer.viewText': { ko: '📝 텍스트', en: '📝 Text' },
  'viewer.viewMindMap': { ko: '🗺 마인드맵', en: '🗺 Mind map' },
  'viewer.viewToggleAria': { ko: '요약 보기 방식 전환', en: 'Switch summary view' },
  'mindmap.title': { ko: '요약 마인드맵', en: 'Summary mind map' },
  'mindmap.empty': { ko: '제목(heading)이 없어 마인드맵을 만들 수 없습니다. 텍스트 보기를 사용하세요.', en: 'No headings found to build a mind map. Use the text view.' },
  'mindmap.expand': { ko: '펼치기', en: 'Expand' },
  'mindmap.collapse': { ko: '접기', en: 'Collapse' },
  'mindmap.untitled': { ko: '(제목 없음)', en: '(untitled)' },
  'viewer.pdfFail': { ko: 'PDF 내보내기에 실패했습니다. 다른 경로를 선택해주세요.', en: 'Failed to export PDF. Please choose a different path.' },

  // ─── QaChat ───
  'qa.header': { ko: '문서에 대해 질문하세요', en: 'Ask about the document' },
  'qa.indexing': { ko: 'RAG 인덱싱', en: 'RAG indexing' },
  'qa.chunkTooltip': { ko: '임베딩 모델: {model} | {count}개 청크', en: 'Embedding model: {model} | {count} chunks' },
  'qa.ragActive': { ko: 'RAG 시맨틱 검색이 활성화되었습니다. 문서에 대해 질문해보세요.', en: 'RAG semantic search is active. Ask a question about the document.' },
  'qa.emptyHint': { ko: '요약된 내용이나 원문에 대해 궁금한 점을 질문해보세요', en: 'Ask questions about the summary or original document' },
  'qa.generating': { ko: '답변 생성 중...', en: 'Generating answer...' },
  'qa.verifying': { ko: '답변 준비 중 (근거 확인)...', en: 'Preparing answer (checking sources)...' },
  'qa.answerFail': { ko: 'Q&A 답변 생성에 실패했습니다.', en: 'Failed to generate Q&A answer.' },
  'qa.waitIndexing': { ko: 'RAG 인덱싱 중입니다. 잠시 후 다시 시도해주세요.', en: 'RAG is indexing. Please wait a moment and try again.' },
  'qa.charLimit': { ko: '질문은 {max}자까지 입력 가능합니다 ({current}/{max})', en: 'Question limited to {max} characters ({current}/{max})' },
  'qa.placeholder': { ko: '질문을 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)', en: 'Type your question... (Enter: send, Shift+Enter: newline)' },
  'qa.inputAria': { ko: '질문 입력', en: 'Question input' },
  'qa.stopAria': { ko: '답변 중지', en: 'Stop answer' },
  'qa.answerCancelled': { ko: '(답변이 취소되었습니다)', en: '(Answer cancelled)' },
  // 비-abort 빈 응답(로컬 모델이 토큰 없이 done 등) 시 user 단독 orphan 방지용 placeholder.
  'qa.answerEmpty': { ko: '(답변을 생성하지 못했습니다)', en: '(No answer generated)' },
  'qa.sendAria': { ko: '질문 전송', en: 'Send question' },
  'qa.copyAnswer': { ko: '답변 복사', en: 'Copy answer' },
  'qa.copied': { ko: '복사됨', en: 'Copied' },
  // ─── 다중 문서 컬렉션 Q&A (multi-doc Phase 2) ───
  'collection.customTemplateNotApplied': { ko: '커스텀 요약 템플릿은 컬렉션 통합 요약에는 적용되지 않아 전체 요약으로 진행합니다.', en: 'Custom summary templates are not applied to collection summaries; using Full summary instead.' },
  'collection.toggle': { ko: '여러 문서에 걸쳐 질문', en: 'Ask across documents' },
  'collection.toggleHint': { ko: '열어둔 문서들을 묶어 함께 검색합니다', en: 'Search the open documents together' },
  'collection.members': { ko: '검색 대상 문서', en: 'Documents to search' },
  'collection.activeBadge': { ko: '현재', en: 'active' },
  'collection.statusModelMismatch': { ko: '임베딩 모델 불일치 — 검색 제외(요약은 가능)', en: 'embedding model mismatch — excluded from search (summary OK)' },
  'collection.statusNoIndex': { ko: '인덱스 없음 — 검색 제외(요약은 가능)', en: 'no index — excluded from search (summary OK)' },
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
  'collection.summaryNeedsMembers': { ko: '교차 요약은 문서가 2개 이상일 때 가능합니다.', en: 'Cross-document summary needs at least 2 documents.' },
  'collection.preparing': { ko: '교차 요약 준비 중…', en: 'Preparing cross-document summary…' },
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
  'status.running': { ko: '실행 중', en: 'Running' },
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
  'settings.keychainUnavailable': { ko: 'OS 키체인을 사용할 수 없어 API 키를 저장할 수 없습니다. OS 설정을 확인해주세요.', en: 'Cannot store the API key because the OS keychain is unavailable. Please check your OS settings.' },
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
  'settings.restarting': { ko: 'Ollama 재시작 중...', en: 'Restarting Ollama...' },
  'settings.restartOk': { ko: 'Ollama를 재시작했습니다.', en: 'Ollama restarted.' },
  'settings.restartFail': { ko: 'Ollama 재시작에 실패했습니다. 수동으로 시작해주세요.', en: 'Failed to restart Ollama. Please start it manually.' },
  'settings.restartUnmanaged': {
    ko: '외부에서 실행 중인 Ollama 라 앱이 재시작할 수 없습니다. Ollama 앱을 직접 종료 후 다시 실행해주세요.',
    en: 'Ollama is running outside this app, so it cannot be restarted from here. Please quit and relaunch the Ollama app yourself.',
  },
  'settings.theme': { ko: '테마', en: 'Theme' },
  'settings.themeLight': { ko: '라이트', en: 'Light' },
  'settings.themeDark': { ko: '다크', en: 'Dark' },
  'settings.themeSystem': { ko: '시스템', en: 'System' },
  'settings.language': { ko: '언어', en: 'Language' },
  'settings.chunkSize': { ko: '청크 크기', en: 'Chunk size' },
  'settings.customTemplates': { ko: '커스텀 요약 템플릿', en: 'Custom Summary Templates' },
  'settings.customTemplatesDesc': { ko: '나만의 프롬프트로 요약 방식을 정의하세요. 요약 유형 선택에 기본 3종과 함께 표시됩니다.', en: 'Define your own summary prompts. They appear alongside the 3 built-in types in the summary type selector.' },
  'settings.templateName': { ko: '템플릿 이름', en: 'Template name' },
  'settings.templateNamePlaceholder': { ko: '예: 액션 아이템 추출', en: 'e.g. Extract action items' },
  'settings.templatePrompt': { ko: '템플릿 프롬프트', en: 'Template prompt' },
  'settings.templatePromptPlaceholder': { ko: '예: 다음 문서에서 실행해야 할 작업을 목록으로 뽑아줘.', en: 'e.g. List the action items that need to be done from the following document.' },
  'settings.templateDelete': { ko: '템플릿 삭제', en: 'Delete template' },
  'settings.templateAdd': { ko: '템플릿 추가', en: 'Add template' },
  'settings.templateStrategy': { ko: '처리 방식', en: 'Processing' },
  'settings.templateStrategySingle': { ko: '단일 패스 (빠름 · 긴 문서 일부 생략)', en: 'Single pass (fast; long docs partly skipped)' },
  'settings.templateStrategyChunked': { ko: '청크+통합 (긴 문서 전체 커버 · 느림)', en: 'Chunk & integrate (covers long docs; slower)' },
  'settings.templateIncomplete': { ko: '템플릿의 이름과 프롬프트를 모두 입력하세요. (한쪽만 채운 항목은 저장되지 않습니다)', en: 'Enter both a name and a prompt for each template. (Entries with only one filled are not saved.)' },
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
  'settings.aiBusyNotice': {
    ko: '⚙️ AI 생성 중입니다. 테마·언어 등은 바로 바꿀 수 있지만, AI Provider·모델·Ollama URL·청크 크기는 진행이 끝난 뒤 변경할 수 있습니다.',
    en: '⚙️ AI is generating. Theme/language can be changed now, but AI provider, model, Ollama URL, and chunk size are locked until it finishes.',
  },
  'settings.noChanges': { ko: '변경 사항 없음', en: 'No changes' },
  'settings.notInstalled': { ko: '미설치', en: 'Not installed' },

  // ─── OllamaSetupWizard ───
  'setup.title': { ko: 'PDF 자료 분석기 설정', en: 'PDF Analyzer Setup' },
  'setup.desc': { ko: '이 앱은 로컬 AI(Ollama)를 사용하여 PDF 자료를 요약합니다.', en: 'This app uses local AI (Ollama) to summarize PDF documents.' },
  'setup.autoInstall': { ko: '아래 항목이 자동으로 설치됩니다:', en: 'The following will be installed automatically:' },
  'setup.start': { ko: '설정 시작', en: 'Start setup' },
  'setup.done': { ko: '모든 설정이 완료되었습니다!', en: 'Setup complete!' },
  'setup.otherProvider': { ko: '다른 AI Provider 사용', en: 'Use other AI Provider' },
  'setup.statusPending': { ko: '대기 중', en: 'pending' },
  'setup.statusRunning': { ko: '진행 중', en: 'in progress' },
  'setup.statusDone': { ko: '완료', en: 'done' },
  'setup.statusError': { ko: '실패', en: 'failed' },
  'setup.languageGroup': { ko: '언어', en: 'Language' },
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
  // QA7: AI 스트리밍 에러 errorKey — 이전엔 ai-service 가 한국어 원문만 실어 영어 UI 에 노출됐다.
  'mainerr.cloudQuota': { ko: '{provider} 사용 한도(쿼터)를 초과했습니다. 결제·플랜을 확인한 뒤 다시 시도해주세요.', en: 'Your {provider} usage quota has been exceeded. Check your billing/plan and try again.' },
  'mainerr.cloudRateLimit': { ko: '{provider} 요청 한도를 초과했습니다 (rate limit). 잠시 후 다시 시도해주세요.', en: '{provider} rate limit exceeded. Please try again in a moment.' },
  'mainerr.cloudOverloaded': { ko: '{provider} 서버가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도해주세요.', en: '{provider} servers are temporarily overloaded. Please try again in a moment.' },
  'mainerr.apiKeyMissing': { ko: '{provider} API 키가 설정되지 않았습니다.', en: 'No {provider} API key is configured.' },
  'mainerr.apiKeyInvalid': { ko: 'API 키가 유효하지 않습니다.', en: 'The API key is not valid.' },
  'mainerr.responseBlocked': { ko: 'AI 응답이 차단되었습니다 (사유: {reason}). 문서 내용 또는 출력 한도를 확인해주세요.', en: 'The AI response was blocked (reason: {reason}). Check the document content or output limits.' },
  // QA8(B-MED): 토큰 0개로 정상 종료(HTTP 200)한 스트림 — Gemini 는 blockReason 으로 잡혔지만
  // Claude/OpenAI 는 content_filter/빈 delta 로 조용히 빈 요약을 "완료"로 표시했다(무음 no-op).
  'mainerr.emptyResponse': { ko: 'AI 가 빈 응답을 반환했습니다. 잠시 후 다시 시도하거나 요약 유형·문서를 확인해주세요.', en: 'The AI returned an empty response. Please retry, or check the summary type and document.' },
  'mainerr.streamNoResponse': { ko: 'AI 서버 응답이 중단되었습니다 (60초 무응답).', en: 'The AI server stopped responding (no data for 60s).' },
  'mainerr.streamDisconnected': { ko: 'AI 스트림 연결이 끊어졌습니다.', en: 'The AI stream connection was lost.' },
  'mainerr.streamTimeout': { ko: 'AI 서버 응답 타임아웃 (5분).', en: 'The AI server response timed out (5 min).' },
  'mainerr.streamConnectFailed': { ko: 'AI 서버에 연결할 수 없습니다. 서버가 실행 중인지, 주소와 네트워크가 올바른지 확인해주세요.', en: 'Could not connect to the AI server. Check that it is running and that the address and network are correct.' },
  'mainerr.streamTooLarge': { ko: 'AI 응답이 너무 커서 중단했습니다 (50MB 초과). 문서 범위를 좁히거나 다른 모델을 시도해주세요.', en: 'The AI response was too large and was stopped (over 50MB). Narrow the document range or try a different model.' },
  'mainerr.streamLineTooLarge': { ko: 'AI 응답이 손상되어 중단했습니다 (비정상적으로 큰 데이터). 잠시 후 다시 시도해주세요.', en: 'The AI response was malformed and was stopped (abnormally large data). Please try again in a moment.' },
  'mainerr.apiHttpError': { ko: 'API 요청 실패: HTTP {status}', en: 'API request failed: HTTP {status}' },

  // ─── 세션 영속화 (session-persistence) ───
  'recent.title': { ko: '최근 문서', en: 'Recent Documents' },
  'recent.empty': { ko: '저장된 세션이 없습니다. PDF를 분석하면 여기에 나타납니다.', en: 'No saved sessions yet. Analyzed PDFs will appear here.' },
  'recent.open': { ko: '열기', en: 'Open' },
  'recent.delete': { ko: '세션 삭제', en: 'Delete session' },
  'recent.pages': { ko: '{count}페이지', en: '{count} pages' },
  'recent.indexed': { ko: '인덱스 {count}청크', en: '{count} chunks indexed' },
  'recent.openFail': { ko: '문서를 열 수 없습니다. 원본 파일이 이동/삭제되었을 수 있습니다.', en: 'Could not open the document. The original file may have been moved or deleted.' },
  'recent.deleteFail': { ko: '세션을 삭제하지 못했습니다. 잠시 후 다시 시도하세요.', en: 'Could not delete the session. Please try again.' },
  // 전체 문서 검색 (cross-session search)
  'search.title': { ko: '문서 검색', en: 'Search documents' },
  'search.placeholder': { ko: '저장된 모든 문서에서 검색...', en: 'Search across all saved documents...' },
  'search.button': { ko: '검색', en: 'Search' },
  'search.searching': { ko: '검색 중...', en: 'Searching...' },
  'search.noResults': { ko: '"{query}"에 대한 결과가 없습니다.', en: 'No results for "{query}".' },
  'search.resultsCount': { ko: '검색 결과 {count}건', en: '{count} results found' },
  'search.inSummary': { ko: '요약 포함', en: 'in summary' },
  'search.page': { ko: 'p.{page}', en: 'p.{page}' },
  'search.summaryLabel': { ko: '요약', en: 'Summary' },
  'search.modeLabel': { ko: '검색 모드', en: 'Search mode' },
  'search.modeKeyword': { ko: '키워드', en: 'Keyword' },
  'search.modeSemantic': { ko: '의미', en: 'Semantic' },
  'search.modeHint': { ko: '키워드: 정확한 단어 / 의미: 비슷한 내용까지 (임베딩)', en: 'Keyword: exact terms / Semantic: similar meaning (embeddings)' },
  'search.noEmbedModel': { ko: '의미 검색은 임베딩 모델이 필요합니다 — Ollama에서 nomic-embed-text를 설치하거나 키워드 검색을 사용하세요.', en: 'Semantic search needs an embedding model — install nomic-embed-text in Ollama or use keyword search.' },
  'search.embedFailed': { ko: '질의 임베딩에 실패했습니다. 잠시 후 다시 시도하세요.', en: 'Failed to embed the query. Please try again.' },
  'search.excluded': { ko: '임베딩 모델이 다른 {count}개 문서는 제외됨', en: '{count} document(s) excluded (different embedding model)' },
  'search.cloudEmbedBadge': { ko: '🌐 {provider}로 전송', en: '🌐 Sent to {provider}' },
  'search.cloudEmbedTooltip': { ko: '의미 검색은 검색어와 문서 내용을 임베딩하기 위해 {provider} 서버로 전송합니다. 로컬에서만 처리하려면 Ollama 임베딩 모델을 사용하세요.', en: 'Semantic search sends your query and document text to {provider} servers for embedding. Use an Ollama embedding model to keep it fully local.' },
  'settings.dataSection': { ko: '세션 데이터', en: 'Session Data' },
  'settings.persistToggle': { ko: '세션·캐시 저장', en: 'Save sessions & cache' },
  'settings.persistDesc': { ko: '문서별 요약·Q&A·검색 인덱스를 저장해 다시 열 때 복원합니다 (재요약·재임베딩 없음).', en: 'Save summaries, Q&A, and the search index per document to restore them on reopen (no re-summarize/re-embed).' },
  'settings.storageUsage': { ko: '저장: 문서 {count}개 · {size}', en: 'Stored: {count} documents · {size}' },
  'settings.storageLocation': { ko: '위치: {dir}', en: 'Location: {dir}' },
  'settings.clearSessions': { ko: '전체 비우기', en: 'Clear all' },
  'settings.clearConfirm': { ko: '저장된 모든 세션을 삭제할까요? 되돌릴 수 없습니다.', en: 'Delete all saved sessions? This cannot be undone.' },
  // ─── 자동 업데이트 (electron-updater) ───
  'update.section': { ko: '앱 업데이트', en: 'App Updates' },
  'update.currentVersion': { ko: '현재 버전 {version}', en: 'Current version {version}' },
  'update.autoCheckLabel': { ko: '시작할 때 새 버전 확인', en: 'Check for updates on startup' },
  'update.autoCheckDesc': {
    ko: '확인만 자동으로 하고, 다운로드는 항상 사용자가 승인한 뒤에 시작합니다.',
    en: 'Only the check is automatic — downloads always start after you approve them.',
  },
  'update.checkBtn': { ko: '지금 확인', en: 'Check now' },
  'update.checking': { ko: '업데이트 확인 중...', en: 'Checking for updates...' },
  'update.upToDate': { ko: '최신 버전을 사용 중입니다.', en: 'You are on the latest version.' },
  // QA19(D-LOW): 보간 파라미터 뒤에 조사를 붙이면 항상 비문이 된다("… 0.31.32 을") — 버전
  // 끝자리 발음의 받침 유무로 을/를이 갈리는데 사전에는 조사 처리기가 없다. 조사를 쓰지 않는
  // 어순(괄호 부기)으로 통일하고, 버전 미상일 때를 위한 무-버전 변형을 함께 둔다.
  'update.available': { ko: '새 버전을 사용할 수 있습니다 ({version})', en: 'A new version is available ({version})' },
  'update.availableNoVersion': { ko: '새 버전을 사용할 수 있습니다.', en: 'A new version is available.' },
  'update.downloadBtn': { ko: '다운로드', en: 'Download' },
  'update.downloading': { ko: '다운로드 중... {percent}%', en: 'Downloading... {percent}%' },
  // QA19(D-MED): 라이브 영역(role="status")에는 퍼센트를 넣지 않는다 — 정수 1단위로 갱신돼
  // 스크린리더가 최대 100회 낭독한다. 숫자는 progressbar 의 aria-valuenow 와 시각 텍스트에만.
  'update.downloadingLive': { ko: '업데이트를 다운로드하고 있습니다.', en: 'Downloading the update…' },
  'update.downloadProgressAria': { ko: '업데이트 다운로드 진행률', en: 'Update download progress' },
  'update.downloaded': { ko: '{version} 설치 준비 완료 — 재시작하면 적용됩니다.', en: 'Version {version} is ready — restart to apply.' },
  'update.installBtn': { ko: '재시작하여 설치', en: 'Restart and install' },
  'update.installNotice': {
    ko: '설치 중 앱이 종료됩니다. 작업 중인 요약·Q&A 는 종료 전에 저장됩니다.',
    en: 'The app will close to install. Summaries and Q&A in progress are saved before it closes.',
  },
  'update.unsupported': {
    ko: '자동 업데이트는 설치된 Windows 앱에서만 동작합니다 (개발 실행 중에는 비활성).',
    en: 'Auto-update works only in the installed Windows app (disabled while running from source).',
  },
  'update.bannerReady': { ko: '새 버전이 설치 준비되었습니다 ({version})', en: 'A new version is ready to install ({version})' },
  'update.bannerReadyNoVersion': { ko: '새 버전이 설치 준비되었습니다.', en: 'A new version is ready to install.' },
  // QA19(A-MED): 설치는 앱을 종료시키므로 생성 중에는 막는다(세션 삭제와 동일 등급의 파괴적 조작).
  'update.installBlockedBusy': { ko: '요약·답변 생성이 끝난 뒤 설치할 수 있습니다.', en: 'You can install once the summary/answer finishes.' },
  'update.bannerDismiss': { ko: '업데이트 알림 닫기', en: 'Dismiss update notice' },
  // main updater errorKey (mainerr.* 규약) — classifyUpdateError 가 반환하는 4종
  'mainerr.updateNetwork': {
    ko: '업데이트 서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해주세요.',
    en: 'Could not reach the update server. Check your network and try again.',
  },
  'mainerr.updateNoFeed': {
    ko: '업데이트 정보를 찾을 수 없습니다. 잠시 후 다시 시도하거나 GitHub 릴리즈에서 직접 내려받아주세요.',
    en: 'No update information was found. Try again later or download it directly from the GitHub releases page.',
  },
  'mainerr.updateChecksum': {
    ko: '다운로드한 파일의 무결성 검증에 실패했습니다. 다시 시도해주세요.',
    en: 'The downloaded file failed its integrity check. Please try again.',
  },
  'mainerr.updateUnknown': { ko: '업데이트에 실패했습니다.', en: 'The update failed.' },
  'mainerr.updateInstallFailed': {
    ko: '설치를 시작하지 못했습니다. 내려받은 설치 파일이 백신에 격리되었거나 삭제되었을 수 있습니다 — 다시 다운로드하거나 릴리즈 페이지에서 직접 설치해주세요.',
    en: 'The installer could not be started. The downloaded file may have been quarantined by antivirus or removed — download it again, or install manually from the releases page.',
  },
  'session.saveFailedNotice': { ko: '세션 저장에 반복 실패했습니다. 저장 공간·권한을 확인해주세요 — 요약·Q&A·검색 인덱스가 디스크에 보존되지 않아 다시 열면 사라집니다.', en: 'Session saving keeps failing. Check disk space/permissions — summaries, Q&A, and the search index are not being persisted and will be lost on reopen.' },
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

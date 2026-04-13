// 페이지별 추출 이미지
export interface PageImage {
  pageIndex: number;
  imageIndex: number;
  base64: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}

// Q&A 메시지
export interface QaMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

// PDF 문서 정보
export interface PdfDocument {
  id: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  extractedText: string;
  pageTexts: string[];
  chapters: Chapter[];
  images: PageImage[];
  createdAt: Date;
  isOcr?: boolean;
}

// 챕터 (페이지 기반 분할)
export interface Chapter {
  index: number;
  title: string;
  startPage: number;   // 1-based inclusive (첫 페이지 번호)
  endPage: number;     // slice용 exclusive 경계 (중간 챕터: 다음 챕터 시작 인덱스, 마지막 챕터: pages.length)
  text: string;
}

// 요약 결과 — Q&A는 대화 메시지에 저장되므로 Summary의 type은 DefaultSummaryType만 가능
export interface Summary {
  id: string;
  documentId: string;
  type: DefaultSummaryType;
  content: string;
  model: string;
  provider: AiProviderType;
  createdAt: Date;
  durationMs: number;
}

// 요약 진행 상세 정보
export interface ProgressInfo {
  percent: number;             // 0-100
  phase: 'image' | 'summarize' | 'integrate'; // 현재 단계
  current: number;             // 현재 처리 중인 항목 번호
  total: number;               // 전체 항목 수
  chapterName?: string;        // 챕터 모드 시 현재 챕터명
  elapsedMs: number;           // 경과 시간 (ms)
  estimatedRemainingMs?: number; // 예상 남은 시간 (ms)
}

// 요약 유형 (런타임 요청 타입) — 'qa' 는 Q&A 채팅 전용이며 설정으로 저장되지 않음
export type SummaryType = 'full' | 'chapter' | 'keywords' | 'qa';

// 설정에 저장 가능한 기본 요약 유형 — 'qa'는 대화형 요청이므로 기본값으로 지정 불가
export type DefaultSummaryType = 'full' | 'chapter' | 'keywords';

// 앱 UI 언어
export type UiLanguage = 'ko' | 'en';
export const UI_LANGUAGES: { value: UiLanguage; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
];

// 요약 출력 언어
export type SummaryLanguage = 'ko' | 'en' | 'ja' | 'zh' | 'auto';
export const SUMMARY_LANGUAGES: { value: SummaryLanguage; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
  { value: 'auto', label: '원문 유지' },
];

// AI 제공자
export type AiProviderType = 'ollama' | 'claude' | 'openai';

// 앱 설정 (API 키는 Main 프로세스에서만 관리)
export interface AppSettings {
  provider: AiProviderType;
  model: string;
  ollamaBaseUrl: string;
  theme: 'light' | 'dark' | 'system';
  uiLanguage: UiLanguage;
  defaultSummaryType: DefaultSummaryType;
  maxChunkSize: number;
  enableImageAnalysis: boolean;
  enableOcrFallback: boolean;
  summaryLanguage: SummaryLanguage;
}

// Provider별 대표 모델
export const PROVIDER_MODELS: Record<AiProviderType, { label: string; value: string }[]> = {
  ollama: [], // 동적으로 로드
  claude: [
    { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
  ],
  openai: [
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o mini', value: 'gpt-4o-mini' },
  ],
};

// Ollama 상태
export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  models: string[];
  selectedModel?: string;
}

// RAG 인덱싱 상태
export interface RagIndexState {
  isIndexing: boolean;
  progress: { current: number; total: number } | null;
  isAvailable: boolean;  // 임베딩 모델 사용 가능 여부
  model: string | null;  // 사용 중인 임베딩 모델
  chunkCount: number;     // 인덱싱된 청크 수
}

// 에러 코드
export type AppErrorCode =
  | 'PDF_PARSE_FAIL'
  | 'PDF_NO_TEXT'
  | 'PDF_TOO_MANY_PAGES'
  | 'OLLAMA_NOT_FOUND'
  | 'OLLAMA_NOT_RUNNING'
  | 'OLLAMA_INSTALL_FAIL'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_PULL_FAIL'
  | 'GENERATE_FAIL'
  | 'GENERATE_TIMEOUT'
  | 'EXPORT_FAIL'
  | 'OCR_FAIL'
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID'
  | 'SETTINGS_SAVE_FAIL';

export interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string;
}

// 한국어 성능이 우수한 Ollama 추천 모델
export const KOREAN_RECOMMENDED_MODELS = ['gemma3', 'qwen2.5', 'exaone3.5'];

// 초기 설치 시 함께 다운로드할 모델 (한국어 PDF 요약 특화)
export const INITIAL_INSTALL_MODELS = ['gemma3', 'exaone3.5', 'nomic-embed-text'] as const;

// 기본 설정값
export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'ollama',
  model: 'gemma3',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  uiLanguage: 'ko',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
  enableImageAnalysis: true,
  enableOcrFallback: true,
  summaryLanguage: 'ko' as SummaryLanguage,
};

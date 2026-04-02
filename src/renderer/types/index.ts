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

// 요약 결과
export interface Summary {
  id: string;
  documentId: string;
  type: SummaryType;
  content: string;
  model: string;
  provider: AiProviderType;
  createdAt: Date;
  durationMs: number;
}

// 요약 유형
export type SummaryType = 'full' | 'chapter' | 'keywords' | 'qa';

// AI 제공자
export type AiProviderType = 'ollama' | 'claude' | 'openai';

// 앱 설정 (API 키는 Main 프로세스에서만 관리)
export interface AppSettings {
  provider: AiProviderType;
  model: string;
  ollamaBaseUrl: string;
  theme: 'light' | 'dark' | 'system';
  defaultSummaryType: SummaryType;
  maxChunkSize: number;
  enableImageAnalysis: boolean;
  enableOcrFallback: boolean;
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

// 에러 코드
export type AppErrorCode =
  | 'PDF_PARSE_FAIL'
  | 'PDF_NO_TEXT'
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
export const INITIAL_INSTALL_MODELS = ['gemma3', 'exaone3.5'] as const;

// 기본 설정값
export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'ollama',
  model: 'gemma3',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
  enableImageAnalysis: true,
  enableOcrFallback: true,
};

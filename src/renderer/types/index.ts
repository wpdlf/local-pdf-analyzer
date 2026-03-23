// PDF 문서 정보
export interface PdfDocument {
  id: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  extractedText: string;
  chapters: Chapter[];
  createdAt: Date;
}

// 챕터 (페이지 기반 분할)
export interface Chapter {
  index: number;
  title: string;
  startPage: number;
  endPage: number;
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
export type SummaryType = 'full' | 'chapter' | 'keywords';

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
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID';

export interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string;
}

// 한국어 성능이 우수한 Ollama 추천 모델
export const KOREAN_RECOMMENDED_MODELS = ['gemma3', 'qwen2.5', 'exaone3.5'];

// 기본 설정값
export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'ollama',
  model: 'llama3.2',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
};

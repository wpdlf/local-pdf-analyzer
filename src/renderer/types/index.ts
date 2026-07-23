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
  /**
   * v0.18.6 D4: 시스템성 메타 메시지 표식.
   * - `'cancelled'` — 비실질 placeholder(사용자 취소, 또는 비-abort 빈 응답)로 추가된
   *   assistant 메시지. user 단독 orphan 을 막아 짝 FIFO 불변식을 유지하면서, formatHistory
   *   빌더가 LLM 컨텍스트에서 제외한다(안내 문구가 다음 턴 컨텍스트로 주입되는 오염 방지).
   * 일반 LLM 응답이나 사용자 입력에는 설정되지 않는다.
   */
  meta?: 'cancelled';
  /**
   * M3(UX): 컬렉션 교차 검색이 제한되어 일부 문서로만 답한 강등 답변 표식.
   * 이전엔 전역 단일 슬롯 notice 배너로 띄워 다른 알림에 덮이거나 어느 답변에 해당하는지
   * 모호했다. 이제 해당 assistant 메시지에 실어 답변 바로 아래 인라인 표시한다.
   */
  degraded?: boolean;
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
  /**
   * QA6-D: 파싱 당시 이미지 분석 설정이 OFF 라 이미지 추출을 스킵했다는 마커.
   * 이후 설정을 ON 으로 바꿔 재요약해도 images=[] 라 Vision 이 무음 no-op 이 되는데,
   * 텍스트-only PDF 의 정당한 0장과 구분해 "재오픈 필요" 안내를 띄우기 위해 필요.
   */
  imagesSkipped?: boolean;
}

// 챕터 (페이지 기반 분할)
export interface Chapter {
  index: number;
  title: string;
  startPage: number;   // 1-based inclusive (첫 페이지 번호)
  endPage: number;     // slice용 exclusive 경계 (중간 챕터: 다음 챕터 시작 인덱스, 마지막 챕터: pages.length)
  text: string;
}

// 요약 결과 — Q&A는 대화 메시지에 저장되므로 Summary의 type은 요약 선택(ActiveSummaryType)만 가능
export interface Summary {
  id: string;
  documentId: string;
  type: ActiveSummaryType;
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

// 요약 유형 (런타임 요청 타입) — 'qa' 는 Q&A 채팅 전용, 'custom' 은 커스텀 템플릿(customPrompt 동반).
// 둘 다 설정 기본값(defaultSummaryType)으로는 저장되지 않는다.
export type SummaryType = 'full' | 'chapter' | 'keywords' | 'qa' | 'custom';

// 설정에 저장 가능한 기본 요약 유형 — 'qa'는 대화형 요청이므로 기본값으로 지정 불가
export type DefaultSummaryType = 'full' | 'chapter' | 'keywords';

// 커스텀 템플릿 요약 전략:
//  - 'single' : 문서 앞부분을 단일 패스로 처리(빠름, 긴 문서는 예산 초과분 절단). 홀리스틱 지시에 적합.
//  - 'chunked': 문서 전체를 청크로 나눠 각각 커스텀 프롬프트로 요약 후, 결합 요약에 프롬프트를 한 번 더
//               적용해 통합(긴 문서 전부 커버·느림). "빠짐없이 추출" 류에 적합.
// 미지정(기존 템플릿)은 'single' 로 간주(하위호환).
export type SummaryStrategy = 'single' | 'chunked';

// 커스텀 요약 템플릿 — 사용자 정의 이름+프롬프트. summaries 캐시·세션에는 `custom:<id>` 키로 참조.
export interface SummaryTemplate {
  id: string;
  name: string;
  prompt: string;
  strategy?: SummaryStrategy;
}
// 활성 요약 선택 — 기본 3종 또는 커스텀 템플릿(`custom:<id>`). store.summaryType·summaries 캐시·
// 세션 영속 키로 사용. 커스텀은 단일 패스(전체 문서)로 생성되며 chunk/chapter 파이프라인을 타지 않는다.
export type ActiveSummaryType = DefaultSummaryType | `custom:${string}`;
// 커스텀 템플릿 제약 — 프로토타입 오염/과대 페이로드 방지(설정 검증과 공유).
export const MAX_CUSTOM_TEMPLATES = 20;
export const MAX_TEMPLATE_NAME_LEN = 60;
export const MAX_TEMPLATE_PROMPT_LEN = 4000;
export function isCustomSummaryType(t: string): t is `custom:${string}` {
  return t.startsWith('custom:');
}

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
export type AiProviderType = 'ollama' | 'claude' | 'openai' | 'gemini';

// provider 표시 이름 — StatusBar/설정 토스트 공용 단일 출처.
// R43 I-1: StatusBar 의 3-provider ternary 가 gemini 를 'OpenAI' 로 표시하던 결함의 재발 방지.
export const PROVIDER_LABELS: Record<AiProviderType, string> = {
  ollama: 'Ollama',
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

/**
 * Ollama 설치 목록의 `name[:tag]` 항목이 베이스 모델명과 일치하는지 콜론 경계로 판정.
 * R43 F1: 단순 startsWith 는 'gemma3' 가 실존 모델 'gemma3n:e4b' 와 오매칭되어
 * 첫 설치가 스킵되고 기본 모델이 미설치 상태로 남는 결함이 있었다.
 */
export function matchesModel(installed: string, base: string): boolean {
  return installed === base || installed.startsWith(base + ':');
}

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
  // 커스텀 요약 템플릿 목록(사용자 정의 프롬프트). 요약 유형 선택기에 기본 3종과 함께 노출된다.
  customSummaryTemplates: SummaryTemplate[];
  // Q&A 답변 검증 — 답변 초안을 RAG 인덱스와 대조해 환각 의심 문장이 있으면 refine 한 번 더.
  // 사용자에게는 여전히 단일 답변만 표시되며 배지/스코어는 노출하지 않음 — 내부적으로 정확성만 개선.
  // OFF 하면 기존 단일 pass 스트리밍 (빠르지만 환각 위험 높음).
  enableAnswerVerification: boolean;
  // session-persistence: 문서별 요약·Q&A·RAG 인덱스를 콘텐츠 해시 기준으로 영속화.
  // OFF 시 저장/복원 전체 skip(프라이버시/디스크 민감 사용자용). 기본 ON.
  persistSessions: boolean;
  // 자동 업데이트: 앱 기동 시 새 버전 존재 여부만 확인한다(다운로드는 항상 사용자 승인 후).
  // OFF 시 설정의 "지금 확인" 수동 버튼만 동작. 패키징 빌드 + Windows 에서만 의미가 있다.
  autoCheckUpdates: boolean;
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
  gemini: [
    { label: 'Gemini 3.5 Flash', value: 'gemini-3.5-flash' },
    { label: 'Gemini 3.1 Flash-Lite', value: 'gemini-3.1-flash-lite' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
  ],
};

// Ollama 상태
export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  models: string[];
  selectedModel?: string;
  /**
   * QA18(C-MED): 앱이 직접 spawn 해 관리 중인 프로세스인지. false 면 외부(로그인 시 자동 실행된
   * `ollama app.exe` 등)에서 돌고 있어 앱의 stop/start 가 no-op 이다 — "재시작" 성공 오보고 방지.
   */
  managed?: boolean;
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
  | 'PDF_ENCRYPTED'
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
  | 'SETTINGS_SAVE_FAIL'
  // 컬렉션 전용 코드(R48 LOW): PDF_PARSE_FAIL/GENERATE_FAIL 재사용은 메시지는 맞아도 code 가
  // 의미와 어긋나 텔레메트리/분기를 오도한다. 실패 출처를 명확히 하도록 전용 코드 분리.
  | 'COLLECTION_OPEN_FAIL'
  | 'COLLECTION_SAVE_FAIL'
  | 'COLLECTION_SUMMARY_FAIL';

export interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string;
}

// 한국어 성능이 우수한 Ollama 추천 모델 — "보급형 크기(3~5GB)" 큐레이션.
// R45: qwen2.5 → qwen3.5:4b 세대교체. 태그를 명시하는 이유: bare 'qwen3.5' 는 기본 태그
// (9b, 6.6GB)로 설치돼 목록의 크기 대역을 벗어난다. 소비자 매칭 주의 — App.tsx 힌트는
// 베이스명 비교이므로 항목의 베이스(`split(':')[0]`)와 대조해야 한다.
// gemma4 는 최소 변형이 7.2GB(e2b)라 보류 — 소형 변형 출시 시 재검토.
export const KOREAN_RECOMMENDED_MODELS = ['gemma3', 'qwen3.5:4b', 'exaone3.5'];

// 초기 설치 시 반드시 다운로드할 모델 (범용 요약 + RAG 임베딩, 약 3.6GB).
// exaone3.5(약 4.8GB)는 한국어 특화 품질 부스터라 첫 설치에서 선택 옵션으로 분리 —
// App.tsx 의 ensureDefaultModels 백그라운드 재설치 대상에서도 제외된다.
export const INITIAL_INSTALL_MODELS = ['gemma3', 'nomic-embed-text'] as const;

// 첫 설치 마법사에서 선택 설치로 제공하는 한국어 특화 모델.
// 미설치 시에도 설정 → 모델 관리에서 언제든 추가 가능.
export const OPTIONAL_KOREAN_MODEL = 'exaone3.5';

// ─── 다중 문서 탭 (multi-doc Phase 1) ───
// 탭은 메타데이터만 보관 — 무거운 상태(요약/Q&A/RAG 인덱스/pdfBytes)는 활성 문서 1개만
// 메모리에 유지하고, 전환 시 세션 영속화(persist→재오픈→해시 복원)로 즉시 복원한다.
// 키는 filePath: 같은 파일 재오픈 시 탭 중복을 막고, 전환 시 file:open-path 재읽기에 사용.
export interface OpenTab {
  /** 탭 식별자 겸 재오픈 경로. DOM 드롭(dev)은 파일명만일 수 있어 전환 실패 시 에러로 안내 */
  filePath: string;
  fileName: string;
  pageCount: number;
  /**
   * 콘텐츠 해시 — 세션 복원 흐름이 채움. 파일 재읽기가 실패해도(경로가 이름뿐/파일 이동)
   * 영속 세션에서 직접 복원하는 전환 fallback 의 키 (뷰어만 비활성, 분석은 전부 복원).
   */
  docHash?: string;
}

// ─── 다중 문서 컬렉션 Q&A (multi-doc Phase 2) ───
// Design Ref: docs/02-design/features/multi-doc-collection-qa.design.md §3

/** 컬렉션 Q&A 모드 상태 (Zustand store). 멤버는 openTabs 의 부분집합(docHash 기준) */
export interface CollectionState {
  enabled: boolean;       // 컬렉션 Q&A 모드 on/off (기본 off — 단일 문서 Q&A 보존)
  memberHashes: string[]; // 질의 대상 docHash 부분집합
}

/** 멤버 동질성 게이트 산출 — 검색 가능 여부와 사유를 UI 배지로 표시 */
export interface ResolvedMember {
  docHash: string;
  fileName: string;
  source: 'memory' | 'session';                              // 활성(메모리) vs 비활성(세션 로드)
  status: 'ready' | 'no-index' | 'model-mismatch' | 'missing';
}

/** 컬렉션 검색 결과 — 단일 문서 SearchResult 에 출처(문서) 식별자 부착 */
export interface CollectionSearchResult {
  text: string;
  score: number;
  index: number;
  pageStart?: number;
  pageEnd?: number;
  docHash: string;
  fileName: string;
}

// ─── 세션 영속화 (session-persistence) ───
// Design Ref: §3 — 콘텐츠 해시 기준 세션·인덱스 캐싱. 본문 도메인 타입은 여기,
// manifest/stats primitive 메타는 src/shared/session-types.ts.

/** index.bin 의 벡터 순서와 1:1 평행한 청크 메타 (벡터 본체는 바이너리 블롭) */
export interface PersistedChunkMeta {
  text: string;
  index: number;
  pageStart?: number;
  pageEnd?: number;
}

/** VectorStore 직렬화 결과 — 메타는 JSON, 정규화 벡터는 ArrayBuffer(Float32) */
export interface SerializedIndex {
  model: string | null;
  dimension: number | null;
  chunkMeta: PersistedChunkMeta[];
  buffer: ArrayBuffer; // chunkMeta.length × dimension floats (row-major, unit-normalized)
}

/** 타입별 저장 요약 */
export interface PersistedSummary {
  content: string;
  model: string;
  provider: AiProviderType;
}

/** userData/sessions/<docHash>/session.json — 벡터 본체는 index.bin 에 분리 저장 */
export interface PersistedSession {
  schemaVersion: number;
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  // 파싱 텍스트 (재파싱 없이 Q&A 컨텍스트 복원). images 는 미저장(용량·Vision 캐싱은 Out of Scope)
  extractedText: string;
  pageTexts: string[];
  chapters: Chapter[];
  isOcr?: boolean;
  // 분석 결과 — 커스텀 템플릿 요약은 `custom:<id>` 키로 캐시(기존 세션에 추가적·하위호환).
  summaries: Partial<Record<ActiveSummaryType, PersistedSummary>>;
  summaryType: ActiveSummaryType;
  qaMessages: QaMessage[];
  // 인덱스 메타 (벡터 본체는 index.bin)
  embedModel: string | null;
  embedDim: number | null;
  chunkMeta: PersistedChunkMeta[];
}

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
  customSummaryTemplates: [],
  enableAnswerVerification: true,
  persistSessions: true,
  autoCheckUpdates: true,
};

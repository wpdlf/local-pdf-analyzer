import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfDocument, Chapter, PageImage, AppError } from '../types';
import { useAppStore } from './store';
import { t } from './i18n';
import { restoreSessionForDocument, persistCurrentSession } from './use-session';
import { confirmDiscardIfNotPersisted } from './discard-policy';
import { MAX_PDF_SIZE_BYTES } from '../../shared/constants';
// Vite의 ?url 쿼리를 사용해 worker 파일을 정적 에셋으로 번들링.
// bare specifier + import.meta.url 패턴은 Vite에서 dev/build 동작이 다를 수 있어
// 패키지된 Electron(ASAR)에서 worker 로드 실패 위험이 있음. ?url은 명시적 에셋 처리.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// pdfjs-dist 지연 로딩(성능): 콜드스타트 eager 번들에서 pdfjs(메인스레드 API ~425KB raw)를
// 제거 — 실제로 PDF 를 파싱/렌더할 때만 동적 로드한다. 워커 경로는 최초 로드 시 1회 설정
// (idempotent). PdfViewer 도 이 로더를 재사용해 워커 설정 단일 출처를 유지한다.
// (worker 파일 자체는 ?url 정적 자산이라 별도 emit — 본 분할과 무관.)
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return mod;
    }).catch((err: unknown) => {
      // QA22(B-LOW): **실패한 promise 를 캐시에 남기지 않는다.** 이전에는 rejected promise 가
      // 그대로 보관돼, 일시적 실패(청크 로드 네트워크 오류·메모리 압박) 한 번이면 이후
      // parsePdf·PdfViewer·extractPageImages 가 전부 같은 에러로 즉시 실패하고 **앱 재시작
      // 전까지 어떤 PDF 도 열 수 없었다** — 재시도 수단이 아예 없는 영구 정지
      // (QA18 의 "IPC 타임아웃 abort 자멸 → 영구정지" 와 동형 클래스).
      // null 로 되돌리면 다음 호출이 새 import 를 시도해 스스로 회복한다.
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

/**
 * 문서의 filePath 가 디스크에서 재읽기 가능한 실경로인지 — pdfBytes 비상주(메모리 M1) 판정용.
 *
 * 모든 정상 진입 경로(IPC 드롭 file.path / 다이얼로그 result.path / DOM 드롭 getPathForFile /
 * 최근목록·탭 openPath)는 절대경로를 준다. DOM 드롭에서 getPathForFile 이 실패할 때만 `file.name`
 * (경로 구분자 없는 합성명)으로 fallback 하는데, 이건 file:open-path 로 재읽기가 불가능하다.
 * 파일명에는 `/`·`\` 가 들어갈 수 없으므로 "경로 구분자 유무"가 재읽기 가능성의 견고한 신호.
 */
export function isReReadablePath(filePath: string): boolean {
  return /[\\/]/.test(filePath);
}

export interface ParsePdfOptions {
  enableOcrFallback?: boolean;
  onOcrProgress?: (current: number, total: number) => void;
  /**
   * 페이지 이미지 추출 여부(기본 true). false 면 페이지당 getOperatorList(pdfjs 최고비용 호출)
   * + 이미지 디코딩/base64(최대 50장)를 통째로 건너뛴다. 추출된 images 는 Vision 분석
   * (enableImageAnalysis)에서만 소비되므로, 분석 OFF 시엔 순수 낭비 — 그때 false 로 전달.
   */
  extractImages?: boolean;
  /** 사용자 취소 지원. aborted 시 다음 배치/OCR 페이지 진입 직전에 ABORTED 에러로 조기 종료. */
  signal?: AbortSignal;
}

// 페이지 수 상한 — 대용량 PDF의 자원 폭주 방지.
// 텍스트/이미지 추출 + 선택적 OCR 파이프라인이 페이지 수에 선형/병렬로 확장되므로
// 수천 페이지 문서는 메모리/시간 모두 비현실적. 사용자에게 분할을 안내.
export const MAX_PAGE_COUNT = 500;

/** AbortSignal aborted 시 ABORTED 코드가 붙은 에러를 throw */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('PDF 처리가 취소되었습니다.'), { code: 'ABORTED' });
  }
}

/**
 * v0.18.20 R32 P2: OCR per-page requestId 발급. 클라우드 OCR (Claude/OpenAI) 경로에서
 * 사용자가 Stop 을 눌렀을 때 in-flight IPC 호출을 main 측에서 즉시 끊을 수 있도록 함.
 * 이전엔 다음 배치만 차단되고 진행 중인 8건은 ~90s 까지 토큰 청구가 계속됐다.
 */
function generateOcrRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `ocr-${crypto.randomUUID()}`;
    }
  } catch { /* fallthrough */ }
  return `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 이미지의 문서 내 동일성 판정 키(순수). 같은 로고가 매 페이지에 반복되는 경우를 걸러내
 * Vision 예산(MAX_TOTAL_IMAGES)이 앞 페이지에서 소진되는 것을 막는다.
 *
 * base64 전체를 해시하면 수 MB × 50장을 다시 훑어야 하므로, **크기 + base64 의 앞·뒤 표본**으로
 * 시그니처를 만든다. PNG/JPEG 는 헤더·팔레트가 앞쪽에, 픽셀 데이터 끝이 뒤쪽에 오므로 같은
 * 이미지끼리는 일치하고 다른 이미지끼리 충돌할 확률은 실질적으로 무시할 수 있다.
 * (충돌해도 결과는 "이미지 한 장을 분석에서 제외" 이지 오답이 아니다.)
 */
export function imageSignature(img: Pick<PageImage, 'base64' | 'width' | 'height' | 'mimeType'>): string {
  const b = img.base64;
  const head = b.slice(0, 64);
  const tail = b.length > 128 ? b.slice(-64) : '';
  return `${img.mimeType}|${img.width}x${img.height}|${b.length}|${head}|${tail}`;
}

/** pdfjs TextItem 중 본 조립기가 쓰는 필드만 (테스트가 최소 픽스처로 구동할 수 있도록). */
export interface TextItemLike {
  str?: string;
  transform?: number[] | null;
  width?: number;
  /**
   * pdfjs 가 계산해 주는 줄바꿈 표식(TextItem 계약). worker 가 **회전각을 역보정하고 textRise 를
   * 보정한 뒤** 판정하므로, 좌표로 재추정하는 것보다 정확하다(QA23 C-MED).
   */
  hasEOL?: boolean;
}

/**
 * 페이지 텍스트 조립 — 아이템의 텍스트 행렬 위치로 공백/줄바꿈을 복원한다.
 *
 * pdfjs 는 한 줄을 여러 아이템으로 쪼개 주고(특히 한글은 글자 단위로 쪼개지는 경우가 많다) 공백·
 * 줄바꿈을 문자열에 담아주지 않는다. 그래서 좌표로 복원하는데, 이 로직은 **추출 품질의 뿌리**
 * (요약·인용·검색·RAG 가 전부 이 결과를 본다)면서도 parsePdf 의 배치 루프 안에 인라인이라
 * 테스트가 한 건도 없었다(QA22 가 "그 루프에 테스트 0건이라 위험" 으로 수정을 보류한 지점).
 * 순수 함수로 분리해 회귀 넷을 세우고, 아래 회전 텍스트 결함을 그 넷 위에서 고친다.
 *
 * 텍스트 행렬 tx = [a, b, c, d, e, f] — 글자 크기 s, 회전 θ 이면 [s·cosθ, s·sinθ, -s·sinθ, s·cosθ].
 */
export function assemblePageText(items: readonly unknown[]): string {
  const parts: string[] = [];
  /** 직전 아이템의 기하 정보 — 다음 아이템과의 관계를 **그 줄의 좌표계**로 판정하기 위해 보관. */
  let prev: {
    x: number; y: number;
    /** 문자 진행 방향 단위벡터(회전 반영). 회전 없으면 (1, 0). */
    dirX: number; dirY: number;
    /** 진행 방향으로의 전진량(= 이 아이템이 차지한 길이). */
    advance: number;
    fontSize: number;
    hasEOL: boolean;
  } | null = null;

  /**
   * QA24(A-M1): 직전에 만난 **빈 줄**(단락 경계) 개수.
   *
   * pdfjs 는 EOL 을 두 형태로 낸다(pdf.worker.mjs `appendEOL`): 누적 중이면 그 아이템에
   * `hasEOL=true` 를 실어 flush 하고, **누적이 없으면**(= 연속 줄바꿈 = 빈 줄)
   * `{ str: "", width: 0, transform, hasEOL: true }` 를 단독으로 push 한다.
   * 종전 필터 `!item.str` 은 후자를 통째로 버렸다 — 즉 **단락 경계 신호만 정확히 폐기**했다.
   *
   * 그 결과 페이지 안에서 `'\n\n'` 이 **한 번도 생성되지 않았고**, `split(/\n\n+/)` 를 쓰는
   * 요약 단락 라벨링(use-summarize)과 청킹(chunker)이 "한 페이지 = 항상 한 단락"을 봤다.
   * QA23 이 Tier3(splitLongParagraph)·Tier4(codepoint 오버랩)로 대증치료한 조건이 실은
   * 모든 페이지에 해당했던 것이다. 그 두 방어는 긴 단락에 여전히 필요하므로 그대로 둔다.
   */
  let pendingBlankLines = 0;

  // pdfjs 의 items 는 TextItem | TextMarkedContent 혼합이라 str 유무로 걸러낸다.
  for (const raw of items) {
    const item = raw as TextItemLike | null;
    if (!item || typeof item.str !== 'string') continue;
    if (!item.str) {
      // 빈 문자열 아이템은 텍스트를 기여하지 않지만, hasEOL 이면 **빈 줄**이라는 신호다.
      // prev 가 없으면(페이지 선두) 앞에 붙일 것이 없으므로 무시한다.
      if (item.hasEOL === true && prev) pendingBlankLines += 1;
      continue;
    }
    const tx = item.transform ?? null;
    if (!tx) {
      // transform이 없으면 공백 연결 fallback
      if (parts.length > 0) parts.push(pendingBlankLines > 0 ? '\n\n' : ' ');
      parts.push(item.str);
      pendingBlankLines = 0;
      prev = null;
      continue;
    }
    const x = tx[4] ?? 0;
    const y = tx[5] ?? 0;
    const a = tx[0] ?? 0;
    const b = tx[1] ?? 0;
    // QA22 백로그: 이전엔 `|a| || |d| || 12` 였다. 90°/270° 회전 텍스트는 a=d=0 이고 크기가
    // b·c 에 들어가므로 **실제 크기와 무관하게 12 로 폴백**됐다. hypot(a,b) = 문자 진행 방향의
    // 실제 배율이라 회전각과 무관하게 정확하고, 회전 없는 경우([s,0,0,s])는 |a| 와 동일하다.
    const fontSize = Math.hypot(a, b) || Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || 12;
    // 진행 방향 단위벡터. 퇴화 행렬(크기 0)은 종전과 같이 가로쓰기로 본다.
    const dirLen = Math.hypot(a, b);
    const dirX = dirLen > 0 ? a / dirLen : 1;
    const dirY = dirLen > 0 ? b / dirLen : 0;
    const advance = item.width ?? item.str.length * fontSize * 0.5;

    if (prev) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      // 직전 줄의 좌표계로 분해: along = 문자 진행 방향, perp = 그 수직(= 줄이 바뀌는 방향).
      // QA23(C-MED): 이전에는 이 둘을 각각 x·y 로 **고정**해 놓아, 90° 회전 텍스트에서 글자
      // 진행(= y 이동)이 전부 줄바꿈으로 판정됐다("정확도" → "정\n확\n도"). 그러면 그 라벨은
      // 검색·인용·RAG 에서 사실상 존재하지 않는 것과 같아진다.
      const along = dx * prev.dirX + dy * prev.dirY;
      const perp = Math.abs(dx * -prev.dirY + dy * prev.dirX);
      // QA23(C-MED): 임계 글꼴은 **두 아이템 중 큰 쪽**이다. 이전에는 현재 아이템 기준이라,
      // 각주 번호·수식 첨자(6~7pt)가 나오면 임계가 3~3.5 로 좁아져 본문 베이스라인으로
      // 돌아오는 4pt 이동이 **문장 한가운데서 줄바꿈**으로 오판됐다(국문 교재·논문에서 페이지마다
      // 발생). 줄의 정체성은 본문 글꼴이 정한다.
      const scale = Math.max(prev.fontSize, fontSize);
      // pdfjs 가 준 hasEOL 이 1차 신호다 — worker 가 회전·textRise 를 보정한 뒤 판정한 값이라
      // 좌표 재추정보다 정확하다. 기하 판정은 그 필드가 없는 입력(합성 픽스처·구버전)용 보강.
      // QA24(A-M1): 빈 줄 신호가 있으면 줄바꿈을 **단락 경계**로 승격한다(`'\n\n'`).
      // 빈 줄이 여러 개여도 두 줄로 정규화한다 — 단락 분리에는 그것으로 충분하고, 장식용
      // 여백이 많은 문서에서 개행이 폭증해 청크 예산을 잠식하는 것을 막는다.
      if (prev.hasEOL || pendingBlankLines > 0 || perp > scale * 0.5) {
        parts.push(pendingBlankLines > 0 ? '\n\n' : '\n');
      } else if (along > prev.advance + scale * 0.3) {
        // 같은 줄에서 간격이 있으면 공백 (한글 글자 단위 분할은 간격이 좁아 붙는다)
        parts.push(' ');
      }
    }

    parts.push(item.str);
    pendingBlankLines = 0;
    prev = { x, y, dirX, dirY, advance, fontSize, hasEOL: item.hasEOL === true };
  }

  return parts.join('');
}

/**
 * 텍스트가 비어 있는 페이지 수 — 순수. 통지 여부 판정과 테스트가 공유한다.
 * 10% 초과이면서 2장 이상일 때만 유의미로 본다(표지·간지 한두 장은 정상).
 */
export function countEmptyPages(pageTexts: readonly string[]): { empty: number; total: number; significant: boolean } {
  const total = pageTexts.length;
  const empty = pageTexts.filter((p) => isBlankOcrPage(p)).length;
  return { empty, total, significant: total > 0 && empty >= 2 && empty / total > 0.1 };
}

/**
 * QA29(C-1/C-2): "이 페이지는 아무것도 얻지 못했다" 의 단일 판정(순수).
 * OCR 회로차단기(진행 중)와 최종 실패 판정, 그리고 위 통지 판정이 **같은 기준**을 보도록 한다.
 */
export function isBlankOcrPage(text: string | undefined | null): boolean {
  return !text || text.replace(/\s+/g, '').length === 0;
}

/**
 * QA29(C-1): **연속 전량공란 배치** 상한 = 3.
 *
 * 1~2 로 두면 오탐이 실제로 가능하다 — 스캔본의 간지·사진 전용 페이지가 배치 하나를 통째로
 * 채우는 일은 흔하고, 클라우드 429 가 짧게 한 배치를 쓸어가는 일도 있다. 3 배치 연속으로
 * **단 한 글자도** 못 얻는 것은 그런 우연으로 설명되지 않는다(= runner 고착·자격증명 만료·
 * 모델 미탑재 같은 지속 상태). 비용 상한도 함께 본다: Ollama BATCH_SIZE=3 × callVision
 * timeoutMs 90s 기준 최악 3×3×90s ≈ 13분에서 끊긴다(종전엔 300페이지 = 100배치 ≈ 2.5시간
 * 동안 isParsing 게이트가 요약·Q&A·컬렉션을 잠갔다).
 */
export const OCR_BLANK_BATCH_STREAK_LIMIT = 3;

/**
 * QA29(C-2): 문서 전체에서 허용하는 **공란 페이지 비율** 상한 = 30%.
 *
 * 종전 판정은 `ocrText.trim().length < 50` 이라는 절대 문자수 하나였다. 300페이지 중 앞 10장만
 * OCR 된 뒤 Ollama 가 죽어도 그 10장이 50자를 가볍게 넘으므로 파싱은 **성공**으로 끝나고,
 * 자동저장이 나머지 290장의 빈 pageTexts 를 같은 docHash 의 **디스크 세션 위에 덮어썼다**
 * (재드롭은 handlePdfData 경로라 세션-우선 복원이 없다 — tabs.ts 의 탭 전환 전용).
 * 30% 는 "정상 스캔본의 간지·사진 페이지"(경험적으로 한 자릿수 %)와 "파이프라인이 도중에
 * 죽었다"(대개 절반 이상 공란) 사이의 넉넉한 분리선이다. 10~30% 구간은 종전대로 부분 실패
 * 통지(pdf.ocrPartialFailNotice)만 띄운다 — 두 임계가 겹치지 않게 맞춰 둔 값이기도 하다.
 */
export const OCR_BLANK_PAGE_RATIO_LIMIT = 0.3;

/**
 * 비율 판정의 **절대 하한**. 2페이지 문서의 간지 1장(50%)처럼 표본이 너무 작아 비율이
 * 의미를 갖지 못하는 경우를 배제한다(통지 판정의 `empty >= 2` 와 같은 이유·같은 값).
 */
export const OCR_BLANK_PAGE_MIN_COUNT = 2;

export type OcrAbortReason = 'blankStreak' | 'blankRatio' | null;

export interface OcrHealthObservation {
  /** 직전까지 **연속으로 전 페이지가 공란**이던 배치 수. */
  consecutiveBlankBatches: number;
  /** 지금까지 OCR 을 마친 페이지 수(공란 포함). */
  processedPages: number;
  /** 그중 공란으로 돌아온 페이지 수. */
  blankPages: number;
}

/**
 * QA29(C-1/C-2): OCR 중단 판정 — **순수**. 관측치를 주입받아 결정만 내린다
 * (update-policy.ts / window-flush-policy.ts / isSummaryTimedOut 과 같은 분리 원칙).
 * 파이프라인을 모킹하지 않고도 경계값을 단위 테스트로 고정할 수 있다.
 *
 * - `'inProgress'`(배치 루프): 연속 전량공란 스트릭만 본다. 진행 중 비율은 표본이 앞쪽에
 *   치우쳐 있어 정상 문서(표지 몇 장이 먼저 나오는 스캔본)를 오탐할 수 있다.
 * - `'final'`(전 페이지 완료): 스트릭 + 전체 공란 비율.
 *
 * 반환값이 null 이 아니면 호출자는 OCR_FAIL 로 중단한다 — **아무것도 영속되지 않는다**는
 * 것이 이 판정의 핵심 계약이다(부분 결과를 성공으로 저장하면 온전한 세션을 파괴한다).
 */
export function ocrAbortReason(
  obs: OcrHealthObservation,
  phase: 'inProgress' | 'final',
): OcrAbortReason {
  if (obs.consecutiveBlankBatches >= OCR_BLANK_BATCH_STREAK_LIMIT) return 'blankStreak';
  if (phase !== 'final') return null;
  if (obs.processedPages <= 0) return null;
  if (obs.blankPages < OCR_BLANK_PAGE_MIN_COUNT) return null;
  if (obs.blankPages / obs.processedPages > OCR_BLANK_PAGE_RATIO_LIMIT) return 'blankRatio';
  return null;
}

/**
 * 비어 있는(텍스트 미추출) 페이지가 유의미하게 많으면 1회 통지. 무음 손실을 표면화하는 용도라
 * 임계를 낮게 두되, 표지·간지 몇 장이 비어 있는 정상 문서에서 과알림이 되지 않도록 비율을 본다.
 */
export function notifyEmptyPages(
  pageTexts: readonly string[],
  key: 'pdf.emptyPagesNotice' | 'pdf.ocrPartialFailNotice',
): void {
  const { empty, total, significant } = countEmptyPages(pageTexts);
  if (!significant) return;
  try {
    useAppStore.getState().setNotice({
      message: t(key, { count: String(empty), total: String(total) }),
    });
  } catch { /* 테스트/비-store 환경 — best-effort */ }
}

export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  filePath: string,
  options?: ParsePdfOptions,
): Promise<PdfDocument> {
  const signal = options?.signal;
  // 하위호환: 미지정이면 종전대로 추출(true).
  const extractImages = options?.extractImages !== false;
  throwIfAborted(signal);

  const pdfjs = await loadPdfjs();
  // pdfjs 6.x: PDFDocumentProxy.destroy() 가 제거되어 문서 파기는 loadingTask 를 통해야 한다.
  // (loadingTask.destroy() 가 워커 연결 + 문서를 함께 해제) → loadingTask 참조를 보관.
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: './cmaps/',
    cMapPacked: true,
  });
  // QA13(C-MED): loadingTask.promise 가 reject(암호화·손상 PDF)하면 아래 try/finally 진입 전에
  // throw 되어 loadingTask.destroy() 가 호출되지 않아 pdfjs 워커 스레드/문서가 세션 내내 누수됐다
  // (encrypted/corrupt 파일을 반복 열면 워커 누적). reject 시 명시적으로 파기하고 재던진다.
  // 또한 PasswordException 은 사용자에게 "암호 보호" 를 알리는 전용 로컬라이즈 코드로 매핑한다
  // (기존엔 generic PDF_PARSE_FAIL + pdfjs 영어 원문 노출).
  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => { /* ignore */ });
    if ((err as { name?: string })?.name === 'PasswordException') {
      throw Object.assign(new Error(t('pdf.encrypted')), { code: 'PDF_ENCRYPTED' });
    }
    throw err;
  }
  throwIfAborted(signal);
  const pageCount = pdf.numPages;

  // QA(low): 아래 검증 throw 는 try/finally 진입 전이라 pdf.destroy() 가 호출되지 않았다.
  // 워커측 PDFDocumentProxy 누수를 막기 위해 throw 전에 명시적으로 파기한다.
  if (pageCount === 0) {
    await loadingTask.destroy().catch(() => { /* ignore */ });
    throw Object.assign(new Error(t('uploader.emptyPdf')), { code: 'PDF_NO_TEXT' });
  }
  if (pageCount > MAX_PAGE_COUNT) {
    await loadingTask.destroy().catch(() => { /* ignore */ });
    // R43: 한국어 하드코딩 → i18n 키 사용 (영어 UI 사용자도 현재 언어로 에러를 보도록).
    // t() 는 store 의 uiLanguage 를 읽는 순수 함수라 hook 컨텍스트 불필요.
    throw Object.assign(
      new Error(t('uploader.tooManyPages', { pages: String(pageCount), max: String(MAX_PAGE_COUNT) })),
      { code: 'PDF_TOO_MANY_PAGES' },
    );
  }

  // 배치 병렬 처리 (한 번에 10페이지씩)
  const BATCH_SIZE = 10;
  const pages: string[] = new Array(pageCount).fill('');
  const allImages: PageImage[] = [];
  // QA22(B-MED): 이미 담은 이미지의 시그니처 — 문서 내 반복 이미지(로고·머리말 장식) 제외용.
  const seenImageSignatures = new Set<string>();
  // 문서 전체에서 검사한 이미지 수(채택 여부 무관) — 위 shouldExtractMoreImages 의 두 번째 예산.
  const imageStats = { examined: 0 };
  // QA28(B2-Low → QA22 배선 누락): QA22 가 `pdf.imageBudgetNotice` 문구를 추가하고 "안내도 뜨지
  // 않았다" 고 적었지만 방출자가 없어 한 번도 표시되지 않았다. 예산 초과(신규 이미지가 남은 슬롯보다
  // 많음)를 관측해 handlePdfData 가 파싱 완료 후 고지한다.
  let imageBudgetExceeded = false;

  try {
    for (let batchStart = 0; batchStart < pageCount; batchStart += BATCH_SIZE) {
      // 취소 체크 — 배치 사이에 조기 종료
      throwIfAborted(signal);
      const batchEnd = Math.min(batchStart + BATCH_SIZE, pageCount);
      const promises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        // 페이지별 에러 격리: 한 페이지의 손상(깨진 xref, 미지원 폰트, 악성 content stream)이
        // 전체 파싱을 중단시키지 않도록 catch 내부에서 빈 문자열로 대체.
        // ABORTED 는 상위 취소 흐름이 처리하므로 재throw.
        promises.push(
          pdf.getPage(i + 1).then(async (page) => {
            // 이미지 추출 — 캡 검사를 Promise 진입 시점에 수행 (R28: 배치 동시성으로 캡이 우회되지 않도록)
            // 같은 배치의 다른 페이지 promise가 이미 캡을 채웠을 수 있으므로 await 진입 직전에 재확인.
            const imagePromise = (async (): Promise<PageImage[]> => {
              // perf: 이미지 분석 OFF면 추출 자체를 건너뛴다(getOperatorList + 디코딩/base64 낭비 제거).
              if (!extractImages) return [];
              // QA23(C-MED): 채택 수뿐 아니라 **검사 수**도 예산이다. 채택되지 않는 이미지(고해상
              // 스캔 거절·중복 로고)만 반복되면 채택 수가 영원히 차지 않아 500페이지 전부에
              // getOperatorList + 전체 디코딩이 돌았다.
              if (!shouldExtractMoreImages(allImages.length, imageStats.examined)) return [];
              try {
                return await extractPageImages(page, i, imageStats);
              } catch {
                return [];
              }
            })();

            const textContent = await page.getTextContent();
            pages[i] = assemblePageText(textContent.items);

            const pageImages = await imagePromise;
            // 푸시 직전 잔여 슬롯 확인 — 다른 페이지 promise가 그동안 푸시했을 수 있으므로
            // 슬롯을 초과하지 않도록 잘라낸 후 추가 (이미지 1장당 base64 수 MB → OOM 방지)
            const remainingSlots = MAX_TOTAL_IMAGES - allImages.length;
            if (remainingSlots > 0 && pageImages.length > 0) {
              // QA22(B-MED): **문서 내 중복 이미지 제거.** 이 앱의 대표 입력인 강의자료는 모든
              // 슬라이드 상단에 같은 로고가 박혀 있는 경우가 흔한데, 배치가 페이지 오름차순으로
              // 돌며 선착순으로 슬롯을 먹으므로 앞 5~10페이지의 로고 반복만으로 50장 예산이
              // 소진됐다 — 뒷부분의 실제 차트·수식·다이어그램이 **한 장도** Vision 에 가지 않고,
              // 클라우드면 로고 50장 분석 비용까지 낸다. imagesSkipped 마커는 "설정 OFF" 전용이라
              // 안내도 뜨지 않았다.
              const fresh = pageImages.filter((img) => {
                const sig = imageSignature(img);
                if (seenImageSignatures.has(sig)) return false;
                seenImageSignatures.add(sig);
                return true;
              });
              if (fresh.length > remainingSlots) imageBudgetExceeded = true;
              if (fresh.length > 0) allImages.push(...fresh.slice(0, remainingSlots));
            } else if (pageImages.length > 0 && remainingSlots <= 0) {
              // 슬롯이 이미 0 인데 이 페이지에 이미지가 있었다 — 중복 여부와 무관하게 예산 초과로 본다
              // (중복만 남았을 가능성은 있지만 앞서 채택된 50장이 이미 한도라는 사실은 같다).
              imageBudgetExceeded = true;
            }

            // 페이지 내부 리소스 해제 — 대용량 PDF에서 누적 메모리 상승 방지
            // (텍스트/이미지 추출이 모두 끝난 시점에 호출해야 안전)
            try { page.cleanup(); } catch (err) {
              console.warn(`[pdf-parser] page.cleanup() 실패 (page ${i + 1}):`, err);
            }
          }).catch((err: unknown) => {
            if ((err as { code?: string })?.code === 'ABORTED') throw err;
            console.warn(`[pdf-parser] page ${i + 1} 파싱 실패, 빈 페이지로 대체:`, err);
            pages[i] = '';
          }),
        );
      }
      await Promise.all(promises);
    }

    const extractedText = pages.join('\n\n');

    // 공백 제거 후 실제 텍스트 길이로 OCR 진입 판정 (watermark 등 공백 패딩 우회 방지)
    if (extractedText.replace(/\s+/g, '').length < 50) {
      if (!options?.enableOcrFallback) {
        throw Object.assign(new Error(t('uploader.noText')), {
          code: 'PDF_NO_TEXT',
        });
      }
      // OCR fallback: 페이지를 이미지로 렌더링 → Vision 모델로 텍스트 추출
      throwIfAborted(signal);
      const ocrPages = await ocrFallback(pdf, pageCount, options.onOcrProgress ?? (() => {}), signal);
      const ocrText = ocrPages.join('\n\n');
      // QA29(C-2): **부분 실패를 성공으로 끝내지 않는다.** 종전 판정은 절대 문자수 하나여서,
      // 300페이지 중 앞 10장만 OCR 된 뒤 파이프라인이 죽어도 그 10장이 50자를 넘으면 파싱이
      // 성공으로 끝났다 — 통지 배너 한 장만 뜨고, 자동저장이 나머지 290장의 빈 pageTexts 를
      // 같은 docHash 의 디스크 세션 위에 덮어썼다(재드롭은 handlePdfData 경로라 세션-우선
      // 복원이 없다 → 잘 OCR 됐던 세션이 파괴된다). 이제 **공란 페이지 비율**로 판정한다.
      // 절대 문자수 조건은 그대로 둔다 — 비율이 낮아도(공란은 아닌데) 문서 전체가 잡음 몇 글자뿐인
      // 경우를 잡는 별개 조건이다.
      const { empty: blankPages, total: processedPages } = countEmptyPages(ocrPages);
      const ocrVerdict = ocrAbortReason(
        { consecutiveBlankBatches: 0, processedPages, blankPages },
        'final',
      );
      if (ocrVerdict !== null || ocrText.trim().length < 50) {
        throw Object.assign(new Error(t('uploader.ocrFail')), {
          code: 'OCR_FAIL',
        });
      }
      // QA22(B-MED): **부분 실패 고지.** per-page catch 와 배치 실패가 실패 페이지를 전부 빈
      // 문자열로 수렴시키는데(인덱스 정렬 목적이라 정당) 위 게이트는 **전체 합계**뿐이다. 그래서
      // 200페이지 중 150이 429/타임아웃으로 실패해도 50페이지만 살아남으면 총합이 임계를 넘어
      // **정상 완료 UI**(OCR 배지)로 끝났다 — 요약·인용·RAG 가 150페이지를 통째로 누락하는데
      // 어떤 표시도 없었다.
      notifyEmptyPages(ocrPages, 'pdf.ocrPartialFailNotice');
      const chapters = detectChapters(ocrPages);
      return {
        id: crypto.randomUUID(),
        fileName,
        filePath,
        pageCount,
        extractedText: ocrText,
        pageTexts: ocrPages,
        chapters,
        // QA9(A-MED): 이미지 추출 패스가 OCR 판정보다 먼저 돌아 allImages 를 이미 채웠다(가장 비싼
        // getOperatorList+decode+base64 완료분). OCR 진입 시 images:[] 로 버리면 extractImages 가
        // 켜져 있어도 imagesSkipped=false → 정당한 text-only PDF 와 구분 불가한 무음 no-op 이 됐다
        // (QA6-D 가 닫은 클래스 재현). 이미 메모리에 있는 추출 이미지를 그대로 실어 Vision 분석 대상에 포함.
        images: allImages,
        createdAt: new Date(),
        isOcr: true,
      };
    }

    // QA22(B-MED): **텍스트 미추출 페이지 고지.** OCR 진입 판정이 문서 전체 합계 임계라, 표지
    // 한 장만 텍스트 레이어를 가진 300페이지 스캔본은 임계를 통과해 OCR 이 돌지 않고 나머지가
    // 빈 채로 남는다 — 요약은 표지만 보고 만들어지고 인용은 빈 페이지를 가리키며 RAG 는 사실상
    // 비어 있는데, 에러도 배지도 없다. 자동 OCR 승격은 오검출 시 실제 과금(클라우드 OCR)이라
    // 보류하고 무음만 없앤다 — 판단은 사용자에게 넘긴다.
    notifyEmptyPages(pages, 'pdf.emptyPagesNotice');

    const chapters = detectChapters(pages);

    return {
      id: crypto.randomUUID(),
      fileName,
      filePath,
      pageCount,
      extractedText,
      pageTexts: [...pages],
      chapters,
      images: allImages.slice(0, MAX_TOTAL_IMAGES),
      createdAt: new Date(),
      ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
    };
  } finally {
    // 파싱 종료 시 PDF 문서 내부 리소스 해제 — 정상/취소/에러 모두 동일
    try { await loadingTask.destroy(); } catch { /* destroy 실패 무시 */ }
  }
}

// ─── OCR Fallback ───

const MAX_OCR_PAGE_EDGE = 3000;

async function renderPageToImage(
  pdf: PDFDocumentProxy,
  pageNum: number,
  scale = 2.0,
): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  // 최대 해상도 가드: 긴 변 3000px 초과 시 scale 자동 축소
  let finalScale = scale;
  if (Math.max(viewport.width, viewport.height) > MAX_OCR_PAGE_EDGE) {
    finalScale = scale * (MAX_OCR_PAGE_EDGE / Math.max(viewport.width, viewport.height));
  }
  const finalViewport = finalScale !== scale ? page.getViewport({ scale: finalScale }) : viewport;
  const canvas = new OffscreenCanvas(Math.round(finalViewport.width), Math.round(finalViewport.height));
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context 생성 실패');
    // pdfjs 6.x: RenderParameters 에 canvas 가 필수(canvasContext 는 deprecated). OffscreenCanvas
    // 를 canvas 로 전달 — 타입은 HTMLCanvasElement 를 요구하나 런타임은 OffscreenCanvas 를 수용.
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: finalViewport,
    }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const CHUNK = 8192;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return btoa(parts.join(''));
  } finally {
    // QA post-v0.31.15: render/convert 가 reject 해도 GPU backing store(최대 ~36MB) + pdfjs
    // 페이지 폰트/이미지 버퍼를 즉시 해제한다. 이전엔 성공 경로에서만 해제해, 스캔 PDF 배치 OCR 에서
    // render 실패(손상 스트림 = OCR 유발 조건)가 누적되면 OOM 방지 의도와 반대로 메모리가 쌓였다.
    // 이미지추출·PdfViewer 경로가 이미 쓰는 finally 해제 패턴과 정렬.
    canvas.width = 0;
    canvas.height = 0;
    try { page.cleanup(); } catch (err) {
      console.warn(`[pdf-parser] OCR page.cleanup() 실패 (page ${pageNum}):`, err);
    }
  }
}

async function ocrFallback(
  pdf: PDFDocumentProxy,
  pageCount: number,
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const pages: string[] = [];
  // Provider-aware 배치 크기. 클라우드 API(Claude/OpenAI)는 네트워크 레이턴시 지배적이어서
  // 큰 배치가 throughput에 유리. 로컬 Ollama는 단일 GPU/CPU에 제한되므로 작게 유지.
  // 읽기 시점에 store에서 provider를 조회 — 파싱 중 provider가 바뀔 일은 없음.
  //
  // v0.18.19 patch R32 P2: 클라우드 BATCH_SIZE=8 + 3000×3000 캔버스(2-페이지에서 ~36MB RGBA)
  // 가 동시에 in-flight 상태로 잡혀 피크 메모리가 ~250-300MB 까지 일시 점유되던 결함.
  // 페이지 수가 많아 어차피 scale 이 축소되는 큰 PDF (101+) 에서는 캔버스가 작아 8 유지가
  // 안전하지만, 50-100 페이지 PDF 는 scale=1.5 라 캔버스가 여전히 크므로 4 로 축소하여
  // 저사양 환경(4GB RAM 노트북) 에서의 OOM 위험을 낮춘다. (R32 Surface 2 P3)
  // R44(R43 후속 M5): Gemini 는 무료 티어 분당 한도가 낮아 클라우드 일괄 8 대신 3 으로 하향
  // (429 는 ai-service 의 retryOn429 백오프가 추가 방어 — Vision/임베딩 경로 한정). use-summarize Vision 배치와 동일 정책.
  const provider = useAppStore.getState().settings.provider;
  const BATCH_SIZE = provider === 'ollama' || provider === 'gemini'
    ? 3
    : (pageCount > 50 && pageCount <= 100 ? 4 : 8);
  // 대용량 PDF: 50+ 페이지 시 scale 자동 축소
  const scale = pageCount > 100 ? 1.0 : pageCount > 50 ? 1.5 : 2.0;

  // QA30(A-F4): per-page 로 삼키면 안 되는 코드 — 한 페이지의 사고가 아니라 **모든 페이지에
  // 똑같이 재현될 조건**이다. 열거를 두 catch 가 공유해 한쪽만 갱신되는 drift 를 막는다.
  const OCR_FATAL_CODES = new Set(['ABORTED', 'API_KEY_INVALID']);

  // QA29(C-1): **무진전 회로차단기.** per-page catch 와 배치 catch 가 ABORTED 외 모든 실패를
  // '' 로 삼켜서, 루프는 실패를 한 번도 세지 않고 언제나 pageCount 까지 완주했다. Ollama 가
  // 고착되면(서비스는 살아 있고 runner 만 멈춘 상태 — 모델 교체 중에 흔하다) 페이지마다
  // callVision 의 timeoutMs 90초를 통째로 태운다. 요약 경로는 QA19/20 이 정확히 이 회로차단기를
  // 세웠는데(isSummaryTimedOut) OCR 만 형제가 없었다.
  let consecutiveBlankBatches = 0;

  for (let i = 0; i < pageCount; i += BATCH_SIZE) {
    // 취소 체크 — 배치 사이에 조기 종료
    throwIfAborted(signal);
    const batch: Promise<string>[] = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, pageCount); j++) {
      const pageIdx = j;
      batch.push(
        renderPageToImage(pdf, pageIdx + 1, scale).then(async (base64) => {
          // IPC 전에 한 번 더 체크 — 렌더링이 끝났으나 취소된 경우 API 비용 절감
          throwIfAborted(signal);
          // v0.18.20 R32 P2: per-page requestId 발급 + signal abort 시 main 에 즉시 전파.
          // 클라우드 OCR (BATCH_SIZE=8, ~90s/call) 에서 사용자 Stop 클릭 시 다음 배치만
          // 막던 결함을 해소 — 진행 중 8건의 토큰 청구도 함께 차단.
          const requestId = generateOcrRequestId();
          const onAbort = () => {
            // ai.abort 는 idempotent. main 측 controller.abort() 가 httpPost 의 abort listener
            // 를 트리거해 in-flight 소켓을 즉시 파괴 → callVision Promise reject('Aborted').
            window.electronAPI.ai.abort(requestId).catch(() => {});
          };
          if (signal) {
            if (signal.aborted) { onAbort(); throwIfAborted(signal); }
            signal.addEventListener('abort', onAbort);
            // v0.18.19 patch R34 P2 (R33 P4 fix): addEventListener 와 직전 aborted 체크 사이에
            // abort 가 발화하면 late-attached listener 가 fire 안 한다 (AbortSignal 규약).
            // 결과: 우리는 IPC 호출을 그대로 진행해 ~90s 비용 발생 + 사용자가 인지 못함.
            // listener attach 직후 한 번 더 확인해 그 사이 abort 도 catch.
            throwIfAborted(signal);
          }
          try {
            const result = await window.electronAPI.ai.ocrPage(base64, requestId);
            throwIfAborted(signal);
            // main 이 ABORTED code 로 응답하면 throw 하여 상위 정리 경로 진입.
            if (!result.success && result.code === 'ABORTED') {
              throw Object.assign(new Error('OCR 취소'), { code: 'ABORTED' });
            }
            // QA30(A-F4): **키 문제는 페이지 단위 실패가 아니다.** 키를 회수·만료한 채 스캔
            // PDF 를 열면 모든 페이지가 401 을 받는데, 아래 per-page catch 가 그것을 '' 로
            // 삼켜 "OCR로도 텍스트를 추출할 수 없습니다"(PDF 품질 문제) 로 둔갑했다.
            // 남은 페이지를 계속 태울 이유도 없으므로 즉시 상위로 올린다.
            if (!result.success && result.code === 'API_KEY_INVALID') {
              throw Object.assign(new Error(t('uploader.ocrAuthFail')), { code: 'API_KEY_INVALID' });
            }
            return (result.success && result.text) ? result.text : '';
          } finally {
            if (signal) signal.removeEventListener('abort', onAbort);
          }
        }).catch((err: unknown) => {
          // 방어적 re-throw: ABORTED/API_KEY_INVALID 는 상위로 전파되어 parsePdf finally의
          // 정리 경로를 탄다. 다른 에러(렌더링 실패, IPC 실패)는 페이지 단위로 무음 처리하여
          // 나머지 페이지를 계속 OCR 하도록 허용.
          if (OCR_FATAL_CODES.has((err as { code?: string })?.code ?? '')) throw err;
          return '';
        }),
      );
    }
    // 내부 per-promise .catch 가 ABORTED 외 모든 에러를 '' 로 수렴시키므로 Promise.all 은
    // ABORTED 외에는 reject 하지 않는다. 만약 코드가 리팩터링되어 inner catch 가 사라지더라도
    // 배치 크기만큼 빈 문자열을 넣어 페이지 인덱스 정렬이 깨지지 않도록 방어.
    const expectedBatchSize = Math.min(i + BATCH_SIZE, pageCount) - i;
    const results = await Promise.all(batch).catch((err: unknown) => {
      if (OCR_FATAL_CODES.has((err as { code?: string })?.code ?? '')) throw err;
      console.warn('[pdf-parser] OCR 배치 실패, 해당 페이지 공란 처리:', err);
      return new Array(expectedBatchSize).fill('') as string[];
    });
    pages.push(...results);
    onProgress(Math.min(i + BATCH_SIZE, pageCount), pageCount);

    // QA29(C-1): 배치가 **전량 공란**이면 스트릭을 올리고, 한 장이라도 건졌으면 리셋한다
    // (간헐적 실패는 정상 동작으로 본다 — 차단 대상은 "지속적으로 아무것도 못 얻는 상태").
    // 판정은 순수 함수에 위임해 테스트와 기준을 공유한다. ABORTED 전파 경로는 위 catch 들이
    // 그대로 유지하며, 여기서 던지는 OCR_FAIL 은 parsePdf 의 try/finally 를 타고 loadingTask 를
    // 정리한 뒤 상위로 나간다 — 부분 결과는 **저장되지 않는다**(C-2 와 같은 계약).
    consecutiveBlankBatches = results.every((text) => isBlankOcrPage(text))
      ? consecutiveBlankBatches + 1
      : 0;
    if (ocrAbortReason(
      { consecutiveBlankBatches, processedPages: pages.length, blankPages: 0 },
      'inProgress',
    ) !== null) {
      console.warn(
        `[pdf-parser] OCR 연속 ${consecutiveBlankBatches}개 배치가 전량 공란 — 중단 (page ${pages.length}/${pageCount})`,
      );
      throw Object.assign(new Error(t('uploader.ocrFail')), { code: 'OCR_FAIL' });
    }
  }
  return pages;
}

/**
 * 목차(TOC) 줄 판정 — 순수.
 *
 * QA23(C-HIGH): 국문 교재·학위논문의 전형 구조는 [표지 → 목차 2~4쪽 → 본문] 이다. 목차 줄
 * ("제1장 서론 …… 3")도 페이지의 첫 시각 줄이라 챕터로 승격되는데, 그러면 **번호를 먼저
 * 소진**해 뒤따르는 실제 본문 제1·2·3장이 전부 아래 notAdvancing 가드에 걸려 억제된다 —
 * 본문 챕터 경계가 통째로 사라지고 제목이 목차 점선 줄이 된다(에러·배지 없음).
 *
 * 목차 줄의 판별 신호는 **줄 끝의 쪽번호**와 그 앞의 채움(leader)이다: 점선(`.`·`·`·`…`)이나
 * 3칸 이상 공백 뒤에 숫자로 끝나면 목차로 본다. 본문 헤딩("제1장 서론")은 쪽번호로 끝나지
 * 않으므로 걸리지 않고, "제3장 사례 2" 처럼 단일 공백 뒤 숫자로 끝나는 정상 제목도 안전하다.
 */
export function isTocLine(line: string): boolean {
  return /[.·…]{2,}\s*\d+\s*$/.test(line) || /\s{3,}\d+\s*$/.test(line);
}

/**
 * 챕터 헤딩에서 비교 가능한 정체성을 뽑는다(순수 — 러닝 헤더 판정용).
 * - `key`: 공백·구두점을 정규화한 제목. 직전 챕터와 같으면 **같은 챕터의 러닝 헤더**로 본다.
 * - `num`: 챕터 번호(있으면). 같은 단위 안에서 증가하지 않으면 새 챕터로 승격하지 않는다.
 * - `unit`: 번호의 단위(`장`/`절`/`chapter`). QA23(C-HIGH): 이전에는 줄 어디서든 첫 숫자를
 *   집어 단위를 구분하지 않았다. 그래서 `1절`·`2절` 이 번호 2를 선점하면 뒤따르는 **`제2장`이
 *   억제돼 장 하나가 통째로 사라졌다**(절이 새 쪽에서 시작하는 국문 교재에서 흔한 배치).
 *   단위가 다르면 번호를 비교하지 않는다.
 */
export function parseChapterHeading(firstLine: string): { key: string; num: number | null; unit: string | null } {
  const key = firstLine.replace(/\s+/g, ' ').replace(/[.·:;,\-–—]+$/, '').trim().toLowerCase();
  // 헤딩 토큰에서만 번호·단위를 뽑는다(줄 뒤쪽의 쪽번호·연도 등을 집지 않도록).
  const ko = firstLine.match(/^제?\s*(\d+)\s*([장절])/);
  if (ko?.[1] !== undefined) return { key, num: Number.parseInt(ko[1], 10), unit: ko[2] ?? null };
  const en = firstLine.match(/^chapter\s*(\d+)/i);
  if (en?.[1] !== undefined) return { key, num: Number.parseInt(en[1], 10), unit: 'chapter' };
  return { key, num: null, unit: null };
}

export function detectChapters(pages: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  // 헤딩 패턴: "제1장", "Chapter 1", "1장" (명시적 챕터 마커만 매칭)
  // "1. " 패턴 제거 — 본문 번호 목록 오탐 방지
  const headingPattern = /^(제?\d+[장절]|chapter\s*\d+|\d+장)/i;

  let currentChapter: Chapter | null = null;
  let chapterIndex = 0;
  let preChapterText = '';
  // QA22(B-MED): 직전에 승격한 헤딩의 정체성. **러닝 헤더 오인 차단**용.
  let lastHeading: { key: string; num: number | null; unit: string | null } | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    const firstLine = page.trim().split('\n')[0] || '';
    let match = firstLine.match(headingPattern);

    // QA22(B-MED): 페이지의 **첫 시각 줄**만 보고 챕터를 승격하면, 국문 교재·학위논문에 흔한
    // 러닝 헤더("제3장 프로세스 관리" 가 모든 페이지 상단에 인쇄)가 매 페이지를 새 챕터로
    // 만든다 — 300페이지 = 300챕터. summarizeByChapter 는 챕터당 최소 1회 LLM 을 호출하므로
    // ~30회여야 할 요약이 **300회**가 되고(로컬은 시간, 클라우드는 비용) 본문은 동일 제목
    // 300개로 도배된다. 직전 헤딩과 **제목이 같거나 번호가 진행하지 않으면** 승격하지 않고
    // 본문으로 흡수한다(같은 챕터가 여러 페이지에 걸치는 정상 상태).
    // QA23(C-HIGH): 목차 줄은 애초에 승격하지 않는다. 승격되면 번호를 소진해 **본문 챕터
    // 전체가 아래 notAdvancing 에 걸려 사라진다**(목차가 본문보다 앞에 오므로 항상 이 순서다).
    if (match && isTocLine(firstLine)) match = null;

    if (match && lastHeading) {
      const h = parseChapterHeading(firstLine);
      const sameTitle = h.key === lastHeading.key;
      // 번호가 있는데 이전 이하로 되돌아가면(같은 번호 반복 포함) 새 챕터가 아니다.
      // 단, **단위가 다르면 비교하지 않는다** — `2절` 이 `제2장` 을 가리는 것을 막는다(QA23).
      const prevNum = lastHeading.num;
      const notAdvancing = h.num !== null && prevNum !== null && h.unit === lastHeading.unit && h.num <= prevNum;
      if (sameTitle || notAdvancing) match = null;
    }

    if (match) {
      lastHeading = parseChapterHeading(firstLine);
      if (currentChapter) {
        currentChapter.endPage = i;
        chapters.push(currentChapter);
      }
      chapterIndex++;
      currentChapter = {
        index: chapterIndex,
        title: firstLine.substring(0, 80).trim(),
        startPage: i + 1,
        endPage: i + 1,
        text: page,
      };
    } else if (currentChapter) {
      currentChapter.text += '\n\n' + page;
    } else {
      // 첫 챕터 이전 페이지 수집
      preChapterText += (preChapterText ? '\n\n' : '') + page;
    }
  }

  if (currentChapter) {
    currentChapter.endPage = pages.length;
    chapters.push(currentChapter);
  }

  // 첫 챕터 이전 페이지(서론/목차 등)를 첫 챕터에 포함
  if (preChapterText && chapters.length > 0 && chapters[0]) {
    chapters[0].text = preChapterText + '\n\n' + chapters[0].text;
    chapters[0].startPage = 1;
  }

  // 챕터 감지 실패 시 페이지 기반 분할
  if (chapters.length === 0) {
    const chunkSize = 10;
    for (let i = 0; i < pages.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, pages.length);
      chapters.push({
        index: Math.floor(i / chunkSize) + 1,
        title: t('pdf.pageRangeChapter', { start: String(i + 1), end: String(end) }),
        startPage: i + 1,
        endPage: end,
        text: pages.slice(i, end).join('\n\n'),
      });
    }
  }

  return chapters;
}

// ─── 이미지 추출 ───

const MIN_IMAGE_SIZE = 50;
const MAX_IMAGE_EDGE = 1024;
const MAX_IMAGE_PIXELS = 4_000_000; // 4M 픽셀 초과 시 스킵 (OOM 방지)
const MAX_IMAGES_PER_PAGE = 10;

/**
 * **검사한** 이미지 수의 상한 — 채택된 수(MAX_TOTAL_IMAGES)와 별개다.
 *
 * QA23(C-MED): 추출 단락(short-circuit)이 `allImages.length >= MAX_TOTAL_IMAGES` 하나뿐이라
 * **채택되지 않는 이미지는 아무리 처리해도 예산이 차지 않았다.** 두 경우가 흔하다:
 *  - 300 DPI A4 스캔(2480×3508 = 8.7M 픽셀)은 MAX_IMAGE_PIXELS 로 전량 거절 → 계속 0
 *  - QA22 가 넣은 중복 제거는 **디코딩·캔버스·base64 를 다 끝낸 뒤** 걸러내므로, 로고가 300장
 *    반복되는 강의자료는 로고를 300번 인코딩하고 299번 버린다 → 역시 계속 0
 * 그래서 500페이지 전부에 대해 `getOperatorList`(pdfjs 최고비용 호출, 페이지당 5s 타임아웃)와
 * 전체 이미지 디코딩이 돌았다 — QA22 의 정합성 수정이 파싱 시간·피크 메모리 회귀를 동반한 것이다.
 * 채택 여부와 무관하게 "본 것"을 세어 병리적 문서에서 작업량을 유한하게 만든다.
 * (정상 문서는 이 값에 닿지 않는다 — 50장을 채우거나 문서가 먼저 끝난다.)
 */
export const MAX_EXAMINED_IMAGES = 400;

/** Vision 분석에 넘길 이미지 수 상한(문서 전체). 이전에는 parsePdf 지역 상수였다. */
export const MAX_TOTAL_IMAGES = 50;

/** 이미지 추출 예산 판정 — 순수. 둘 중 하나라도 소진되면 더 이상 페이지를 열지 않는다. */
export function shouldExtractMoreImages(acceptedCount: number, examinedCount: number): boolean {
  return acceptedCount < MAX_TOTAL_IMAGES && examinedCount < MAX_EXAMINED_IMAGES;
}

async function extractPageImages(
  page: PDFPageProxy,
  pageIndex: number,
  /** 문서 전체에서 **검사한** 이미지 수(채택 여부 무관) — 호출자가 공유해 예산으로 쓴다(QA23). */
  stats?: { examined: number },
): Promise<PageImage[]> {
  const { OPS } = await loadPdfjs(); // 메모이즈됨 — parsePdf 가 이미 로드해 즉시 반환
  // getOperatorList 는 pdfjs 내부 content stream 파싱을 수행 — 손상된 PDF 에서 hang 가능.
  // 5초 타임아웃을 Promise.race 로 걸어 뒤의 이미지 페치 경로에서 페이지를 빈 배열로 스킵.
  // R30 (v0.18.17): timeoutId 를 finally 에서 명시적으로 clear — 이전엔 race 가 빠르게
  // resolve 되어도 setTimeout 이 살아있어 200p PDF 에서 200개 pending timer + 200개의
  // 오해 소지 있는 "timeout" 경고가 5초 뒤 폭주하던 leak 차단.
  //
  // v0.18.22 R36 P4 (한계 문서화): Promise.race 는 결과 selection 만 빠르게 resolve 할 뿐,
  // pdfjs 의 내부 op 파싱은 백그라운드에서 계속 진행되어 CPU/메모리를 점유한다. pdfjs 가
  // `getOperatorList(signal)` 같은 AbortSignal 인프라를 노출하지 않아 실 작업 취소는 불가
  // (한계). 200p 손상 PDF 의 누적 부하는 timeout 발화 후에도 페이지 수만큼 백그라운드 작업이
  // 잔존하며 이는 pdfjs 업스트림 abort 지원이 도입되기 전까지 mitigation 가능 영역 밖이다.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ fnArray: number[]; argsArray: unknown[] }>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`[pdf-parser] page ${pageIndex + 1} getOperatorList timeout, skipping images`);
      resolve({ fnArray: [], argsArray: [] });
    }, 5000);
  });
  let opsOrEmpty: { fnArray: number[]; argsArray: unknown[] };
  try {
    opsOrEmpty = await Promise.race([page.getOperatorList(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  const ops = opsOrEmpty as Awaited<ReturnType<typeof page.getOperatorList>>;
  const images: PageImage[] = [];

  for (let j = 0; j < ops.fnArray.length && images.length < MAX_IMAGES_PER_PAGE; j++) {
    if (ops.fnArray[j] !== OPS.paintImageXObject) continue;

    // R29 (v0.18.13): argsArray[j] 가 undefined 거나 [0] 이 string 이 아닌
    // 손상된 PDF op 가 throw 로 페이지 전체 이미지 루프를 죽이지 않도록 guard.
    // 이전엔 `argsArray[j]![0] as string` 의 non-null 단언이 undefined 접근 시 throw 했고,
    // outer try/catch 가 페이지 단위 fallback 으로 1장 손상 → 9장 유실 패턴이 됐다.
    const args = ops.argsArray[j];
    // R30 (v0.18.17): R29 가드를 더 좁힘. 빈 문자열은 page.objs.get('') 가 callback 을
    // 호출하지 않아 1s 타임아웃까지 낭비하는 dead path 가 되므로 사전 거절.
    if (!Array.isArray(args) || typeof args[0] !== 'string' || args[0].length === 0) continue;
    const imageName = args[0];
    // 여기서부터가 비싼 구간(objs.get → 디코딩 → 캔버스 → base64). 채택되든 거절되든 "본 것"으로
    // 센다 — 거절만 반복되는 문서(고해상 스캔·반복 로고)에서 작업량이 무한히 늘지 않도록.
    if (stats) stats.examined++;
    let imgData: { width: number; height: number; data: Uint8ClampedArray; kind?: number } | null = null;
    try {
      imgData = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error('timeout')); }
        }, 1000);
        page.objs.get(imageName, (obj: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (obj && typeof obj === 'object' && 'width' in obj && 'height' in obj && 'data' in obj) {
            const imgObj = obj as { width: number; height: number; data: Uint8ClampedArray; kind?: number };
            if (typeof imgObj.width === 'number' && typeof imgObj.height === 'number' && imgObj.data && imgObj.data.length > 0) {
              resolve(imgObj);
            } else {
              reject(new Error('invalid image data'));
            }
          } else {
            reject(new Error('not an image'));
          }
        });
      });
    } catch {
      continue;
    }

    if (!imgData || imgData.width < MIN_IMAGE_SIZE || imgData.height < MIN_IMAGE_SIZE) continue;
    if (!imgData.data || imgData.data.length === 0) continue;
    const pixels = imgData.width * imgData.height;
    if (pixels > MAX_IMAGE_PIXELS) continue; // OOM 방지
    // RGBA 변환 출력 크기 체크 (CMYK 등 배치 병렬 처리 시 메모리 보호)
    if (pixels * 4 > 16 * 1024 * 1024) continue; // 16MB per image

    try {
      const base64 = await imageDataToBase64(imgData.width, imgData.height, imgData.data);
      if (base64) {
        images.push({
          pageIndex,
          imageIndex: images.length,
          base64,
          width: imgData.width,
          height: imgData.height,
          mimeType: 'image/jpeg',
        });
      }
    } catch {
      // 개별 이미지 변환 실패 무시
    }
  }

  return images;
}

/**
 * pdfjs 이미지의 raw 픽셀 버퍼를 RGBA(length = width*height*4)로 정규화한다.
 * 포맷은 데이터 길이로 추정: RGBA(>=px*4) / RGB(>=px*3) / grayscale(>=px). 1바이트/픽셀
 * 미만(예: 손상/부분 버퍼)은 비지원으로 null. RGB→A=255, grayscale→RGB 동값+A=255.
 * 순수 함수(캔버스 비의존)라 단위 테스트 대상 — imageDataToBase64 의 canvas 경로(happy-dom
 * 한계로 E2E 영역)와 분리해 분류·확장 분기를 가드한다.
 * 주의: CMYK 도 4채널(px*4)이라 RGBA 로 분류된다 — 길이 기반 추정의 알려진 한계.
 */
export function expandToRgba(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> | null {
  // 반환은 ArrayBuffer-backed 로 좁힘 — 호출부 imageDataToBase64 의 `new ImageData(rgbaData, …)`
  // 가 ImageDataArray(Uint8ClampedArray<ArrayBuffer>)를 요구하기 때문.
  const pixelCount = width * height;
  const isRGBA = data.length >= pixelCount * 4;
  const isRGB = !isRGBA && data.length >= pixelCount * 3;
  const isGrayscale = !isRGBA && !isRGB && data.length >= pixelCount;

  if (!isRGBA && !isRGB && !isGrayscale) return null; // 비지원 포맷 (1바이트/픽셀 미만)

  const rgbaData = new Uint8ClampedArray(pixelCount * 4);

  if (isRGBA) {
    rgbaData.set(data.subarray(0, pixelCount * 4));
  } else if (isRGB) {
    for (let p = 0; p < pixelCount; p++) {
      rgbaData[p * 4] = data[p * 3]!;
      rgbaData[p * 4 + 1] = data[p * 3 + 1]!;
      rgbaData[p * 4 + 2] = data[p * 3 + 2]!;
      rgbaData[p * 4 + 3] = 255;
    }
  } else {
    // 그레이스케일
    for (let p = 0; p < pixelCount; p++) {
      const v = data[p] ?? 0;
      rgbaData[p * 4] = v;
      rgbaData[p * 4 + 1] = v;
      rgbaData[p * 4 + 2] = v;
      rgbaData[p * 4 + 3] = 255;
    }
  }

  return rgbaData;
}

async function imageDataToBase64(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): Promise<string | null> {
  // C5-R2(QA cycle5): canvas 를 try 밖으로 호이스트하고 finally 에서 일괄 해제. 이전엔 정상/
  // ctx-거부 경로만 명시 해제하고 catch(putImageData/drawImage/convertToBlob throw — 정확히
  // 메모리 압박 상황)는 lazy GC 에 맡겨, 배치 병렬(페이지 10×이미지 10) 실패가 겹치면 최대
  // 16MB RGBA backing store 들이 OCR/추출이 헤드룸을 가장 필요로 하는 순간 잔류했다
  // (renderPageToImage 의 finally-해제 패턴과 동형화).
  let srcCanvas: OffscreenCanvas | null = null;
  let canvas: OffscreenCanvas | null = null;
  try {
    let targetW = width;
    let targetH = height;
    if (Math.max(width, height) > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / Math.max(width, height);
      targetW = Math.round(width * scale);
      targetH = Math.round(height * scale);
    }

    srcCanvas = new OffscreenCanvas(width, height);
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return null;

    const rgbaData = expandToRgba(width, height, data);
    if (!rgbaData) return null; // 비지원 포맷 (1바이트/픽셀 미만)

    srcCtx.putImageData(new ImageData(rgbaData, width, height), 0, 0);

    canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // 2번째 2D 컨텍스트 거부 — 메모리 압박 시 더 자주 발생. finally 가 즉시 해제.
      return null;
    }
    ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // 청크 단위 바이너리→문자열 변환 (8KB 청크는 콜스택 안전 + 고성능)
    const CHUNK = 8192;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return btoa(parts.join(''));
  } catch {
    // OOM 또는 Canvas 생성 실패 시 안전하게 null 반환
    return null;
  } finally {
    // GPU/backing store 즉시 반환 (GC 대기 없이) — 모든 경로(정상/ctx-거부/throw) 단일 출구
    if (srcCanvas) { srcCanvas.width = 0; srcCanvas.height = 0; }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

// ─── 공용 PDF 처리 함수 (PdfUploader + App file drop 공통) ───

const MAX_FILE_SIZE = MAX_PDF_SIZE_BYTES;

// 현재 진행 중인 PDF 파싱의 AbortController. 사용자 취소 버튼 또는 다른 파일 드롭 시 abort.
// 동시에 하나의 파싱만 실행되므로 단일 모듈 레벨 참조로 충분.
let activeParseController: AbortController | null = null;

/** 진행 중인 PDF 파싱을 취소. 다음 배치/OCR 페이지 진입 직전에 ABORTED 에러로 조기 종료됨. */
export function cancelPdfParse(): void {
  activeParseController?.abort();
}

export async function handlePdfData(
  data: ArrayBuffer,
  name: string,
  filePath: string,
  opts: {
    /**
     * QA24(A-I1): 파기 확인을 건너뛴다. 탭 전환·탭 닫기 경로는 진입부에서 이미 물었고,
     * 그쪽의 파일 재파싱 fallback 이 이 함수를 호출하므로 여기서 또 물으면 이중 질문이 된다.
     */
    skipDiscardConfirm?: boolean;
  } = {},
): Promise<void> {
  const store = useAppStore.getState();
  if (store.isGenerating) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyGenerating'),
    } as AppError);
    return;
  }
  if (store.isQaGenerating) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyQa'),
    } as AppError);
    return;
  }
  // QA post-v0.31.15: 컬렉션 교차 요약 gather 단계(isCollectionBusy=true, isQaGenerating 아직
  // false)에도 새 파일 열기를 차단 — isTabSwitchBlocked 가 이미 isCollectionBusy 를 포함하는 것과
  // 대칭. 누락 시 드롭이 게이트를 통과해 in-flight 멤버 요약(클라우드)이 끊기지 않고 백그라운드
  // 완주하며 토큰을 낭비했다(탭 전환 경로 tabs.ts:32-35 가 이미 닫은 것과 동일 결함 클래스).
  if (store.isCollectionBusy) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyCollection'),
    } as AppError);
    return;
  }
  // QA24(A-I1): 영속화 OFF 면 새 문서 로드가 현재 요약·Q&A 를 되돌릴 수 없이 파기한다.
  // 드롭·Ctrl+O·최근 문서·전역 검색이 전부 이 함수로 직행하므로 여기가 그 경로들의 단일
  // 게이트다. **파싱 전에** 묻는다 — 수십 초 파싱이 끝난 뒤 묻는 확인은 의미가 없다.
  if (!opts.skipDiscardConfirm && useAppStore.getState().document && !confirmDiscardIfNotPersisted()) {
    return;
  }
  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 중에도 새 파일 열기 차단. 드롭/최근
  // 문서/전역검색/Ctrl+O 는 isTabSwitchBlocked 를 거치지 않고 본 함수로 직행하므로, 누락 시
  // 컬렉션 멤버 upsert·첫 멤버 활성화 루프와 인터리브돼 탭 세트가 뒤섞이고(멤버+낙오 문서 혼재)
  // 활성 문서가 경쟁 패자의 것으로 남았다.
  if (store.collectionOpenInFlight) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyCollectionOpen'),
    } as AppError);
    return;
  }
  if (data.byteLength > MAX_FILE_SIZE) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('uploader.fileTooLarge', { size: String(Math.round(data.byteLength / 1024 / 1024)) }),
    } as AppError);
    return;
  }
  // 매직바이트 검증 — 모든 진입 경로(DOM drop, IPC file:dropped, file:open-pdf 다이얼로그)
  // 의 공통 게이트. zero-copy 뷰로 5바이트만 읽어 pdfjs 로딩 전에 위장 바이너리를 조기 거부.
  // DOM 경로(App.tsx, PdfUploader)는 이미 materialize 전에 Blob.slice(0,5) 로 차단하지만,
  // IPC 경로는 main 에서 fs-level 검증만 하므로 여기서 content-type 검증을 통일한다.
  // QA13(C-LOW): pdfjs 는 %PDF- 헤더 앞의 선행 바이트(UTF-8 BOM·공백·잘못 덧붙은 헤더)를 허용해
  // 파싱하는데, 오프셋 0 정확 매칭만 하면 그런 유효 PDF 를 조기 오거부했다. 파서와 관용도를 맞춰
  // 앞쪽 1KB 창에서 %PDF- 시그니처를 스캔한다(위장 바이너리 조기 거부 목적은 그대로 달성).
  const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const scanLen = Math.min(data.byteLength, 1024);
  const head = scanLen >= PDF_SIG.length ? new Uint8Array(data, 0, scanLen) : null;
  let isPdfMagic = false;
  if (head) {
    for (let i = 0; i <= head.length - PDF_SIG.length; i++) {
      if (PDF_SIG.every((b, j) => head[i + j] === b)) { isPdfMagic = true; break; }
    }
  }
  if (!isPdfMagic) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.invalidFile'),
    } as AppError);
    return;
  }
  // 이미 파싱 진행 중이면 abort 후 새 파일로 교체.
  // 기존 가드는 "진행 중이면 무시" 였으나, 사용자가 다른 PDF를 드롭/Ctrl+O 했을 때
  // 아무 반응이 없어 UX가 혼란스러움. abort-replace 패턴으로 새 파일이 우선권을 가짐.
  if (activeParseController) {
    activeParseController.abort();
  }
  const controller = new AbortController();
  activeParseController = controller;

  store.setIsParsing(true);
  // onProgress 콜백도 ownership 체크 — 이전 파싱의 OCR 진행률이 새 파싱의 진행률을
  // 덮어쓰는 경쟁 방지. parsePdf 는 abort 이후에도 in-flight 페이지의 콜백을 흘릴 수 있음.
  const ownedProgress = (current: number, total: number) => {
    if (activeParseController !== controller) return;
    store.setOcrProgress({ current, total });
  };
  // page-citation-viewer: PdfViewer lazy 마운트를 위해 원본 바이트를 별도 보관.
  // parsePdf 가 내부적으로 pdfjs.getDocument({ data }) 를 호출할 때 ArrayBuffer 가 transfer 될 수
  // 있으므로, 파싱 전에 복사본을 만들어 두어 detached 상태를 피한다.
  // C5-R1(QA cycle5): 복사는 상주가 실제로 필요한 경우(재읽기 불가 합성경로 드롭)에만 수행.
  // 게이트 조건(isReReadablePath, doc.filePath === 본 filePath 인자)은 파싱 전에 이미 알 수
  // 있는데도 무조건 복사해, 모든 정상 경로에서 최대 100MB 사장 힙이 파싱(OCR 스캔 PDF 면
  // 분 단위) 내내 클로저에 붙들려 있었다 — v0.31.10 pdfBytes 비상주(M1)의 잔여분.
  // QA21(A-LOW): 이 할당은 반드시 try **안**에 있어야 한다. setIsParsing(true) 이후 try 진입
  // 전까지가 유일한 무보호 구간인데, 경로 없는 드롭(합성 File)에서 최대 100MB 복사가
  // RangeError(OOM)로 실패하면 finally 를 타지 못해 **isParsing 이 true 로 고착**한다.
  // 그러면 요약(QA20 이 요약 버튼을 isParsing 에 묶었다)·⚙️·탭 전환·업로더가 전부 영구 비활성
  // 되고, 복구 수단은 드래그드롭 재열기(abort-replace 로 새 파싱이 소유권을 가져감)뿐이다.
  let pdfBytesCopy: Uint8Array | null = null;
  try {
    pdfBytesCopy = isReReadablePath(filePath) ? null : new Uint8Array(data.slice(0));
    // 이미지 분석이 꺼져 있으면 이미지 추출 스킵(파싱 시간↓ — 이미지 많은 PDF에서 큰 폭).
    // QA6-D: 스킵 여부를 doc 에 마커로 남긴다 — 이후 설정을 ON 으로 바꿔 재요약하면 images=[]
    // 라 Vision 이 무음 no-op 이었는데, 텍스트-only PDF 의 정당한 0장과 구분할 수 없었다.
    // use-summarize 가 이 마커로 "재오픈 필요" 안내를 띄운다.
    const extractImagesEnabled = store.settings.enableImageAnalysis;
    const doc = await parsePdf(data, name, filePath, {
      enableOcrFallback: store.settings.enableOcrFallback,
      extractImages: extractImagesEnabled,
      onOcrProgress: ownedProgress,
      signal: controller.signal,
    });
    if (!extractImagesEnabled) doc.imagesSkipped = true;
    // abort-replace 로 우리가 초과(supersede)된 경우, 성공한 파싱 결과를 store 에 반영하지 않는다.
    // 그렇지 않으면 오래된 문서가 새 문서를 덮어쓰는 경쟁 조건이 발생.
    if (activeParseController !== controller) return;
    // multi-doc Phase 1: 새 문서로 교체하기 전에 이전 문서의 미저장 tail 을 flush.
    // 자동 영속화는 1.5s 디바운스라, 로드 직후 다른 문서로 갈아타면(연속 드롭/빠른 탭 작업)
    // 이전 세션이 디스크에 없어 탭 전환 fallback·최근 문서 복원이 실패했다.
    if (useAppStore.getState().document) {
      try { await persistCurrentSession(); } catch { /* best-effort */ }
      if (activeParseController !== controller) return; // flush 중 supersede 재확인
    }
    // 새 문서로 교체되므로 이전 문서의 요약/Q&A/진행률 상태를 모두 초기화
    // (드롭/Ctrl+O로 덮어쓸 때 이전 문서의 summaryStream·qaMessages가 새 문서의 헤더와
    // 섞여 표시되는 버그 방지)
    store.clearStream();
    store.setSummary(null);
    store.setProgress(0);
    store.setProgressInfo(null);
    store.clearQa();
    store.setDocument(doc);
    // pdfBytes 비상주(메모리 M1): 원본 바이트(최대 100MB)는 인용 클릭 시 PdfViewer 만 쓴다.
    // 재읽기 가능한 실경로 문서는 상주시키지 않고(=null), PdfViewerPanel 이 인용 클릭 시 디스크에서
    // 1회 lazy 로드한다. 경로 없는 합성 드롭 문서만 재읽기 불가라 fallback 으로 상주 유지.
    // (C5-R1: 복사 자체를 위 게이트로 옮겨 null 이면 애초에 할당되지 않음)
    store.setPdfBytes(pdfBytesCopy);
    // multi-doc Phase 1: 모든 성공 로드 경로(드롭/다이얼로그/IPC/최근 문서/탭 전환)가 본
    // 함수를 경유하므로 여기가 탭 등록의 단일 지점 — filePath 중복은 메타 갱신(중복 탭 없음).
    store.upsertOpenTab({ filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount });
    // session-persistence(module-3): setDocument 직후 복원 게이트 ON → useRagBuilder 자동
    // 재임베딩을 보류시키고, 콘텐츠 해시로 세션 복원을 시도한다. hit 시 재요약·재임베딩 0,
    // miss 시 게이트 해제 후 정상 빌드. (setDocument→resetSummaryState 가 게이트를 false 로
    // 초기화하므로 반드시 그 "이후"에 true 로 설정해야 함)
    store.setSessionRestorePending(true);
    void restoreSessionForDocument(doc);
    store.setError(null);
    // v0.18.7 D5 fix: notice 채널도 함께 정리. v0.18.6 D1 에서 notice 를 추가했지만
    // 새 PDF 로드 성공 시 stale notice (예: 직전 multi-file 드롭 경고) 를 정리하지 않아
    // 다른 단일 파일을 열어도 이전 경고가 잔존하던 lifecycle 갭 해소.
    store.setNotice(null);
    // QA28: Vision 예산 소진 고지(QA22 문구의 배선) — 위 setNotice(null) **뒤**에 둬야 남는다.
    if (doc.imageBudgetExceeded) {
      store.setNotice({ message: t('pdf.imageBudgetNotice', { max: String(MAX_TOTAL_IMAGES) }) });
    }
  } catch (err) {
    const error = err as Error & { code?: string };
    // 사용자 취소는 에러 배너로 표시하지 않음 (의도적 액션)
    if (error.code === 'ABORTED') {
      return;
    }
    // abort-replace 로 우리를 덮어쓴 새 파싱이 있는 경우, 에러 배너도 띄우지 않음.
    if (activeParseController !== controller) return;
    const validCodes = new Set(['PDF_PARSE_FAIL', 'PDF_NO_TEXT', 'PDF_TOO_MANY_PAGES', 'PDF_ENCRYPTED', 'OCR_FAIL']);
    const code = (error.code && validCodes.has(error.code) ? error.code : 'PDF_PARSE_FAIL') as AppError['code'];
    store.setError({
      code,
      message: error.message || t('uploader.cannotRead'),
    });
  } finally {
    // 새 파싱이 abort-replace 로 우리를 덮어쓴 경우, 전역 상태(isParsing, ocrProgress)를
    // 건드리지 않음 — 새 파싱이 자신의 라이프사이클로 관리한다.
    if (activeParseController === controller) {
      activeParseController = null;
      store.setIsParsing(false);
      store.setOcrProgress(null);
    }
  }
}

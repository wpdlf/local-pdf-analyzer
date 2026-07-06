import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfDocument, Chapter, PageImage, AppError } from '../types';
import { useAppStore } from './store';
import { t } from './i18n';
import { restoreSessionForDocument, persistCurrentSession } from './use-session';
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
  const pdf = await loadingTask.promise;
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
  const MAX_TOTAL_IMAGES = 50;
  const pages: string[] = new Array(pageCount).fill('');
  const allImages: PageImage[] = [];

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
              if (allImages.length >= MAX_TOTAL_IMAGES) return [];
              try {
                return await extractPageImages(page, i);
              } catch {
                return [];
              }
            })();

            const textContent = await page.getTextContent();
            // 텍스트 아이템 간 위치 기반 공백/줄바꿈 삽입 (한글 깨짐 방지)
            let lastY: number | null = null;
            let lastEndX = 0;
            const parts: string[] = [];

            for (const item of textContent.items) {
              if (!('str' in item) || !item.str) continue;
              const tx = ('transform' in item) ? item.transform : null;
              if (!tx) {
                // transform이 없으면 공백 연결 fallback
                if (parts.length > 0) parts.push(' ');
                parts.push(item.str);
                continue;
              }
              const x = tx[4];
              const y = tx[5];
              const fontSize = Math.abs(tx[0]) || Math.abs(tx[3]) || 12;

              if (lastY !== null) {
                const yDiff = Math.abs(y - lastY);
                if (yDiff > fontSize * 0.5) {
                  // 줄이 바뀜
                  parts.push('\n');
                } else if (x > lastEndX + fontSize * 0.3) {
                  // 같은 줄에서 간격이 있으면 공백
                  parts.push(' ');
                }
                // 한글 글자 단위 분할: 간격이 매우 좁으면 공백 없이 연결
              }

              parts.push(item.str);
              lastY = y;
              lastEndX = x + (item.width ?? item.str.length * fontSize * 0.5);
            }

            pages[i] = parts.join('');

            const pageImages = await imagePromise;
            // 푸시 직전 잔여 슬롯 확인 — 다른 페이지 promise가 그동안 푸시했을 수 있으므로
            // 슬롯을 초과하지 않도록 잘라낸 후 추가 (이미지 1장당 base64 수 MB → OOM 방지)
            const remainingSlots = MAX_TOTAL_IMAGES - allImages.length;
            if (remainingSlots > 0 && pageImages.length > 0) {
              allImages.push(...pageImages.slice(0, remainingSlots));
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
      if (ocrText.trim().length < 50) {
        throw Object.assign(new Error(t('uploader.ocrFail')), {
          code: 'OCR_FAIL',
        });
      }
      const chapters = detectChapters(ocrPages);
      return {
        id: crypto.randomUUID(),
        fileName,
        filePath,
        pageCount,
        extractedText: ocrText,
        pageTexts: ocrPages,
        chapters,
        images: [],
        createdAt: new Date(),
        isOcr: true,
      };
    }

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
            return (result.success && result.text) ? result.text : '';
          } finally {
            if (signal) signal.removeEventListener('abort', onAbort);
          }
        }).catch((err: unknown) => {
          // 방어적 re-throw: ABORTED 는 상위로 전파되어 parsePdf finally의 정리 경로를 탐.
          // 다른 에러(렌더링 실패, IPC 실패)는 페이지 단위로 무음 처리하여 나머지 페이지를
          // 계속 OCR 하도록 허용.
          if ((err as { code?: string })?.code === 'ABORTED') throw err;
          return '';
        }),
      );
    }
    // 내부 per-promise .catch 가 ABORTED 외 모든 에러를 '' 로 수렴시키므로 Promise.all 은
    // ABORTED 외에는 reject 하지 않는다. 만약 코드가 리팩터링되어 inner catch 가 사라지더라도
    // 배치 크기만큼 빈 문자열을 넣어 페이지 인덱스 정렬이 깨지지 않도록 방어.
    const expectedBatchSize = Math.min(i + BATCH_SIZE, pageCount) - i;
    const results = await Promise.all(batch).catch((err: unknown) => {
      if ((err as { code?: string })?.code === 'ABORTED') throw err;
      console.warn('[pdf-parser] OCR 배치 실패, 해당 페이지 공란 처리:', err);
      return new Array(expectedBatchSize).fill('') as string[];
    });
    pages.push(...results);
    onProgress(Math.min(i + BATCH_SIZE, pageCount), pageCount);
  }
  return pages;
}

function detectChapters(pages: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  // 헤딩 패턴: "제1장", "Chapter 1", "1장" (명시적 챕터 마커만 매칭)
  // "1. " 패턴 제거 — 본문 번호 목록 오탐 방지
  const headingPattern = /^(제?\d+[장절]|chapter\s*\d+|\d+장)/i;

  let currentChapter: Chapter | null = null;
  let chapterIndex = 0;
  let preChapterText = '';

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    const firstLine = page.trim().split('\n')[0] || '';
    const match = firstLine.match(headingPattern);

    if (match) {
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
        title: `${i + 1}~${end} 페이지`,
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

async function extractPageImages(
  page: PDFPageProxy,
  pageIndex: number,
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
  const magic = data.byteLength >= 5 ? new Uint8Array(data, 0, 5) : null;
  const isPdfMagic = magic !== null
    && magic[0] === 0x25 && magic[1] === 0x50
    && magic[2] === 0x44 && magic[3] === 0x46
    && magic[4] === 0x2D;
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
  const pdfBytesCopy = isReReadablePath(filePath) ? null : new Uint8Array(data.slice(0));
  try {
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
  } catch (err) {
    const error = err as Error & { code?: string };
    // 사용자 취소는 에러 배너로 표시하지 않음 (의도적 액션)
    if (error.code === 'ABORTED') {
      return;
    }
    // abort-replace 로 우리를 덮어쓴 새 파싱이 있는 경우, 에러 배너도 띄우지 않음.
    if (activeParseController !== controller) return;
    const validCodes = new Set(['PDF_PARSE_FAIL', 'PDF_NO_TEXT', 'PDF_TOO_MANY_PAGES', 'OCR_FAIL']);
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

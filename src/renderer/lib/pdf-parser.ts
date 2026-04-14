import * as pdfjsLib from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
import type { PdfDocument, Chapter, PageImage, AppError } from '../types';
import { useAppStore } from './store';
import { MAX_PDF_SIZE_BYTES } from '../../shared/constants';
// Vite의 ?url 쿼리를 사용해 worker 파일을 정적 에셋으로 번들링.
// bare specifier + import.meta.url 패턴은 Vite에서 dev/build 동작이 다를 수 있어
// 패키지된 Electron(ASAR)에서 worker 로드 실패 위험이 있음. ?url은 명시적 에셋 처리.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// PDF.js worker 설정
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ParsePdfOptions {
  enableOcrFallback?: boolean;
  onOcrProgress?: (current: number, total: number) => void;
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

export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  filePath: string,
  options?: ParsePdfOptions,
): Promise<PdfDocument> {
  const signal = options?.signal;
  throwIfAborted(signal);

  const pdf = await pdfjsLib.getDocument({
    data,
    cMapUrl: './cmaps/',
    cMapPacked: true,
  }).promise;
  throwIfAborted(signal);
  const pageCount = pdf.numPages;

  if (pageCount === 0) {
    throw Object.assign(new Error('PDF에 페이지가 없습니다.'), { code: 'PDF_NO_TEXT' });
  }
  if (pageCount > MAX_PAGE_COUNT) {
    throw Object.assign(
      new Error(`페이지 수가 너무 많습니다 (${pageCount}p). 최대 ${MAX_PAGE_COUNT}페이지까지 지원합니다. 문서를 분할해주세요.`),
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
      // 이미지 상한 도달 여부를 배치 시작 시점에 캡처 (레이스 컨디션 방지)
      const skipImages = allImages.length >= MAX_TOTAL_IMAGES;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, pageCount);
      const promises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        // 페이지별 에러 격리: 한 페이지의 손상(깨진 xref, 미지원 폰트, 악성 content stream)이
        // 전체 파싱을 중단시키지 않도록 catch 내부에서 빈 문자열로 대체.
        // ABORTED 는 상위 취소 흐름이 처리하므로 재throw.
        promises.push(
          pdf.getPage(i + 1).then(async (page) => {
            // 이미지 추출 (배치 단위로 상한 체크 — 병렬 Promise 내 레이스 방지)
            const imagePromise = !skipImages
              ? extractPageImages(page, i).catch(() => [] as PageImage[])
              : Promise.resolve([] as PageImage[]);

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
            allImages.push(...pageImages);

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
        throw Object.assign(new Error('PDF에서 텍스트를 추출할 수 없습니다. 설정에서 "스캔 PDF OCR"을 활성화하면 이미지 기반 PDF를 분석할 수 있습니다.'), {
          code: 'PDF_NO_TEXT',
        });
      }
      // OCR fallback: 페이지를 이미지로 렌더링 → Vision 모델로 텍스트 추출
      throwIfAborted(signal);
      const ocrPages = await ocrFallback(pdf, pageCount, options.onOcrProgress ?? (() => {}), signal);
      const ocrText = ocrPages.join('\n\n');
      if (ocrText.trim().length < 50) {
        throw Object.assign(new Error('OCR로도 텍스트를 추출할 수 없습니다. PDF 품질을 확인해주세요.'), {
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
    try { await pdf.destroy(); } catch { /* destroy 실패 무시 */ }
  }
}

// ─── OCR Fallback ───

const MAX_OCR_PAGE_EDGE = 3000;

async function renderPageToImage(
  pdf: pdfjsLib.PDFDocumentProxy,
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
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context 생성 실패');
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: finalViewport }).promise;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  // GPU 메모리 즉시 해제 (대용량 PDF에서 OOM 방지)
  canvas.width = 0;
  canvas.height = 0;
  try { page.cleanup(); } catch (err) {
    console.warn(`[pdf-parser] OCR page.cleanup() 실패 (page ${pageNum}):`, err);
  }
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  }
  return btoa(parts.join(''));
}

async function ocrFallback(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageCount: number,
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const pages: string[] = [];
  // Provider-aware 배치 크기. 클라우드 API(Claude/OpenAI)는 네트워크 레이턴시 지배적이어서
  // 큰 배치가 throughput에 유리. 로컬 Ollama는 단일 GPU/CPU에 제한되므로 작게 유지.
  // 읽기 시점에 store에서 provider를 조회 — 파싱 중 provider가 바뀔 일은 없음.
  const provider = useAppStore.getState().settings.provider;
  const BATCH_SIZE = provider === 'ollama' ? 3 : 8;
  // 대용량 PDF: 50+ 페이지 시 scale 자동 축소
  const scale = pageCount > 100 ? 1.0 : pageCount > 50 ? 1.5 : 2.0;

  for (let i = 0; i < pageCount; i += BATCH_SIZE) {
    // 취소 체크 — 배치 사이에 조기 종료 (in-flight IPC 는 취소 불가하지만 다음 배치 진입 차단)
    throwIfAborted(signal);
    const batch: Promise<string>[] = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, pageCount); j++) {
      const pageIdx = j;
      batch.push(
        renderPageToImage(pdf, pageIdx + 1, scale).then(async (base64) => {
          // IPC 전에 한 번 더 체크 — 렌더링이 끝났으나 취소된 경우 API 비용 절감
          throwIfAborted(signal);
          const result = await window.electronAPI.ai.ocrPage(base64);
          throwIfAborted(signal);
          return (result.success && result.text) ? result.text : '';
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
    const firstLine = pages[i].trim().split('\n')[0] || '';
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
        text: pages[i],
      };
    } else if (currentChapter) {
      currentChapter.text += '\n\n' + pages[i];
    } else {
      // 첫 챕터 이전 페이지 수집
      preChapterText += (preChapterText ? '\n\n' : '') + pages[i];
    }
  }

  if (currentChapter) {
    currentChapter.endPage = pages.length;
    chapters.push(currentChapter);
  }

  // 첫 챕터 이전 페이지(서론/목차 등)를 첫 챕터에 포함
  if (preChapterText && chapters.length > 0) {
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
  page: pdfjsLib.PDFPageProxy,
  pageIndex: number,
): Promise<PageImage[]> {
  // getOperatorList 는 pdfjs 내부 content stream 파싱을 수행 — 손상된 PDF 에서 hang 가능.
  // 5초 타임아웃을 Promise.race 로 걸어 뒤의 이미지 페치 경로에서 페이지를 빈 배열로 스킵.
  const opsOrEmpty = await Promise.race([
    page.getOperatorList(),
    new Promise<{ fnArray: number[]; argsArray: unknown[] }>((resolve) => {
      setTimeout(() => {
        console.warn(`[pdf-parser] page ${pageIndex + 1} getOperatorList timeout, skipping images`);
        resolve({ fnArray: [], argsArray: [] });
      }, 5000);
    }),
  ]);
  const ops = opsOrEmpty as Awaited<ReturnType<typeof page.getOperatorList>>;
  const images: PageImage[] = [];

  for (let j = 0; j < ops.fnArray.length && images.length < MAX_IMAGES_PER_PAGE; j++) {
    if (ops.fnArray[j] !== OPS.paintImageXObject) continue;

    const imageName = ops.argsArray[j]![0] as string;
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

async function imageDataToBase64(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): Promise<string | null> {
  try {
    let targetW = width;
    let targetH = height;
    if (Math.max(width, height) > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / Math.max(width, height);
      targetW = Math.round(width * scale);
      targetH = Math.round(height * scale);
    }

    const srcCanvas = new OffscreenCanvas(width, height);
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return null;

    const pixelCount = width * height;
    const isRGBA = data.length >= pixelCount * 4;
    const isRGB = !isRGBA && data.length >= pixelCount * 3;
    const isGrayscale = !isRGBA && !isRGB && data.length >= pixelCount;

    if (!isRGBA && !isRGB && !isGrayscale) return null; // 비지원 포맷 (CMYK 등)

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

    srcCtx.putImageData(new ImageData(rgbaData, width, height), 0, 0);

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    // GPU 메모리 즉시 해제 (GC 대기 없이 backing store 반환)
    srcCanvas.width = 0;
    srcCanvas.height = 0;
    canvas.width = 0;
    canvas.height = 0;
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
      message: '요약 진행 중에는 새 파일을 열 수 없습니다.',
    } as AppError);
    return;
  }
  if (store.isQaGenerating) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: 'Q&A 답변 생성 중에는 새 파일을 열 수 없습니다.',
    } as AppError);
    return;
  }
  if (data.byteLength > MAX_FILE_SIZE) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: `파일이 너무 큽니다 (${Math.round(data.byteLength / 1024 / 1024)}MB). 최대 100MB까지 지원합니다.`,
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
  const pdfBytesCopy = new Uint8Array(data.slice(0));
  try {
    const doc = await parsePdf(data, name, filePath, {
      enableOcrFallback: store.settings.enableOcrFallback,
      onOcrProgress: ownedProgress,
      signal: controller.signal,
    });
    // abort-replace 로 우리가 초과(supersede)된 경우, 성공한 파싱 결과를 store 에 반영하지 않는다.
    // 그렇지 않으면 오래된 문서가 새 문서를 덮어쓰는 경쟁 조건이 발생.
    if (activeParseController !== controller) return;
    // 새 문서로 교체되므로 이전 문서의 요약/Q&A/진행률 상태를 모두 초기화
    // (드롭/Ctrl+O로 덮어쓸 때 이전 문서의 summaryStream·qaMessages가 새 문서의 헤더와
    // 섞여 표시되는 버그 방지)
    store.clearStream();
    store.setSummary(null);
    store.setProgress(0);
    store.setProgressInfo(null);
    store.clearQa();
    store.setDocument(doc);
    store.setPdfBytes(pdfBytesCopy); // PdfViewer 가 참조할 원본
    store.setError(null);
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
      message: error.message || 'PDF를 읽을 수 없습니다.',
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

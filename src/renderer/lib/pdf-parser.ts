import * as pdfjsLib from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
import type { PdfDocument, Chapter, PageImage } from '../types';

// PDF.js worker 설정
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  filePath: string,
): Promise<PdfDocument> {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pageCount = pdf.numPages;

  // 배치 병렬 처리 (한 번에 10페이지씩)
  const BATCH_SIZE = 10;
  const MAX_TOTAL_IMAGES = 50;
  const pages: string[] = new Array(pageCount);
  const allImages: PageImage[] = [];

  for (let batchStart = 0; batchStart < pageCount; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, pageCount);
    const promises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      promises.push(
        pdf.getPage(i + 1).then(async (page) => {
          // 이미지 추출 (텍스트와 병렬)
          const imagePromise = extractPageImages(page, i).catch(() => [] as PageImage[]);

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
        }),
      );
    }
    await Promise.all(promises);
  }

  const extractedText = pages.join('\n\n');

  if (extractedText.trim().length < 50) {
    throw Object.assign(new Error('PDF에서 텍스트를 추출할 수 없습니다. 이미지 기반 PDF는 지원하지 않습니다.'), {
      code: 'PDF_NO_TEXT',
    });
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
}

function detectChapters(pages: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  // 헤딩 패턴: "1.", "제1장", "Chapter 1", "1장" 등
  const headingPattern = /^(제?\d+[장절]|chapter\s*\d+|\d+\.\s)/i;

  let currentChapter: Chapter | null = null;
  let chapterIndex = 0;

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
    }
  }

  if (currentChapter) {
    currentChapter.endPage = pages.length;
    chapters.push(currentChapter);
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
const MAX_IMAGES_PER_PAGE = 10;

async function extractPageImages(
  page: pdfjsLib.PDFPageProxy,
  pageIndex: number,
): Promise<PageImage[]> {
  const ops = await page.getOperatorList();
  const images: PageImage[] = [];

  for (let j = 0; j < ops.fnArray.length && images.length < MAX_IMAGES_PER_PAGE; j++) {
    if (ops.fnArray[j] !== OPS.paintImageXObject) continue;

    const imageName = ops.argsArray[j]![0] as string;
    let imgData: { width: number; height: number; data: Uint8ClampedArray; kind?: number } | null = null;
    try {
      imgData = await new Promise((resolve, reject) => {
        page.objs.get(imageName, (obj: unknown) => {
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
        setTimeout(() => reject(new Error('timeout')), 3000);
      });
    } catch {
      continue;
    }

    if (!imgData || imgData.width < MIN_IMAGE_SIZE || imgData.height < MIN_IMAGE_SIZE) continue;
    if (!imgData.data || imgData.data.length === 0) continue;

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
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

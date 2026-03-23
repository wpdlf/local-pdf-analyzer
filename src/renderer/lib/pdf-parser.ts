import * as pdfjsLib from 'pdfjs-dist';
import type { PdfDocument, Chapter } from '../types';

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
  const pages: string[] = new Array(pageCount);

  for (let batchStart = 0; batchStart < pageCount; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, pageCount);
    const promises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      promises.push(
        pdf.getPage(i + 1).then(async (page) => {
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
    chapters,
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

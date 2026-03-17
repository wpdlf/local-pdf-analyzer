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
  const pages: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pages.push(pageText);
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

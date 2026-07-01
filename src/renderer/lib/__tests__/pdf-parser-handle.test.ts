// @vitest-environment happy-dom

// pdf-parser 보강 — handlePdfData 오케스트레이션(가드/성공/에러 매핑)과 cancelPdfParse,
// parsePdf 의 pageCount 가드·OCR fallback 경로. parsePdf 의 텍스트 추출/이미지 캡/args 가드는
// pdf-parser.test.ts(node-env) 가 별도 커버. pdfjs-dist/worker/use-session 은 목 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P = vi.hoisted(() => {
  // getOperatorList(이미지 추출 경로의 비싼 호출)를 공유 spy 로 — extractImages 스킵 검증용.
  const getOperatorList = vi.fn(() => Promise.resolve({ fnArray: [], argsArray: [] }));
  function makePage(items: unknown[]) {
    return {
      getTextContent: () => Promise.resolve({ items }),
      getOperatorList,
      objs: { get: () => {} },
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
    };
  }
  function fakePdf(numPages: number, items: unknown[]) {
    return {
      numPages,
      getPage: vi.fn(() => Promise.resolve(makePage(items))),
      destroy: vi.fn(() => Promise.resolve()),
    };
  }
  return { fakePdf, getOperatorList, getDocument: vi.fn(), restore: vi.fn(() => Promise.resolve()), persist: vi.fn(() => Promise.resolve()) };
});

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
// pdfjs 6.x: 프로덕션 코드가 PDFDocumentProxy.destroy() 대신 loadingTask.destroy() 를 호출한다.
// mock 의 loadingTask({ promise }) 에 destroy 가 없으면 에러 분기(page 0 / too-many-pages)에서
// TypeError 가 나 기대 에러코드가 안 잡힌다. P.getDocument 에 위임하면서(호출수 검증 보존) destroy 부착.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => {
    const task = P.getDocument(...args) as { promise: Promise<unknown>; destroy?: unknown };
    if (task && typeof task.destroy !== 'function') task.destroy = vi.fn(() => Promise.resolve());
    return task;
  },
  OPS: { paintImageXObject: 85 },
}));
vi.mock('../use-session', () => ({ restoreSessionForDocument: P.restore, persistCurrentSession: P.persist }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { ocrPage: vi.fn(() => Promise.resolve({ success: false, text: '' })), abort: vi.fn(() => Promise.resolve()) } },
}));
vi.stubGlobal('crypto', { randomUUID: () => 'doc-uuid' });

import { handlePdfData, cancelPdfParse, MAX_PAGE_COUNT } from '../pdf-parser';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';
import { MAX_PDF_SIZE_BYTES } from '../../../shared/constants';

const GOOD_ITEMS = [{ str: 'A'.repeat(60), transform: [12, 0, 0, 12, 0, 700], width: 100 }];
const SHORT_ITEMS = [{ str: 'ab', transform: [12, 0, 0, 12, 0, 700], width: 10 }];

function pdfBuf(extra = 200): ArrayBuffer {
  const u = new Uint8Array(5 + extra);
  u.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
  return u.buffer;
}

beforeEach(() => {
  vi.clearAllMocks();
  P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, GOOD_ITEMS)) });
  P.restore.mockResolvedValue(undefined);
  P.persist.mockResolvedValue(undefined);
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false },
    document: null, isGenerating: false, isQaGenerating: false, isParsing: false, isCollectionBusy: false,
    error: null, summary: null, summaryStream: '', qaMessages: [], pdfBytes: null,
  });
});
afterEach(() => { cancelPdfParse(); });

describe('handlePdfData — 가드', () => {
  it('요약 생성 중이면 거부 + parse 미시도', async () => {
    useAppStore.setState({ isGenerating: true });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  it('Q&A 생성 중이면 거부', async () => {
    useAppStore.setState({ isQaGenerating: true });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  // QA post-v0.31.15(M2): 컬렉션 gather 단계(isCollectionBusy=true, isQaGenerating 아직 false)에도
  // 새 파일 열기를 차단 — isTabSwitchBlocked 와 대칭(누락 시 in-flight 멤버 요약 토큰 낭비).
  it('컬렉션 요약 gather 중(isCollectionBusy)이면 거부', async () => {
    useAppStore.setState({ isGenerating: false, isQaGenerating: false, isCollectionBusy: true });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  it('용량 초과 → PDF_PARSE_FAIL', async () => {
    const big = new ArrayBuffer(MAX_PDF_SIZE_BYTES + 1);
    await handlePdfData(big, 'big.pdf', '/d/big.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/너무 큽니다/);
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  it('매직바이트 불일치(위장 바이너리) → 거부', async () => {
    const u = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await handlePdfData(u.buffer, 'fake.pdf', '/d/fake.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/유효한 PDF/);
    expect(P.getDocument).not.toHaveBeenCalled();
  });
});

describe('handlePdfData — 성공 오케스트레이션', () => {
  it('유효 PDF(실경로) → 문서 설정 + 세션 복원 트리거, pdfBytes 는 비상주(lazy)', async () => {
    await handlePdfData(pdfBuf(), 'lecture.pdf', '/d/lecture.pdf');
    const s = useAppStore.getState();
    expect(P.getDocument).toHaveBeenCalledTimes(1);
    expect(s.document?.fileName).toBe('lecture.pdf');
    expect(s.document?.pageCount).toBe(2);
    expect(s.document?.chapters.length).toBeGreaterThan(0);
    // pdfBytes 비상주(메모리 M1): 재읽기 가능한 실경로는 상주 안 함 — 인용 클릭 시 lazy 로드.
    expect(s.pdfBytes).toBeNull();
    expect(P.restore).toHaveBeenCalledTimes(1);
    expect(s.error).toBeNull();
    expect(s.isParsing).toBe(false);
  });

  it('합성경로(경로 구분자 없음) 드롭 → 재읽기 불가라 pdfBytes 상주(fallback)', async () => {
    await handlePdfData(pdfBuf(), 'lecture.pdf', 'lecture.pdf'); // getPathForFile 실패 시 파일명 fallback
    const s = useAppStore.getState();
    expect(s.document?.fileName).toBe('lecture.pdf');
    expect(s.pdfBytes).not.toBeNull(); // 재읽기 불가 → 상주 유지
  });

  // perf(A1): 이미지 분석 OFF면 parsePdf 가 이미지 추출(getOperatorList=pdfjs 최고비용)을 스킵.
  it('enableImageAnalysis=true → getOperatorList 호출(이미지 경로 실행)', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: true } });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(P.getOperatorList).toHaveBeenCalled();
  });

  it('enableImageAnalysis=false → getOperatorList 미호출(추출 스킵) + images 비어있음', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: false } });
    await handlePdfData(pdfBuf(), 'b.pdf', '/d/b.pdf');
    expect(P.getOperatorList).not.toHaveBeenCalled();
    expect(useAppStore.getState().document?.images).toEqual([]);
  });

  it('기존 문서가 있으면 새 문서 반영 전에 persist flush', async () => {
    useAppStore.setState({ document: { id: 'old', fileName: 'old.pdf', filePath: '/d/old.pdf', pageCount: 1, extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date() } });
    await handlePdfData(pdfBuf(), 'new.pdf', '/d/new.pdf');
    expect(P.persist).toHaveBeenCalled();
    expect(useAppStore.getState().document?.fileName).toBe('new.pdf');
  });
});

describe('handlePdfData — parsePdf 경로/에러 매핑', () => {
  it('페이지 0 → PDF_NO_TEXT', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(0, GOOD_ITEMS)) });
    await handlePdfData(pdfBuf(), 'empty.pdf', '/d/empty.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('페이지 수 초과 → PDF_TOO_MANY_PAGES', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(MAX_PAGE_COUNT + 1, GOOD_ITEMS)) });
    await handlePdfData(pdfBuf(), 'huge.pdf', '/d/huge.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_TOO_MANY_PAGES');
  });

  it('텍스트 거의 없음 + OCR 비활성 → PDF_NO_TEXT', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, SHORT_ITEMS)) });
    await handlePdfData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('텍스트 거의 없음 + OCR 활성 → OCR 시도 후 OCR_FAIL', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: true } });
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, SHORT_ITEMS)) });
    await handlePdfData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');
    expect(useAppStore.getState().error?.code).toBe('OCR_FAIL');
  });

  it('getDocument 가 ABORTED → 에러 배너 미표시(의도적 취소)', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.reject(Object.assign(new Error('취소'), { code: 'ABORTED' })) });
    await handlePdfData(pdfBuf(), 'x.pdf', '/d/x.pdf');
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isParsing).toBe(false);
  });

  it('getDocument 일반 에러 → PDF_PARSE_FAIL 로 매핑', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.reject(new Error('손상된 스트림')) });
    await handlePdfData(pdfBuf(), 'x.pdf', '/d/x.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(useAppStore.getState().error?.message).toMatch(/손상된 스트림/);
  });
});

describe('cancelPdfParse', () => {
  it('진행 중 파싱이 없으면 안전하게 no-op', () => {
    expect(() => cancelPdfParse()).not.toThrow();
  });
});

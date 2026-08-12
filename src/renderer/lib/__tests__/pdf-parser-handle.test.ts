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

  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 중에도 새 파일 열기 차단 — 드롭/최근
  // 문서/전역검색/Ctrl+O 는 isTabSwitchBlocked 를 안 거치므로 여기 진입 가드가 유일한 방어선.
  it('컬렉션 열기 중(collectionOpenInFlight)이면 거부', async () => {
    useAppStore.setState({ isGenerating: false, isQaGenerating: false, isCollectionBusy: false, collectionOpenInFlight: true });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
    useAppStore.setState({ collectionOpenInFlight: false });
  });

  // QA post-v0.31.16(i18n 갭): 진입 가드 메시지가 하드코딩 한글이 아니라 i18n 을 거친다.
  // en 로케일에서 영문으로 표시되어야 한다(이전엔 영어 UI 에도 한글 노출).
  it('en 로케일: 가드/검증 메시지가 i18n 영문으로 표시된다', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', uiLanguage: 'en' }, isGenerating: true });
    await handlePdfData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/Cannot open a new file while summarizing/);

    // 매직바이트 실패 메시지도 영문(위장 바이너리)
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', uiLanguage: 'en' }, isGenerating: false });
    await handlePdfData(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer, 'fake.pdf', '/d/fake.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/Not a valid PDF file/);
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

  // QA13(C-LOW): pdfjs 는 %PDF- 앞의 선행 바이트(BOM 등)를 허용한다. 게이트가 오프셋0 정확매칭만
  // 하면 그런 유효 PDF 를 오거부 → 앞쪽 1KB 창 스캔으로 완화. BOM 접두 PDF 가 파싱 시도되어야 한다.
  it('선행 BOM 이 있는 유효 PDF 는 매직 게이트를 통과한다', async () => {
    const body = new Uint8Array(3 + 5 + 200);
    body.set([0xef, 0xbb, 0xbf], 0);            // UTF-8 BOM
    body.set([0x25, 0x50, 0x44, 0x46, 0x2d], 3); // %PDF-
    await handlePdfData(body.buffer, 'bom.pdf', '/d/bom.pdf');
    expect(P.getDocument).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().error).toBeNull();
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

  // QA22 백로그: 조립 로직을 순수 함수(assemblePageText)로 분리하면서, **그 함수가 실제로 파싱
  // 경로에 배선돼 있는지**를 별도로 잡는다. 순수 테스트만 두면 호출을 떼어내는 뮤테이션이 통과한다
  // (같은 실수를 이번 사이클 dedup 배선에서 한 번 했다).
  it('배선: 위치 기반 공백·줄바꿈이 실제 파싱 결과(pageTexts)에 반영된다', async () => {
    // PDF_NO_TEXT 가드(최소 길이)를 넘기려면 본문이 충분히 길어야 하므로 각 조각을 30자로 만든다.
    const seg = (ch: string) => ch.repeat(30);
    const items = [
      { str: seg('가'), transform: [10, 0, 0, 10, 0, 700], width: 300 },
      { str: seg('나'), transform: [10, 0, 0, 10, 300, 700], width: 300 }, // 바로 이어짐 → 붙여쓰기
      { str: seg('다'), transform: [10, 0, 0, 10, 0, 680], width: 300 },   // y 20 차 → 줄바꿈
      { str: seg('라'), transform: [10, 0, 0, 10, 360, 680], width: 300 }, // 넓은 간격 → 공백
    ];
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(1, items)) });
    await handlePdfData(pdfBuf(), 'pos.pdf', '/d/pos.pdf');
    expect(useAppStore.getState().document?.pageTexts[0])
      .toBe(`${seg('가')}${seg('나')}\n${seg('다')} ${seg('라')}`);
  });

  // QA23(C-MED) 배선: 검사 예산이 실제 파싱 루프에 걸려 있는지. 순수 판정만 테스트하면
  // 호출을 떼는 뮤테이션이 통과한다(이번 사이클 dedup 배선에서 겪은 형태).
  it('배선: 채택되지 않는 이미지만 반복돼도 페이지 열기가 무한히 계속되지 않는다', async () => {
    // 모든 이미지가 MAX_IMAGE_PIXELS 초과로 거절되는 문서(300 DPI 스캔) — 채택 수는 영원히 0.
    const huge = { width: 3000, height: 3000, data: new Uint8ClampedArray(4), kind: 3 };
    const opsPerPage = 40;
    const getOperatorList = vi.fn(() => Promise.resolve({
      fnArray: new Array(opsPerPage).fill(85),                       // OPS.paintImageXObject
      argsArray: new Array(opsPerPage).fill(['img_dup']),
    }));
    const page = {
      getTextContent: () => Promise.resolve({ items: [{ str: 'A'.repeat(80), transform: [12, 0, 0, 12, 0, 700], width: 100 }] }),
      getOperatorList,
      objs: { get: (_n: string, cb: (o: unknown) => void) => cb(huge) },
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
    };
    P.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 60, getPage: vi.fn(() => Promise.resolve(page)), destroy: vi.fn(() => Promise.resolve()) }),
    });
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: true } });

    await handlePdfData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');

    // 예산(400 검사)이 페이지당 40장이면 10페이지에서 소진 — 60페이지 전부를 열지 않아야 한다.
    expect(getOperatorList.mock.calls.length).toBeLessThan(60);
    expect(useAppStore.getState().document?.images).toEqual([]); // 전량 거절은 종전대로
  });

  // QA24(A-I1): 드롭·Ctrl+O·최근 문서·전역 검색은 전부 이 함수로 직행한다. 영속화 OFF 면
  // 새 문서 로드가 현재 요약·Q&A 를 되돌릴 수 없이 파기하는데, 종전에는 탭 전환에만 확인이
  // 있었고 이 경로들은 무경고였다.
  describe('영속화 OFF 파기 확인 (직행 로드 경로)', () => {
    const seedWorkWithPersistOff = () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        document: { id: 'old', fileName: 'old.pdf', filePath: '/d/old.pdf', pageCount: 1, extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date() },
        qaMessages: [{ id: 'q1', role: 'user', content: '질문' }],
      });
    };

    it('취소하면 파싱조차 시작하지 않는다 (수십 초 파싱 뒤 묻는 확인은 의미가 없다)', async () => {
      seedWorkWithPersistOff();
      P.getDocument.mockClear();
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await handlePdfData(pdfBuf(), 'new.pdf', '/d/new.pdf');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(P.getDocument, '취소했는데 파싱이 돌면 안 된다').not.toHaveBeenCalled();
        expect(useAppStore.getState().document?.fileName, '기존 문서가 유지돼야 한다').toBe('old.pdf');
        expect(useAppStore.getState().qaMessages).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('확인하면 종전대로 진행한다', async () => {
      seedWorkWithPersistOff();
      vi.stubGlobal('confirm', vi.fn(() => true));
      try {
        await handlePdfData(pdfBuf(), 'new.pdf', '/d/new.pdf');
        expect(useAppStore.getState().document?.fileName).toBe('new.pdf');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('열린 문서가 없으면(첫 로드) 묻지 않는다 — 파기할 것이 없다', async () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        document: null,
        qaMessages: [],
      });
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await handlePdfData(pdfBuf(), 'first.pdf', '/d/first.pdf');
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('skipDiscardConfirm=true 면 묻지 않는다 (탭 전환 fallback 의 이중 질문 방지)', async () => {
      seedWorkWithPersistOff();
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await handlePdfData(pdfBuf(), 'new.pdf', '/d/new.pdf', { skipDiscardConfirm: true });
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
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

  // QA13(C-MED): 암호화/손상 PDF 는 loadingTask.promise 가 try/finally 진입 전 reject 하므로
  // destroy 가 누락돼 pdfjs 워커가 누수됐다. reject 경로에서도 파기하고, PasswordException 은
  // 전용 로컬라이즈 코드(PDF_ENCRYPTED)로 매핑하는지 가드.
  it('암호화 PDF(PasswordException) → PDF_ENCRYPTED + loadingTask.destroy 로 워커 파기', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    P.getDocument.mockReturnValue({
      promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
      destroy,
    });
    await handlePdfData(pdfBuf(), 'locked.pdf', '/d/locked.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_ENCRYPTED');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('cancelPdfParse', () => {
  it('진행 중 파싱이 없으면 안전하게 no-op', () => {
    expect(() => cancelPdfParse()).not.toThrow();
  });
});

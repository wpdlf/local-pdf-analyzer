// @vitest-environment happy-dom

// QA29(C-1/C-2): OCR 파이프라인의 중단 판정 회귀 넷.
//
// C-1 — 배치 루프에 **무진전 회로차단기가 없었다**: per-page catch 와 배치 catch 가 ABORTED 외
//        모든 실패를 '' 로 삼켜서 실패를 한 번도 세지 않고 언제나 pageCount 까지 완주했다.
//        Ollama 고착 시 페이지마다 90초를 태워 300페이지 = 약 2.5시간 동안 isParsing 게이트가
//        요약·Q&A·컬렉션을 잠갔다.
// C-2 — 최종 성공/실패를 **절대 문자수**(`ocrText.trim().length < 50`) 하나로 판정해, 300장 중
//        앞 10장만 OCR 된 채 죽어도 "성공" 으로 끝나고 자동저장이 빈 pageTexts 290장을 디스크의
//        온전한 세션 위에 덮어썼다.
//
// 판정은 순수 함수 ocrAbortReason 에 있으므로 경계값은 파이프라인 모킹 없이 고정하고,
// 배선(루프가 실제로 끊기는가 / ABORTED 가 여전히 전파되는가)만 parsePdf 통합으로 검증한다.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const P = vi.hoisted(() => {
  const ocrPage = vi.fn();
  return { ocrPage, getDocument: vi.fn() };
});

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => {
    const task = P.getDocument(...args) as { promise: Promise<unknown>; destroy?: unknown };
    if (task && typeof task.destroy !== 'function') task.destroy = vi.fn(() => Promise.resolve());
    return task;
  },
  OPS: { paintImageXObject: 85 },
}));

// OCR 렌더 경로(OffscreenCanvas → convertToBlob → btoa)를 최소 구현으로 통과시켜야
// ai.ocrPage 가 실제로 호출된다. 스텁이 없으면 렌더가 먼저 실패해 "전량 공란" 이 되는데,
// 그러면 ocrPage 호출 수로 회로차단기를 관측할 수 없다(테스트가 공허해진다).
class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext(): object { return {}; }
  convertToBlob(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) });
  }
}
vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { ocrPage: P.ocrPage, abort: vi.fn(() => Promise.resolve()) } },
}));
vi.stubGlobal('crypto', { randomUUID: () => 'doc-uuid' });

import {
  parsePdf,
  ocrAbortReason,
  isBlankOcrPage,
  OCR_BLANK_BATCH_STREAK_LIMIT,
  OCR_BLANK_PAGE_RATIO_LIMIT,
} from '../pdf-parser';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';

// 텍스트 레이어가 사실상 비어 있어야 OCR fallback 으로 진입한다.
const SHORT_ITEMS = [{ str: 'ab', transform: [12, 0, 0, 12, 0, 700], width: 10 }];

function makePage() {
  return {
    getTextContent: () => Promise.resolve({ items: SHORT_ITEMS }),
    getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
    objs: { get: () => {} },
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => {},
  };
}

function mockPdf(numPages: number): void {
  P.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages, getPage: vi.fn(() => Promise.resolve(makePage())) }),
    destroy: vi.fn(() => Promise.resolve()),
  });
}

function pdfBuf(): ArrayBuffer {
  return new Uint8Array(64).buffer;
}

/** 페이지 인덱스(1-base 호출 순서)마다 OCR 결과 텍스트를 정하는 헬퍼. */
function ocrReturns(textFor: (callIndex: number) => string): void {
  let n = 0;
  P.ocrPage.mockImplementation(() => {
    const text = textFor(++n);
    return Promise.resolve({ success: true, text });
  });
}

const LONG = 'OCR 로 추출한 본문 텍스트입니다. '.repeat(4);

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: true },
    notice: null,
  });
});

describe('isBlankOcrPage — 공란 판정 단일 출처', () => {
  it('빈 문자열·공백만·undefined 는 공란', () => {
    expect(isBlankOcrPage('')).toBe(true);
    expect(isBlankOcrPage('   \n\t ')).toBe(true);
    expect(isBlankOcrPage(undefined)).toBe(true);
  });

  it('글자가 하나라도 있으면 공란이 아니다', () => {
    expect(isBlankOcrPage(' a ')).toBe(false);
  });
});

describe('ocrAbortReason — C-1 연속 전량공란 스트릭 경계', () => {
  it(`스트릭이 상한(${OCR_BLANK_BATCH_STREAK_LIMIT}) 미만이면 계속 진행한다`, () => {
    for (let s = 0; s < OCR_BLANK_BATCH_STREAK_LIMIT; s++) {
      expect(ocrAbortReason(
        { consecutiveBlankBatches: s, processedPages: s * 3, blankPages: s * 3 },
        'inProgress',
      )).toBeNull();
    }
  });

  it(`스트릭이 상한(${OCR_BLANK_BATCH_STREAK_LIMIT})에 닿으면 blankStreak 으로 중단한다`, () => {
    expect(ocrAbortReason(
      { consecutiveBlankBatches: OCR_BLANK_BATCH_STREAK_LIMIT, processedPages: 9, blankPages: 9 },
      'inProgress',
    )).toBe('blankStreak');
    // final 단계에서도 같은 판정(두 호출자가 기준을 공유한다).
    expect(ocrAbortReason(
      { consecutiveBlankBatches: OCR_BLANK_BATCH_STREAK_LIMIT + 5, processedPages: 9, blankPages: 9 },
      'final',
    )).toBe('blankStreak');
  });
});

describe('ocrAbortReason — C-2 공란 비율 경계', () => {
  it(`비율이 상한(${OCR_BLANK_PAGE_RATIO_LIMIT}) 이하면 통과한다(부분 실패 통지만)`, () => {
    expect(ocrAbortReason(
      { consecutiveBlankBatches: 0, processedPages: 100, blankPages: 30 },
      'final',
    )).toBeNull();
  });

  it('비율이 상한을 넘으면 blankRatio 로 실패시킨다 — 부분 결과가 저장되지 않도록', () => {
    expect(ocrAbortReason(
      { consecutiveBlankBatches: 0, processedPages: 100, blankPages: 31 },
      'final',
    )).toBe('blankRatio');
    // C-2 원래 시나리오: 300장 중 앞 10장만 성공.
    expect(ocrAbortReason(
      { consecutiveBlankBatches: 0, processedPages: 300, blankPages: 290 },
      'final',
    )).toBe('blankRatio');
  });

  it('진행 중(inProgress)에는 비율로 끊지 않는다 — 표본이 앞쪽에 치우쳐 오탐한다', () => {
    expect(ocrAbortReason(
      { consecutiveBlankBatches: 1, processedPages: 3, blankPages: 3 },
      'inProgress',
    )).toBeNull();
  });

  it('공란이 1장뿐이면 비율이 높아도 통과한다(표본 하한 — 2페이지 문서의 간지)', () => {
    expect(ocrAbortReason(
      { consecutiveBlankBatches: 0, processedPages: 2, blankPages: 1 },
      'final',
    )).toBeNull();
  });

  it('정상 문서(공란 0)는 어느 단계에서도 영향받지 않는다', () => {
    expect(ocrAbortReason({ consecutiveBlankBatches: 0, processedPages: 300, blankPages: 0 }, 'final')).toBeNull();
    expect(ocrAbortReason({ consecutiveBlankBatches: 0, processedPages: 0, blankPages: 0 }, 'final')).toBeNull();
  });
});

describe('parsePdf OCR 배선 — 회로차단기와 실패 판정', () => {
  it('C-1: 전량 공란이 3배치 연속되면 남은 페이지를 태우지 않고 OCR_FAIL 로 끊는다', async () => {
    // ollama BATCH_SIZE=3 × 10페이지 = 3/3/3/1 배치. 회로차단기가 없으면 10회 전부 호출된다.
    mockPdf(10);
    ocrReturns(() => '');
    await expect(parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true }))
      .rejects.toMatchObject({ code: 'OCR_FAIL' });
    expect(P.ocrPage).toHaveBeenCalledTimes(9);
  });

  it('C-1: 한 장이라도 건진 배치가 나오면 스트릭이 리셋돼 문서를 완주한다', async () => {
    // 첫 배치(1~3)만 공란, 이후 9장 성공 → 공란 3/12 = 25% ≤ 30% → 성공 + 부분 실패 통지.
    mockPdf(12);
    ocrReturns((n) => (n <= 3 ? '' : LONG));
    const doc = await parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true });
    expect(P.ocrPage).toHaveBeenCalledTimes(12);
    expect(doc.isOcr).toBe(true);
    expect(doc.pageTexts).toHaveLength(12);
    // 기존 부분 실패 고지는 그대로 살아 있어야 한다(임계 미만 구간의 유일한 신호).
    expect(useAppStore.getState().notice).not.toBeNull();
  });

  it('C-2: 앞부분만 OCR 되고 나머지가 공란이면 — 문자수는 충분해도 OCR_FAIL', async () => {
    // 6페이지 중 앞 3장 성공(수백 자 = 종전 임계 50자를 가볍게 통과) + 뒤 3장 공란 → 50%.
    // 스트릭은 1 이므로 회로차단기가 아니라 **비율 판정**이 끊었다는 것을 호출 수로 고정한다.
    mockPdf(6);
    ocrReturns((n) => (n <= 3 ? LONG : ''));
    await expect(parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true }))
      .rejects.toMatchObject({ code: 'OCR_FAIL' });
    expect(P.ocrPage).toHaveBeenCalledTimes(6);
  });

  it('전 페이지 정상 OCR 이면 그대로 성공한다(회로차단기가 정상 문서를 막지 않는다)', async () => {
    mockPdf(9);
    ocrReturns(() => LONG);
    const doc = await parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true });
    expect(doc.isOcr).toBe(true);
    expect(doc.extractedText).toContain('OCR 로 추출한 본문');
    expect(P.ocrPage).toHaveBeenCalledTimes(9);
  });

  it('ABORTED 는 회로차단기에 삼켜지지 않고 그대로 전파된다', async () => {
    mockPdf(9);
    P.ocrPage.mockResolvedValue({ success: false, code: 'ABORTED' });
    await expect(parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    // 첫 배치에서 즉시 중단 — OCR_FAIL 로 강등되지 않는다.
    expect(P.ocrPage).toHaveBeenCalledTimes(3);
  });

  // QA30(A-F4): 401 은 **모든 페이지에 똑같이 재현될 조건**이라 페이지 단위 사고가 아니다.
  // 이전엔 per-page catch 가 '' 로 삼켜 회로차단기가 "OCR_FAIL(PDF 품질 문제)" 로 보고했고,
  // 사용자는 키를 회수·만료한 사실을 끝내 알 수 없었다.
  it('API_KEY_INVALID 는 OCR_FAIL 로 둔갑하지 않고 즉시 전파된다', async () => {
    mockPdf(9);
    P.ocrPage.mockResolvedValue({ success: false, code: 'API_KEY_INVALID', error: 'HTTP 401' });
    await expect(parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true }))
      .rejects.toMatchObject({ code: 'API_KEY_INVALID' });
    // 남은 페이지를 태우지 않는다(클라우드면 페이지마다 왕복 비용).
    expect(P.ocrPage).toHaveBeenCalledTimes(3);
  });

  // QA30 후속 — **실기기 스모크가 잡은 것**. Vision 모델이 설치돼 있지 않으면 OCR 이 페이지마다
  // 404 를 받는데, 그것을 '' 로 삼키면 최종 안내가 "OCR로도 텍스트를 추출할 수 없습니다.
  // PDF 품질을 확인해주세요" 가 된다. 실제 해결책은 `ollama pull llava` 이므로, 사용자를
  // 엉뚱한 곳(PDF 품질)으로 보내는 조용한 오답이다.
  it('OLLAMA_MODEL_NOT_FOUND 는 PDF 품질 문제로 둔갑하지 않고 모델명과 함께 전파된다', async () => {
    mockPdf(9);
    P.ocrPage.mockResolvedValue({
      success: false, code: 'OLLAMA_MODEL_NOT_FOUND',
      errorKey: 'ollamaModelNotFound', errorParams: { model: 'llava' },
      error: 'Vision API 요청 실패: HTTP 404',
    });
    const err = await parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true })
      .then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err?.code).toBe('OLLAMA_MODEL_NOT_FOUND');
    // 어떤 모델을 받아야 하는지가 메시지에 있어야 사용자가 움직일 수 있다.
    expect(err?.message).toContain('llava');
    expect(err?.message).not.toContain('PDF 품질');
    // 모든 페이지에 똑같이 재현될 조건이므로 남은 페이지를 태우지 않는다.
    expect(P.ocrPage).toHaveBeenCalledTimes(3);
  });

  it('OLLAMA_OOM 도 같은 계약 — 메모리 사유가 그대로 올라온다', async () => {
    mockPdf(9);
    P.ocrPage.mockResolvedValue({
      success: false, code: 'OLLAMA_OOM',
      errorKey: 'ollamaOutOfMemory', errorParams: { detail: 'requires more system memory (9.2 GiB)' },
      error: 'Vision API 요청 실패: HTTP 500',
    });
    const err = await parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true })
      .then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err?.code).toBe('OLLAMA_OOM');
    expect(err?.message).toContain('9.2 GiB');
    expect(P.ocrPage).toHaveBeenCalledTimes(3);
  });

  it('그 외 실패는 종전대로 페이지 단위로 삼켜 나머지를 계속 OCR 한다 (과잉 전파 방지)', async () => {
    mockPdf(12);
    let n = 0;
    P.ocrPage.mockImplementation(() => {
      n++;
      return n <= 2
        ? Promise.resolve({ success: false, error: '일시적 IPC 오류' })
        : Promise.resolve({ success: true, text: LONG });
    });
    const doc = await parsePdf(pdfBuf(), 'scan.pdf', '/d/scan.pdf', { enableOcrFallback: true });
    expect(P.ocrPage).toHaveBeenCalledTimes(12);
    expect(doc.pageTexts).toHaveLength(12);
  });
});

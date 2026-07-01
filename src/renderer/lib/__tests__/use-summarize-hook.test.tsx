// @vitest-environment happy-dom

// useSummarize 오케스트레이션 행위 — handleSummarize 의 가드/가용성/전체·챕터·다청크 통합 경로,
// PDF_NO_TEXT, 후처리(strip+citation), 이미지 분석(preflight 성공/실패), handleAbort.
// 순수 헬퍼(labelParagraphsWithPages/stripConversationalText)는 use-summarize(.strip).test 가 별도 커버.
// AiClient 만 목 격리 — chunker/citation/enrich-doc 는 실제 모듈 사용.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const M = vi.hoisted(() => ({
  available: true,
  tokens: ['핵심 ', '요약'] as string[],
  summarizeCalls: [] as { text: string; type: string }[],
  imageResult: 'IMG_DESC' as string | null,
  imageCalls: 0,
  // preflight analyzeImage 호출 시 실행할 훅(테스트에서 abort 등 store 변경 주입용).
  onAnalyzeImage: null as null | (() => void),
  reqCounter: 0,
  // Stop→재요약 race 테스트용: 첫 summarize 호출만 이 promise 에서 일시정지시켜
  // stale run 의 finally 가 새 run 보다 늦게 도달하는 상황을 결정적으로 재현.
  gate: null as Promise<void> | null,
}));

vi.mock('../ai-client', () => ({
  AiClient: class {
    constructor(_settings: unknown) { /* noop */ }
    async isAvailable() { return M.available; }
    prepareSummarize() { return `req-${++M.reqCounter}`; }
    // 실제 시그니처: summarize(text, type, requestId?) — 계약 패리티를 위해 3번째 인자 포함.
    async *summarize(text: string, type: string, _requestId?: string): AsyncGenerator<string> {
      M.summarizeCalls.push({ text, type });
      // 첫 호출만 gate 에서 대기 (race 재현). 이후 호출은 즉시 진행.
      if (M.gate && M.summarizeCalls.length === 1) { await M.gate; }
      for (const tk of M.tokens) yield tk;
    }
    async analyzeImage(_b: string, _r?: string): Promise<string | null> {
      M.imageCalls++;
      M.onAnalyzeImage?.();
      return M.imageResult;
    }
  },
}));

const abortMock = vi.fn(() => Promise.resolve());
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { abort: abortMock, analyzeImage: vi.fn() } },
}));
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random()}` });

import { useSummarize } from '../use-summarize';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';
import type { PdfDocument, PageImage } from '../../types';

function makeDoc(over: Partial<PdfDocument> = {}): PdfDocument {
  return {
    id: 'doc-1', fileName: 'a.pdf', filePath: '/d/a.pdf', pageCount: 1,
    extractedText: '본문 텍스트입니다.', pageTexts: ['본문 텍스트입니다.'],
    chapters: [], images: [], createdAt: new Date('2026-06-17T00:00:00Z'),
    ...over,
  };
}

function img(pageIndex: number): PageImage {
  return { pageIndex, imageIndex: 0, base64: 'AAAA', width: 10, height: 10, mimeType: 'image/png' };
}

beforeEach(() => {
  M.available = true;
  M.tokens = ['핵심 ', '요약'];
  M.summarizeCalls = [];
  M.imageResult = 'IMG_DESC';
  M.imageCalls = 0;
  M.onAnalyzeImage = null;
  M.reqCounter = 0;
  M.gate = null;
  abortMock.mockClear();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false },
    document: makeDoc(),
    summaryType: 'full',
    isGenerating: false,
    isQaGenerating: false,
    summaryStream: '',
    summary: null,
    error: null,
    enrichedPageTexts: null,
    currentRequestId: null,
  });
});
afterEach(() => {
  useAppStore.setState({ isGenerating: false });
});

async function runSummarize() {
  const { result } = renderHook(() => useSummarize());
  await act(async () => { await result.current.handleSummarize(); });
  return result;
}

describe('useSummarize — 가드', () => {
  it('문서 없으면 아무 것도 하지 않는다', async () => {
    useAppStore.setState({ document: null });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  it('이미 생성 중이면 재진입하지 않는다', async () => {
    useAppStore.setState({ isGenerating: true });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
  });
});

describe('useSummarize — 가용성', () => {
  it('Ollama 미가용 → OLLAMA_NOT_RUNNING + 생성 종료', async () => {
    M.available = false;
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('OLLAMA_NOT_RUNNING');
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  it('Claude 미가용(키 없음) → API_KEY_MISSING', async () => {
    M.available = false;
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'claude' } });
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('API_KEY_MISSING');
  });
});

describe('useSummarize — 전체 요약', () => {
  it('단일 청크 happy path → 스트림 누적 + setSummary + progress 100', async () => {
    await runSummarize();
    const st = useAppStore.getState();
    expect(st.summaryStream).toContain('핵심 요약');
    expect(st.summary?.type).toBe('full');
    expect(st.summary?.content).toContain('핵심 요약');
    expect(st.summary?.documentId).toBe('doc-1');
    expect(st.progress).toBe(100);
    expect(st.isGenerating).toBe(false);
    expect(M.summarizeCalls.every((c) => c.type === 'full')).toBe(true);
  });

  it('유의미한 텍스트 없음 → PDF_NO_TEXT', async () => {
    useAppStore.setState({ document: makeDoc({ extractedText: '', pageTexts: [] }) });
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('다청크 → 통합 요약 단계 추가', async () => {
    const para = '문단 내용이 길게 이어집니다. '.repeat(40);
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', maxChunkSize: 50, summaryLanguage: 'ko' },
      document: makeDoc({ pageTexts: [`${para}\n\n${para}\n\n${para}`], extractedText: para }),
    });
    await runSummarize();
    expect(useAppStore.getState().summaryStream).toContain('통합 요약');
    // 청크 요약 + 통합(full) 호출 — 2회 이상
    expect(M.summarizeCalls.length).toBeGreaterThan(1);
  });

  it('후처리: 대화형 멘트 제거 + 인용 정규화 후 저장', async () => {
    M.tokens = ['핵심 내용입니다.\n', '도움이 되길 바랍니다'];
    await runSummarize();
    const content = useAppStore.getState().summary?.content ?? '';
    expect(content).toContain('핵심 내용입니다.');
    expect(content).not.toContain('도움이 되길'); // 대화형 줄 제거됨
  });
});

describe('useSummarize — 챕터 요약', () => {
  it('summaryType=chapter + 챕터 2개 이상 → 챕터별 헤더 출력', async () => {
    useAppStore.setState({
      summaryType: 'chapter',
      document: makeDoc({
        pageTexts: ['1쪽 내용', '2쪽 내용'],
        chapters: [
          { index: 0, title: '서론', startPage: 1, endPage: 1, text: '1쪽 내용' },
          { index: 1, title: '본론', startPage: 2, endPage: 2, text: '2쪽 내용' },
        ],
      }),
    });
    await runSummarize();
    const stream = useAppStore.getState().summaryStream;
    expect(stream).toContain('## 서론');
    expect(stream).toContain('## 본론');
    expect(M.summarizeCalls.every((c) => c.type === 'chapter')).toBe(true);
  });
});

describe('useSummarize — 이미지 분석', () => {
  it('이미지 + Vision ON → preflight analyzeImage 호출 + enrichedPageTexts 설정', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0)] }),
    });
    await runSummarize();
    expect(M.imageCalls).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().enrichedPageTexts).not.toBeNull();
    expect(useAppStore.getState().summary).not.toBeNull();
  });

  // QA post-v0.31.15: 진짜 Vision 실패(비-abort)는 전체 요약을 막지 않고 텍스트 전용으로 강등한다.
  // (이전엔 GENERATE_FAIL 로 전체 중단 — enableImageAnalysis default ON 이라 vision 모델 없는
  //  Ollama 사용자가 이미지 PDF 를 아예 요약 못 하던 함정)
  it('이미지 preflight 실패(비-abort) → 텍스트 전용 강등(에러 없음 + notice + 요약 진행)', async () => {
    M.imageResult = null;
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0)] }),
      notice: null, error: null,
    });
    await runSummarize();
    expect(useAppStore.getState().error).toBeNull();               // 차단 에러 없음
    expect(useAppStore.getState().notice?.message).toBeTruthy();   // 비차단 안내
    expect(M.summarizeCalls.length).toBeGreaterThan(0);            // 텍스트 요약 진행
    expect(useAppStore.getState().summary).not.toBeNull();
  });

  // QA post-v0.31.15: 이미지 분석 중 Stop/타임아웃이면 스퍼리어스 배너를 띄우지 않고 요약만 중단.
  it('이미지 분석 중 abort → 스퍼리어스 에러 없음 + 요약 미진행', async () => {
    M.imageResult = null;
    // preflight 도중 사용자 Stop 시뮬레이션(isGenerating→false) 후 null 반환(abort).
    M.onAnalyzeImage = () => { useAppStore.setState({ isGenerating: false }); };
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0)] }),
      notice: null, error: null,
    });
    await runSummarize();
    expect(useAppStore.getState().error).toBeNull(); // 스퍼리어스 배너 없음
    expect(M.summarizeCalls).toHaveLength(0);        // 요약 미진행
  });

  // QA post-v0.31.15(테스트 메타감사): 이미지 preflight 도중 문서가 교체되면(!ours) 스퍼리어스
  // 에러/구 문서 대상 요약 커밋 없이 중단. abort 와 코드 경로는 공유하나 별도 상태전이라 명시 가드.
  it('이미지 분석 중 문서 전환(!ours) → 에러 없음 + 구 문서 요약 미커밋', async () => {
    M.imageResult = null;
    // preflight 도중 다른 문서로 전환(isGenerating 은 true 유지, document.id 만 교체).
    M.onAnalyzeImage = () => { useAppStore.setState({ document: makeDoc({ id: 'doc-OTHER', images: [] }) }); };
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ id: 'doc-1', images: [img(0)] }),
      notice: null, error: null, summary: null,
    });
    await runSummarize();
    expect(useAppStore.getState().error).toBeNull();  // 스퍼리어스 배너 없음
    // 구 문서(doc-1) 대상 요약이 새 문서에 커밋되지 않음.
    expect(useAppStore.getState().summary).toBeNull();
  });
});

describe('useSummarize — handleAbort', () => {
  it('진행 중 abort → ai.abort(reqId) + 생성 종료', () => {
    const { result } = renderHook(() => useSummarize());
    useAppStore.setState({ currentRequestId: 'req-9', isGenerating: true });
    act(() => { result.current.handleAbort(); });
    expect(abortMock).toHaveBeenCalledWith('req-9');
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(useAppStore.getState().currentRequestId).toBeNull();
  });
});

describe('useSummarize — Stop→재요약 race (ownership 가드, QA post-v0.31.14)', () => {
  // 회귀: 이전엔 useSummarize 의 finally 가 ownership 무관하게 무조건 timeoutTimer 를
  // clear 하고 isGenerating 을 false 로 만들어, Stop 직후 재요약하면 stale run 의 finally 가
  // 새 run 을 클로버링해 빈 결과로 끝났다(use-qa 의 finallyStillOurs 패턴 누락).
  it('abort 된 stale run 이 늦게 끝나도 새 run 의 요약 결과를 덮어쓰지 않는다', async () => {
    let release!: () => void;
    M.gate = new Promise<void>((r) => { release = r; });

    const { result } = renderHook(() => useSummarize());

    // run1 시작 — 첫 generator 호출이 gate 에서 멈춘다 (await 보류).
    let run1Done: Promise<void> = Promise.resolve();
    await act(async () => {
      run1Done = result.current.handleSummarize();
      // isAvailable() + generator 진입 + gate 도달까지 pending 작업 flush.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useAppStore.getState().isGenerating).toBe(true);
    expect(M.summarizeCalls).toHaveLength(1);

    // 사용자 Stop → run1 의 clientRef 무효화.
    act(() => { result.current.handleAbort(); });
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(useAppStore.getState().progressInfo).toBeNull();

    // run2 시작 — gate 없이 완주하여 정상 요약 생성.
    await act(async () => { await result.current.handleSummarize(); });
    const run2Summary = useAppStore.getState().summary;
    expect(run2Summary?.content).toContain('핵심 요약');
    expect(useAppStore.getState().isGenerating).toBe(false);

    // run1 gate 해제 → stale run 이 뒤늦게 finally 까지 진행.
    await act(async () => { release(); await run1Done; });

    const final = useAppStore.getState();
    // run1 의 finally/ setSummary 가 ownership 가드로 스킵 → run2 결과 보존.
    expect(final.summary?.id).toBe(run2Summary?.id);
    expect(final.isGenerating).toBe(false);
  });
});

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
  truncated: false,
  // Stop→재요약 race 테스트용: 첫 summarize 호출만 이 promise 에서 일시정지시켜
  // stale run 의 finally 가 새 run 보다 늦게 도달하는 상황을 결정적으로 재현.
  gate: null as Promise<void> | null,
  // C5-M1 race 테스트용: 첫 analyzeImage(preflight) 호출만 일시정지 — 이미지분석 단계에서
  // Stop→재요약 시 stale run 부활을 결정적으로 재현.
  imageGate: null as Promise<void> | null,
  // QA25(B-High) 워치독 테스트용: 토큰 하나를 내보낼 때마다 실행 — fake timer 를 전진시켜
  // "진전이 있는 채로 시간이 흐르는" 상황을 결정적으로 만든다.
  onToken: null as null | (() => void),
  // 이미지 한 장 분석에 걸리는 시간. 0 이 아니면 실제로 그만큼 **기다린다**(fake timer).
  // 호출 진입 시점에 동기적으로 시계를 밀면 배치 진행 중에 찍히는 진행률 신호가 낄 틈이 없어
  // 실제와 다른 타이밍이 된다 — 그래서 대기로 재현한다.
  imageDelayMs: 0,
  // QA29(C-3): N 개의 토큰을 내보낸 **뒤** 스트림이 환경 요인으로 죽는 상황(모델 언로드·연결
  // 단절). null 이면 정상 완주. 사용자 abort 와 달리 ABORTED 코드가 아니라 일반 실패다.
  throwAfterTokens: null as number | null,
}));

vi.mock('../ai-client', () => ({
  AiClient: class {
    constructor(_settings: unknown) { /* noop */ }
    // QA30(A-F5): 실제 AiClient 는 ai:done 의 잘림 표식을 run 단위 sticky 플래그로 노출한다.
    get lastTruncated() { return M.truncated; }
    async isAvailable() { return M.available; }
    prepareSummarize() { return `req-${++M.reqCounter}`; }
    // 실제 시그니처: summarize(text, type, requestId?) — 계약 패리티를 위해 3번째 인자 포함.
    async *summarize(text: string, type: string, _requestId?: string): AsyncGenerator<string> {
      M.summarizeCalls.push({ text, type });
      // 첫 호출만 gate 에서 대기 (race 재현). 이후 호출은 즉시 진행.
      if (M.gate && M.summarizeCalls.length === 1) { await M.gate; }
      let sent = 0;
      for (const tk of M.tokens) {
        if (M.throwAfterTokens !== null && sent >= M.throwAfterTokens) throw new Error('model unloaded');
        M.onToken?.(); yield tk; sent++;
      }
      if (M.throwAfterTokens !== null && sent >= M.throwAfterTokens) throw new Error('model unloaded');
    }
    async analyzeImage(_b: string, _r?: string): Promise<string | null> {
      M.imageCalls++;
      M.onAnalyzeImage?.();
      // 첫 호출(run1 preflight)만 gate 에서 대기 (C5-M1 race 재현). 이후 호출은 즉시 진행.
      if (M.imageGate && M.imageCalls === 1) { await M.imageGate; }
      if (M.imageDelayMs > 0) { await new Promise((r) => setTimeout(r, M.imageDelayMs)); }
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
import { t } from '../i18n';
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
  M.truncated = false;
  M.gate = null;
  M.imageGate = null;
  M.onToken = null;
  M.imageDelayMs = 0;
  M.throwAfterTokens = null;
  abortMock.mockClear();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false },
    document: makeDoc(),
    summaryType: 'full',
    isGenerating: false,
    isQaGenerating: false,
    isParsing: false,
    isTabSwitching: false,
    summaryStream: '',
    summary: null,
    error: null,
    enrichedPageTexts: null,
    currentRequestId: null,
    // QA25: 범위 요약 테스트가 뒤 테스트로 새지 않도록 명시 초기화(순서 의존 방지).
    summaryPageRange: null,
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

  // QA20(C-MED, 데이터손실): 파싱 중에는 store 의 document 가 곧 교체된다 — 여기서 시작한 요약은
  // pdf-parser 의 setDocument 시점에 저장 없이 폐기된다(persistCurrentSession 은 생성 중이라 skip).
  it('파싱 중이면 요약을 시작하지 않는다 (완료 후 폐기 방지)', async () => {
    useAppStore.setState({ isParsing: true });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  // QA21(A-MED): isParsing 만으로는 부족했다 — 탭 전환의 주 경로인 세션-우선 복원
  // (restoreTabFromSession)은 isParsing 을 세우지 않고 isTabSwitching 만 세운다. 그 두 await
  // (persistCurrentSession → session.load) 동안 시작한 요약은 복원이 끝나며 증발했다.
  it('탭 전환 중이면 요약을 시작하지 않는다 (세션-우선 복원 경로)', async () => {
    useAppStore.setState({ isTabSwitching: true });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
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

  // QA30(A-F5): 출력 토큰 상한(4096)에 걸려 잘린 요약이 4프로바이더 모두 "완료" 로 커밋되고
  // 있었다(한국어는 토큰당 ~1.5자라 장문 full 요약에서 도달). main 은 과차단 방지를 위해
  // 이것을 거부가 아니라 표식으로 다루므로, 잘림을 사용자에게 전달할 책임은 여기에 있다.
  it('출력 상한 잘림 → 저장 본문 말미에 잘림 마커가 붙는다', async () => {
    M.truncated = true;
    await runSummarize();
    const st = useAppStore.getState();
    expect(st.summary?.content).toContain('핵심 요약');
    // 배지가 아니라 본문에 넣는다 — 세션에서 다시 연 요약에는 UI 상태가 남지 않기 때문.
    expect(st.summary?.content).toContain(t('summary.outputLimitMarker'));
    // 화면(summaryStream)과 저장본이 갈리면 사용자가 본 것과 저장된 것이 달라진다.
    expect(st.summaryStream).toContain(t('summary.outputLimitMarker'));
  });

  it('정상 완주 → 잘림 마커가 붙지 않는다', async () => {
    await runSummarize();
    expect(useAppStore.getState().summary?.content).not.toContain(t('summary.outputLimitMarker'));
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

  // QA28(A-★ 배선 가드): QA27 이 labelChaptersWithPages 를 summarizeByChapter 에 배선했지만
  // 순수 함수 테스트만 있어 `const labeledChapters = doc.chapters;` 뮤테이션이 99/99 통과했다.
  // 훅 레벨에서 모델에 실제로 넘어간 프롬프트에 **절대 페이지 번호**(startPage 오프셋 적용)의
  // `[p.N]` 이 박혀 있는지 본다 — chapter.text 는 일부러 라벨 없는 원문으로 둔다.
  it('챕터 프롬프트는 startPage 오프셋이 적용된 절대 페이지 [p.N] 라벨을 담는다 (배선 가드)', async () => {
    useAppStore.setState({
      summaryType: 'chapter',
      document: makeDoc({
        pageCount: 3,
        pageTexts: ['첫째 쪽 본문', '둘째 쪽 본문', '셋째 쪽 본문'],
        chapters: [
          { index: 0, title: '서론', startPage: 1, endPage: 1, text: '첫째 쪽 본문' },
          { index: 1, title: '본론', startPage: 2, endPage: 3, text: '둘째 쪽 본문\n\n셋째 쪽 본문' },
        ],
      }),
    });
    await runSummarize();
    const chapterCalls = M.summarizeCalls.filter((c) => c.type === 'chapter');
    expect(chapterCalls).toHaveLength(2);
    const [intro, body] = chapterCalls;
    expect(intro!.text).toContain('[p.1] 첫째 쪽 본문');
    // 두 번째 챕터는 2~3쪽 — 챕터 내부 인덱스(1,2)가 아니라 절대 번호(2,3)여야 한다.
    expect(body!.text).toContain('[p.2] 둘째 쪽 본문');
    expect(body!.text).toContain('[p.3] 셋째 쪽 본문');
    expect(body!.text).not.toContain('[p.1]');
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

  // QA20(C-MED, 데이터손실): 커밋 경로의 **문서** 소유권 절. clientRef 소유권만 보던 시절,
  // 스트리밍이 끝나는 사이 문서가 교체되면(파싱 완료/탭 전환) 문서 A 의 요약이 문서 B 에
  // setSummary 되고, 이어지는 자동저장이 그 본문을 B 의 세션 파일에 summaries[A타입] 으로
  // 기록해 B 의 기존 요약을 오염시켰다. catch 블록·use-qa 에는 있던 가드의 성공 경로 누락.
  it('스트리밍 중 문서가 교체되면 구 문서 요약을 새 문서에 커밋하지 않는다', async () => {
    let release!: () => void;
    M.gate = new Promise<void>((r) => { release = r; });

    const { result } = renderHook(() => useSummarize());

    let runDone: Promise<void> = Promise.resolve();
    await act(async () => {
      runDone = result.current.handleSummarize();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(M.summarizeCalls).toHaveLength(1);

    // 문서 교체 — clientRef 소유권은 그대로다(새 run 이 시작된 게 아니므로).
    act(() => { useAppStore.setState({ document: makeDoc({ id: 'doc-OTHER' }), summary: null }); });

    // 스트리밍 완주 → 후처리·커밋 단계 도달.
    await act(async () => { release(); await runDone; });

    const st = useAppStore.getState();
    expect(st.summary).toBeNull();              // 새 문서에 구 문서 요약이 붙지 않음
    expect(st.summaryStreamComplete).toBe(false); // 저장 자격도 서지 않음(자동저장 덮어쓰기 차단)
    expect(st.isGenerating).toBe(false);         // finally 정리는 정상 수행
  });

  // C5-M1(QA cycle5): 취소 술어가 ambient `!isGenerating` 이던 시절, Stop→즉시 재요약하면
  // 새 run 이 isGenerating 을 true 로 되돌려 이미지분석 단계의 stale run 이 "부활" — 배치
  // Vision 을 계속 호출(이중 클라우드 과금)하고 진행률/스트림에 잔여물을 주입했다. 소유권
  // 토큰(isRunAborted) 전환 후 stale run 은 preflight 복귀 즉시 영구 취소된다.
  it('C5-M1: 이미지분석 단계에서 Stop→즉시 재요약 시 stale run 이 부활하지 않는다', async () => {
    useAppStore.setState({
      document: makeDoc({ images: [img(0), img(1), img(2), img(3)] }),
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
    });
    let releaseImage!: () => void;
    M.imageGate = new Promise<void>((r) => { releaseImage = r; });
    let releaseStream!: () => void;
    M.gate = new Promise<void>((r) => { releaseStream = r; });

    const { result } = renderHook(() => useSummarize());

    // run1 — preflight Vision 호출에서 정지(요약 단계 진입 전 = 이미지분석 단계 한복판).
    let run1Done: Promise<void> = Promise.resolve();
    await act(async () => {
      run1Done = result.current.handleSummarize();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(M.imageCalls).toBe(1); // run1 preflight 만

    // Stop → 즉시 재요약. run2 는 이미지분석(preflight+배치 3)을 완주하고 summarize 스트리밍
    // (gate)에서 대기 — isGenerating=true 인 상태로 유지된다.
    act(() => { result.current.handleAbort(); });
    let run2Done: Promise<void> = Promise.resolve();
    await act(async () => {
      run2Done = result.current.handleSummarize();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useAppStore.getState().isGenerating).toBe(true); // run2 in-flight
    const callsBeforeRelease = M.imageCalls; // 1(run1 preflight) + 4(run2 preflight+배치3)

    // run1 preflight 해제 — ambient 술어였다면 run2 의 isGenerating 때문에 배치 루프에 진입해
    // Vision 을 3회 더 호출했다. 소유권 술어로는 즉시 취소되어 추가 호출 0.
    await act(async () => { releaseImage(); await new Promise((r) => setTimeout(r, 0)); });
    expect(M.imageCalls).toBe(callsBeforeRelease);

    // run2 완주 → 정상 요약 결과가 보존된다(스트림 오염/조기 strip 없음).
    await act(async () => { releaseStream(); await Promise.all([run1Done, run2Done]); });
    const st = useAppStore.getState();
    expect(st.summary?.content).toContain('핵심 요약');
    expect(st.isGenerating).toBe(false);
  });
});

// QA25(B-High): 요약 무진전 워치독의 **배선** 회귀 넷.
//
// 이 자리가 비어 있던 대가를 이미 치렀다. summary-timeout 은 순수 판정 함수(isSummaryTimedOut)를
// 15건 테스트하고 있었지만, use-summarize* 테스트 5종 중 **fake timer 를 쓰는 파일이 하나도
// 없어서** 워치독 타이머가 한 번도 발화하지 않았다. 그래서 QA20 에서 "진전 신호를 토큰 수신에만
// 둬서 이미지 분석 단계(토큰 0)가 무진전으로 오판되는" 회귀가 **2릴리즈 출시된 뒤에야** 발견됐다.
// 그때 추가한 회귀 넷도 순수 함수 테스트라 재발을 막지 못한다 — 그래서 여기서 배선을 잡는다.
describe('useSummarize — 무진전 워치독 배선 (QA25)', () => {
  const IDLE_MS = 120_000; // use-summarize.ts 의 IDLE_TIMEOUT_MS

  afterEach(() => {
    vi.useRealTimers();
  });

  it('완전 무진전이 임계를 넘으면 요약을 중단시킨다 (워치독이 실제로 장전돼 있는가)', async () => {
    vi.useFakeTimers();
    // 첫 summarize 호출을 영원히 붙잡아 토큰도 진행률도 오지 않는 상태를 만든다.
    M.gate = new Promise<void>(() => {});
    const { result } = renderHook(() => useSummarize());
    await act(async () => {
      void result.current.handleSummarize();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    });
    expect(useAppStore.getState().error?.code).toBe('GENERATE_TIMEOUT');
    expect(abortMock).toHaveBeenCalled();
  });

  it('토큰이 계속 오는 동안에는 임계를 넘겨도 중단하지 않는다', async () => {
    vi.useFakeTimers();
    // 토큰마다 100초씩 흘린다 — 총 경과는 임계를 훌쩍 넘지만 무진전 구간은 100초뿐이다.
    M.tokens = ['가', '나', '다', '라'];
    M.onToken = () => { vi.advanceTimersByTime(100_000); };
    const { result } = renderHook(() => useSummarize());
    await act(async () => { await result.current.handleSummarize(); });
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().summary).not.toBeNull();
  });

  // ★ QA20 회귀 가드 — 이 테스트가 이 describe 블록의 존재 이유다.
  //   analyzeDocumentImages 는 append 를 한 번도 하지 않고 **진행률만** 갱신한다. 진전 신호를
  //   토큰 수신에만 두면 이미지 분석 단계 전체가 무진전으로 오판돼, 기본 설정
  //   (enableImageAnalysis=true)에서 이미지가 조금만 많아도 정상 요약이 2분에 죽는다.
  it('토큰 없이 진행률만 갱신되는 이미지 분석 단계를 무진전으로 오판하지 않는다', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0), img(1), img(2)] }),
    });
    // 이미지 한 장 분석에 100초가 걸린다(preflight 1장 + 배치 2장 = 누적 200초).
    // 토큰은 이 단계 내내 한 개도 오지 않는다. 누적 경과는 임계(120초)를 넘지만,
    // 진행률 갱신이 진전으로 취급되면 무진전 구간은 매번 100초라 살아남아야 한다.
    M.imageDelayMs = 100_000;
    const { result } = renderHook(() => useSummarize());
    await act(async () => {
      const p = result.current.handleSummarize();
      await vi.advanceTimersByTimeAsync(400_000);
      await p;
    });
    expect(M.imageCalls).toBeGreaterThanOrEqual(3);
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().summary).not.toBeNull();
  });
});

// QA25(B-Important): 페이지 범위 요약의 **배선** 회귀 넷.
//
// 양 끝은 이미 테스트돼 있었다 — page-range 순수 함수 15건, SummaryTypeSelector UI 5건.
// 그런데 그 사이, 즉 "요약이 실제로 그 범위만 읽는가" 를 보는 테스트가 없었다. 그래서
// 슬라이스 한 줄을 지워도(= 사용자가 2~4쪽을 골라도 전체 문서가 조용히 요약돼도) 전부 그린이었다.
describe('useSummarize — 페이지 범위 요약 배선 (QA25)', () => {
  const docFivePages = () =>
    makeDoc({
      pageCount: 5,
      pageTexts: [
        '첫째 쪽 고유내용 알파.',
        '둘째 쪽 고유내용 베타.',
        '셋째 쪽 고유내용 감마.',
        '넷째 쪽 고유내용 델타.',
        '다섯째 쪽 고유내용 엡실론.',
      ],
      extractedText: '전체 본문',
    });

  it('선택한 범위 밖 페이지 내용이 프롬프트에 들어가지 않는다', async () => {
    useAppStore.setState({ document: docFivePages(), summaryPageRange: { start: 2, end: 4 } });
    await runSummarize();
    const sent = M.summarizeCalls.map((c) => c.text).join('\n');
    expect(sent).toContain('베타');
    expect(sent).toContain('감마');
    expect(sent).toContain('델타');
    // 범위 밖 — 하나라도 새면 사용자가 고른 범위가 지켜지지 않은 것이다.
    expect(sent).not.toContain('알파');
    expect(sent).not.toContain('엡실론');
  });

  it('전체 범위면 문서를 그대로 쓴다 (마스킹이 과잉 적용되지 않는다)', async () => {
    useAppStore.setState({ document: docFivePages(), summaryPageRange: { start: 1, end: 5 } });
    await runSummarize();
    const sent = M.summarizeCalls.map((c) => c.text).join('\n');
    expect(sent).toContain('알파');
    expect(sent).toContain('엡실론');
  });

  it('범위 요약은 Vision enriched 를 RAG 에 공유하지 않는다 (Q&A 컨텍스트 오염 방지)', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: { ...docFivePages(), images: [img(1)] },
      summaryPageRange: { start: 2, end: 4 },
    });
    await runSummarize();
    expect(useAppStore.getState().enrichedPageTexts).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA29(C-3, 데이터손실): 스트림이 **환경 요인**(모델 언로드·네트워크 단절)으로 끊기면 catch 는
// 배너만 세우고 setSummary 를 호출하지 않는다. 그런데 `summaryStreamComplete` 를 세우는 것은
// setSummary 뿐이고(store.ts) 자동저장 게이트는 그 플래그를 요구한다(use-session.ts) — 그래서
// 화면에 보이는 토큰이 디스크에 한 글자도 닿지 못한 채 다음 문서 전환에서 사라졌다.
//
// 자동 커밋은 QA12 의 "생성 중 skip 과 구분" 원칙을 깨므로 하지 않는다. 사용자가 승인하는
// 경로만 연다: 실패 배너에 저장 액션을 노출하고, 그 액션이 부분 표식과 함께 커밋한다.
// ─────────────────────────────────────────────────────────────────────────────
describe('useSummarize — 중단된 부분 요약의 승인 저장 (QA29 C-3)', () => {
  async function runUntilStreamFailure() {
    M.tokens = ['앞부분 ', '요약 내용'];
    M.throwAfterTokens = 2; // 두 토큰을 받은 뒤 모델이 죽는다
    const { result } = renderHook(() => useSummarize());
    await act(async () => { await result.current.handleSummarize(); });
    return result;
  }

  it('실패 직후에는 자동 커밋하지 않는다 — 화면엔 남지만 완주 표시는 서지 않는다', async () => {
    await runUntilStreamFailure();
    const st = useAppStore.getState();
    expect(st.error?.code).toBe('GENERATE_FAIL');
    expect(st.summary, '실패한 run 이 완주본으로 자동 커밋됐다').toBeNull();
    expect(st.summaryStreamComplete, '미완주인데 자동저장 게이트가 열렸다').toBe(false);
    expect(st.summaryStream).toContain('앞부분 요약 내용');
    // 배너가 저장 가능함을 알린다 — 안내가 없으면 사용자는 액션의 존재를 모른다.
    expect(st.error?.message).toContain('저장할 수 있습니다');
  });

  it('승인하면 부분 표식과 함께 커밋되어 자동저장 게이트를 통과한다', async () => {
    const result = await runUntilStreamFailure();
    const rec = result.current.getPartialRecovery();
    expect(rec, '부분 저장 액션이 노출되지 않았다').not.toBeNull();
    expect(rec!.label.trim().length).toBeGreaterThan(0);

    let ok = false;
    await act(async () => { ok = rec!.commit(); });
    expect(ok).toBe(true);

    const st = useAppStore.getState();
    expect(st.summary?.content).toContain('앞부분 요약 내용');
    expect(st.summary?.type).toBe('full');
    expect(st.summary?.documentId).toBe('doc-1');
    expect(st.summaryStreamComplete, '커밋했는데 자동저장 게이트가 닫혀 있다').toBe(true);
    // 영속 경로가 실제로 집는 값은 summaryStream 이다 — 표식이 여기에도 들어가야 한다.
    expect(st.summaryStream).toContain('앞부분 요약 내용');
    expect(st.summaryStream, '미완성 표식이 없다 — 저장본만 보면 완성본과 구별되지 않는다').toMatch(/\[\.\.\./);
    expect(st.summary?.content).toMatch(/\[\.\.\./);
    expect(st.error, '저장했는데 실패 배너가 남아 있다').toBeNull();
    expect(st.notice).not.toBeNull();
    // 한 번 커밋하면 제안은 사라진다(중복 커밋 방지).
    expect(result.current.getPartialRecovery()).toBeNull();
  });

  it('사용자 Stop 은 제안을 남기지 않는다 (라운드 19 판단 유지 — 재시도 의사)', async () => {
    M.tokens = ['앞부분 ', '요약 내용'];
    const { result } = renderHook(() => useSummarize());
    await act(async () => { await result.current.handleSummarize(); });
    await act(async () => { result.current.handleAbort(); });
    expect(result.current.getPartialRecovery()).toBeNull();
  });

  it('토큰을 한 개도 못 받고 실패하면 제안하지 않는다 (빈 요약 커밋 방지)', async () => {
    M.tokens = ['앞부분 '];
    M.throwAfterTokens = 0; // 첫 토큰 전에 죽는다
    const { result } = renderHook(() => useSummarize());
    await act(async () => { await result.current.handleSummarize(); });
    expect(useAppStore.getState().error?.code).toBe('GENERATE_FAIL');
    expect(useAppStore.getState().error?.message).not.toContain('저장할 수 있습니다');
    expect(result.current.getPartialRecovery()).toBeNull();
  });

  it('새 요약이 시작되면 이전 실패의 제안은 폐기된다 (새 스트림에 옛 본문 커밋 금지)', async () => {
    const result = await runUntilStreamFailure();
    expect(result.current.getPartialRecovery()).not.toBeNull();
    M.throwAfterTokens = null;
    M.tokens = ['새 ', '요약'];
    await act(async () => { await result.current.handleSummarize(); });
    expect(result.current.getPartialRecovery()).toBeNull();
    expect(useAppStore.getState().summary?.content).toContain('새 요약');
  });

  it('문서가 교체된 뒤의 승인은 거부된다 (남의 세션 파일 오염 방지)', async () => {
    const result = await runUntilStreamFailure();
    const rec = result.current.getPartialRecovery();
    useAppStore.setState({ document: makeDoc({ id: 'doc-2', fileName: 'b.pdf' }) });
    let ok = true;
    await act(async () => { ok = rec!.commit(); });
    expect(ok).toBe(false);
    expect(useAppStore.getState().summary).toBeNull();
    expect(useAppStore.getState().summaryStreamComplete).toBe(false);
  });
});

// QA30(A-F8): main 이 공백 토큰만 흘리고 정상 종료(ai:done)하면 finalContent 가 비는데,
// 이전 코드는 setSummary 를 **건너뛰기만** 해서 요약도 에러도 없이 스피너만 사라졌다.
describe('QA30 A-F8: 빈 요약은 조용히 넘어가지 않는다', () => {
  it('공백 토큰만 받고 정상 종료 → 명시 에러 + 요약 미커밋', async () => {
    M.tokens = ['   ', '  	 '];
    await runSummarize();
    const st = useAppStore.getState();
    expect(st.summary).toBeNull();
    expect(st.error?.code).toBe('GENERATE_FAIL');
    expect(st.error?.message).toBeTruthy();
    expect(st.isGenerating).toBe(false);
  });

  it('실제 글자가 하나라도 있으면 종전대로 커밋된다 (과잉 에러 방지)', async () => {
    M.tokens = ['  ', '요약본'];
    await runSummarize();
    const st = useAppStore.getState();
    expect(st.summary?.content).toContain('요약본');
    expect(st.error).toBeNull();
  });
});

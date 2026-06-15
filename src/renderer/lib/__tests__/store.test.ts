import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// store.ts 는 module init 시 localStorage.getItem('citationPanelWidth') 를 읽으므로
// import 이전에 localStorage stub 을 설치한다. electronAPI 는 settings 디바운스에서만 호출되므로
// 본 테스트 범위(stream/Q&A FIFO)에서는 no-op 으로 stub.
const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
vi.stubGlobal('window', {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
});
// v0.18.8 R27-I4: 결정적 stub (다른 테스트와 통일).
let _testIdCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `id-${++_testIdCounter}` });

import { useAppStore } from '../store';

// 각 테스트 진입 시 스트림/메시지 상태만 초기화 — timer 는 fake 사용.
function resetStreams(): void {
  const s = useAppStore.getState();
  s.clearStream();
  s.clearQaStream();
  useAppStore.setState({ qaMessages: [], qaStream: '', summaryStream: '' });
}

describe('stream batching — summaryStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStreams();
    // v0.18.22 R36 P1: appendStream 이 isGenerating=true 일 때만 토큰을 받도록
    // 가드 추가됨 (appendQaStream R32 P3 미러, ghost token 차단). 기존 배치 테스트는
    // 그 가드를 우회하기 위해 명시 활성화.
    useAppStore.setState({ isGenerating: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ isGenerating: false });
  });

  it('appendStream 은 50ms 후 batched flush 로 summaryStream 에 반영된다', () => {
    const s = useAppStore.getState();
    s.appendStream('a');
    s.appendStream('b');
    s.appendStream('c');
    // 타이머가 돌기 전에는 아직 stream 에 반영되지 않음
    expect(useAppStore.getState().summaryStream).toBe('');
    vi.advanceTimersByTime(50);
    expect(useAppStore.getState().summaryStream).toBe('abc');
  });

  it('ghost token 가드: append → clear 후 타이머가 fire 해도 stream 은 비어있다', () => {
    const s = useAppStore.getState();
    s.appendStream('ghost');
    // 타이머 도착 전에 clear — cleared 플래그 설정, buffer 삭제
    s.clearStream();
    // 스케줄된 setTimeout 콜백이 실행되어도 cleared=true 라 set 호출하지 않아야 한다
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().summaryStream).toBe('');
  });

  it('flushStream 은 즉시 buffer 를 summaryStream 에 합친다', () => {
    const s = useAppStore.getState();
    s.appendStream('pending');
    s.flushStream();
    expect(useAppStore.getState().summaryStream).toBe('pending');
    // flush 후 타이머가 추가로 fire 해도 double-apply 되지 않는다 (buffer 비움 + timer null)
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().summaryStream).toBe('pending');
  });

  // v0.18.22 R36 P1 회귀 가드: isGenerating=false 면 토큰 무시.
  // appendQaStream(R32 P3) 의 ghost-token race 가 요약 측에도 비대칭으로 존재하던 결함을
  // 동일 입구 게이트로 차단. 사용자 Stop → handleAbort 가 flushStream + setIsGenerating(false)
  // 직후 in-flight IPC 토큰이 도착해도 summaryStream 에 ghost text 가 남지 않아야 한다.
  it('isGenerating=false 일 때 appendStream 호출은 summaryStream 을 건드리지 않는다 (R36 P1 ghost-token race)', () => {
    useAppStore.setState({ isGenerating: false });
    const s = useAppStore.getState();
    s.appendStream('zombie');
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().summaryStream).toBe('');
  });
});

describe('stream batching — qaStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStreams();
    // v0.18.19 patch R32 P3: appendQaStream 이 isQaGenerating=true 일 때만 토큰을 받도록
    // 가드 추가됨 (ghost token 차단). 기존 배치 테스트는 그 가드를 우회하기 위해 명시 활성화.
    useAppStore.setState({ isQaGenerating: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ isQaGenerating: false });
  });

  it('appendQaStream 도 동일하게 50ms batched flush 동작', () => {
    const s = useAppStore.getState();
    s.appendQaStream('x');
    s.appendQaStream('y');
    expect(useAppStore.getState().qaStream).toBe('');
    vi.advanceTimersByTime(50);
    expect(useAppStore.getState().qaStream).toBe('xy');
  });

  it('qa ghost token 가드: clearQaStream 후 타이머 fire 해도 잔존 없음', () => {
    const s = useAppStore.getState();
    s.appendQaStream('gh');
    s.clearQaStream();
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().qaStream).toBe('');
  });

  it('appendQaStream 이후 새 append 는 flush 이후에도 버퍼 초기화되어 정상 축적', () => {
    const s = useAppStore.getState();
    s.appendQaStream('first ');
    vi.advanceTimersByTime(50);
    s.appendQaStream('second');
    vi.advanceTimersByTime(50);
    expect(useAppStore.getState().qaStream).toBe('first second');
  });

  // v0.18.19 patch R32 P3 회귀 가드: isQaGenerating=false 면 토큰 무시.
  it('isQaGenerating=false 일 때 append 호출은 qaStream 을 건드리지 않는다 (R32 P3 ghost-token race)', () => {
    useAppStore.setState({ isQaGenerating: false });
    const s = useAppStore.getState();
    s.appendQaStream('zombie');
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().qaStream).toBe('');
  });
});

describe('addQaMessage FIFO cap (10 turns = 20 messages)', () => {
  beforeEach(() => { resetStreams(); });

  it('20 메시지까지는 그대로 보존', () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 10; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
    }
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(20);
    expect(msgs[0]!.content).toBe('u0');
    expect(msgs[19]!.content).toBe('a9');
  });

  it('v0.18.5 M3: 21번째(홀수 excess) 메시지 추가 시 짝수(2개) drop — 윈도우는 19개로 수축하되 user 로 시작', () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 10; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
    }
    // 21번째 메시지 = 11턴의 user
    s.addQaMessage({ role: 'user', content: 'u10' });
    const msgs = useAppStore.getState().qaMessages;
    // excess=1 → dropCount=2 → u0/a0 쌍 drop. 첫 메시지는 u1 (user→assistant 짝 유지).
    expect(msgs).toHaveLength(19);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('u1');
    expect(msgs[msgs.length - 1]!.content).toBe('u10');
  });

  it('v0.18.5 M3: 22번째(짝수 excess) 메시지까지 추가되면 윈도우 20개 회복 + user→assistant 불변식 유지', () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 10; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
    }
    s.addQaMessage({ role: 'user', content: 'u10' });
    s.addQaMessage({ role: 'assistant', content: 'a10' });
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(20);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('u1');
    expect(msgs[msgs.length - 1]!.content).toBe('a10');
  });

  it('v0.18.5 M3 불변식: FIFO 동작 중 윈도우 선두는 항상 user 역할', () => {
    const s = useAppStore.getState();
    // 13 턴(26 메시지) 주입하며 매 호출 후 첫 메시지 role 을 확인
    for (let i = 0; i < 13; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      const afterUser = useAppStore.getState().qaMessages;
      if (afterUser.length > 0) expect(afterUser[0]!.role).toBe('user');
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
      const afterAssistant = useAppStore.getState().qaMessages;
      if (afterAssistant.length > 0) expect(afterAssistant[0]!.role).toBe('user');
    }
  });

  it('메시지에는 고유 id 가 부여된다', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: 'q' });
    s.addQaMessage({ role: 'assistant', content: 'a' });
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs[0]!.id).toBeTruthy();
    expect(msgs[1]!.id).toBeTruthy();
    expect(msgs[0]!.id).not.toBe(msgs[1]!.id);
  });
});

describe('citationPanelWidth clamp + persist', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 이전 테스트의 localStorage 잔존 초기화
    delete lsStore['citationPanelWidth'];
  });
  afterEach(() => { vi.useRealTimers(); });

  it('0.2–0.8 범위로 clamp 된다', () => {
    const s = useAppStore.getState();
    s.setCitationPanelWidth(0.05);
    expect(useAppStore.getState().citationPanelWidth).toBe(0.2);
    s.setCitationPanelWidth(0.95);
    expect(useAppStore.getState().citationPanelWidth).toBe(0.8);
    s.setCitationPanelWidth(0.5);
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });

  it('200ms 디바운스 후 localStorage 에 저장된다 (마지막 값만)', () => {
    const s = useAppStore.getState();
    s.setCitationPanelWidth(0.3);
    s.setCitationPanelWidth(0.4);
    s.setCitationPanelWidth(0.55);
    // 디바운스 창 내에선 아직 미저장
    expect(lsStore['citationPanelWidth']).toBeUndefined();
    vi.advanceTimersByTime(200);
    expect(lsStore['citationPanelWidth']).toBe('0.55');
  });
});

// v0.18.6 D1 — notice 채널이 error 와 분리되어 있어 setError(null) 이 notice 를 클리어하지 않음.
describe('notice channel (D1)', () => {
  it('setError(null) 은 notice 를 건드리지 않는다', () => {
    const s = useAppStore.getState();
    s.setNotice({ message: '다중 파일 경고' });
    s.setError({ code: 'PDF_PARSE_FAIL', message: '에러 발생' });
    expect(useAppStore.getState().notice?.message).toBe('다중 파일 경고');
    s.setError(null);
    // 핵심: error 가 지워져도 notice 는 그대로
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().notice?.message).toBe('다중 파일 경고');
  });

  it('setNotice(null) 은 error 를 건드리지 않는다 (대칭)', () => {
    const s = useAppStore.getState();
    s.setError({ code: 'PDF_PARSE_FAIL', message: '에러' });
    s.setNotice({ message: 'notice' });
    s.setNotice(null);
    expect(useAppStore.getState().error?.message).toBe('에러');
    expect(useAppStore.getState().notice).toBeNull();
  });

  // R30 P2 (v0.18.18): setNotice 후 일정 시간(6초) 지나면 자동으로 dismiss.
  it('setNotice 후 6초 경과하면 자동으로 notice 가 null 로 비워진다', () => {
    vi.useFakeTimers();
    try {
      const s = useAppStore.getState();
      s.setNotice({ message: '자동 dismiss 테스트' });
      expect(useAppStore.getState().notice?.message).toBe('자동 dismiss 테스트');
      // 6초 직전엔 남아 있어야 함
      vi.advanceTimersByTime(5999);
      expect(useAppStore.getState().notice).not.toBeNull();
      // 6초 도달 시 비워짐
      vi.advanceTimersByTime(1);
      expect(useAppStore.getState().notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('setNotice 중복 호출 시 이전 타이머는 cancel 되고 마지막 notice 만 dismiss 대상', () => {
    vi.useFakeTimers();
    try {
      const s = useAppStore.getState();
      s.setNotice({ message: 'first' });
      vi.advanceTimersByTime(3000);
      s.setNotice({ message: 'second' });
      // 'first' 의 타이머가 cancel 됐는지 — 3 + 3 = 6초 경과해도 'second' 는 살아 있어야 함
      vi.advanceTimersByTime(3000);
      expect(useAppStore.getState().notice?.message).toBe('second');
      // 'second' 의 자체 6초 후엔 dismiss
      vi.advanceTimersByTime(3000);
      expect(useAppStore.getState().notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // R31 회귀 (v0.18.18 patch): setNotice(null) 호출 시 pending 타이머 cancel.
  it('setNotice(null) 호출 시 pending dismiss 타이머는 cancel 된다', () => {
    vi.useFakeTimers();
    try {
      const s = useAppStore.getState();
      s.setNotice({ message: 'pending' });
      vi.advanceTimersByTime(3000);
      // 사용자가 직접 닫기 → pending 6초 타이머는 cancel 되어야 함
      s.setNotice(null);
      expect(useAppStore.getState().notice).toBeNull();
      // 추가로 3초 흘려도 stale 타이머가 발화해 다른 동작을 일으키지 않아야 함
      vi.advanceTimersByTime(3000);
      // 새 notice 를 설정해 6초 dismiss 가 정상 작동하는지 확인 — 이전 타이머가 cancel
      // 안 됐다면 3초 후 (전 타이머 6초 도달) 잘못된 dismiss 발화 가능.
      s.setNotice({ message: 'fresh' });
      vi.advanceTimersByTime(5999);
      expect(useAppStore.getState().notice?.message).toBe('fresh');
      vi.advanceTimersByTime(1);
      expect(useAppStore.getState().notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// R28 P2 (v0.18.12): setDocument 비-null 분기에서도 resetSummaryState 가 호출되어
// 이전 문서의 stale 상태가 새 문서로 누출되지 않아야 함.
describe('setDocument(newDoc) — stale state cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStreams();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('새 문서 로드 시 이전 문서의 summaryStream / qaMessages / summary 가 모두 비워진다', () => {
    const s = useAppStore.getState();
    // 이전 문서 + stale 데이터 시뮬레이션
    s.setDocument({
      id: 'old',
      fileName: 'old.pdf',
      filePath: '/old.pdf',
      pageCount: 1,
      extractedText: 'a'.repeat(50),
      pageTexts: ['a'.repeat(50)],
      chapters: [],
      images: [],
      createdAt: new Date(),
    });
    useAppStore.setState({
      summaryStream: '이전 요약 본문',
      summary: {
        id: 'sum-old',
        documentId: 'old',
        type: 'full',
        content: '이전 요약',
        model: 'gemma3',
        provider: 'ollama',
        createdAt: new Date(),
        durationMs: 1000,
      },
      qaMessages: [{ id: 'msg-old', role: 'user', content: '이전 질문' }],
    });
    expect(useAppStore.getState().summaryStream).toBe('이전 요약 본문');

    // 새 문서 로드
    s.setDocument({
      id: 'new',
      fileName: 'new.pdf',
      filePath: '/new.pdf',
      pageCount: 1,
      extractedText: 'b'.repeat(50),
      pageTexts: ['b'.repeat(50)],
      chapters: [],
      images: [],
      createdAt: new Date(),
    });

    const after = useAppStore.getState();
    expect(after.document?.fileName).toBe('new.pdf');
    expect(after.summaryStream).toBe('');
    expect(after.summary).toBeNull();
    expect(after.qaMessages).toEqual([]);
    expect(after.enrichedPageTexts).toBeNull();
  });
});

// v0.18.20 R32 P2: resetSummaryState 가 in-flight ai 요청을 abort 하지 않아 stale 토큰이
// 새 세션에 인터리브되던 cross-session contamination 회귀 가드.
describe('resetSummaryState abort propagation (R32 P2)', () => {
  beforeEach(() => {
    resetStreams();
    // window.electronAPI.ai.abort 호출 카운트 리셋
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    abortMock.mockClear();
  });

  it('qaRequestId 가 있으면 abort 가 호출된다', () => {
    useAppStore.setState({ qaRequestId: 'qa-stale-123' });
    useAppStore.getState().resetSummaryState();
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    expect(abortMock).toHaveBeenCalledWith('qa-stale-123');
  });

  it('currentRequestId 가 있으면 abort 가 호출된다 (요약 중 문서 전환)', () => {
    useAppStore.setState({ currentRequestId: 'sum-stale-456' });
    useAppStore.getState().resetSummaryState();
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    expect(abortMock).toHaveBeenCalledWith('sum-stale-456');
  });

  it('두 id 모두 있으면 둘 다 abort 한다', () => {
    useAppStore.setState({ qaRequestId: 'qa-1', currentRequestId: 'sum-1' });
    useAppStore.getState().resetSummaryState();
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    expect(abortMock).toHaveBeenCalledWith('qa-1');
    expect(abortMock).toHaveBeenCalledWith('sum-1');
    expect(abortMock).toHaveBeenCalledTimes(2);
  });

  it('id 가 모두 null 이면 abort 가 호출되지 않는다', () => {
    useAppStore.setState({ qaRequestId: null, currentRequestId: null });
    useAppStore.getState().resetSummaryState();
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('reset 이후 store 의 qaRequestId/currentRequestId 는 null 로 비워진다', () => {
    useAppStore.setState({ qaRequestId: 'q', currentRequestId: 'c' });
    useAppStore.getState().resetSummaryState();
    const after = useAppStore.getState();
    expect(after.qaRequestId).toBeNull();
    expect(after.currentRequestId).toBeNull();
  });

  it('ai.abort 가 reject 해도 reset 의 동기 동작은 유지된다 (silent catch)', () => {
    const abortMock = window.electronAPI.ai.abort as ReturnType<typeof vi.fn>;
    abortMock.mockReturnValueOnce(Promise.reject(new Error('IPC down')));
    useAppStore.setState({ qaRequestId: 'q' });
    expect(() => useAppStore.getState().resetSummaryState()).not.toThrow();
    expect(useAppStore.getState().qaRequestId).toBeNull();
  });
});

// v0.18.20 R32 P2: setError 가 sanitizeErrorPath 를 자동 적용해 PDF parse / file-dialog
// 에러에 포함된 절대경로가 banner 로 새지 않도록 함. AppErrorBoundary 의 render-time 경로
// 와 별도 채널 (App.tsx drop/Ctrl+O, PdfUploader 등) 의 정보 누출 회귀 가드.
describe('setError path sanitization (R32 P2)', () => {
  it('Windows 홈 경로가 message 에 포함되면 ~ 로 치환', () => {
    const s = useAppStore.getState();
    s.setError({ code: 'PDF_PARSE_FAIL', message: "ENOENT: 'C:\\Users\\jjw\\Documents\\private.pdf'" });
    const msg = useAppStore.getState().error?.message ?? '';
    expect(msg).not.toContain('jjw');
    expect(msg).not.toContain('private.pdf');
    expect(msg).toContain('~');
  });

  it('Linux 홈 경로도 치환', () => {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: 'cannot read /home/alice/work/a.pdf' });
    const msg = useAppStore.getState().error?.message ?? '';
    expect(msg).not.toContain('alice');
    expect(msg).toContain('~');
  });

  it('Windows 일반 드라이브 경로는 <path> 로 치환', () => {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: 'failed at D:\\Projects\\secret\\plan.pdf' });
    const msg = useAppStore.getState().error?.message ?? '';
    expect(msg).not.toContain('secret');
    expect(msg).toContain('<path>');
  });

  it('setError(null) 은 그대로 null', () => {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: 'pre' });
    useAppStore.getState().setError(null);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('경로 없는 일반 message 는 원본 보존', () => {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: 'pdfjs internal error: invalid xref' });
    expect(useAppStore.getState().error?.message).toBe('pdfjs internal error: invalid xref');
  });
});

// v0.18.19 patch R32 P2 회귀: setEnrichedPageTexts 는 단순 setter 지만, use-summarize 의
// Vision-partial-failure 경로에서 명시적으로 null 호출해야 stale enriched 데이터가 RAG 에
// 남지 않는다. 이 store-level 동작은 setter 자체가 idempotent 임을 확인하는 가드.
describe('setEnrichedPageTexts idempotent null reset (R32 P2)', () => {
  it('이전에 enriched 값이 있어도 null 호출 시 정확히 null 로 비워진다', () => {
    const s = useAppStore.getState();
    s.setEnrichedPageTexts(['page1 + image desc', 'page2 + image desc']);
    expect(useAppStore.getState().enrichedPageTexts).not.toBeNull();
    s.setEnrichedPageTexts(null);
    expect(useAppStore.getState().enrichedPageTexts).toBeNull();
  });

  it('이미 null 인 상태에서 null 재호출도 안전 (멱등)', () => {
    useAppStore.getState().setEnrichedPageTexts(null);
    useAppStore.getState().setEnrichedPageTexts(null);
    expect(useAppStore.getState().enrichedPageTexts).toBeNull();
  });

  // v0.18.22 R36 P2 회귀 가드: 동일 reference 호출은 version bump 도 건너뛴다.
  // 이전엔 idempotent null 호출도 매번 version 을 증가시켜, fingerprint 로직이 향후
  // `r` 분기에서 version 을 포함하도록 바뀌면 false-positive 재빌드가 발생하던 잠재 결함.
  it('R36 P2: 동일 reference 재호출 시 version 은 증가하지 않는다', () => {
    useAppStore.getState().setEnrichedPageTexts(null);
    const v0 = useAppStore.getState().enrichedPageTextsVersion;
    useAppStore.getState().setEnrichedPageTexts(null);
    useAppStore.getState().setEnrichedPageTexts(null);
    expect(useAppStore.getState().enrichedPageTextsVersion).toBe(v0);

    const same = ['p1', 'p2'];
    useAppStore.getState().setEnrichedPageTexts(same);
    const v1 = useAppStore.getState().enrichedPageTextsVersion;
    useAppStore.getState().setEnrichedPageTexts(same);
    expect(useAppStore.getState().enrichedPageTextsVersion).toBe(v1);

    // 다른 reference(같은 내용) 는 의도된 bump (내용 변경 감지가 reference 식별 한계).
    useAppStore.getState().setEnrichedPageTexts(['p1', 'p2']);
    expect(useAppStore.getState().enrichedPageTextsVersion).toBe(v1 + 1);
  });
});

// session-persistence(module-3): 복원 게이트/마커 + resetSummaryState 초기화.
describe('session-persistence store fields', () => {
  it('setSessionRestorePending / setRestoredSession 동작', () => {
    useAppStore.getState().setSessionRestorePending(true);
    expect(useAppStore.getState().sessionRestorePending).toBe(true);
    const marker = { docId: 'd1', provider: 'ollama', embedModel: 'm' };
    useAppStore.getState().setRestoredSession(marker);
    expect(useAppStore.getState().restoredSession).toEqual(marker);
  });

  it('setQaMessages 는 대화를 일괄 교체', () => {
    useAppStore.getState().setQaMessages([
      { id: 'a', role: 'user', content: 'q' },
      { id: 'b', role: 'assistant', content: 'a' },
    ]);
    expect(useAppStore.getState().qaMessages).toHaveLength(2);
    expect(useAppStore.getState().qaMessages[0]!.id).toBe('a');
  });

  it('resetSummaryState 는 restoredSession/sessionRestorePending 를 초기화', () => {
    useAppStore.getState().setRestoredSession({ docId: 'd1', provider: 'ollama', embedModel: 'm' });
    useAppStore.getState().setSessionRestorePending(true);
    useAppStore.getState().resetSummaryState();
    expect(useAppStore.getState().restoredSession).toBeNull();
    expect(useAppStore.getState().sessionRestorePending).toBe(false);
  });
});

describe('컬렉션 Q&A 상태 (multi-doc Phase 2)', () => {
  beforeEach(() => {
    useAppStore.setState({ collection: { enabled: false, memberHashes: [] } });
  });

  it('기본값은 비활성 + 빈 멤버', () => {
    expect(useAppStore.getState().collection).toEqual({ enabled: false, memberHashes: [] });
  });

  it('setCollectionEnabled 는 멤버를 보존한 채 모드만 토글', () => {
    useAppStore.getState().setCollectionMembers(['a', 'b']);
    useAppStore.getState().setCollectionEnabled(true);
    expect(useAppStore.getState().collection).toEqual({ enabled: true, memberHashes: ['a', 'b'] });
    useAppStore.getState().setCollectionEnabled(false);
    expect(useAppStore.getState().collection.memberHashes).toEqual(['a', 'b']); // 멤버 보존
  });

  it('toggleCollectionMember 는 포함/제외를 번갈아 적용', () => {
    const s = useAppStore.getState();
    s.toggleCollectionMember('a');
    expect(useAppStore.getState().collection.memberHashes).toEqual(['a']);
    s.toggleCollectionMember('b');
    expect(useAppStore.getState().collection.memberHashes).toEqual(['a', 'b']);
    s.toggleCollectionMember('a'); // 제외
    expect(useAppStore.getState().collection.memberHashes).toEqual(['b']);
  });

  // R46 Important: 닫힌 탭의 docHash 가 컬렉션 멤버에 stale 로 남지 않아야 함
  it('removeOpenTab 은 닫힌 탭의 docHash 를 컬렉션 멤버에서도 제거', () => {
    useAppStore.setState({
      openTabs: [
        { filePath: '/a', fileName: 'a.pdf', pageCount: 1, docHash: 'ha' },
        { filePath: '/b', fileName: 'b.pdf', pageCount: 1, docHash: 'hb' },
      ],
      collection: { enabled: true, memberHashes: ['ha', 'hb'] },
    });
    useAppStore.getState().removeOpenTab('/b');
    expect(useAppStore.getState().collection.memberHashes).toEqual(['ha']);
    expect(useAppStore.getState().collection.enabled).toBe(true); // 탭 남아있으면 모드 유지
  });

  it('removeOpenTab 으로 모든 탭이 닫히면 컬렉션 모드 초기화', () => {
    useAppStore.setState({
      openTabs: [{ filePath: '/a', fileName: 'a.pdf', pageCount: 1, docHash: 'ha' }],
      collection: { enabled: true, memberHashes: ['ha'] },
    });
    useAppStore.getState().removeOpenTab('/a');
    expect(useAppStore.getState().openTabs).toHaveLength(0);
    expect(useAppStore.getState().collection).toEqual({ enabled: false, memberHashes: [] });
  });
});

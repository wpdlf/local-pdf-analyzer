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
  });
  afterEach(() => {
    vi.useRealTimers();
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
});

describe('stream batching — qaStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStreams();
  });
  afterEach(() => { vi.useRealTimers(); });

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

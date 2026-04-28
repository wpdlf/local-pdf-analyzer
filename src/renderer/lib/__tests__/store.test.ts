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
vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` });

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
    expect(msgs[0].content).toBe('u0');
    expect(msgs[19].content).toBe('a9');
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
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('u1');
    expect(msgs[msgs.length - 1].content).toBe('u10');
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
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('u1');
    expect(msgs[msgs.length - 1].content).toBe('a10');
  });

  it('v0.18.5 M3 불변식: FIFO 동작 중 윈도우 선두는 항상 user 역할', () => {
    const s = useAppStore.getState();
    // 13 턴(26 메시지) 주입하며 매 호출 후 첫 메시지 role 을 확인
    for (let i = 0; i < 13; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      const afterUser = useAppStore.getState().qaMessages;
      if (afterUser.length > 0) expect(afterUser[0].role).toBe('user');
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
      const afterAssistant = useAppStore.getState().qaMessages;
      if (afterAssistant.length > 0) expect(afterAssistant[0].role).toBe('user');
    }
  });

  it('메시지에는 고유 id 가 부여된다', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: 'q' });
    s.addQaMessage({ role: 'assistant', content: 'a' });
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs[0].id).toBeTruthy();
    expect(msgs[1].id).toBeTruthy();
    expect(msgs[0].id).not.toBe(msgs[1].id);
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
});

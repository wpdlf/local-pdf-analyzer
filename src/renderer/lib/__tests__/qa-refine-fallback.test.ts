import { describe, it, expect, vi } from 'vitest';

// v0.18.4 H1 회귀 테스트 — refine LLM 이 0 토큰을 반환할 때 draft 가 유실되지 않아야 한다.
// 이전(v0.18.0~v0.18.3)에는 handleAsk 클로저 안에 for-await 가 인라인돼 있어
// refine 이 빈 스트림을 뱉으면 answer='' → outer `if (answer)` 가드에 걸려 draft 통째 유실.
// collectRefineAnswer 헬퍼가 빈 응답 시 draft 로 fallback 시키는 불변식을 검증.

vi.stubGlobal('window', {
  electronAPI: {
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    settings: { set: vi.fn(), get: vi.fn() },
  },
});
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('crypto', { randomUUID: () => 'uuid' });

import { collectRefineAnswer } from '../use-qa';

/** 토큰 배열을 AsyncIterable 로 래핑 */
async function* tokenStream(tokens: string[]): AsyncGenerator<string> {
  for (const t of tokens) yield t;
}

describe('collectRefineAnswer (v0.18.4 H1 regression)', () => {
  it('refine 이 0 토큰을 반환하면 draft 를 fallback 으로 사용한다', async () => {
    const onToken = vi.fn();
    const result = await collectRefineAnswer(
      tokenStream([]),
      'draft answer content',
      () => true,
      onToken,
    );
    expect(result).toBe('draft answer content');
    expect(onToken).not.toHaveBeenCalled();
  });

  it('refine 이 공백만 반환해도 draft fallback (trim 후 empty)', async () => {
    const onToken = vi.fn();
    const result = await collectRefineAnswer(
      tokenStream(['   ', '\n', '\t']),
      'meaningful draft',
      () => true,
      onToken,
    );
    expect(result).toBe('meaningful draft');
    // 토큰은 스트림에서 소비되어 onToken 으로 전달됨(중간에 사용자 UI 에 표시되긴 하지만
    // 최종 반환값은 draft fallback). 이 동작은 기존 코드와 동일.
    expect(onToken).toHaveBeenCalledTimes(3);
  });

  it('refine 이 정상 토큰을 반환하면 누적된 답변을 반환 (draft 무시)', async () => {
    const onToken = vi.fn();
    const result = await collectRefineAnswer(
      tokenStream(['Hello', ' ', 'world', '.']),
      'OLD DRAFT',
      () => true,
      onToken,
    );
    expect(result).toBe('Hello world.');
    expect(onToken).toHaveBeenCalledTimes(4);
    expect(onToken).toHaveBeenCalledWith('Hello');
    expect(onToken).toHaveBeenLastCalledWith('.');
  });

  it('isActive() 가 false 로 전환되면 즉시 break — 그때까지 누적된 답변 반환', async () => {
    const onToken = vi.fn();
    let active = true;
    const result = await collectRefineAnswer(
      tokenStream(['a', 'b', 'c', 'd']),
      'draft',
      () => active,
      (token) => {
        onToken(token);
        if (token === 'b') active = false; // b 까지만 수집되어야 함
      },
    );
    // 순서: a 수신 → isActive true → b 수신 → isActive false (다음 반복에서 break)
    expect(result).toBe('ab');
    expect(onToken).toHaveBeenCalledTimes(2);
  });

  it('isActive() 가 false 로 끝난 뒤 answer 가 비면 draft 로 fallback', async () => {
    const onToken = vi.fn();
    const result = await collectRefineAnswer(
      tokenStream(['anything']),
      'recovered draft',
      () => false, // 시작부터 비활성
      onToken,
    );
    // 첫 토큰 수신 전 isActive 체크 실패 → 누적 없음 → draft fallback
    expect(result).toBe('recovered draft');
    expect(onToken).not.toHaveBeenCalled();
  });

  it('한 글자 토큰이라도 내용이 있으면 draft 로 덮이지 않음', async () => {
    const result = await collectRefineAnswer(
      tokenStream(['x']),
      'draft',
      () => true,
      () => {},
    );
    expect(result).toBe('x');
  });

  it('빈 draft 와 빈 refine 스트림 조합도 안전 (둘 다 빈 문자열)', async () => {
    const result = await collectRefineAnswer(
      tokenStream([]),
      '',
      () => true,
      () => {},
    );
    expect(result).toBe('');
  });
});

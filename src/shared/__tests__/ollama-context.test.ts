import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONTEXT_BUCKETS,
  DEFAULT_NUM_CTX,
  OUTPUT_RESERVE_TOKENS,
  estimateTokens,
  resolveNumCtx,
  stickyNumCtx,
  exceedsMaxContext,
  numCtxTimeoutScale,
  __resetStickyNumCtxForTest,
} from '../ollama-context';

/**
 * 실측 근거(2026-09-03, Ollama 0.23.4 + gemma3):
 *
 *  - `num_ctx` 를 보내지 않으면 서버 기본값 **4096** 이 적용된다. 프롬프트가 그것을 넘으면
 *    **앞부분부터** 조용히 버려지고 `done_reason` 은 `stop` 이라 아무 신호도 없다
 *    (Q&A 8000자 = 4,200토큰 → 104토큰 잘림 / 컬렉션 12000자 = 6,263토큰 → 2,167토큰(35%) 잘림).
 *    앱의 기존 `detectTruncation` 은 `done_reason === 'length'`(**출력** 절단)만 보므로 못 잡는다.
 *  - `num_ctx` 가 바뀌면 모델이 **재로드**된다(2.8초). 그래서 정확값이 아니라 **버킷**을 쓴다 —
 *    같은 활동 안에서 값이 변하지 않아야 청크마다 재로드가 나지 않는다.
 *  - 고정 큰 값은 쓸 수 없다: KV 비용이 모델마다 다르다(4096→16384 에서 gemma3 +0.25GB,
 *    llama3.2 **+2.00GB**). 그래서 필요한 만큼만 올린다.
 *  - 모델 상한을 넘겨 보내도 에러가 아니라 Ollama 가 클램프한다(200000 → 131072, 총 7.24GB) —
 *    즉 **우리 쪽 상한이 유일한 메모리 방어선**이다.
 */

describe('estimateTokens — 과소추정이 곧 절단이므로 넉넉하게 잡는다', () => {
  it('빈 문자열은 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('한글은 영어보다 토큰을 많이 쓴다 (같은 글자 수 기준)', () => {
    const ko = '운영체제는 프로세스를 관리한다'.repeat(20);
    const en = 'the operating system manages'.repeat(20);
    expect(ko.length).toBeGreaterThan(0);
    expect(estimateTokens(ko)).toBeGreaterThan(estimateTokens(en.slice(0, ko.length)));
  });

  /**
   * 실측 대조 — 이 두 지점이 추정식의 기준점이다. 실제보다 **낮게** 추정하면 절단이 나므로
   * 하한만 못박는다(위로는 여유가 있어도 버킷이 흡수한다).
   *   한국어 6,000자 → 실측 3,170토큰 / 영어 16,000자 → 실측 2,784토큰
   */
  it('실측된 토큰 수를 밑돌지 않는다 (한국어 6,000자 ≥ 3,170)', () => {
    const ko = '운영체제는 프로세스와 스레드를 관리하며 CPU 스케줄링 정책에 따라 실행 순서를 정한다. '.repeat(200).slice(0, 6000);
    expect(estimateTokens(ko)).toBeGreaterThanOrEqual(3170);
  });

  it('실측된 토큰 수를 밑돌지 않는다 (영어 16,000자 ≥ 2,784)', () => {
    const en = 'The operating system manages processes and threads according to the scheduling policy. '.repeat(300).slice(0, 16000);
    expect(estimateTokens(en)).toBeGreaterThanOrEqual(2784);
  });
});

describe('resolveNumCtx — 버킷 선택', () => {
  it('짧은 프롬프트는 기본값(4096)에 머문다 — 현행 동작 무회귀', () => {
    expect(resolveNumCtx('시스템', '짧은 질문')).toBe(DEFAULT_NUM_CTX);
    expect(DEFAULT_NUM_CTX).toBe(4096);
  });

  /**
   * ⚠️ 설계 초안은 "기본 요약 청크는 4096 에 머물러 무회귀" 를 전제했는데 **틀렸다**.
   * 실측: 입력 3,158토큰 + 출력 765토큰 = 3,923 / 4,096 — 창의 **96%** 를 쓰고 있었다
   * (여유 173토큰). 이번 출력이 안 잘린 것은 요약이 짧게 끝나서일 뿐이고, 조금만 길어지면
   * `done_reason: 'length'` 로 끊긴다. 입력만 보고 "들어간다" 고 판정한 것이 오류였다 —
   * `num_ctx` 는 입력+출력 **총합**의 상한이다.
   */
  it('요약 청크(한국어 6,000자)는 출력 여유까지 보면 4096 을 넘는다', () => {
    const chunk = '운영체제는 프로세스와 스레드를 관리하며 CPU 스케줄링 정책에 따라 실행 순서를 정한다. '.repeat(200).slice(0, 6000);
    expect(resolveNumCtx('요약 지시문', chunk)).toBe(8192);
  });

  it('Q&A 컨텍스트(8,000자)는 한 단계 올라간다 — 지금 잘리고 있는 경로', () => {
    const ctx = '운영체제는 프로세스와 스레드를 관리하며 CPU 스케줄링 정책에 따라 실행 순서를 정한다. '.repeat(200).slice(0, 8000);
    expect(resolveNumCtx('시스템', ctx)).toBeGreaterThan(4096);
  });

  it('컬렉션 교차 요약(12,000자)도 올라간다 — 35% 잘리던 경로', () => {
    const ctx = '운영체제는 프로세스와 스레드를 관리하며 CPU 스케줄링 정책에 따라 실행 순서를 정한다. '.repeat(300).slice(0, 12000);
    expect(resolveNumCtx('시스템', ctx)).toBeGreaterThan(4096);
  });

  it('버킷 값만 반환한다 (임의 값이면 요청마다 모델이 재로드된다)', () => {
    for (const chars of [1000, 5000, 9000, 13000, 30000, 90000]) {
      const text = '가'.repeat(chars);
      expect(CONTEXT_BUCKETS, `${chars}자 → 버킷 밖의 값`).toContain(resolveNumCtx('s', text));
    }
  });

  it('아무리 커도 상한을 넘지 않는다 (Ollama 는 모델 상한까지 클램프할 뿐 막지 않는다)', () => {
    const huge = '가'.repeat(500_000);
    expect(resolveNumCtx('시스템', huge)).toBe(CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1]);
  });

  it('system 과 prompt 를 **함께** 센다 (한쪽만 세면 그만큼이 절단분이 된다)', () => {
    // 둘 다 상한에 걸리는 크기를 쓰면 비교가 성립하지 않는다 — 버킷 경계를 **넘게 하는**
    // 크기로 잡아야 system 을 세는지 아닌지가 드러난다(초판이 9000자씩이라 둘 다 16384 였다).
    const prompt = '가'.repeat(1500);
    const system = '가'.repeat(3000);
    expect(resolveNumCtx('', prompt)).toBe(4096);
    expect(resolveNumCtx(system, prompt)).toBeGreaterThan(4096);
  });

  it('출력 예약분을 더한다 — num_ctx 는 입력+출력 총합이라 입력만 맞추면 답이 잘린다', () => {
    // 예약이 없다면 4096 에 딱 맞았을 크기가, 예약 때문에 다음 버킷으로 올라가야 한다.
    const text = '가'.repeat(Math.floor((4096 - OUTPUT_RESERVE_TOKENS / 2) * 1.5));
    expect(OUTPUT_RESERVE_TOKENS).toBeGreaterThan(0);
    expect(resolveNumCtx('', text)).toBeGreaterThan(4096);
  });

  it('버킷은 오름차순이고 4096 에서 시작한다', () => {
    expect(CONTEXT_BUCKETS[0]).toBe(DEFAULT_NUM_CTX);
    for (let i = 1; i < CONTEXT_BUCKETS.length; i++) {
      expect(CONTEXT_BUCKETS[i]!).toBeGreaterThan(CONTEXT_BUCKETS[i - 1]!);
    }
  });
});

/**
 * QA32(A-1): 버킷의 근거였던 "한 활동 안에서 값이 변하지 않는다" 가 실제 문서에서 깨졌다 —
 * 요약 지시문(1,461자)을 포함하면 8192→16384 경계가 청크 5,914자에 오는데 chunker 의 청크
 * 상한은 라벨 포함 6,174자다. 경계가 상한 **아래**라 청크들이 양옆에 흩어지고, 한국어 40쪽
 * 실측에서 22청크 중 전환 8회(재로드 22.4초)가 났다.
 */
describe('stickyNumCtx — 하강 전환 제거', () => {
  beforeEach(() => { __resetStickyNumCtxForTest(); });

  it('올라간 창은 내려오지 않는다 (재로드의 대다수가 하강이다)', () => {
    expect(stickyNumCtx('gemma3', 8192)).toBe(8192);
    expect(stickyNumCtx('gemma3', 16384)).toBe(16384);
    expect(stickyNumCtx('gemma3', 4096)).toBe(16384);
    expect(stickyNumCtx('gemma3', 8192)).toBe(16384);
  });

  it('모델이 다르면 서로 끌어올리지 않는다 (다른 모델은 어차피 별도 로드다)', () => {
    stickyNumCtx('gemma3', 16384);
    expect(stickyNumCtx('llama3.2', 4096)).toBe(4096);
  });

  it('청크 수열의 전환 횟수를 단언한다 (값 하나씩 보면 요동을 못 잡는다)', () => {
    // 실측 재현: 경계 양옆에 흩어진 청크들
    const seq = [16384, 8192, 8192, 16384, 8192, 16384, 8192, 4096];
    const sticky = seq.map((n) => stickyNumCtx('gemma3', n));
    const transitions = sticky.filter((v, i) => i > 0 && v !== sticky[i - 1]).length;
    expect(transitions, `전환 ${transitions}회 — 하강이 남아 있다`).toBe(0);
    // 원본 수열은 전환이 5회였다(이 테스트가 공허하지 않다는 근거).
    const rawTransitions = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
    expect(rawTransitions).toBeGreaterThan(0);
  });

  it('상승은 허용한다 — 필요한 창을 못 쓰면 원래 결함이 돌아온다', () => {
    expect(stickyNumCtx('gemma3', 4096)).toBe(4096);
    expect(stickyNumCtx('gemma3', 16384)).toBe(16384);
  });
});

describe('exceedsMaxContext — 상한 초과는 여전히 잘린다는 사실을 알린다', () => {
  it('상한 안이면 false', () => {
    expect(exceedsMaxContext('시스템', '가'.repeat(1000))).toBe(false);
  });

  it('상한을 넘으면 true (설정에서 청크를 올리면 도달 가능한 구간)', () => {
    expect(exceedsMaxContext('시스템', '가'.repeat(30_000))).toBe(true);
  });

  it('resolveNumCtx 가 상한으로 클램프한 바로 그 경우를 가리킨다', () => {
    const huge = '가'.repeat(30_000);
    expect(resolveNumCtx('', huge)).toBe(CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1]);
    expect(exceedsMaxContext('', huge)).toBe(true);
  });
});

describe('numCtxTimeoutScale — 감시견이 정상 스트림을 죽이지 않도록', () => {
  it('기본값에서는 1 (종전 동작 무회귀)', () => {
    expect(numCtxTimeoutScale(DEFAULT_NUM_CTX)).toBe(1);
  });

  it('창이 커진 비율만큼 커진다 (프롬프트 평가량이 그만큼 늘어난다)', () => {
    expect(numCtxTimeoutScale(8192)).toBe(2);
    expect(numCtxTimeoutScale(16384)).toBe(4);
  });

  it('1 아래로는 내려가지 않는다 (상한을 줄이는 방향은 없다)', () => {
    expect(numCtxTimeoutScale(1024)).toBe(1);
  });
});

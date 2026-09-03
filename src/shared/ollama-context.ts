/**
 * Ollama 컨텍스트 창(`num_ctx`) 결정 — 순수 모듈.
 *
 * ## 왜 필요한가 (실측 2026-09-03, Ollama 0.23.4)
 *
 * 앱은 `/api/generate` 에 `options: { temperature }` 만 실어 왔다. `num_ctx` 를 보내지 않으면
 * Ollama 서버 기본값 **4096** 이 적용되는데, gemma3 가 지원하는 컨텍스트는 **131072** 다 —
 * 모델 능력의 3%만 쓰고 있었다. 그리고 프롬프트가 4096 을 넘으면 llama.cpp 가 **앞부분부터**
 * 버리는데, `done_reason` 은 `stop` 이라 **어떤 실패 신호도 나오지 않는다**. 기존
 * `detectTruncation` 은 `done_reason === 'length'`(**출력** 절단)만 보므로 이 경우를 못 잡는다.
 *
 * 실측된 피해(입력 절단):
 *   Q&A 컨텍스트(8,000자)      4,200토큰 → 104토큰 잘림. **2%만 잘려도 맨 앞은 사라진다**
 *   컬렉션 교차 요약(12,000자) 6,263토큰 → 2,167토큰(35%) 잘림
 *   청크 상한 설정(16000토큰) 10,078토큰 → 5,982토큰(59%) 잘림
 *
 * ⚠️ 요약 청크는 입력만 보면 3,170토큰이라 "안전" 해 보이지만 **아니다**: 같은 조건에서
 * 출력이 765토큰이었고 3,158 + 765 = **3,923 / 4,096 — 창의 96%** 다(여유 173토큰).
 * 이번에 안 잘린 것은 요약이 짧게 끝나서일 뿐이고, 조금만 길어지면 출력이 끊긴다.
 * `num_ctx` 는 입력이 아니라 **입력+출력 총합**의 상한이므로 입력만 보고 판정하면 틀린다.
 *
 * 컬렉션 경로의 앞쪽은 **첫 번째 문서의 블록**이다. 즉 문서 한둘이 통째로 사라진 채 "통합
 * 요약" 이 나오고, 프롬프트는 모든 근거에 `[문서명 p.N]` 을 요구하므로 모델은 **보지도 못한
 * 문서를 인용**하게 된다(QA27·QA29 가 닫아 온 "조용한 오답" 과 같은 클래스).
 *
 * ## 왜 정확값이 아니라 버킷인가
 *
 * `num_ctx` 가 바뀌면 Ollama 가 모델을 **재로드한다(실측 2.8초, 같은 값이면 0.3초)**.
 * 요청마다 정확값을 계산해 보내면 청크마다 재로드가 나 요약이 훨씬 느려진다. 버킷을 쓰면
 * 한 활동(요약 run) 안에서 값이 변하지 않아 재로드가 0 이다.
 *
 * ## 왜 고정 큰 값이 아닌가
 *
 * KV 캐시 비용이 **모델마다 다르다**. 4096 → 16384 에서 gemma3 는 +0.25GB(슬라이딩 윈도우
 * 어텐션)인데 llama3.2 는 **+2.00GB**(표준 어텐션)다 — 8배 차이. 그래서 필요한 만큼만 올린다.
 *
 * ## 왜 상한이 필요한가
 *
 * 모델 상한을 넘겨 보내도 Ollama 는 **거부하지 않고 클램프한다**(200000 요청 → 131072 적용,
 * 총 점유 7.24GB). 즉 서버는 메모리를 막아 주지 않는다 — 이 상수가 유일한 방어선이다.
 */

/**
 * 선택 가능한 컨텍스트 창. 첫 값은 서버 기본값과 같아야 한다 — 짧은 프롬프트에서 종전과
 * 똑같이 동작해야 메모리·재로드 회귀가 없다.
 *
 * 값을 늘리면 그만큼 재로드 지점이 늘어난다. 세 단계로 두는 이유: 짧은 프롬프트(4096) ·
 * 기본 요약/Q&A/컬렉션(8192) · 청크 상한을 올린 사용자(16384) 가 실측상 이 셋에 나뉘어
 * 떨어진다. 기본 워크플로가 8192 하나에 모이는 것은 의도적이다 — 요약↔Q&A 를 오갈 때
 * 버킷이 바뀌면 그때마다 2.8초 재로드가 난다.
 */
export const CONTEXT_BUCKETS = [4096, 8192, 16384] as const;

/** 메모리 방어선 — Ollama 는 모델 상한까지 그대로 늘려 주므로 막는 것은 이 값뿐이다. */
const MAX_NUM_CTX: number = CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1]!;

/** Ollama 서버 기본값. 이 아래로는 절대 내리지 않는다(내리면 종전보다 더 잘린다). */
export const DEFAULT_NUM_CTX = 4096;

/**
 * 출력용 예약 토큰. `num_ctx` 는 입력이 아니라 **입력+출력 총합**의 상한이므로, 입력에만
 * 맞추면 답변이 자라다가 컨텍스트에 걸려 잘린다(그쪽은 `done_reason: 'length'` 로 드러나긴
 * 하지만, 애초에 안 걸리게 하는 게 맞다). 요약 한 편 분량을 넉넉히 잡는다.
 */
export const OUTPUT_RESERVE_TOKENS = 2048;

/**
 * 추정 오차 흡수 계수. 아래 추정은 문자 종류 비율로 어림하는 것이라 실제 토크나이저와
 * 어긋난다. **과대추정은 버킷이 흡수하지만 과소추정은 곧 절단**이므로 위쪽으로 여유를 준다.
 */
const SAFETY_FACTOR = 1.15;

/** CJK(한글·가나·한자) 한 글자당 토큰 수의 역수 — 이 부류는 토큰을 많이 먹는다. */
const CJK_CHARS_PER_TOKEN = 1.3;
/** 그 외(라틴 문자·숫자·공백) */
const OTHER_CHARS_PER_TOKEN = 3.5;

const CJK_PATTERN = /[가-힯㄰-㆏ᄀ-ᇿ぀-ゟ゠-ヿ一-鿿]/g;

/**
 * 프롬프트의 토큰 수를 어림한다.
 *
 * `chunker.estimateCharsPerToken` 과 상수가 다른 것은 드리프트가 아니라 **목적이 반대**이기
 * 때문이다: 저쪽은 청크를 자르려고 토큰당 문자 수를 **크게**(=토큰을 적게) 잡아도 되지만,
 * 여기서 토큰을 적게 잡으면 컨텍스트가 모자라 **입력이 잘린다**. 그래서 이쪽은 토큰을 더
 * 많이 세는 방향으로 상수를 잡는다(실측: 한국어 6,000자 = 3,170토큰 = 1.89 chars/token 인데
 * 여기서는 1.3 으로 본다).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

/**
 * 이 요청에 쓸 `num_ctx`.
 *
 * system 과 prompt 를 **함께** 센다 — Ollama 는 둘을 하나의 컨텍스트에 넣으므로 한쪽만 세면
 * 그 크기만큼이 그대로 절단분이 된다.
 */
function requiredTokens(system: string, prompt: string): number {
  return Math.ceil(
    estimateTokens(system) * SAFETY_FACTOR
    + estimateTokens(prompt) * SAFETY_FACTOR
    + OUTPUT_RESERVE_TOKENS,
  );
}

export function resolveNumCtx(system: string, prompt: string): number {
  const needed = requiredTokens(system, prompt);
  for (const bucket of CONTEXT_BUCKETS) {
    if (needed <= bucket) return bucket;
  }
  // 상한을 넘는 프롬프트는 여기서 막지 못한다(자르는 것은 호출부 예산의 몫이다).
  // 다만 메모리는 이 상한이 지킨다 — Ollama 는 모델 상한까지 그대로 늘려 준다.
  return MAX_NUM_CTX;
}

/**
 * 모델별 "최근 사용 버킷" — 내려가지 않는다 (QA32 A-1).
 *
 * ## 왜 필요한가 (실측)
 * 버킷을 쓴 근거는 "한 활동 안에서 값이 변하지 않는다" 였는데 **실제 문서에서 성립하지 않았다**.
 * 요약 지시문(ko/full = 1,461자, 인용 규칙 블록이 그중 861자)을 포함하면 8192→16384 경계가
 * 청크 **5,914자**에 오는데, chunker 의 청크 상한은 라벨 포함 **6,174자**다. 즉 경계가 상한
 * 아래라 문단 길이가 고르지 않은 실제 PDF 의 청크들이 경계 양옆에 흩어진다. 한국어 40쪽 문서
 * 실측에서 22청크 중 **전환 8회 = 재로드 8 × 2.8초 = 22.4초**가 났다.
 *
 * ## 왜 이 방식인가
 * 전환의 대다수는 **하강**(큰 청크 뒤에 작은 청크)이고, 하강은 아무 이득이 없다 — 이미 그
 * 크기로 로드된 모델을 굳이 작게 다시 로드하는 것뿐이다. 상승만 허용하면 한 문서 안에서
 * 재로드는 **최대 버킷 수 − 1 회**로 묶인다.
 *
 * 메모리는 keep_alive 만료 시 Ollama 가 모델을 내리면서 함께 회수되므로 영구 점유가 아니다.
 * 모델이 바뀌면 어차피 다른 모델이 로드되므로 키를 분리한다.
 */
const stickyByModel = new Map<string, number>();

/** 하강 전환을 없앤 최종 `num_ctx`. 같은 모델에서 한 번 올라간 창은 내리지 않는다. */
export function stickyNumCtx(model: string, computed: number): number {
  const prev = stickyByModel.get(model) ?? 0;
  const next = Math.max(prev, computed);
  stickyByModel.set(model, next);
  return next;
}

/** 테스트 전용 — 모듈 스코프 상태를 비운다(스위트 간 누수 방지). */
export function __resetStickyNumCtxForTest(): void {
  stickyByModel.clear();
}

/**
 * 이 프롬프트가 상한을 **넘어서** 여전히 앞부분이 잘리는가 (QA32 A/C).
 *
 * `resolveNumCtx` 는 초과분을 조용히 클램프한다. 그런데 호출부 예산(`maxChunkSize` 는 설정에서
 * 최대 16000토큰까지 허용된다)이 이 상한을 모르기 때문에, 라틴 문서 + 큰 청크 설정에서는
 * **수정 전과 똑같이 앞부분부터 잘리는 구간**이 남는다. 그 사실을 호출부가 사용자에게 알릴 수
 * 있도록 판정만 분리해 내보낸다 — 조용히 나빠지는 것이 이 라운드가 없애려는 바로 그 실패다.
 */
export function exceedsMaxContext(system: string, prompt: string): boolean {
  return requiredTokens(system, prompt) > MAX_NUM_CTX;
}

/**
 * 무진전 감시견의 시간 상한에 곱할 배율 (QA32 A-2).
 *
 * 감시견들은 **토큰 수신**만 진전 신호로 본다. 그런데 첫 토큰이 나오기까지는 프롬프트 평가가
 * 끝나야 하고, 그 작업량은 `num_ctx` 에 비례한다. 수정 전에는 Ollama 가 4096 에서 프롬프트를
 * 잘라 버려 평가량이 하드캡돼 있었는데, 이제 최대 4배가 된다 — 같은 120초 상한이면 **정상
 * 스트림을 감시견이 죽인다**(QA20 A-High 가 이미지 분석 단계에서 겪은 것과 같은 클래스).
 *
 * 기준선(4096) 대비 비율을 그대로 쓴다. 상한을 늘린 만큼만 기다린다는 뜻이라 폭주 방어는 유지된다.
 */
export function numCtxTimeoutScale(numCtx: number): number {
  return Math.max(1, numCtx / DEFAULT_NUM_CTX);
}

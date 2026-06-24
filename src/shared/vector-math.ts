/**
 * 코사인 유사도 프리미티브 — Main/Renderer 공용 순수 함수(단일 출처).
 *
 * VectorStore(renderer)의 의미 검색과 main 의 전체 문서 의미 검색(session:searchSemantic)이
 * 동일한 정규화/내적 로직을 공유해 drift 를 차단한다. constants.ts 와 동일하게 런타임 API 참조
 * 금지(순수 값/계산만). 이전엔 vector-store.ts 내부 private 함수였으나 main 재사용을 위해 추출.
 */

/** 벡터를 unit-length 로 정규화한 Float32Array 반환. 영벡터/무효값은 0으로 채움(내적이 항상 0 → minScore 필터). */
export function normalizeToFloat32(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sumSq = 0;
  // noUncheckedIndexedAccess: 루프 인덱스가 length 내부임이 보장되어 non-null 단언.
  for (let i = 0; i < v.length; i++) sumSq += v[i]! * v[i]!;
  const mag = Math.sqrt(sumSq);
  if (!Number.isFinite(mag) || mag === 0) {
    return out; // 영벡터/무효 값 → dot product 가 항상 0
  }
  const inv = 1 / mag;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

/**
 * 두 unit 벡터의 dot product = 코사인 유사도.
 *
 * Float32 정규화는 round-off 로 magnitude 가 정확히 1.0 이 아닐 수 있어(1.0000001) 동일 벡터의
 * dot 이 1.0 을 미세 초과할 수 있다. 수학적으로 코사인은 [-1, 1] 이 보장되어야 하므로 명시 clamp.
 */
export function dotClamped(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  // noUncheckedIndexedAccess: 호출 측에서 동일 차원 보장. 핫패스라 non-null 단언으로 좁힘 비용 0.
  for (let i = 0; i < len; i++) sum += a[i]! * b[i]!;
  if (sum > 1) return 1;
  if (sum < -1) return -1;
  return sum;
}

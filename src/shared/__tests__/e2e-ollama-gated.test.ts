/**
 * QA25(B-MED): "CI 에서 돌지 않는 E2E" 의 목록을 고정하는 드리프트 가드.
 *
 * Ollama 가 필요한 스펙은 CI 러너에서 구조적으로 skip 되고, Playwright 는 skip 을 실패로
 * 보고하지 않는다 — 즉 그 스펙들이 가드하던 기능(컬렉션 교차문서 요약·마인드맵·인덱싱 중
 * 탭 전환)은 **CI 에 가드가 없는 상태로 초록**이다. 그 자체는 러너에 Ollama 가 없는 이상
 * 불가피하지만, 이 집합이 **조용히 커지는 것**은 불가피하지 않다.
 *
 * 이 테스트는 두 가지를 고정한다:
 *  1) CI 에서 skip 되는 스펙의 목록 — 새 스펙이 목록 갱신 없이 합류하면 실패한다.
 *  2) 그 스펙들은 반드시 공유 게이트(requireOllama)를 쓴다 — 손으로 쓴 skip 은 REQUIRED
 *     모드(E2E_OLLAMA_REQUIRED=1)를 존중하지 않아 전제 위반을 조용히 통과시킨다.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments } from './helpers/source-scan';

// QA29(D1-2): 스펙 스캔은 주석을 걷은 뒤 한다. 원본을 보면 `requireOllama(` 를 주석에만 남긴
// 스펙이 "게이트를 쓴다" 로 집계되고(목록은 그대로 초록), 반대로 주석 처리된
// `test.skip(!!process.env.CI…)` 가 거짓 위반으로 잡힌다.
const readSpec = (p: string) => stripJsComments(readFileSync(p, 'utf8'));

const E2E_DIR = fileURLToPath(new URL('../../../e2e/', import.meta.url));

/**
 * **CI 에서 실행되지 않는 테스트를 품은 스펙 파일** 목록. 추가할 때는 이유를 함께 적을 것.
 *
 * QA26(B-Low): 종전 주석은 "CI 에서 실행되지 않는 스펙" 이라고 적었는데 단위가 파일이라 사실과
 * 어긋났다 — `tabs.spec.ts` 는 두 테스트 중 하나(:29)가 CI 에서 **정상 실행**되고 다른 하나만
 * 게이트다. 목록만 읽으면 CI 커버리지를 실제보다 작게 본다.
 *
 * 또한 `E2E_OLLAMA_REQUIRED` 는 `.github/` 어디에도 설정돼 있지 않다 — REQUIRED 모드는 현재
 * **수동 전용**이고, CI 에서의 실질 변화는 stdout 사유 로그와 이 드리프트 목록뿐이다.
 */
const OLLAMA_GATED = [
  'collection-phase3.spec.ts', // 통합 요약 + 저장→재오픈 (실 LLM 생성 필요)
  'collection.spec.ts', // 교차문서 Q&A (실 LLM + 임베딩 필요)
  'mindmap.spec.ts', // 실 요약 → 마인드맵 토글 (실 LLM 생성 필요)
  'tabs.spec.ts', // 실 인덱싱 중 탭 전환 (실 임베딩 필요)
];

function specFiles(): string[] {
  return readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts')).sort();
}

describe('CI 에서 돌지 않는 E2E 목록 (QA25)', () => {
  it('Ollama 게이트를 쓰는 스펙이 승인 목록과 정확히 일치한다', () => {
    const gated = specFiles().filter((f) =>
      readSpec(join(E2E_DIR, f)).includes('requireOllama('));
    expect(gated).toEqual(OLLAMA_GATED);
  });

  it('손으로 쓴 CI skip 이 남아 있지 않다 (공유 게이트만 사용)', () => {
    // 손수 쓴 `test.skip(!!process.env.CI, …)` 는 E2E_OLLAMA_REQUIRED 를 존중하지 않는다 —
    // 그러면 "전제가 깨졌는데 초록" 을 다시 만들 수 있다.
    const offenders = specFiles().filter((f) => {
      const src = readSpec(join(E2E_DIR, f));
      return /test\.skip\(\s*!!\s*process\.env\.CI/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('게이트 헬퍼가 REQUIRED 모드에서 skip 대신 실패시킨다', () => {
    const src = readSpec(join(E2E_DIR, 'ollama-gate.ts'));
    // skip 경로마다 REQUIRED 분기가 앞에 있어야 한다.
    expect(src).toContain("process.env.E2E_OLLAMA_REQUIRED === '1'");
    expect(src.match(/throw new Error/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

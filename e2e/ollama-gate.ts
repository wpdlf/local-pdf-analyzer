import { test } from '@playwright/test';

/**
 * Ollama 실행이 필요한 "로컬 전용" E2E 스펙의 공통 게이트.
 *
 * QA25(B-MED): 이 게이트들은 CI 에서 **구조적으로 skip** 되고 Playwright 는 skip 을 실패로
 * 보고하지 않는다. 즉 컬렉션 교차문서 요약·마인드맵의 E2E 가드는 CI 에 존재하지 않으면서
 * 잡은 초록이다. 로컬에서도 모델이 없으면 다시 초록이 되므로, 실제로 이 스펙들이 마지막으로
 * 돌아간 시점을 아무도 모른다.
 *
 * 러너에 Ollama 를 심는 것은 비용이 크므로 skip 자체는 유지하되, 두 가지를 바꾼다:
 *  1) `E2E_OLLAMA_REQUIRED=1` 이면 skip 을 **금지**한다 — 전제 위반을 조용히 통과시키지 않고
 *     즉시 실패시킨다(packaged-smoke 가 이미 쓰는 idiom과 동일).
 *  2) skip 될 때 사유를 stdout 에 남긴다 — "돌지 않았다" 가 로그에서 보이도록.
 *
 * 어떤 스펙이 이 게이트를 쓰는지는 `e2e-ollama-gated.test.ts` 가 목록으로 고정한다.
 * 새 스펙이 조용히 이 무형 집합에 합류하는 것을 막기 위해서다.
 */
export const OLLAMA_REQUIRED = process.env.E2E_OLLAMA_REQUIRED === '1';

const BASE = 'http://localhost:11434';

function note(reason: string): void {
  console.log(`[ollama-gate] skip: ${reason}`);
}

/**
 * Ollama 가 살아 있고 필요한 모델이 설치돼 있는지 확인한다.
 * 기본 모드에서는 조건 미충족 시 skip, REQUIRED 모드에서는 throw.
 */
export async function requireOllama(modelPrefix?: string): Promise<void> {
  if (process.env.CI && !OLLAMA_REQUIRED) {
    note('CI 러너에는 Ollama 없음');
    test.skip(true, 'CI 러너에는 Ollama 없음');
    return;
  }

  const alive = await fetch(`${BASE}/api/version`).then((r) => r.ok).catch(() => false);
  if (!alive) {
    if (OLLAMA_REQUIRED) {
      throw new Error('E2E_OLLAMA_REQUIRED=1 인데 Ollama 가 응답하지 않습니다 (localhost:11434)');
    }
    note('로컬 Ollama 미실행');
    test.skip(true, '로컬 Ollama 미실행');
    return;
  }

  if (!modelPrefix) return;

  // QA22(D-LOW): /api/version 만 보면 모델 존재를 확인하지 않아, 표준 설치만 한 개발자에게는
  // 생성이 끝나지 않아 타임아웃 red 가 됐다 — 사실상 "특정 머신에서만 도는" 스펙이었다.
  const hasModel = await fetch(`${BASE}/api/tags`)
    .then((r) => r.json())
    .then((j: { models?: { name?: string }[] }) =>
      (j.models ?? []).some((m) => m.name?.startsWith(modelPrefix)))
    .catch(() => false);
  if (!hasModel) {
    if (OLLAMA_REQUIRED) {
      throw new Error(`E2E_OLLAMA_REQUIRED=1 인데 모델이 없습니다: ${modelPrefix}`);
    }
    note(`${modelPrefix} 미설치 (설정 → 모델 관리에서 설치하면 이 스펙이 활성화됩니다)`);
    test.skip(true, `${modelPrefix} 미설치 (설정 → 모델 관리에서 설치하면 이 스펙이 활성화됩니다)`);
  }
}

/**
 * 임의 문자열을 PowerShell single-quote literal 로 안전하게 래핑.
 * 규칙: 내부 `'` 를 `''` 로 두 번 escape 후 전체를 `'...'` 로 감싼다.
 *
 * 호출처 (ollama-manager.ts):
 *  - `installWindows`: `Start-Process -FilePath ${q} -Verb RunAs`
 *  - `verifyInstallerSignature`: `Get-AuthenticodeSignature -LiteralPath ${q}`
 *
 * 두 위치는 동일 규칙으로 escape 해야 한다. 이전에는 인라인으로 두 번 작성되어
 * 한쪽만 수정될 경우 escape 비대칭이 발생할 위험이 있었고, escape 로직 자체에
 * 회귀 테스트도 없었음 (R15 H1 / R28 P2 의 회귀 가드 부재 — R32 Surface 4 P3).
 *
 * 본 모듈은 electron 등 native 의존성을 전혀 import 하지 않아 vitest 의 node
 * 환경에서 직접 import 하여 단위 테스트가 가능하다 — `ollama-manager.ts` 안에
 * 두면 `electron` import 가 vitest 에서 실패한다.
 *
 * v0.18.19 patch R32 P2 신설.
 */
export function psQuotePath(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

import { describe, it, expect } from 'vitest';

// v0.18.19 patch R32 P2: ollama-manager 의 psQuotePath 회귀 가드.
// R15 H1 (PowerShell 단일 quote 미escape) / R28 P2 (-FilePath → -LiteralPath) 두 차례
// 실 사용에서 깨졌던 영역인데도 unit test 가 0건이라 다음 회귀를 잡을 게이트가 없었다.
// 테스트는 escape 규칙 자체(순수 문자열 변환) 만 검증 — PowerShell 실행은 불필요.
//
// 본 helper 는 main 프로세스의 native 의존성 (`electron`) 으로부터 격리된
// `src/main/ps-quote.ts` 모듈에서 export 된다 — `ollama-manager.ts` 가 그 헬퍼를
// 재사용하지만 그 파일 자체는 electron 을 import 하므로 vitest 의 node 환경에서
// 직접 import 가 불가하다.

import { psQuotePath } from '../../../main/ps-quote';

describe('psQuotePath (R32 P2)', () => {
  it('일반 ASCII 경로는 single-quote 로 감싼다', () => {
    expect(psQuotePath('C:\\Users\\jjw\\Downloads\\OllamaSetup.exe'))
      .toBe("'C:\\Users\\jjw\\Downloads\\OllamaSetup.exe'");
  });

  it('공백 포함 경로 — quote 만 감싸도 PowerShell 이 single token 으로 인식', () => {
    expect(psQuotePath('C:\\Users\\John Doe\\OllamaSetup.exe'))
      .toBe("'C:\\Users\\John Doe\\OllamaSetup.exe'");
  });

  it('내부 single-quote 는 두 번 (`\\\'\\\'`) 으로 escape 된다 (R15 H1 회귀 가드)', () => {
    // 예: O'Brien 같은 사용자명이 경로에 들어가는 경우
    const out = psQuotePath("C:\\Users\\O'Brien\\OllamaSetup.exe");
    expect(out).toBe("'C:\\Users\\O''Brien\\OllamaSetup.exe'");
  });

  it('연속된 single-quote 도 각각 두 번씩 escape', () => {
    const out = psQuotePath("a''b'c");
    expect(out).toBe("'a''''b''c'");
  });

  it('CJK 경로 처리 — 한글/일본어 문자 그대로 보존', () => {
    expect(psQuotePath('C:\\사용자\\다운로드\\OllamaSetup.exe'))
      .toBe("'C:\\사용자\\다운로드\\OllamaSetup.exe'");
  });

  it('대괄호/별표/물음표 wildcard 문자도 그대로 보존 (PowerShell 측 -LiteralPath 가 해석 책임)', () => {
    // R28 P2 의 동기 — 본 helper 는 문자열을 건드리지 않는다.
    // 호출자가 `-LiteralPath` 를 써서 wildcard 해석을 막아야 함.
    const out = psQuotePath('C:\\foo[bar]*\\?.exe');
    expect(out).toBe("'C:\\foo[bar]*\\?.exe'");
  });

  it('빈 경로는 빈 quote-pair 반환 (caller 책임 영역; helper 는 throw 하지 않는다)', () => {
    expect(psQuotePath('')).toBe("''");
  });

  it('백슬래시는 escape 대상이 아니다 (single-quote literal 안에서는 literal)', () => {
    // PowerShell single-quote string 안에서 `\` 는 escape 문자가 아니므로 그대로 둬도 된다.
    expect(psQuotePath('a\\b\\c')).toBe("'a\\b\\c'");
  });

  it('공백 + single-quote 조합 (가장 흔한 실 사례)', () => {
    expect(psQuotePath("C:\\Users\\John O'Brien Doe\\setup.exe"))
      .toBe("'C:\\Users\\John O''Brien Doe\\setup.exe'");
  });
});

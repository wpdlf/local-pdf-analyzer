import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VALID_SETTINGS_KEYS } from '../settings-keys';

// settings 진실 출처 4번째(= main/index.ts 의 `defaultSettings`) drift 가드 (QA11 B-LOW).
//
// settings-keys.ts 헤더는 새 키 추가 절차를 5단계로 못박아 두었지만, 기존 테스트
// (renderer/lib/__tests__/settings-keys.test.ts) 는 그중 1↔3 (renderer AppSettings /
// DEFAULT_SETTINGS ↔ VALID_SETTINGS_KEYS) 만 검증했다. 2단계(main defaultSettings)는 어떤
// 테스트도 보지 않아, `customSummaryTemplates` 추가(v0.31.21) 때 실제로 누락된 채 릴리즈됐다.
//
// main/index.ts 는 electron 을 import 하므로 vitest 에서 직접 import 할 수 없다. 그래서
// ipc-channel-contract.test.ts 와 동일하게 **소스에서 키를 추출**해 대조한다 — 손유지 목록이
// 없어 rename/추가/삭제에 자가 적응한다.

const MAIN_INDEX_SRC = readFileSync(
  resolve(import.meta.dirname, '../index.ts'),
  'utf-8',
);

/** main/index.ts 의 `const defaultSettings = { ... } as const;` 리터럴에서 top-level 키를 추출. */
function extractDefaultSettingsKeys(src: string): string[] {
  const literal = /const defaultSettings = \{([\s\S]*?)\n\} as const;/.exec(src);
  if (!literal) {
    throw new Error(
      'main/index.ts 에서 defaultSettings 리터럴을 찾지 못했습니다. ' +
      '리터럴을 옮겼거나 형태를 바꿨다면 본 테스트의 정규식을 함께 갱신하세요.',
    );
  }
  // 들여쓰기 2칸의 `key:` 만 top-level 로 인정 (중첩 객체/배열 내부 키 제외).
  return [...literal[1]!.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
}

describe('main defaultSettings — settings 키 drift 가드 (QA11)', () => {
  it('defaultSettings 리터럴을 소스에서 추출할 수 있다', () => {
    expect(extractDefaultSettingsKeys(MAIN_INDEX_SRC).length).toBeGreaterThan(0);
  });

  it('main defaultSettings 의 키 집합 == VALID_SETTINGS_KEYS (양방향)', () => {
    const mainKeys = extractDefaultSettingsKeys(MAIN_INDEX_SRC).sort();
    const validKeys = [...VALID_SETTINGS_KEYS].sort();
    expect(mainKeys).toEqual(validKeys);
  });

  it('회귀 가드: customSummaryTemplates 가 main defaultSettings 에 존재', () => {
    // v0.31.21 에서 실제로 누락됐던 키. 첫 실행 settings 에 이 키가 없으면 main 측 소비자가
    // 추가되는 순간 undefined 를 만난다.
    expect(extractDefaultSettingsKeys(MAIN_INDEX_SRC)).toContain('customSummaryTemplates');
  });

  it('추출기가 중첩 키를 top-level 로 오인하지 않는다', () => {
    const fake = [
      'const defaultSettings = {',
      "  provider: 'ollama',",
      '  nested: {',
      '    inner: 1,',
      '  },',
      '} as const;',
    ].join('\n');
    expect(extractDefaultSettingsKeys(fake)).toEqual(['provider', 'nested']);
  });
});

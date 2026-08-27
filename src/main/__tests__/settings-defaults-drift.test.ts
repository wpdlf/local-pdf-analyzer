import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripJsComments } from '../../shared/__tests__/helpers/source-scan';
import { VALID_SETTINGS_KEYS } from '../settings-keys';
import { DEFAULT_SETTINGS } from '../../renderer/types';

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

// QA29(D1-2): 주석을 걷고 스캔한다 — 주석에 남은 옛 키 목록이나 `case 'x':` 예시가
// 실제 코드인 것처럼 잡히면(또는 코드에서 사라진 키를 주석이 대신 만족시키면) 이 드리프트
// 가드가 조용히 무력화된다. 공용 헬퍼 단일 출처.
const MAIN_INDEX_SRC = stripJsComments(readFileSync(
  resolve(import.meta.dirname, '../index.ts'),
  'utf-8',
));
// QA22(C-LOW): 값 검증 switch 가 index.ts 의 settings:set 핸들러에서 settings-validate.ts 모듈로
// 이관됐다(읽기 경로 loadSettings 와 규칙 공유). 가드도 그 모듈을 본다 — **이 가드가 리팩터링을
// 실제로 잡아줬다**(옮긴 직후 case 0개로 red).
const SETTINGS_VALIDATE_SRC = stripJsComments(readFileSync(
  resolve(import.meta.dirname, '../settings-validate.ts'),
  'utf-8',
));

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

/**
 * defaultSettings 리터럴에서 top-level `key: value` 를 추출해 실제 값으로 파싱.
 *
 * QA22(백로그): 이 가드는 **키 집합만** 대조하고 값은 보지 않았다. 두 기본값이 갈라지면
 * (예: main 은 maxChunkSize 4000, renderer 는 8000) 첫 실행 사용자는 화면에 보이는 값과 실제
 * 동작하는 값이 다른 상태가 되고, 어떤 테스트도 red 가 되지 않는다. 주석("DEFAULT_SETTINGS와
 * 동기화 필요")이 유일한 방어였다.
 *
 * 지원 리터럴: 문자열('x' / "x"), 숫자, 불리언, 빈 배열([]). 그 외 형태가 생기면 throw 해서
 * 가드가 조용히 무력화되지 않게 한다(값 검증을 못 하게 된 사실 자체가 red 여야 한다).
 */
function extractDefaultSettingsValues(src: string): Record<string, unknown> {
  const literal = /const defaultSettings = \{([\s\S]*?)\n\} as const;/.exec(src);
  if (!literal) throw new Error('defaultSettings 리터럴을 찾지 못했습니다.');
  const out: Record<string, unknown> = {};
  for (const m of literal[1]!.matchAll(/^ {2}(\w+): (.+),$/gm)) {
    const [, key, raw] = m as unknown as [string, string, string];
    const text = raw.trim();
    if (/^'(.*)'$/.test(text) || /^"(.*)"$/.test(text)) out[key] = text.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(text)) out[key] = Number(text);
    else if (text === 'true' || text === 'false') out[key] = text === 'true';
    else if (text === '[]') out[key] = [];
    else throw new Error(`defaultSettings.${key} 의 값 형태(${text})를 파서가 모릅니다 — 파서를 확장하세요.`);
  }
  return out;
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

  // QA19(A-LOW): 5단계 절차 중 4단계(`settings:set` 의 switch validator)만 가드가 없었다.
  // case 를 빠뜨리면 두 drift 가드는 green 인데 `filtered` 에 키가 안 담겨 **사용자가 토글을
  // 켜고 저장해도 값이 저장되지 않는다**(패널 재진입 시 원복). 소스 스캔으로 대조한다.
  it('validateSettingValue 의 case 집합 == VALID_SETTINGS_KEYS (4단계 drift 가드)', () => {
    const block = /export function validateSettingValue\(([\s\S]*?)\n\}/.exec(SETTINGS_VALIDATE_SRC);
    expect(block, 'validateSettingValue 를 찾지 못했습니다 — 구조가 바뀌었다면 정규식을 갱신하세요').not.toBeNull();
    const cases = [...block![1]!.matchAll(/case '(\w+)':/g)].map((m) => m[1]!).sort();
    expect(cases).toEqual([...VALID_SETTINGS_KEYS].sort());
  });

  it('회귀 가드: autoCheckUpdates 가 switch validator 에 존재 (v0.31.30 신규 키)', () => {
    expect(SETTINGS_VALIDATE_SRC).toContain("case 'autoCheckUpdates':");
  });

  // QA22(C-LOW): 읽기 경로도 같은 검증기를 쓰는지 — 이 배선이 빠지면 수기 편집/손상된
  // settings.json 값이 렌더러로 그대로 유입돼 설정 화면이 크래시할 수 있다(비배열 템플릿).
  it('loadSettings 호출이 validateSettingValue 를 전달한다 (읽기 경로 검증 배선)', () => {
    expect(MAIN_INDEX_SRC).toMatch(/_loadSettings\([\s\S]{0,200}?validateSettingValue/);
  });

  // QA22(백로그): 키뿐 아니라 **값**도 대조 — 두 기본값이 갈라지면 첫 실행 사용자가 겪는
  // "UI 가 보여주는 기본값 ≠ main 이 실제로 쓰는 기본값" 을 잡는다.
  it('main defaultSettings 의 값 == renderer DEFAULT_SETTINGS 의 값 (전 키)', () => {
    const mainValues = extractDefaultSettingsValues(MAIN_INDEX_SRC);
    // renderer 쪽은 타입 단언(`'ko' as SummaryLanguage`)이 붙어 있어도 런타임 값은 동일하다 —
    // 그래서 소스 파싱(main) ↔ 실제 import(renderer) 로 비대칭 대조한다.
    expect(mainValues).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('값 파서: 지원하지 않는 리터럴 형태는 조용히 통과하지 않고 throw', () => {
    const fake = [
      'const defaultSettings = {',
      '  weird: someCall(),',
      '} as const;',
    ].join('\n');
    expect(() => extractDefaultSettingsValues(fake)).toThrow(/파서를 확장/);
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

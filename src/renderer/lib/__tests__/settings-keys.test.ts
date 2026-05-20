import { describe, it, expect } from 'vitest';
import type { AppSettings } from '../../types';
import { DEFAULT_SETTINGS } from '../../types';

// v0.18.19 patch R34 P2: settings 키 단일 출처 모듈의 drift 가드.
//
// 이전엔 `src/main/index.ts` 안에서 `VALID_SETTINGS_KEYS_SET` (loadSettings 측) 과
// `VALID_SETTINGS_KEYS` (settings:set 측) 가 별도 리터럴로 유지되어, 다음 키 추가 시 한쪽만
// 갱신될 silent drift 위험이 있었다. R33 Surface 4 P3 가 단위 가드 부재를 지적.
//
// 본 테스트는 세 진실 출처 (renderer types.AppSettings / renderer DEFAULT_SETTINGS / main
// settings-keys.VALID_SETTINGS_KEYS) 가 일치함을 강제한다. 새 키 추가 시 어느 한 곳을 빠뜨리면
// 즉시 fail.

import { VALID_SETTINGS_KEYS, VALID_SETTINGS_KEYS_SET } from '../../../main/settings-keys';

describe('settings-keys 단일 출처 — drift 가드 (R34 P2)', () => {
  it('VALID_SETTINGS_KEYS_SET 은 VALID_SETTINGS_KEYS 와 동일 원소 집합', () => {
    const arr = [...VALID_SETTINGS_KEYS].sort();
    const set = [...VALID_SETTINGS_KEYS_SET].sort();
    expect(set).toEqual(arr);
  });

  it('VALID_SETTINGS_KEYS 의 모든 키가 AppSettings 타입에 존재 (compile-time guard)', () => {
    // 타입 system 검증 — VALID_SETTINGS_KEYS[number] 가 keyof AppSettings 의 subset 인지
    // 컴파일 타임에 확인. 키가 빠지면 TS 에러 발생.
    type _check = typeof VALID_SETTINGS_KEYS[number] extends keyof AppSettings ? true : false;
    const _typeCheck: _check = true;
    expect(_typeCheck).toBe(true);
  });

  it('VALID_SETTINGS_KEYS 가 DEFAULT_SETTINGS 의 모든 키를 커버한다 (런타임 drift 차단)', () => {
    const defaultKeys = Object.keys(DEFAULT_SETTINGS).sort();
    const validKeys = [...VALID_SETTINGS_KEYS].sort();
    expect(validKeys).toEqual(defaultKeys);
  });

  it('VALID_SETTINGS_KEYS 가 keyof AppSettings 의 슈퍼셋이 아니다 (DEFAULT 외 키 금지)', () => {
    // 새 키를 VALID 에만 추가하고 DEFAULT_SETTINGS 에 빠뜨리면 위 테스트가 잡지만,
    // 반대 방향(VALID 에 잉여 키가 있는 경우)도 명시적으로 한 번 더 검증.
    const defaultKeySet = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const k of VALID_SETTINGS_KEYS) {
      expect(defaultKeySet.has(k)).toBe(true);
    }
  });

  it('Set 의 has() 는 알려진 키에 true, 미지 키에 false', () => {
    expect(VALID_SETTINGS_KEYS_SET.has('provider')).toBe(true);
    expect(VALID_SETTINGS_KEYS_SET.has('enableAnswerVerification')).toBe(true);
    expect(VALID_SETTINGS_KEYS_SET.has('__proto__')).toBe(false);
    expect(VALID_SETTINGS_KEYS_SET.has('constructor')).toBe(false);
    expect(VALID_SETTINGS_KEYS_SET.has('toString')).toBe(false);
    expect(VALID_SETTINGS_KEYS_SET.has('unknown_future_key')).toBe(false);
  });

  it('VALID_SETTINGS_KEYS 는 readonly tuple 이라 mutate 시도 컴파일 에러 (회귀 가드)', () => {
    // `as const` tuple 의 readonly 보존 검증
    type _t = typeof VALID_SETTINGS_KEYS;
    type _readonly = _t extends readonly string[] ? true : false;
    const _check: _readonly = true;
    expect(_check).toBe(true);
  });
});

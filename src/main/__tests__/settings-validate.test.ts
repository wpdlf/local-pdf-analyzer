/**
 * QA25(B-Important): settings-validate 의 직접 회귀 넷.
 *
 * 이 모듈은 **쓰기(settings:set)와 읽기(loadSettings)가 공유하는 단일 출처**인데, 정작 이
 * 함수를 직접 구동하는 테스트가 없었다:
 *  - 쓰기 경로는 ipc-handlers.test 가 provider/theme/maxChunkSize/미지 키만 돌린다.
 *  - 읽기 경로는 settings-store.test 가 `loadSettings(path, DEFAULTS, VALID_KEYS)` 로
 *    **4번째 인자(validator)를 아예 넘기지 않아** 실검증이 실행되지 않는다.
 * 그 결과 customSummaryTemplates 분기 24줄이 한 번도 실행되지 않았고, 모듈 주석이 스스로
 * 위협으로 명시한 "비배열 → SummaryTypeSelector 의 .filter TypeError → 설정 화면 크래시" 가
 * 무방비였다. drift 가드(settings-defaults-drift)는 case **라벨 집합**만 정규식으로 보므로
 * 분기 안의 규칙이 통째로 사라져도 잡지 못한다.
 */

import { describe, it, expect } from 'vitest';
import { validateSettingValue } from '../settings-validate';
import { MAX_TEMPLATE_ID_LEN } from '../../shared/constants';

const ok = (key: string, val: unknown) => validateSettingValue(key, val);

describe('validateSettingValue — 열거형/스칼라', () => {
  it.each([
    ['provider', 'ollama', true],
    ['provider', 'gemini', true],
    ['provider', 'grok', false],
    ['theme', 'system', true],
    ['theme', 'neon', false],
    ['uiLanguage', 'ko', true],
    ['uiLanguage', 'ja', false], // UI 는 아직 ko/en 만 — 요약 언어와 다르다
    ['summaryLanguage', 'ja', true],
    ['summaryLanguage', 'de', false],
    ['defaultSummaryType', 'keywords', true],
    ['defaultSummaryType', 'custom', false],
  ])('%s = %p → ok=%s', (key, val, expected) => {
    expect(ok(key as string, val).ok).toBe(expected);
  });

  it.each([
    ['maxChunkSize', 4000, true],
    ['maxChunkSize', 1500.5, false], // float 금지
    ['maxChunkSize', 999, false],
    ['maxChunkSize', 16001, false],
    ['maxChunkSize', '4000', false], // 문자열이 통과하면 Math.floor(NaN) 으로 예산 비교가 무력화된다
  ])('%s = %p → ok=%s', (key, val, expected) => {
    expect(ok(key as string, val).ok).toBe(expected);
  });

  it.each(['enableImageAnalysis', 'enableOcrFallback', 'persistSessions', 'autoCheckUpdates'])(
    '%s 는 boolean 만 받는다',
    (key) => {
      expect(ok(key, true).ok).toBe(true);
      expect(ok(key, 'true').ok).toBe(false);
      expect(ok(key, 1).ok).toBe(false);
    },
  );

  it('model 은 빈 문자열/과대 길이를 거부한다', () => {
    expect(ok('model', 'qwen3.5:4b').ok).toBe(true);
    expect(ok('model', '').ok).toBe(false);
    expect(ok('model', 'x'.repeat(101)).ok).toBe(false);
  });

  it('알 수 없는 키는 거부한다', () => {
    expect(ok('__proto__', {}).ok).toBe(false);
    expect(ok('nonexistent', 1).ok).toBe(false);
  });
});

describe('validateSettingValue — customSummaryTemplates (한 번도 실행되지 않던 분기)', () => {
  const tpl = (over: Record<string, unknown> = {}) => ({
    id: 'tpl-1',
    name: '요약 템플릿',
    prompt: '다음 문서를 요약하라.',
    ...over,
  });

  it('비배열은 거부한다 (설정 화면 렌더 크래시 방어선)', () => {
    // 이 방어가 사라지면 SummaryTypeSelector 의 .filter 가 TypeError 를 던져 화면이 통째로 죽는다.
    for (const bad of ['x', 42, null, {}, true]) {
      expect(ok('customSummaryTemplates', bad).ok).toBe(false);
    }
  });

  it('빈 배열은 유효하다', () => {
    const r = ok('customSummaryTemplates', []);
    expect(r.ok).toBe(true);
    expect((r as { value: unknown[] }).value).toEqual([]);
  });

  it('형태가 깨진 항목만 버리고 유효 항목은 남긴다', () => {
    const r = ok('customSummaryTemplates', [
      tpl(),
      null,
      'string-item',
      tpl({ id: '' }), // 빈 id
      tpl({ name: '   ' }), // 공백뿐인 이름
      tpl({ prompt: '' }), // 빈 프롬프트
      tpl({ id: 'tpl-2' }),
    ]);
    expect(r.ok).toBe(true);
    const value = (r as { value: { id: string }[] }).value;
    expect(value.map((v) => v.id)).toEqual(['tpl-1', 'tpl-2']);
  });

  it('개수 상한 20 으로 절단한다 (과대 페이로드 방어)', () => {
    const many = Array.from({ length: 50 }, (_, i) => tpl({ id: `t-${i}` }));
    const r = ok('customSummaryTemplates', many);
    expect((r as { value: unknown[] }).value).toHaveLength(20);
  });

  it('name/prompt 길이를 절단한다', () => {
    // id 는 절단이 아니라 **필터에서 탈락**한다(아래 테스트) — 그래서 여기서는 유효한 id 를 쓴다.
    const r = ok('customSummaryTemplates', [
      tpl({ id: 'i'.repeat(MAX_TEMPLATE_ID_LEN), name: 'n'.repeat(200), prompt: 'p'.repeat(9000) }),
    ]);
    const v = (r as { value: { id: string; name: string; prompt: string }[] }).value[0]!;
    expect(v.id.length).toBe(MAX_TEMPLATE_ID_LEN);
    expect(v.name.length).toBe(60);
    expect(v.prompt.length).toBe(4000);
  });

  it('id 가 상한을 넘는 항목은 애초에 버린다 (세션 요약 키 상한과 정합)', () => {
    // 절단이 아니라 필터에서 걸러지는 것이 계약이다 — `custom:<id>` 세션 키가 여기서 파생된다.
    const r = ok('customSummaryTemplates', [tpl({ id: 'x'.repeat(MAX_TEMPLATE_ID_LEN + 1) })]);
    expect((r as { value: unknown[] }).value).toHaveLength(0);
  });

  it('strategy 는 chunked 만 유효하고 나머지는 single 로 정규화한다', () => {
    const r = ok('customSummaryTemplates', [
      tpl({ id: 'a', strategy: 'chunked' }),
      tpl({ id: 'b', strategy: 'bogus' }),
      tpl({ id: 'c' }), // 미지정
    ]);
    const v = (r as { value: { id: string; strategy: string }[] }).value;
    expect(v.map((x) => x.strategy)).toEqual(['chunked', 'single', 'single']);
  });

  it('정규화 결과에 원본의 여분 필드가 섞이지 않는다 (프로토타입 오염/과대 페이로드 차단)', () => {
    const r = ok('customSummaryTemplates', [tpl({ evil: 'payload', __proto__: { polluted: true } })]);
    const v = (r as { value: Record<string, unknown>[] }).value[0]!;
    expect(Object.keys(v).sort()).toEqual(['id', 'name', 'prompt', 'strategy']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

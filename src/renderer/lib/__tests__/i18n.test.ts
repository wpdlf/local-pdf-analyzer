import { describe, it, expect, vi, beforeEach } from 'vitest';

// v0.18.5 T2 — `_translations` 가 export 되어 런타임 parity 검증이 가능해졌다.
// 이전에는 소스 파일을 regex 로 파싱해 "ko:"/"en:" 존재 여부만 확인했기 때문에
// `en: ''` 같은 빈 번역도 합격하는 갭이 있었다. 런타임 검증은 trim() 기반이라 강력.
//
// t() 런타임 테스트용 stub — store 와 electronAPI 는 t() 경로에서만 필요.
vi.stubGlobal('window', {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
});
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
vi.stubGlobal('crypto', { randomUUID: () => 'uuid' });

// v0.18.5 T2 — 런타임 parity 는 `_translations` export 를 직접 읽어 "빈 문자열 / 공백만"
// 도 누락으로 간주한다. 소스 파싱 기반 체크는 `hasKo`/`hasEn` 정규식만 확인하므로
// `en: ''` 같은 번역 누락 회귀를 잡지 못했다 (Round 22 T2 지적).
describe('i18n key parity (ko/en) · 런타임 검증 (주)', () => {
  it('_translations export 가 작동한다 (최소 30 키)', async () => {
    const { _translations } = await import('../i18n');
    const keys = Object.keys(_translations);
    expect(keys.length).toBeGreaterThanOrEqual(30);
  });

  it('모든 엔트리의 ko 값이 공백 외 문자를 포함한다', async () => {
    const { _translations } = await import('../i18n');
    const empty: string[] = [];
    for (const [key, entry] of Object.entries(_translations) as Array<[string, { ko: string; en: string }]>) {
      if (!entry.ko || entry.ko.trim() === '') empty.push(key);
    }
    expect(empty, `ko 값이 빈/공백: ${empty.join(', ')}`).toEqual([]);
  });

  it('모든 엔트리의 en 값이 공백 외 문자를 포함한다', async () => {
    const { _translations } = await import('../i18n');
    const empty: string[] = [];
    for (const [key, entry] of Object.entries(_translations) as Array<[string, { ko: string; en: string }]>) {
      if (!entry.en || entry.en.trim() === '') empty.push(key);
    }
    expect(empty, `en 값이 빈/공백: ${empty.join(', ')}`).toEqual([]);
  });

  it('엔트리 구조는 항상 { ko, en } — 추가 언어 필드가 실수로 들어가지 않음', async () => {
    const { _translations } = await import('../i18n');
    const malformed: string[] = [];
    for (const [key, entry] of Object.entries(_translations) as Array<[string, Record<string, string>]>) {
      const fieldKeys = Object.keys(entry).sort();
      if (fieldKeys.length !== 2 || fieldKeys[0] !== 'en' || fieldKeys[1] !== 'ko') {
        malformed.push(`${key}:{${fieldKeys.join(',')}}`);
      }
    }
    expect(malformed, `잘못된 구조: ${malformed.join(', ')}`).toEqual([]);
  });

  it('보간 placeholder (`{name}`) 를 한 쪽만 가지는 비대칭 엔트리가 없다', async () => {
    const { _translations } = await import('../i18n');
    const mismatched: string[] = [];
    for (const [key, entry] of Object.entries(_translations) as Array<[string, { ko: string; en: string }]>) {
      const koParams = Array.from(entry.ko.matchAll(/\{(\w+)\}/g)).map((m) => m[1]).sort();
      const enParams = Array.from(entry.en.matchAll(/\{(\w+)\}/g)).map((m) => m[1]).sort();
      if (koParams.join(',') !== enParams.join(',')) {
        mismatched.push(`${key}: ko[${koParams}] vs en[${enParams}]`);
      }
    }
    expect(mismatched, `보간 비대칭: ${mismatched.join(' | ')}`).toEqual([]);
  });
});

// ─── 런타임 t() 동작 ───

describe('t() 런타임 동작', () => {
  beforeEach(async () => {
    // 모듈 캐시 리셋 없이도 상태만 초기화하면 됨 — store 는 모듈 싱글톤.
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' } }));
  });

  it('ko 언어에서 ko 번역 반환', async () => {
    const { t } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' } }));
    const out = t('pdfviewer.pageOf', { current: 1, total: 10 });
    expect(out).toBe('1 / 10 페이지');
  });

  it('en 언어에서 en 번역 반환', async () => {
    const { t } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'en' } }));
    const out = t('pdfviewer.pageOf', { current: 1, total: 10 });
    expect(out).toBe('Page 1 of 10');
  });

  it('보간 파라미터 누락 시 {name} 리터럴 반환 (silent 회귀 방지)', async () => {
    const { t } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' } }));
    // model 파라미터 누락 — 빈 params 전달
    const out = t('app.downloadingModel' as never, {} as never);
    expect(out).toContain('{model}');
  });

  it('알 수 없는 키는 키 문자열 자체를 반환 (런타임 방어)', async () => {
    const { t } = await import('../i18n');
    // TS 가 막지만 런타임 가드를 테스트하기 위해 cast.
    const out = (t as (k: string) => string)('__does_not_exist__');
    expect(out).toBe('__does_not_exist__');
  });

  it('숫자 파라미터도 String 변환되어 보간된다', async () => {
    const { t } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'en' } }));
    const out = t('pdfviewer.pageOf', { current: 42, total: 100 });
    expect(out).toBe('Page 42 of 100');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

// R44(R43 후속 F3/F8): main 구조화 메시지 번역 헬퍼 + 키 동기화 가드
describe('translateMainProgress / translateMainError', () => {
  it('main 이 방출하는 진행/에러 키 전수가 i18n 에 정의돼 있다 (R44: 소스 정적 스캔 drift 가드)', async () => {
    // R44 F3: 이전의 하드코딩 키 목록은 main 에 새 키가 추가되는 방향의 drift 를 못 잡았다.
    // preload-shape 와 동일하게 main 소스를 정적으로 읽어 방출 집합을 추출, 양방향 가드.
    const { _translations } = await import('../i18n');
    const managerSrc = readFileSync(resolve(import.meta.dirname, '../../../main/ollama-manager.ts'), 'utf-8');
    const progressSrc = readFileSync(resolve(import.meta.dirname, '../../../main/ollama-pull-progress.ts'), 'utf-8');

    const progKeys = new Set<string>();
    for (const m of managerSrc.matchAll(/sendProgress\(\{\s*key:\s*'([A-Za-z]+)'/g)) progKeys.add(m[1]!);
    for (const m of progressSrc.matchAll(/return\s*\{\s*key:\s*'([A-Za-z]+)'/g)) progKeys.add(m[1]!);
    progKeys.delete('raw'); // translateMainProgress 가 원문 passthrough 로 특수 처리
    expect(progKeys.size, '추출 실패 의심 — 정규식/소스 구조 확인').toBeGreaterThanOrEqual(12);
    for (const k of progKeys) {
      expect(_translations[`mainprog.${k}` as keyof typeof _translations], `mainprog.${k} 미정의`).toBeTruthy();
    }

    const errKeys = new Set<string>();
    for (const m of managerSrc.matchAll(/errorKey:\s*'([A-Za-z]+)'/g)) errKeys.add(m[1]!);
    expect(errKeys.size, '추출 실패 의심').toBeGreaterThanOrEqual(4); // pullInProgress/Timeout/Failed/Cancelled
    for (const k of errKeys) {
      expect(_translations[`mainerr.${k}` as keyof typeof _translations], `mainerr.${k} 미정의`).toBeTruthy();
    }
  });

  it('이벤트를 현재 언어로 번역하고 params 를 치환한다', async () => {
    const { translateMainProgress } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'en' as const } }));
    expect(translateMainProgress({ key: 'pulling', params: { percent: '42%' } })).toBe('Downloading model... 42%');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' as const } }));
    expect(translateMainProgress({ key: 'pulling', params: { percent: '42%' } })).toBe('모델 다운로드 중... 42%');
  });

  it('raw 이벤트는 원문 passthrough, 비정상 입력은 빈 문자열', async () => {
    const { translateMainProgress } = await import('../i18n');
    expect(translateMainProgress({ key: 'raw', params: { text: 'Error: x' } })).toBe('Error: x');
    expect(translateMainProgress(undefined as never)).toBe('');
  });

  it('translateMainError — errorKey 우선, 없으면 error 원문, 둘 다 없으면 fallback', async () => {
    const { translateMainError } = await import('../i18n');
    const { useAppStore } = await import('../store');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'en' as const } }));
    expect(translateMainError({ error: '한국어 원문', errorKey: 'pullInProgress' }, 'fb'))
      .toBe('Another model download is already in progress. Please try again after it finishes.');
    expect(translateMainError({ errorKey: 'pullFailed', errorParams: { detail: 'exit code: 1' } }, 'fb'))
      .toBe('Model download failed: exit code: 1');
    expect(translateMainError({ error: 'raw error' }, 'fb')).toBe('raw error');
    expect(translateMainError({}, 'fb')).toBe('fb');
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' as const } }));
  });
});

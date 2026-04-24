import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// i18n.ts 의 `translations` 상수는 비공개(non-exported) 이므로 소스 파일을 직접 파싱해
// key parity(모든 엔트리가 ko/en 동시 존재) 를 검증한다. 이렇게 해야 새 키 추가 시
// 한쪽 언어를 누락하면 CI 에서 즉시 실패.
//
// t() 함수 단위 동작(store 의존, 보간, 누락 키 fallback) 은 별도 블록에서 런타임 테스트.

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_SRC = resolve(__dirname, '../i18n.ts');
const src = readFileSync(I18N_SRC, 'utf-8');

/**
 * translations 객체 본문(`const translations = { ... } as const;`) 을 추출.
 * 단순 문자열 매칭으로도 충분 — 중첩 객체가 한 단계뿐이라 `as const;` 종결부만 찾으면 된다.
 */
function extractTranslationsBody(): string {
  const startMarker = 'const translations = {';
  const endMarker = '} as const;';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  expect(startIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(startIdx);
  return src.slice(startIdx + startMarker.length, endIdx);
}

/**
 * 각 엔트리에서 key 와 ko/en 존재 여부를 추출. 문자열 리터럴 안에 있는 `{` 는 정규식으로
 * 신뢰할 수 없으므로, 키 라인만 찾고 해당 라인 이후 다음 키 전까지의 블록에서 ko/en 유무 확인.
 */
function parseEntries(): Array<{ key: string; hasKo: boolean; hasEn: boolean; rawBlock: string }> {
  const body = extractTranslationsBody();
  // 키는 `'...':` 혹은 `"...":` 패턴. 정의 라인의 위치만 우선 잡는다.
  const keyRegex = /(^|\n)\s*['"]([^'"\n]+)['"]\s*:/g;
  const matches: Array<{ index: number; key: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(body)) !== null) {
    matches.push({ index: m.index + (m[1]?.length ?? 0), key: m[2] });
  }

  // key 는 top-level(외부 객체) 와 ko/en(내부 객체) 양쪽에서 잡히므로 필터링 필요.
  // top-level 키는 value 위치에 `{` 가 오고, 그 {} 블록 안에 `ko:` 와 `en:` 이 있다.
  // 아래에서 각 match 의 다음 `{`→짝 `}` 블록을 뜯어 내부 키가 `ko`/`en` 여부만 체크.
  const entries: Array<{ key: string; hasKo: boolean; hasEn: boolean; rawBlock: string }> = [];
  for (const { index, key } of matches) {
    if (key === 'ko' || key === 'en') continue; // 내부 키 스킵
    const afterColon = body.slice(index);
    const bracePos = afterColon.indexOf('{');
    if (bracePos < 0) continue;
    // 괄호 짝 맞추기 (문자열 리터럴은 동일 라인에서 끝나므로 단순 카운터로 충분)
    let depth = 0;
    let endPos = -1;
    for (let i = bracePos; i < afterColon.length; i++) {
      const ch = afterColon[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endPos = i; break; }
      }
    }
    if (endPos < 0) continue;
    const block = afterColon.slice(bracePos, endPos + 1);
    const hasKo = /(^|[^a-zA-Z_$])ko\s*:/.test(block);
    const hasEn = /(^|[^a-zA-Z_$])en\s*:/.test(block);
    entries.push({ key, hasKo, hasEn, rawBlock: block });
  }
  return entries;
}

describe('i18n key parity (ko/en)', () => {
  it('translations 블록을 성공적으로 파싱한다', () => {
    const entries = parseEntries();
    expect(entries.length).toBeGreaterThan(20);
  });

  it('모든 엔트리는 ko 번역을 가진다', () => {
    const missing = parseEntries().filter((e) => !e.hasKo).map((e) => e.key);
    expect(missing, `ko 누락 키: ${missing.join(', ')}`).toEqual([]);
  });

  it('모든 엔트리는 en 번역을 가진다', () => {
    const missing = parseEntries().filter((e) => !e.hasEn).map((e) => e.key);
    expect(missing, `en 누락 키: ${missing.join(', ')}`).toEqual([]);
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

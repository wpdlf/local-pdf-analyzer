import { describe, it, expect, vi, beforeEach } from 'vitest';

// v0.18.19 patch R32 P2: applyTheme 의 persist 옵션 회귀 가드.
// SettingsPanel 의 라이브 preview 가 X 버튼 종료 시 dirty 값을 localStorage 에 남겨
// settings.json 과 drift 가 발생하던 결함 (R32 Surface 3 P3) 의 reproducer.

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
// applyTheme 가 document.documentElement.classList 와 matchMedia 를 건드린다.
// 노드 환경에선 둘 다 없으니 최소 stub 만 제공.
vi.stubGlobal('document', {
  documentElement: {
    classList: {
      _set: new Set<string>(),
      add(c: string) { this._set.add(c); },
      remove(c: string) { this._set.delete(c); },
      toggle(c: string, on: boolean) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c: string) { return this._set.has(c); },
    },
  },
});
vi.stubGlobal('window', {
  matchMedia: (_q: string) => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

import { applyTheme } from '../theme';

function clearLs(): void {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

describe('applyTheme persist (R32 P2)', () => {
  beforeEach(() => clearLs());

  it('기본값(persist 미지정) 은 localStorage 에 theme 을 저장한다 — App.tsx 본 저장 경로', () => {
    applyTheme('dark');
    expect(lsStore['theme']).toBe('dark');
  });

  it('persist=true 명시도 동일하게 저장', () => {
    applyTheme('light', { persist: true });
    expect(lsStore['theme']).toBe('light');
  });

  it('persist=false 는 localStorage 를 건드리지 않는다 — SettingsPanel preview', () => {
    // 사전에 다른 값이 있다고 시뮬레이션
    lsStore['theme'] = 'light';
    applyTheme('dark', { persist: false });
    // preview 호출이 'dark' 로 미리보기는 했지만, localStorage 는 그대로 'light' 유지
    expect(lsStore['theme']).toBe('light');
  });

  it('persist=false 인 호출 여러 번 후에도 localStorage 는 처음 값 유지 (drift 가드)', () => {
    lsStore['theme'] = 'system';
    applyTheme('dark', { persist: false });
    applyTheme('light', { persist: false });
    applyTheme('system', { persist: false });
    expect(lsStore['theme']).toBe('system');
  });

  it('cleanup 함수는 모든 분기에서 반환된다', () => {
    expect(typeof applyTheme('dark')).toBe('function');
    expect(typeof applyTheme('light')).toBe('function');
    expect(typeof applyTheme('system')).toBe('function');
    expect(typeof applyTheme('dark', { persist: false })).toBe('function');
  });

  it('dark 적용 시 root.classList.dark 가 추가된다', () => {
    type CL = { contains: (c: string) => boolean };
    const cl = (document.documentElement as unknown as { classList: CL }).classList;
    applyTheme('dark');
    expect(cl.contains('dark')).toBe(true);
  });

  it('light 적용 시 root.classList.dark 가 제거된다', () => {
    type CL = { contains: (c: string) => boolean };
    const cl = (document.documentElement as unknown as { classList: CL }).classList;
    applyTheme('dark');
    applyTheme('light');
    expect(cl.contains('dark')).toBe(false);
  });
});

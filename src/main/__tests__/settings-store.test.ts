import { describe, it, expect, vi, beforeEach } from 'vitest';

// v0.18.22 Top5 #3 (test coverage): loadSettings / saveSettings 단위 테스트.
// 원래 src/main/index.ts 내부 함수였으나 electron 모듈 의존으로 vitest 에서 import 불가였다.
// 본 라운드에서 `src/main/settings-store.ts` 로 순수 파일 I/O 모듈을 분리 (Top5 #3),
// fs/promises 를 모킹하여 다음 동작을 검증한다:
//   - load: ENOENT → defaults, 손상 JSON → defaults, 키 화이트리스트 필터링
//   - save: .tmp + rename 원자적 교체, 중간 실패 시 .tmp 정리

import { loadSettings, saveSettings } from '../settings-store';

const TEST_PATH = '/tmp/test-settings.json';
const DEFAULTS = { provider: 'ollama', model: 'gemma3', theme: 'system' } as const;
const VALID_KEYS = new Set(['provider', 'model', 'theme', 'maxChunkSize']);

// fs/promises 의 모킹된 핸들. 각 테스트가 동작을 재구성한다.
// Vitest 4 의 vi.fn() 기본 반환형이 Procedure | Constructable union 이라 직접 spread-call
// 불가 — 명시 함수 시그니처로 좁혀준다.
const mocks = {
  readFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  rename: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  unlink: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
  },
}));

beforeEach(() => {
  mocks.readFile.mockReset();
  mocks.writeFile.mockReset();
  mocks.rename.mockReset();
  mocks.unlink.mockReset();
});

describe('loadSettings (Top5 #3)', () => {
  it('파일이 없으면(ENOENT) defaults 만 반환 + console.error 미호출', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mocks.readFile.mockRejectedValue(enoent);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result).toEqual(DEFAULTS);
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('손상된 JSON 은 defaults 로 안전 fallback + console.error 호출 (가시성)', async () => {
    mocks.readFile.mockResolvedValue('{ not valid json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result).toEqual(DEFAULTS);
    expect(errSpy).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it('정상 JSON 중 허용 키만 통과 (임의 속성 주입 차단)', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      provider: 'claude',
      model: 'claude-sonnet-4',
      arbitrary: 'injected',
      __proto__: { polluted: true },
      maxChunkSize: 8000,
    }));

    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result['provider']).toBe('claude');
    expect(result['model']).toBe('claude-sonnet-4');
    expect(result['maxChunkSize']).toBe(8000);
    // 허용되지 않은 키는 통과하지 않아야 한다
    expect(result).not.toHaveProperty('arbitrary');
    expect(result).not.toHaveProperty('polluted');
    // theme 는 파일에 없으나 defaults 에서 보존
    expect(result['theme']).toBe('system');
  });

  it('빈 JSON 객체 → defaults 전부 유지', async () => {
    mocks.readFile.mockResolvedValue('{}');
    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result).toEqual(DEFAULTS);
  });

  it('권한 오류(EACCES) 등 ENOENT 이외도 defaults fallback + 로그', async () => {
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mocks.readFile.mockRejectedValue(eacces);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result).toEqual(DEFAULTS);
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('VALID_KEYS 변경 시 즉시 새 키가 통과 (단일 출처화 검증)', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ newKey: 'v', theme: 'dark' }));
    const expanded = new Set(['provider', 'model', 'theme', 'newKey']);
    const result = await loadSettings(TEST_PATH, DEFAULTS, expanded);
    expect(result['newKey']).toBe('v');
    expect(result['theme']).toBe('dark');
  });
});

describe('saveSettings (Top5 #3)', () => {
  it('.tmp 에 먼저 write 한 뒤 rename 으로 원자적 교체 (write→rename 순서)', async () => {
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);

    await saveSettings(TEST_PATH, { provider: 'openai' });

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      TEST_PATH + '.tmp',
      JSON.stringify({ provider: 'openai' }, null, 2),
      'utf-8',
    );
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.rename).toHaveBeenCalledWith(TEST_PATH + '.tmp', TEST_PATH);
    expect(mocks.unlink).not.toHaveBeenCalled();

    // write 가 rename 보다 먼저 호출되어야 함 (호출 순서 invariant)
    const writeOrder = mocks.writeFile.mock.invocationCallOrder[0]!;
    const renameOrder = mocks.rename.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it('writeFile 실패 시 .tmp 정리 시도 후 throw', async () => {
    const writeErr = new Error('disk full');
    mocks.writeFile.mockRejectedValue(writeErr);
    mocks.unlink.mockResolvedValue(undefined);

    await expect(saveSettings(TEST_PATH, { provider: 'x' })).rejects.toThrow('disk full');
    expect(mocks.unlink).toHaveBeenCalledWith(TEST_PATH + '.tmp');
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it('rename 실패 시에도 .tmp 정리 시도 후 throw', async () => {
    mocks.writeFile.mockResolvedValue(undefined);
    const renameErr = new Error('cross-device link');
    mocks.rename.mockRejectedValue(renameErr);
    mocks.unlink.mockResolvedValue(undefined);

    await expect(saveSettings(TEST_PATH, { provider: 'x' })).rejects.toThrow('cross-device link');
    expect(mocks.unlink).toHaveBeenCalledWith(TEST_PATH + '.tmp');
  });

  it('unlink 자체가 실패해도 원래 에러를 정확히 throw (.tmp 가 이미 없어도 안전)', async () => {
    mocks.writeFile.mockRejectedValue(new Error('original'));
    mocks.unlink.mockRejectedValue(new Error('unlink failed'));

    await expect(saveSettings(TEST_PATH, { x: 1 })).rejects.toThrow('original');
  });

  it('JSON.stringify 가 2칸 들여쓰기로 직렬화 (사용자가 settings.json 을 손으로 검사 가능)', async () => {
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    await saveSettings(TEST_PATH, { a: 1, b: { c: 2 } });
    const written = mocks.writeFile.mock.calls[0]![1] as string;
    expect(written).toContain('\n  "a"');
    expect(written).toContain('\n  "b"');
    expect(written).toContain('\n    "c"');
  });
});

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

  // QA24(C-H1): 종전 이 테스트는 "EACCES 도 defaults fallback" 을 **정답으로 못박고** 있었다.
  // 그 동작이 곧 결함이다 — defaults 가 렌더러로 흘러가면 사용자가 무엇이든 하나 바꾸는 순간
  // 전량 페이로드가 디스크를 덮어써 저장된 설정(커스텀 요약 템플릿 = 유일 사본)이 소실된다.
  // 형제 3종(session/collections/api-keys)과 동일하게 "부재/손상 ≠ 일시 I/O 오류" 로 바꾼다.
  it.each([
    ['EACCES', '권한'],
    ['EBUSY', '잠금'],
    ['EPERM', '권한'],
    ['EMFILE', 'fd 고갈'],
  ])('일시 I/O 오류(%s, %s)는 삼키지 않고 throw — defaults 로 흡수하면 덮어쓰기로 이어진다', async (code) => {
    const err: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
    mocks.readFile.mockRejectedValue(err);

    await expect(loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS)).rejects.toThrow(code);
  });

  it('부재(ENOENT)는 종전대로 defaults — 최초 실행은 정상 경로다', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mocks.readFile.mockRejectedValue(enoent);

    const result = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS);
    expect(result).toEqual(DEFAULTS);
  });

  it('손상 JSON 은 종전대로 defaults + 로그 — code 가 없으므로 일시 오류와 구분된다', async () => {
    mocks.readFile.mockResolvedValue('{ 이건 JSON 이 아니다');
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

/**
 * QA30(C-10): `onRawKeys` — 파싱된 **원본 파일의 키 목록**을 호출자에게 알린다.
 *
 * index.ts 의 레거시 가드(v0.16 이전 파일 = uiLanguage 는 있고 summaryLanguage 는 없음)가 merge
 * 결과로 키 출처를 알 수 없어 **같은 파일을 한 번 더 읽던 것**을 없애기 위한 계약이다. 여기서는
 * "언제 호출되고 언제 호출되지 않는가" 를 못박는다 — 부재/손상/일시 I/O 오류에서 호출되면
 * 호출자가 "파일에 그 키가 없었다" 로 오판해 잘못된 보정을 한다.
 */
describe('QA30(C-10): loadSettings 의 onRawKeys (키 출처 통지)', () => {
  it('파일을 읽었으면 화이트리스트 필터 **이전**의 원본 키 목록을 준다', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ provider: 'claude', unknownKey: 1, theme: 'dark' }));
    const seen: string[][] = [];
    const out = await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS, undefined, (keys) => seen.push(keys));
    expect(seen).toHaveLength(1);
    // 미지 키도 포함된다 — "파일에 무엇이 있었는가" 가 질문이기 때문이다.
    expect(seen[0]).toEqual(['provider', 'unknownKey', 'theme']);
    // 반환값은 종전대로 화이트리스트만 통과한다(회귀 방지).
    expect(out).toEqual({ ...DEFAULTS, provider: 'claude', theme: 'dark' });
    // 재독이 없다 — 읽기는 정확히 1회.
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['부재(ENOENT)', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })],
  ])('%s 면 호출되지 않는다 (호출자는 판단 불가로 처리)', async (_l, err) => {
    mocks.readFile.mockRejectedValue(err);
    const seen: string[][] = [];
    await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS, undefined, (keys) => seen.push(keys));
    expect(seen).toHaveLength(0);
  });

  it('손상 JSON 이면 호출되지 않는다', async () => {
    mocks.readFile.mockResolvedValue('{깨진');
    const seen: string[][] = [];
    await loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS, undefined, (keys) => seen.push(keys));
    expect(seen).toHaveLength(0);
  });

  it('일시 I/O 오류(EBUSY)는 종전대로 throw 하고 호출되지 않는다', async () => {
    mocks.readFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const seen: string[][] = [];
    await expect(loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS, undefined, (keys) => seen.push(keys)))
      .rejects.toMatchObject({ code: 'EBUSY' });
    expect(seen).toHaveLength(0);
  });

  it('미전달이어도 동작은 동일하다(선택 인자)', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ provider: 'openai' }));
    await expect(loadSettings(TEST_PATH, DEFAULTS, VALID_KEYS)).resolves.toMatchObject({ provider: 'openai' });
  });
});

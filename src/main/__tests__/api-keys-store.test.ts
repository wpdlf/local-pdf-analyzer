import { describe, it, expect, vi, beforeEach } from 'vitest';

// R38 P1-2 (test coverage): API 키 암호화 저장소 행위 검증.
//
// 원래 src/main/index.ts 내부 함수(readApiKeys/writeApiKeys/saveApiKey/...)였으나 electron
// safeStorage 의존으로 vitest 에서 직접 import 불가였다. 본 라운드에서 ApiKeyStore 클래스로
// 분리(safeStorage 주입)하여 다음 보안 로직을 fs 모킹 + fake crypto 로 검증한다:
//   - prototype pollution 가드 (__proto__/미지 provider/비-string 폐기, null-proto 캐시)
//   - 원자적 쓰기(.tmp → rename), 실패 시 .tmp 정리 + 캐시 무효화
//   - safeStorage 불가 시 KEYCHAIN_UNAVAILABLE throw (silent fail 금지)
//   - 캐시 hit/invalidate (hot path O(1))

import { ApiKeyStore, KNOWN_API_KEY_PROVIDERS, type SafeStorageLike } from '../api-keys-store';

const PATH = '/tmp/api-keys.enc';

const mocks = {
  readFileSync: vi.fn<(...args: unknown[]) => unknown>(),
  writeFileSync: vi.fn<(...args: unknown[]) => unknown>(),
  renameSync: vi.fn<(...args: unknown[]) => unknown>(),
  unlinkSync: vi.fn<(...args: unknown[]) => unknown>(),
};

vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: unknown[]) => mocks.readFileSync(...args),
    writeFileSync: (...args: unknown[]) => mocks.writeFileSync(...args),
    renameSync: (...args: unknown[]) => mocks.renameSync(...args),
    unlinkSync: (...args: unknown[]) => mocks.unlinkSync(...args),
  },
}));

/** 가짜 safeStorage — `enc:` prefix 로 암복호화를 시뮬레이션. */
function makeCrypto(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^enc:/, ''),
  };
}

/** 디스크에 저장된 것처럼 암호화 버퍼를 만든다. */
function storedBuffer(obj: unknown): Buffer {
  return Buffer.from('enc:' + JSON.stringify(obj), 'utf-8');
}

beforeEach(() => {
  mocks.readFileSync.mockReset();
  mocks.writeFileSync.mockReset();
  mocks.renameSync.mockReset();
  mocks.unlinkSync.mockReset();
});

describe('상수', () => {
  it('KNOWN_API_KEY_PROVIDERS 는 ollama/claude/openai/gemini', () => {
    expect([...KNOWN_API_KEY_PROVIDERS]).toEqual(['ollama', 'claude', 'openai', 'gemini']);
  });
});

describe('read', () => {
  it('암호화 불가 시 빈 키셋 (파일 접근 안 함)', () => {
    const store = new ApiKeyStore(PATH, makeCrypto(false));
    const result = store.read();
    expect(result).toEqual({});
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it('파일 미존재(throw) → 빈 키셋으로 안전 fallback', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(store.read()).toEqual({});
  });

  it('손상된 JSON → 빈 키셋', () => {
    mocks.readFileSync.mockReturnValue(Buffer.from('enc:{ not json', 'utf-8'));
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(store.read()).toEqual({});
  });

  it('정상 저장값 중 알려진 provider 만 추출', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c', openai: 'sk-o', ollama: 'x' }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(store.read()).toEqual({ claude: 'sk-c', openai: 'sk-o', ollama: 'x' });
  });

  it('미지 provider / 비-string 값은 폐기', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c', mistral: 'sk-m', openai: 12345 }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    const result = store.read();
    expect(result).toEqual({ claude: 'sk-c' });
    expect(result).not.toHaveProperty('mistral');
    expect(result).not.toHaveProperty('openai');
  });

  it('캐시: 두 번째 read 는 파일 I/O 재호출 없음', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    store.read();
    store.read();
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('반환 객체는 null-prototype (toString 등 상속 없음)', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(Object.getPrototypeOf(store.read())).toBeNull();
  });
});

describe('prototype pollution 가드', () => {
  it('__proto__ 페이로드가 Object.prototype 을 오염시키지 않는다', () => {
    mocks.readFileSync.mockReturnValue(
      Buffer.from('enc:' + '{"__proto__":{"polluted":true},"claude":"sk-c"}', 'utf-8'),
    );
    const store = new ApiKeyStore(PATH, makeCrypto());
    const result = store.read();
    expect(result).toEqual({ claude: 'sk-c' });
    // 전역 오염 없음
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('constructor/prototype 키도 폐기', () => {
    mocks.readFileSync.mockReturnValue(
      Buffer.from('enc:' + '{"constructor":"x","prototype":"y","ollama":"ok"}', 'utf-8'),
    );
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(store.read()).toEqual({ ollama: 'ok' });
  });
});

describe('load', () => {
  it('provider 키 반환 / 없으면 undefined', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(store.load('claude')).toBe('sk-c');
    expect(store.load('openai')).toBeUndefined();
  });
});

describe('save', () => {
  it('기존 키 유지 + 신규 추가 후 .tmp → rename 원자적 교체 (순서)', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    store.save('openai', 'sk-o');

    // tmp 에 먼저 write
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.writeFileSync.mock.calls[0]![0]).toBe(PATH + '.tmp');
    expect(mocks.renameSync).toHaveBeenCalledWith(PATH + '.tmp', PATH);
    const writeOrder = mocks.writeFileSync.mock.invocationCallOrder[0]!;
    const renameOrder = mocks.renameSync.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(renameOrder);

    // 직렬화 내용에 기존+신규 모두 포함
    const decrypted = (mocks.writeFileSync.mock.calls[0]![1] as Buffer).toString('utf-8').replace(/^enc:/, '');
    expect(JSON.parse(decrypted)).toEqual({ claude: 'sk-c', openai: 'sk-o' });
  });

  it('성공 후 캐시 갱신 → 후속 load 가 파일 재읽기 없이 신규값 반환', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({}));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    store.read(); // 1회 읽기
    store.save('claude', 'sk-new');
    expect(store.load('claude')).toBe('sk-new');
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1); // 추가 읽기 없음
  });

  it('safeStorage 불가 시 KEYCHAIN_UNAVAILABLE throw (silent fail 금지)', () => {
    const store = new ApiKeyStore(PATH, makeCrypto(false));
    try {
      store.save('claude', 'sk-c');
      expect.unreachable('should throw');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('KEYCHAIN_UNAVAILABLE');
    }
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('writeFileSync 실패 시 .tmp 정리 + 캐시 무효화 후 원래 에러 throw', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    mocks.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
    mocks.unlinkSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(() => store.save('openai', 'sk-o')).toThrow('disk full');
    expect(mocks.unlinkSync).toHaveBeenCalledWith(PATH + '.tmp');
    expect(mocks.renameSync).not.toHaveBeenCalled();

    // 캐시 무효화 검증: 다음 read 가 파일을 다시 읽는다
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    store.read();
    expect(mocks.readFileSync).toHaveBeenCalledTimes(2); // save 전 1 + invalidate 후 1
  });

  it('renameSync 실패 시에도 .tmp 정리 후 throw', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({}));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockImplementation(() => { throw new Error('EXDEV'); });
    mocks.unlinkSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(() => store.save('claude', 'x')).toThrow('EXDEV');
    expect(mocks.unlinkSync).toHaveBeenCalledWith(PATH + '.tmp');
  });

  it('unlink 자체가 실패해도 원래 에러를 throw', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({}));
    mocks.writeFileSync.mockImplementation(() => { throw new Error('original'); });
    mocks.unlinkSync.mockImplementation(() => { throw new Error('unlink failed'); });

    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(() => store.save('claude', 'x')).toThrow('original');
  });
});

describe('delete', () => {
  it('지정 provider 제거 후 나머지 저장', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c', openai: 'sk-o' }));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    store.delete('claude');

    const decrypted = (mocks.writeFileSync.mock.calls[0]![1] as Buffer).toString('utf-8').replace(/^enc:/, '');
    expect(JSON.parse(decrypted)).toEqual({ openai: 'sk-o' });
    expect(store.load('claude')).toBeUndefined();
    expect(store.load('openai')).toBe('sk-o');
  });
});

describe('invalidate', () => {
  it('무효화 후 read 는 파일을 다시 읽는다', () => {
    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    const store = new ApiKeyStore(PATH, makeCrypto());
    store.read();
    store.invalidate();
    store.read();
    expect(mocks.readFileSync).toHaveBeenCalledTimes(2);
  });
});

// QA11 MED-1: 일시적 I/O 오류(EBUSY/EACCES — Windows 백신·인덱서 잠금)를 "빈 키셋"으로
// 흡수하면, 그 위에 save() 가 merge 해 다른 provider 의 키가 디스크에서 영구 소실됐다.
// session-store 의 isRealIoError 대칭 방어: ENOENT(첫 실행)만 빈 키셋, 그 외 fs 오류는
// 읽기에선 캐시 금지 + 쓰기에선 중단.
describe('일시적 I/O 오류 방어 (QA11 MED-1)', () => {
  function ioError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`mock ${code}`), { code });
  }

  it('save 는 EBUSY 로 기존 키셋을 못 읽으면 덮어쓰지 않고 throw (키 소실 차단)', () => {
    mocks.readFileSync.mockImplementation(() => { throw ioError('EBUSY'); });
    const store = new ApiKeyStore(PATH, makeCrypto());

    expect(() => store.save('claude', 'sk-new')).toThrowError(
      expect.objectContaining({ code: 'APIKEY_READ_FAILED' }),
    );
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.renameSync).not.toHaveBeenCalled();
  });

  it('delete 도 EACCES 시 파괴적 재기록 대신 throw', () => {
    mocks.readFileSync.mockImplementation(() => { throw ioError('EACCES'); });
    const store = new ApiKeyStore(PATH, makeCrypto());

    expect(() => store.delete('openai')).toThrowError(
      expect.objectContaining({ code: 'APIKEY_READ_FAILED' }),
    );
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('read 는 일시적 오류의 빈 결과를 캐시하지 않는다 (다음 읽기에서 회복)', () => {
    mocks.readFileSync.mockImplementationOnce(() => { throw ioError('EBUSY'); });
    const store = new ApiKeyStore(PATH, makeCrypto());

    expect(store.load('claude')).toBeUndefined(); // 잠긴 동안은 키 없음으로 degrade

    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c' }));
    expect(store.load('claude')).toBe('sk-c'); // 잠금 해제 후 자동 회복
  });

  it('EBUSY 이후 회복된 상태에서 save 는 기존 키를 보존한 채 merge', () => {
    mocks.readFileSync.mockImplementationOnce(() => { throw ioError('EBUSY'); });
    const store = new ApiKeyStore(PATH, makeCrypto());
    expect(() => store.save('gemini', 'sk-g')).toThrow(); // 1차: 중단

    mocks.readFileSync.mockReturnValue(storedBuffer({ claude: 'sk-c', openai: 'sk-o' }));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);
    store.save('gemini', 'sk-g'); // 2차: 정상

    const decrypted = (mocks.writeFileSync.mock.calls[0]![1] as Buffer).toString('utf-8').replace(/^enc:/, '');
    expect(JSON.parse(decrypted)).toEqual({ claude: 'sk-c', openai: 'sk-o', gemini: 'sk-g' });
  });

  it('ENOENT(첫 실행)는 여전히 빈 키셋 — save 가 정상 진행', () => {
    mocks.readFileSync.mockImplementation(() => { throw ioError('ENOENT'); });
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);

    const store = new ApiKeyStore(PATH, makeCrypto());
    store.save('claude', 'sk-c');

    const decrypted = (mocks.writeFileSync.mock.calls[0]![1] as Buffer).toString('utf-8').replace(/^enc:/, '');
    expect(JSON.parse(decrypted)).toEqual({ claude: 'sk-c' });
  });

  it('복호화 실패(코드 없는 에러)는 빈 키셋으로 간주 — save 진행 (키체인 회전 등 복구 불가)', () => {
    mocks.readFileSync.mockReturnValue(Buffer.from('garbage-not-enc', 'utf-8'));
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.renameSync.mockReturnValue(undefined);

    const badCrypto: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from('enc:' + s, 'utf-8'),
      decryptString: () => { throw new Error('decrypt failed'); },
    };
    const store = new ApiKeyStore(PATH, badCrypto);
    store.save('claude', 'sk-c');

    const decrypted = (mocks.writeFileSync.mock.calls[0]![1] as Buffer).toString('utf-8').replace(/^enc:/, '');
    expect(JSON.parse(decrypted)).toEqual({ claude: 'sk-c' });
  });
});

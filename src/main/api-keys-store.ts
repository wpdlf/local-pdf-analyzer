/**
 * API 키 암호화 저장소 — electron 비의존(safeStorage 주입) 모듈.
 *
 * R38 P1-2: 이전엔 readApiKeys/writeApiKeys/캐시/prototype-pollution 가드가 `src/main/index.ts`
 * 에 인라인돼 있었고 electron `safeStorage` 의존 때문에 vitest 에서 직접 검증 불가했다. 그래서
 * 다음 보안 로직에 단위 테스트가 0건이었다:
 *   - 변조된 JSON(`__proto__` 등) → 알려진 provider 키만 안전 추출 (prototype pollution 방어)
 *   - 원자적 쓰기(.tmp → rename), 중간 실패 시 .tmp 정리 + 캐시 무효화
 *   - safeStorage 불가 시 silent fail 금지 → KEYCHAIN_UNAVAILABLE throw
 *   - null-prototype 캐시 + save/delete 시에만 무효화 (hot path O(1))
 *
 * settings-store.ts 와 동일한 추출 철학. 단, safeStorage 는 OS 키체인 바인딩이라 path 처럼
 * 인자로 넘길 수 없어 **의존성 주입**(SafeStorageLike)으로 받는다 → 모듈은 fs 외 native 의존이
 * 없어 `__tests__/api-keys-store.test.ts` 가 fs 모킹 + fake crypto 로 행위를 검증한다.
 *
 * 주의: 거부/에러 메시지·캐시 의미·검증 순서는 기존 index.ts 인라인 구현과 동일해야 한다
 * (행위 보존 리팩터). 변경 시 api-keys-store.test.ts 가 회귀를 잡는다.
 */

import fs from 'fs';

/** electron `safeStorage` 의 필요한 표면만 추린 인터페이스 (테스트 시 fake 주입). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * R28 P2 (v0.18.12): prototype pollution 가드용 알려진 provider 목록.
 * 디스크에 변조된 JSON 이 `__proto__` 같은 키를 포함해도 알려진 키만 안전하게 복사한다.
 */
export const KNOWN_API_KEY_PROVIDERS = ['ollama', 'claude', 'openai', 'gemini'] as const;

/**
 * 알려진 provider 의 string 값만 null-prototype 객체로 추출.
 * `__proto__`/미지 provider/비-string 값은 폐기 → Object.prototype 오염 차단.
 */
function pickKnownKeys(source: Record<string, unknown>): Record<string, string> {
  const fresh: Record<string, string> = Object.create(null);
  for (const k of KNOWN_API_KEY_PROVIDERS) {
    const v = source[k];
    if (typeof v === 'string') fresh[k] = v;
  }
  return fresh;
}

/**
 * "파일이 없다"(ENOENT, 첫 실행) 와 "파일은 있는데 지금 못 읽었다"(EBUSY/EACCES/EMFILE 등,
 * Windows 백신·인덱서 잠금) 를 구분한다. session-store.ts 의 동명 함수와 같은 철학:
 * 후자는 디스크에 유효한 데이터가 살아있다는 뜻이므로 파괴적 쓰기를 해서는 안 된다.
 */
function isRealIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== 'ENOENT';
}

export class ApiKeyStore {
  // 복호화된 키의 프로세스 메모리 캐시 — disk/IPC 로 유출되지 않으며 앱 종료 시 소멸.
  // save/delete 시에만 무효화하여 hot path(요약 다수 청크) 의 동기 파일 I/O + OS 복호화를 O(1)로 축소.
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly crypto: SafeStorageLike,
  ) {}

  /**
   * 디스크 키셋을 (keys, transient) 로 반환. `transient=true` 는 "파일이 존재할 수 있으나 지금
   * 읽지 못했다" 를 뜻하며, 이때 빈 키셋은 **진실이 아니다**(캐시 금지, 덮어쓰기 금지).
   *
   * 부재(ENOENT)·복호화 실패·손상 JSON 은 transient 가 아니다: 전자는 첫 실행이고, 후자 둘은
   * 내용이 이미 복구 불가라 빈 키셋이 곧 진실이다(OS 키체인 회전 등).
   */
  private readRaw(): { keys: Record<string, string>; transient: boolean } {
    // null-prototype 객체 — 변조된 JSON 의 `__proto__` 키가 Object.prototype 을 오염시키는
    // 경로 차단. 일반 객체 spread/lookup 은 그대로 동작한다.
    if (!this.crypto.isEncryptionAvailable()) {
      return { keys: Object.create(null), transient: false };
    }
    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(this.filePath);
    } catch (err) {
      return { keys: Object.create(null), transient: isRealIoError(err) };
    }
    try {
      const parsed: unknown = JSON.parse(this.crypto.decryptString(encrypted));
      // 알려진 provider 키만 추출 — 그 외(prototype 키, 미지 provider 등)는 폐기.
      const keys: Record<string, string> = (parsed && typeof parsed === 'object')
        ? pickKnownKeys(parsed as Record<string, unknown>)
        : Object.create(null);
      return { keys, transient: false };
    } catch {
      return { keys: Object.create(null), transient: false };
    }
  }

  /**
   * 캐시 hit 시 즉시 반환, miss 시 디스크에서 복호화·추출 후 캐시.
   *
   * 일시적 I/O 오류의 빈 결과는 **캐시하지 않는다**. 이전엔 캐시해서, AV 가 파일을 잠근 순간
   * 한 번 읽으면 프로세스가 죽을 때까지 "키 없음" 이 굳었고, 그 위에서 save() 가 merge 하면
   * 다른 provider 의 키가 디스크에서 영구 소실됐다.
   */
  read(): Record<string, string> {
    if (this.cache) return this.cache;
    const { keys, transient } = this.readRaw();
    if (!transient) this.cache = keys;
    return keys;
  }

  /**
   * 파괴적 merge-쓰기 전용 읽기. save()/delete() 는 "기존 키셋 위에 한 항목을 얹어 전체를
   * 재기록" 하므로, 기존 키셋을 못 읽었다면 쓰기를 진행해선 안 된다 — throw 로 중단한다.
   */
  private readForWrite(): Record<string, string> {
    if (this.cache) return this.cache;
    const { keys, transient } = this.readRaw();
    if (transient) {
      throw Object.assign(
        new Error('기존 API 키 파일을 읽을 수 없어 저장을 중단했습니다. 잠시 후 다시 시도해주세요.'),
        { code: 'APIKEY_READ_FAILED' },
      );
    }
    this.cache = keys;
    return keys;
  }

  invalidate(): void {
    this.cache = null;
  }

  load(provider: string): string | undefined {
    return this.read()[provider];
  }

  save(provider: string, key: string): void {
    // clone 후 수정 — write 실패 시 캐시가 불일치 상태로 남지 않도록 보호.
    const keys = { ...this.readForWrite(), [provider]: key };
    this.write(keys);
  }

  delete(provider: string): void {
    const keys = { ...this.readForWrite() };
    delete keys[provider];
    this.write(keys);
  }

  private write(keys: Record<string, string>): void {
    if (!this.crypto.isEncryptionAvailable()) {
      // silent return 금지: 호출자가 실패를 감지할 수 있도록 throw.
      // (이전 버그: silent fail 시 UI가 "저장됨"이라고 보고한 뒤 실제 사용 시에야 실패 발견)
      throw Object.assign(
        new Error('OS 키체인을 사용할 수 없어 API 키를 저장할 수 없습니다. OS 설정을 확인해주세요.'),
        { code: 'KEYCHAIN_UNAVAILABLE' },
      );
    }
    const tmpPath = this.filePath + '.tmp';
    const encrypted = this.crypto.encryptString(JSON.stringify(keys));
    try {
      fs.writeFileSync(tmpPath, encrypted);
      fs.renameSync(tmpPath, this.filePath);
      // 쓰기 성공 후 캐시에 최신값 반영 — 다음 읽기에서 파일 I/O 회피.
      // null-prototype 객체로 캐시하여 read() 와 일관성 유지.
      this.cache = pickKnownKeys(keys);
    } catch (err) {
      // rename 실패 시 tmp 파일 정리 + 캐시 무효화 (디스크와 메모리 불일치 방지).
      try { fs.unlinkSync(tmpPath); } catch { /* 이미 삭제됨 */ }
      this.invalidate();
      throw err;
    }
  }
}

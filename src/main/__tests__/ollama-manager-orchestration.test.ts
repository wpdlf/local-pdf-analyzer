import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// install() 오케스트레이션 커버리지 (ollama-manager-install.test.ts 의 후속).
//
// 기존 install 테스트는 리프 헬퍼(downloadFile / verifyInstallerSignature)만 다루고
// "범위 밖: install* 전체 오케스트레이션, computeFileHash" 라 명시했다. 이 파일이 그 공백을
// 메운다 — 단계를 엮는 분기(크기·서명·설치확인·에러·정리)와 보안 분기(macOS path traversal)를
// 검증한다. powershell Start-Process(RunAs)/brew/unzip 는 실제 실행 불가하므로 execFile 호출
// 인자 모양을 단언하고 콜백을 시뮬레이션한다(verifyInstallerSignature 테스트와 동일 패턴).
//
// 전략: 리프(downloadFile/verifyInstallerSignature/computeFileHash/isInstalled)는 인스턴스
// 프로퍼티로 스텁(이미 별도 커버)하고 install* 오케스트레이션 본체만 실제로 구동. computeFileHash
// 자체는 전용 테스트에서 실제 fs.createReadStream 경로로 검증.

const M = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  createReadStream: vi.fn(),
  existsSync: vi.fn(),
  send: vi.fn(),
  // QA29(A-4): installMac 의 fallback 이 이제 zip 매직을 실제로 읽는다.
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => M.execFile(...a),
  spawn: (...a: unknown[]) => M.spawn(...a),
  ChildProcess: class {},
}));
vi.mock('fs', () => ({
  default: {
    existsSync: (...a: unknown[]) => M.existsSync(...a),
    statSync: (...a: unknown[]) => M.statSync(...a),
    unlinkSync: (...a: unknown[]) => M.unlinkSync(...a),
    createReadStream: (...a: unknown[]) => M.createReadStream(...a),
    createWriteStream: vi.fn(),
    openSync: (...a: unknown[]) => M.openSync(...a),
    readSync: (...a: unknown[]) => M.readSync(...a),
    closeSync: (...a: unknown[]) => M.closeSync(...a),
  },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...a: unknown[]) => M.send(...a) } }],
  },
}));

import { OllamaManager } from '../ollama-manager';

type Result = { success: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string> };

interface Privable {
  install: () => Promise<Result>;
  installWindows: () => Promise<Result>;
  installMac: () => Promise<Result>;
  computeFileHash: (filePath: string) => Promise<string>;
  downloadFile: (...args: unknown[]) => Promise<void>;
  verifyInstallerSignature: (...args: unknown[]) => Promise<{ valid: boolean; subject?: string; reason?: string }>;
  isInstalled: (...args: unknown[]) => Promise<boolean>;
}

/** 컴파일타임 private 우회 — 런타임 메서드/프로퍼티는 존재한다. */
function priv(mgr: OllamaManager): Privable {
  return mgr as unknown as Privable;
}

/** execFile 콜백(마지막 함수 인자) 추출 — 3/4-arity 시그니처 모두 대응. */
function cbOf(args: unknown[]): (err?: unknown, stdout?: string) => void {
  return args.find((a) => typeof a === 'function') as (err?: unknown, stdout?: string) => void;
}

/** 리프 헬퍼를 인스턴스에 스텁(오케스트레이션 본체만 실제 구동). */
function stubLeaves(
  mgr: OllamaManager,
  over: Partial<{
    downloadFile: () => Promise<void>;
    verifyInstallerSignature: () => Promise<{ valid: boolean; subject?: string; reason?: string }>;
    computeFileHash: () => Promise<string>;
    isInstalled: () => Promise<boolean>;
  }> = {},
) {
  const p = priv(mgr);
  p.downloadFile = over.downloadFile ?? vi.fn().mockResolvedValue(undefined);
  p.verifyInstallerSignature = over.verifyInstallerSignature ?? vi.fn().mockResolvedValue({ valid: true, subject: 'CN=Ollama' });
  p.computeFileHash = over.computeFileHash ?? vi.fn().mockResolvedValue('a'.repeat(64));
  p.isInstalled = over.isInstalled ?? vi.fn().mockResolvedValue(true);
}

let originalPlatform: PropertyDescriptor | undefined;
function setPlatform(value: NodeJS.Platform) {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  M.existsSync.mockReturnValue(false);
  M.statSync.mockReturnValue({ size: 50 * 1024 * 1024 });
  // 기본은 정상 ZIP(`PK\x03\x04`) — 매직 게이트가 있는 경로들이 종전대로 흐르게 한다.
  M.openSync.mockReturnValue(3);
  M.readSync.mockImplementation((_fd: number, buf: Buffer) => { buf.set([0x50, 0x4b, 0x03, 0x04]); return 4; });
  M.closeSync.mockReturnValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
    originalPlatform = undefined;
  }
});

describe('installWindows — 단계 오케스트레이션/에러 분기', () => {
  it('정상 경로: 다운로드→검증→Start-Process→설치확인 → success', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => cbOf(args)(null));

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ success: true });
  });

  it('powershell Start-Process 가 -Verb RunAs -Wait 로 호출됨 (인자 모양 단언)', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => cbOf(args)(null));

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    await promise;

    const psCall = M.execFile.mock.calls.find((c) => c[0] === 'powershell');
    expect(psCall).toBeDefined();
    const psArgs = psCall![1] as string[];
    const script = psArgs[psArgs.length - 1]!;
    expect(script).toContain('Start-Process');
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain('-Wait');
  });

  it('진행 이벤트는 source:"install" 로 태깅되어 전송됨', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => cbOf(args)(null));

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    await promise;

    const progressCalls = M.send.mock.calls.filter((c) => c[0] === 'setup:progress');
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls.every((c) => (c[1] as { source?: string }).source === 'install')).toBe(true);
    expect(progressCalls.map((c) => (c[1] as { key: string }).key)).toContain('downloadingInstaller');
  });

  it('파일 <1MB → installerTooSmall + 임시파일 정리', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.statSync.mockReturnValue({ size: 1024 }); // 1KB

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installerTooSmall');
    expect(r.errorParams).toEqual({ size: '1024' });
    expect(M.unlinkSync).toHaveBeenCalled();
    // 검증 실패면 Start-Process 까지 가지 않음
    expect(M.execFile).not.toHaveBeenCalled();
  });

  it('서명 무효 → signatureInvalid + 인스톨러 삭제 + 설치 중단', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr, {
      verifyInstallerSignature: vi.fn().mockResolvedValue({ valid: false, reason: '서명자가 Ollama 가 아님' }),
    });

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('signatureInvalid');
    expect(r.errorParams).toEqual({ reason: '서명자가 Ollama 가 아님' });
    expect(M.unlinkSync).toHaveBeenCalled();
    expect(M.execFile).not.toHaveBeenCalled();
  });

  it('설치 후 실행 파일 미발견 → installedButNotFound', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr, { isInstalled: vi.fn().mockResolvedValue(false) });
    M.execFile.mockImplementation((...args: unknown[]) => cbOf(args)(null));

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installedButNotFound');
  });

  it("Start-Process 가 'exited' 메시지로 종료해도 정상 진행 (NSIS 종료코드 허용)", async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => cbOf(args)(new Error('Command failed: process exited with code 1')));

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ success: true });
  });

  it('다운로드 실패 → installFailed + finally 임시파일 정리', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr, { downloadFile: vi.fn().mockRejectedValue(new Error('네트워크 끊김')) });

    const promise = priv(mgr).installWindows() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installFailed');
    expect(r.errorParams?.detail).toContain('네트워크 끊김');
    expect(M.unlinkSync).toHaveBeenCalled(); // finally 정리
  });
});

describe('installMac — brew + fallback 오케스트레이션', () => {
  it('brew install 성공 → success', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => {
      expect(args[0]).toBe('brew');
      cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ success: true });
  });

  it('brew 실패 → zip 다운로드 fallback → unzip → open → success', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0];
      if (cmd === 'brew') return cbOf(args)(new Error('brew not found'));
      if (cmd === 'unzip' && (args[1] as string[])[0] === '-l') return cbOf(args)(null, '  Length  Name\n  1234  Ollama.app/Contents/MacOS/ollama\n');
      if (cmd === 'unzip') return cbOf(args)(null); // -o 추출
      if (cmd === 'open') return cbOf(args)();
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ success: true });
    // brew 실패 후 fallback 진행 이벤트
    const keys = M.send.mock.calls.filter((c) => c[0] === 'setup:progress').map((c) => (c[1] as { key: string }).key);
    expect(keys).toContain('brewFallback');
  });

  it('fallback zip 에 path traversal 엔트리 → 거부 → installFailed (보안 분기)', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0];
      if (cmd === 'brew') return cbOf(args)(new Error('brew not found'));
      if (cmd === 'unzip' && (args[1] as string[])[0] === '-l') return cbOf(args)(null, 'Archive\n  10  ../../etc/passwd\n');
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installFailed');
    expect(r.errorParams?.detail).toContain('위험한 경로');
    // traversal 거부 시 추출 unzip(-o)/open 까지 가지 않음
    const extractCall = M.execFile.mock.calls.find((c) => c[0] === 'unzip' && (c[1] as string[])[0] === '-o');
    expect(extractCall).toBeUndefined();
  });

  it('fallback zip 이 비정상적으로 작음 → installFailed', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.statSync.mockReturnValue({ size: 512 });
    M.execFile.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'brew') return cbOf(args)(new Error('brew not found'));
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installFailed');
    expect(M.unlinkSync).toHaveBeenCalled();
  });

  // QA29(A-4): 이 경로는 `verifyingDownload`("다운로드 무결성 검증 중")를 띄우면서 실제로는
  // **크기 하한 하나**만 봤다 — computeFileHash 는 계산만 되고 아무것과도 대조되지 않았다
  // (win32 는 Authenticode 로 진짜 검증한다). Ollama 가 기준 해시를 게시하지 않으므로 해시
  // 대조는 도입할 수 없고, 대신 검사를 표시에 맞춰 올린다: 선두 매직으로 실제 ZIP 인지 본다.
  it('fallback 다운로드가 ZIP 이 아니면 거부한다 (크기만 통과하는 차단 페이지·HTML 에러)', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    // 크기는 충분한데 내용은 HTML — 종전 검사는 이것을 그대로 unzip 에 넘겼다.
    M.readSync.mockImplementation((_fd: number, buf: Buffer) => { buf.set([0x3c, 0x21, 0x44, 0x4f]); return 4; }); // '<!DO'
    M.execFile.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'brew') return cbOf(args)(new Error('brew not found'));
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    const r = await promise;

    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('installFailed');
    expect(r.errorParams?.detail).toContain('ZIP 형식이 아닙니다');
    // 거부했으면 추출(unzip -l/-o)까지 가지 않는다.
    expect(M.execFile.mock.calls.find((c) => c[0] === 'unzip')).toBeUndefined();
    expect(M.unlinkSync).toHaveBeenCalled();
  });

  it('매직을 읽지 못해도 거부 쪽으로 착지한다 (fd 는 닫는다)', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.openSync.mockImplementation(() => { throw new Error('EBUSY'); });
    M.execFile.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'brew') return cbOf(args)(new Error('brew not found'));
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect((await promise).success).toBe(false);
  });

  it('정상 ZIP 매직은 통과시킨다 (과잉 차단 금지)', async () => {
    const mgr = new OllamaManager();
    stubLeaves(mgr);
    M.execFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0];
      if (cmd === 'brew') return cbOf(args)(new Error('brew not found'));
      if (cmd === 'unzip' && (args[1] as string[])[0] === '-l') return cbOf(args)(null, '  Length  Name\n  1234  Ollama.app/Contents/MacOS/ollama\n');
      return cbOf(args)(null);
    });

    const promise = priv(mgr).installMac() as Promise<Result>;
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ success: true });
    expect(M.closeSync, '매직 확인 후 fd 를 닫지 않으면 핸들이 샌다').toHaveBeenCalled();
  });
});

describe('install/_installInternal — 플랫폼 디스패치 + 동시호출 디덕', () => {
  it('win32 → installWindows 위임', async () => {
    setPlatform('win32');
    const mgr = new OllamaManager();
    const win = vi.fn().mockResolvedValue({ success: true });
    priv(mgr).installWindows = win;

    const r = (await (priv(mgr).install() as Promise<Result>));
    expect(r).toEqual({ success: true });
    expect(win).toHaveBeenCalledOnce();
  });

  it('darwin → installMac 위임', async () => {
    setPlatform('darwin');
    const mgr = new OllamaManager();
    const mac = vi.fn().mockResolvedValue({ success: true });
    priv(mgr).installMac = mac;

    const r = (await (priv(mgr).install() as Promise<Result>));
    expect(r).toEqual({ success: true });
    expect(mac).toHaveBeenCalledOnce();
  });

  it('미지원 OS → unsupportedOs (설치 메서드 미호출)', async () => {
    setPlatform('linux');
    const mgr = new OllamaManager();
    const win = vi.fn();
    const mac = vi.fn();
    priv(mgr).installWindows = win;
    priv(mgr).installMac = mac;

    const r = (await (priv(mgr).install() as Promise<Result>));
    expect(r.success).toBe(false);
    expect(r.errorKey).toBe('unsupportedOs');
    expect(win).not.toHaveBeenCalled();
    expect(mac).not.toHaveBeenCalled();
  });

  it('동시 install() 호출 → 동일 Promise 재사용 (이중 다운로드 방지)', async () => {
    setPlatform('win32');
    const mgr = new OllamaManager();
    let resolveWin!: (r: Result) => void;
    const win = vi.fn(() => new Promise<Result>((res) => { resolveWin = res; }));
    priv(mgr).installWindows = win;

    const p1 = priv(mgr).install() as Promise<Result>;
    const p2 = priv(mgr).install() as Promise<Result>;
    resolveWin({ success: true });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(win).toHaveBeenCalledOnce(); // 두 번째 호출은 진행 중 Promise 재사용
    expect(r1).toEqual({ success: true });
    expect(r2).toEqual({ success: true });
  });
});

describe('computeFileHash — 실제 스트림 경로', () => {
  it('data/end 스트림 → sha256 hex digest', async () => {
    M.createReadStream.mockImplementation(() => {
      const s = new EventEmitter();
      queueMicrotask(() => {
        s.emit('data', Buffer.from('hello'));
        s.emit('end');
      });
      return s;
    });
    const hash = await (priv(new OllamaManager()).computeFileHash('/tmp/x') as Promise<string>);
    // sha256('hello')
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('스트림 error → reject', async () => {
    M.createReadStream.mockImplementation(() => {
      const s = new EventEmitter();
      queueMicrotask(() => s.emit('error', new Error('EIO')));
      return s;
    });
    await expect(priv(new OllamaManager()).computeFileHash('/tmp/x') as Promise<string>).rejects.toThrow('EIO');
  });
});

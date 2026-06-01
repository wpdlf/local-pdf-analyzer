import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// R38 P4 (test coverage): OllamaManager 의 다운로드/서명 검증 보안 로직.
//
// downloadFile / verifyInstallerSignature 는 private 이며 install() 오케스트레이션을 통해서만
// 호출되는데, install() 은 powershell Start-Process(RunAs) + 실제 파일 I/O 까지 엮여 단위 테스트가
// 비현실적이다. 이 두 메서드는 `this` 를 쓰지 않는 사실상 순수 유틸이지만, R32/M3 의 FD-leak·
// backpressure 회귀 수정이 누적된 가장 섬세한 코드라 추출 리팩터 없이 private 접근(cast)으로
// **실제 메서드를 그대로** 검증한다 — 행위 보존이 최우선.
//
// 검증:
//   downloadFile             : 리다이렉트>5 / non-https 리다이렉트 / Location 부재 / content-length
//                              500MB 초과 / 스트리밍 중 크기 초과 / HTTP 에러 / 성공 / 타임아웃(FD 정리)
//   verifyInstallerSignature : OK:CN=Ollama→valid, 타 서명자→invalid, STATUS→invalid, PS 실패→invalid,
//                              -LiteralPath 사용(R28 P2 회귀 가드)
//
// 범위 밖(여전히): install* 전체 오케스트레이션, computeFileHash, E2E.

const M = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  httpGet: vi.fn(),
  httpsGet: vi.fn(),
  createWriteStream: vi.fn(),
  unlinkSync: vi.fn(),
  lastFile: null as (EventEmitter & { destroy: ReturnType<typeof vi.fn> }) | null,
}));

vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => M.execFile(...a),
  spawn: (...a: unknown[]) => M.spawn(...a),
  ChildProcess: class {},
}));
vi.mock('http', () => ({ default: { get: (...a: unknown[]) => M.httpGet(...a) } }));
vi.mock('https', () => ({ default: { get: (...a: unknown[]) => M.httpsGet(...a) } }));
vi.mock('fs', () => ({
  default: {
    existsSync: () => false,
    createWriteStream: (...a: unknown[]) => M.createWriteStream(...a),
    unlinkSync: (...a: unknown[]) => M.unlinkSync(...a),
  },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
}));

import { OllamaManager } from '../ollama-manager';

/** downloadFile(private) 호출 핸들 — 컴파일타임 private 우회(런타임 메서드는 존재). */
type DownloadFn = (url: string, dest: string) => Promise<void>;
type VerifyFn = (filePath: string) => Promise<{ valid: boolean; subject?: string; reason?: string }>;
function dl(mgr: OllamaManager): DownloadFn {
  return (mgr as unknown as { downloadFile: DownloadFn }).downloadFile.bind(mgr);
}
function verify(mgr: OllamaManager): VerifyFn {
  return (mgr as unknown as { verifyInstallerSignature: VerifyFn }).verifyInstallerSignature.bind(mgr);
}

function makeReq() {
  const req = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    __timeoutCb?: () => void;
  };
  req.destroy = vi.fn();
  req.setTimeout = vi.fn((_ms: number, cb: () => void) => { req.__timeoutCb = cb; return req; });
  return req;
}

function makeRes(opts: { statusCode: number; headers?: Record<string, string>; complete?: boolean }) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number; headers: Record<string, string>; complete: boolean;
    resume: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    pipe: ReturnType<typeof vi.fn>; unpipe: ReturnType<typeof vi.fn>;
  };
  res.statusCode = opts.statusCode;
  res.headers = opts.headers ?? {};
  res.complete = opts.complete ?? true;
  res.resume = vi.fn();
  res.destroy = vi.fn();
  res.pipe = vi.fn();
  res.unpipe = vi.fn();
  return res;
}

beforeEach(() => {
  M.lastFile = null;
  M.createWriteStream.mockImplementation(() => {
    const f = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    f.destroy = vi.fn();
    M.lastFile = f;
    return f;
  });
});

describe('downloadFile — 리다이렉트/크기/에러 가드', () => {
  it('non-https 리다이렉트 거부', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 302, headers: { location: 'http://evil.com/x' } })));
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/x')).rejects.toThrow(/안전하지 않은 리다이렉트 URL/);
  });

  it('Location 헤더 부재 리다이렉트 거부', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 301, headers: {} })));
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/x')).rejects.toThrow(/Location 헤더가 없습니다/);
  });

  it('리다이렉트 5회 초과 거부', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 302, headers: { location: 'https://ollama.com/next' } })));
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/start', '/tmp/x')).rejects.toThrow(/너무 많은 리다이렉트/);
  });

  it('content-length 500MB 초과 거부 (스트림 생성 전)', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 200, headers: { 'content-length': String(600 * 1024 * 1024) } })));
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/x')).rejects.toThrow(/파일이 너무 큽니다/);
    expect(M.createWriteStream).not.toHaveBeenCalled();
  });

  it('HTTP 에러 상태 거부', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 404 })));
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/x')).rejects.toThrow(/다운로드 실패: HTTP 404/);
  });

  it('스트리밍 중 500MB 초과 → 중단 + 거부', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200, headers: { 'content-length': '0' } });
        cb(res);
        // 거대 chunk (실제 할당 없이 length 만 큰 객체) → 크기 초과 분기
        queueMicrotask(() => res.emit('data', { length: 500 * 1024 * 1024 + 1 }));
      });
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/x')).rejects.toThrow(/500MB를 초과/);
  });

  it('정상 200 → 파일 finish 시 resolve', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200, headers: { 'content-length': '1000' } });
        cb(res);
        queueMicrotask(() => M.lastFile!.emit('finish'));
      });
      return req;
    });
    await expect(dl(new OllamaManager())('https://ollama.com/x', '/tmp/out')).resolves.toBeUndefined();
    expect(M.createWriteStream).toHaveBeenCalledWith('/tmp/out');
  });

  it('타임아웃 → req.destroy + WriteStream 정리 + 거부 (FD leak 방지)', async () => {
    M.httpsGet.mockImplementation((_url: string, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200, headers: { 'content-length': '1000' } });
        cb(res);
        queueMicrotask(() => req.__timeoutCb!()); // setTimeout 핸들러 발화
      });
      return req;
    });
    const mgr = new OllamaManager();
    await expect(dl(mgr)('https://ollama.com/x', '/tmp/out')).rejects.toThrow(/다운로드 타임아웃/);
    expect(M.lastFile!.destroy).toHaveBeenCalled(); // currentFile?.destroy()
  });
});

describe('verifyInstallerSignature — Authenticode 검증', () => {
  function mockPs(stdout: string | null, err?: Error) {
    M.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as (e: unknown, out: string) => void;
      cb(err ?? null, stdout ?? '');
    });
  }

  it('OK:CN=Ollama 서명자 → valid', async () => {
    mockPs('OK:CN=Ollama, Inc., O=Ollama, C=US');
    const r = await verify(new OllamaManager())('C:\\Temp\\OllamaSetup.exe');
    expect(r.valid).toBe(true);
    expect(r.subject).toContain('Ollama');
  });

  it('OK:타 서명자 → invalid (서명자가 Ollama 가 아님)', async () => {
    mockPs('OK:CN=Microsoft Corporation, O=Microsoft');
    const r = await verify(new OllamaManager())('C:\\Temp\\x.exe');
    expect(r).toEqual({ valid: false, subject: 'CN=Microsoft Corporation, O=Microsoft', reason: '서명자가 Ollama 가 아님' });
  });

  it('STATUS:NotSigned → invalid (서명 상태)', async () => {
    mockPs('STATUS:NotSigned');
    const r = await verify(new OllamaManager())('C:\\Temp\\x.exe');
    expect(r).toEqual({ valid: false, reason: '서명 상태: NotSigned' });
  });

  it('PowerShell 실행 실패 → invalid', async () => {
    mockPs(null, new Error('powershell not found'));
    const r = await verify(new OllamaManager())('C:\\Temp\\x.exe');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/PowerShell 실패/);
  });

  it('-LiteralPath 사용 (R28 P2 회귀: -FilePath glob 우회 방지)', async () => {
    mockPs('OK:CN=Ollama');
    await verify(new OllamaManager())('C:\\Temp\\Ollama[1].exe');
    const call = M.execFile.mock.calls[0]!;
    expect(call[0]).toBe('powershell');
    const psArgs = call[1] as string[];
    const script = psArgs[psArgs.length - 1]!;
    expect(script).toContain('-LiteralPath');
    expect(script).not.toContain('-FilePath');
  });
});

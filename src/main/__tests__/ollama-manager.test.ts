import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// R38 P3 (test coverage): OllamaManager 의 network + process 생명주기 행위 검증.
//
// ollama-manager.ts(661줄)는 child_process(execFile/spawn)·http·fs·electron 의존으로 vitest 가
// 직접 import 불가했고(R15 H1 / R28 P2 회귀 영역) 단위 테스트가 0건이었다. 본 라운드에서 이들을
// 모킹하여 다음을 검증한다:
//   - listModels   : 1MB 응답 캡 / 손상 JSON / timeout / error → 안전 fallback([])
//   - healthCheck  : 200→true, 비-200/error/timeout→false
//   - isInstalled  : execFile error→false, 성공→true
//   - getStatus    : installed/running/models 합성
//   - pullModel    : 재진입 가드, exit code 매핑, spawn error
//   - stop/killPullProcess(win32): taskkill 실패 → SIGKILL fallback (R32 P3)
//
// 범위 밖(P4): downloadFile(리다이렉트/크기 캡), verifyInstallerSignature(powershell),
//   install* 오케스트레이션, start 의 health-retry 루프(실시간 타이머) — 통합/타이머 성격.

const M = vi.hoisted(() => ({
  httpGet: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawned: [] as Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }>,
}));

vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => M.execFile(...a),
  spawn: (...a: unknown[]) => M.spawn(...a),
  ChildProcess: class {},
}));
vi.mock('http', () => ({ default: { get: (...a: unknown[]) => M.httpGet(...a) } }));
vi.mock('fs', () => ({ default: { existsSync: () => false } }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
}));

import { OllamaManager } from '../ollama-manager';

/** 가짜 ChildProcess. */
function makeProc() {
  const p = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; pid: number;
    kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>;
  };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.pid = 4242;
  p.kill = vi.fn();
  p.unref = vi.fn();
  return p;
}

/**
 * http.get 모킹 — 시나리오별 동작. healthCheck 는 cb 안에서 동기 resolve 하고, listModels 는
 * data/end 이벤트가 필요하므로 microtask 로 emit.
 */
function mockHttp(scenario: { statusCode?: number; body?: string; error?: boolean; timeout?: boolean }) {
  M.httpGet.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = vi.fn();
    if (scenario.error) {
      queueMicrotask(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    }
    if (scenario.timeout) {
      queueMicrotask(() => req.emit('timeout'));
      return req;
    }
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void; destroy: () => void };
    res.statusCode = scenario.statusCode ?? 200;
    res.resume = vi.fn();
    res.destroy = vi.fn();
    cb(res);
    queueMicrotask(() => {
      if (scenario.body !== undefined) res.emit('data', Buffer.from(scenario.body));
      res.emit('end');
    });
    return req;
  });
}

beforeEach(() => {
  M.spawned.length = 0;
  M.spawn.mockImplementation(() => {
    const p = makeProc();
    M.spawned.push(p);
    return p;
  });
});

describe('listModels (http 응답 처리)', () => {
  it('정상 응답 → 모델명 배열', async () => {
    mockHttp({ body: JSON.stringify({ models: [{ name: 'gemma3' }, { name: 'llava' }] }) });
    expect(await new OllamaManager().listModels()).toEqual(['gemma3', 'llava']);
  });

  it('models 필드 없음 → 빈 배열', async () => {
    mockHttp({ body: JSON.stringify({}) });
    expect(await new OllamaManager().listModels()).toEqual([]);
  });

  it('손상된 JSON → 빈 배열 (안전 fallback)', async () => {
    mockHttp({ body: '{ not json' });
    expect(await new OllamaManager().listModels()).toEqual([]);
  });

  it('1MB 초과 응답 → 즉시 중단 + 빈 배열', async () => {
    mockHttp({ body: 'x'.repeat(1024 * 1024 + 10) });
    expect(await new OllamaManager().listModels()).toEqual([]);
  });

  it('연결 에러 → 빈 배열', async () => {
    mockHttp({ error: true });
    expect(await new OllamaManager().listModels()).toEqual([]);
  });

  it('타임아웃 → 빈 배열', async () => {
    mockHttp({ timeout: true });
    expect(await new OllamaManager().listModels()).toEqual([]);
  });
});

describe('healthCheck', () => {
  it('HTTP 200 → true', async () => {
    mockHttp({ statusCode: 200 });
    expect(await new OllamaManager().healthCheck()).toBe(true);
  });

  it('HTTP 500 → false', async () => {
    mockHttp({ statusCode: 500 });
    expect(await new OllamaManager().healthCheck()).toBe(false);
  });

  it('연결 에러 → false', async () => {
    mockHttp({ error: true });
    expect(await new OllamaManager().healthCheck()).toBe(false);
  });

  it('타임아웃 → false', async () => {
    mockHttp({ timeout: true });
    expect(await new OllamaManager().healthCheck()).toBe(false);
  });
});

describe('isInstalled (execFile)', () => {
  it('execFile 성공 → true', async () => {
    M.execFile.mockImplementation((...args: unknown[]) => {
      (args.find((a) => typeof a === 'function') as (e: unknown) => void)(null);
    });
    expect(await new OllamaManager().isInstalled()).toBe(true);
  });

  it('execFile error (미설치) → false', async () => {
    M.execFile.mockImplementation((...args: unknown[]) => {
      (args.find((a) => typeof a === 'function') as (e: unknown) => void)(new Error('not found'));
    });
    expect(await new OllamaManager().isInstalled()).toBe(false);
  });
});

describe('getStatus (합성)', () => {
  it('설치+실행 중 → installed/running/version/models 채워짐', async () => {
    const mgr = new OllamaManager();
    vi.spyOn(mgr, 'isInstalled').mockResolvedValue(true);
    vi.spyOn(mgr, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(mgr, 'listModels').mockResolvedValue(['gemma3']);
    // getVersion(private) 은 execFile 사용
    M.execFile.mockImplementation((...args: unknown[]) => {
      (args.find((a) => typeof a === 'function') as (e: unknown, out: string) => void)(null, 'ollama version 0.5.0\n');
    });
    expect(await mgr.getStatus()).toEqual({
      installed: true, running: true, version: 'ollama version 0.5.0', models: ['gemma3'],
    });
  });

  it('미설치 → running false, models 빈 배열, healthCheck/listModels 미호출', async () => {
    const mgr = new OllamaManager();
    vi.spyOn(mgr, 'isInstalled').mockResolvedValue(false);
    const hc = vi.spyOn(mgr, 'healthCheck');
    const lm = vi.spyOn(mgr, 'listModels');
    expect(await mgr.getStatus()).toEqual({ installed: false, running: false, models: [] });
    expect(hc).not.toHaveBeenCalled();
    expect(lm).not.toHaveBeenCalled();
  });
});

describe('pullModel (spawn 생명주기)', () => {
  it('exit code 0 → success', async () => {
    const mgr = new OllamaManager();
    const p = mgr.pullModel('gemma3');
    M.spawned[0]!.emit('close', 0);
    expect(await p).toEqual({ success: true });
    expect(M.spawn).toHaveBeenCalledTimes(1);
  });

  it('exit code 비-0 → 에러 메시지', async () => {
    const mgr = new OllamaManager();
    const p = mgr.pullModel('gemma3');
    M.spawned[0]!.emit('close', 1);
    expect(await p).toEqual({ success: false, error: '모델 다운로드 실패 (exit code: 1)' });
  });

  it('spawn error → 에러 메시지', async () => {
    const mgr = new OllamaManager();
    const p = mgr.pullModel('gemma3');
    M.spawned[0]!.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ success: false, error: '모델 다운로드 실패: ENOENT' });
  });

  it('재진입 가드 — 진행 중이면 두 번째 호출 즉시 거부 (spawn 1회)', async () => {
    const mgr = new OllamaManager();
    const p1 = mgr.pullModel('gemma3');
    const r2 = await mgr.pullModel('llava');
    expect(r2).toEqual({ success: false, error: '다른 모델 다운로드가 이미 진행 중입니다. 완료 후 다시 시도해주세요.' });
    expect(M.spawn).toHaveBeenCalledTimes(1);
    // 정리: 첫 pull 종료 → 타이머 clear
    M.spawned[0]!.emit('close', 0);
    await p1;
  });
});

describe('start (조기 반환 경로)', () => {
  it('이미 실행 중(healthCheck true) → true, spawn 미호출', async () => {
    const mgr = new OllamaManager();
    vi.spyOn(mgr, 'healthCheck').mockResolvedValue(true);
    expect(await mgr.start()).toBe(true);
    expect(M.spawn).not.toHaveBeenCalled();
  });

  it('미설치(healthCheck false + isInstalled false) → false, spawn 미호출', async () => {
    const mgr = new OllamaManager();
    vi.spyOn(mgr, 'healthCheck').mockResolvedValue(false);
    vi.spyOn(mgr, 'isInstalled').mockResolvedValue(false);
    expect(await mgr.start()).toBe(false);
    expect(M.spawn).not.toHaveBeenCalled();
  });
});

describe('stop / killPullProcess — win32 taskkill 실패 시 SIGKILL fallback (R32 P3)', () => {
  const orig = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  // 이 케이스는 serve 프로세스(this.process)가 없는 상태라 stop() 이 killPullProcess() 만
  // 실행하고 `if (!this.process) return` 으로 조기 반환한다 → 검증 대상은 killPullProcess 의
  // pull 자식 종료 경로(R38 QA2 지적: stop() 자체 블록과 구분).
  it('killPullProcess: 진행 중 pull 을 stop 시 taskkill 실패 → SIGKILL fallback', async () => {
    const mgr = new OllamaManager();
    const pull = mgr.pullModel('gemma3');
    const proc = M.spawned[0]!;

    // taskkill execFile 이 실패(권한 거부 등)하도록
    M.execFile.mockImplementation((...args: unknown[]) => {
      (args.find((a) => typeof a === 'function') as (e: unknown) => void)(new Error('access denied'));
    });

    await mgr.stop();

    // taskkill /F /T /PID <pid> 시도
    expect(M.execFile).toHaveBeenCalledWith(
      'taskkill',
      expect.arrayContaining(['/F', '/T', '/PID', String(proc.pid)]),
      expect.any(Function),
    );
    // 실패 → SIGKILL fallback
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    // 정리: close 로 pull 타이머 clear + resolve
    proc.emit('close', 0);
    await pull;
  });

  // stop() 자체의 win32 serve-프로세스 종료 블록 + waitForExit 커버 (R38 QA2 보강).
  // start() 성공 경로(첫 health-retry 가 true → 타이머 없음)로 this.process 를 채운 뒤 stop().
  it('stop(): serve 프로세스 종료 — taskkill 실패 → SIGKILL fallback + waitForExit(close)', async () => {
    const mgr = new OllamaManager();
    vi.spyOn(mgr, 'healthCheck').mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(mgr, 'isInstalled').mockResolvedValue(true);

    expect(await mgr.start()).toBe(true);
    expect(M.spawn).toHaveBeenCalledTimes(1);
    const proc = M.spawned[0]!;

    M.execFile.mockImplementation((...args: unknown[]) => {
      (args.find((a) => typeof a === 'function') as (e: unknown) => void)(new Error('denied'));
    });

    const stopP = mgr.stop();
    await Promise.resolve(); // stop 이 killPullProcess(no-op) → taskkill → SIGKILL 까지 진행하도록 양보
    proc.emit('close'); // waitForExit resolve (5초 타이머 clear)
    await stopP;

    expect(M.execFile).toHaveBeenCalledWith(
      'taskkill',
      expect.arrayContaining(['/F', '/T', '/PID', String(proc.pid)]),
      expect.any(Function),
    );
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

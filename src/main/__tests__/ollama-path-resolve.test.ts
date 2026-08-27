import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * QA29(A-3) 회귀 넷 — ollama 실행 파일 경로 선택.
 *
 * 종전 `getOllamaPath()` 는 `existsSync` 로 **존재**만 보고 첫 후보를 반환했다. v1.2.3 이
 * 인스톨러에서 막 고친 "존재하면 실행된다" 는 전제 그대로다. 백신 격리·중단된 제거로
 * `Programs\Ollama\ollama.exe` 가 0바이트로 남으면 이후 모든 spawn 이 그 죽은 경로에 고정되고
 * **두 번째 후보나 PATH 로 절대 흘러가지 않는다** → getStatus 가 installed:false 를 보고하고
 * UI 는 재설치를 요구하는데, 정작 PATH 에는 멀쩡한 ollama 가 있다.
 */

const M = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => M.execFile(...a),
  spawn: (...a: unknown[]) => M.spawn(...a),
  ChildProcess: class {},
}));
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => M.existsSync(p),
    statSync: (p: string) => M.statSync(p),
  },
}));
vi.mock('http', () => ({ default: { get: vi.fn() } }));
vi.mock('https', () => ({ default: { get: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
}));

import { OllamaManager } from '../ollama-manager';

const PROGRAMS = 'C:\\LA\\Programs\\Ollama\\ollama.exe';
const APPDATA = 'C:\\UP\\AppData\\Local\\Ollama\\ollama.exe';

let realPlatform: PropertyDescriptor | undefined;

/** execFile 로 `--version` 이 호출된 실행 파일 경로들. */
function versionProbes(): string[] {
  return M.execFile.mock.calls
    .filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === '--version')
    .map((c) => c[0] as string);
}

/** 주어진 경로 집합만 `--version` 에 응답하도록. */
function answersVersion(ok: readonly string[]): void {
  M.execFile.mockImplementation((file: string, args: string[], _o: unknown, cb: (e: Error | null, out?: string) => void) => {
    if (args[0] !== '--version') { cb(null, ''); return; }
    if (ok.includes(file)) cb(null, 'ollama version 0.1.0');
    else cb(new Error('ENOENT'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env['LOCALAPPDATA'] = 'C:\\LA';
  process.env['USERPROFILE'] = 'C:\\UP';
  // 기본: 두 win32 경로 모두 없음
  M.existsSync.mockReturnValue(false);
  M.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
  answersVersion(['ollama']);
});

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

/** 존재하는 win32 후보를 설정한다. size 0 = 백신이 비운 스텁. */
function setInstalled(entries: Record<string, { size: number; isFile?: boolean }>): void {
  M.existsSync.mockImplementation((p: string) => p in entries);
  M.statSync.mockImplementation((p: string) => {
    const e = entries[p];
    if (!e) throw new Error('ENOENT');
    return { isFile: () => e.isFile !== false, size: e.size };
  });
}

describe('ollama 경로 선택 — 존재 ≠ 실행 가능 (QA29 A-3)', () => {
  it('0바이트 스텁이 첫 후보여도 PATH 폴백으로 흘러간다', async () => {
    setInstalled({ [PROGRAMS]: { size: 0 } });

    const ok = await new OllamaManager().isInstalled();

    expect(ok, 'PATH 에 멀쩡한 ollama 가 있는데 미설치로 보고하면 UI 가 재설치를 요구한다').toBe(true);
    expect(versionProbes(), '0바이트 후보를 실행 대상으로 잡으면 안 된다').not.toContain(PROGRAMS);
    expect(versionProbes()).toContain('ollama');
  });

  it('디렉터리가 후보 자리에 있어도 폴백한다', async () => {
    setInstalled({ [PROGRAMS]: { size: 4096, isFile: false } });

    expect(await new OllamaManager().isInstalled()).toBe(true);
    expect(versionProbes()).not.toContain(PROGRAMS);
  });

  it('크기는 있으나 --version 에 응답하지 않는 손상 바이너리 → 다음 후보로 흘러간다', async () => {
    setInstalled({ [PROGRAMS]: { size: 1234 }, [APPDATA]: { size: 5678 } });
    answersVersion([APPDATA]); // 첫 후보는 죽어 있고 두 번째가 산다

    const mgr = new OllamaManager();
    expect(await mgr.isInstalled()).toBe(true);
    expect(versionProbes(), '첫 후보에 고정되면 두 번째 설치본을 영영 못 쓴다').toContain(APPDATA);
  });

  it('정상 설치본이 첫 후보면 그것을 쓴다 (PATH 로 새지 않는다)', async () => {
    setInstalled({ [PROGRAMS]: { size: 9_000_000 } });
    answersVersion([PROGRAMS, 'ollama']);

    const mgr = new OllamaManager();
    await mgr.isInstalled();

    expect(versionProbes()[0]).toBe(PROGRAMS);
  });

  it('후보가 PATH 하나뿐이면 프로브를 추가하지 않는다 (spawn 수 종전 유지)', async () => {
    // 기본 상태: win32 경로 둘 다 없음
    await new OllamaManager().isInstalled();
    expect(versionProbes()).toEqual(['ollama']); // 선택 프로브 없이 isInstalled 의 1회뿐
  });

  it('선택 결과를 메모이즈한다 (호출마다 프로브 재실행 금지)', async () => {
    setInstalled({ [PROGRAMS]: { size: 9_000_000 } });
    answersVersion([PROGRAMS]);
    const mgr = new OllamaManager();

    await mgr.isInstalled();
    const afterFirst = versionProbes().length;
    await mgr.isInstalled();
    await mgr.isInstalled();

    // 선택 프로브 1회 + isInstalled 자체의 --version 이 호출마다 1회 = 3회 호출에 +2 만 늘어야 한다.
    expect(versionProbes().length).toBe(afterFirst + 2);
  });

  it('동시 호출은 선택 프로브를 공유한다', async () => {
    setInstalled({ [PROGRAMS]: { size: 9_000_000 } });
    answersVersion([PROGRAMS]);
    const mgr = new OllamaManager();

    await Promise.all([mgr.isInstalled(), mgr.isInstalled(), mgr.isInstalled()]);

    // 선택 프로브 1 + isInstalled 3 = 4. 공유하지 않으면 6 이 된다.
    expect(versionProbes().length).toBe(4);
  });

  // 결함의 실제 피해는 spawn 이 죽은 경로에 고정되는 것이다 — 조회만 고치고 실행 경로가
  // 그대로면 아무것도 나아지지 않는다.
  it('pull spawn 도 0바이트 스텁이 아니라 확정 경로를 쓴다', async () => {
    setInstalled({ [PROGRAMS]: { size: 0 } });
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    M.spawn.mockReturnValue(proc);

    const mgr = new OllamaManager();
    await mgr.isInstalled();          // 경로 확정
    const p = mgr.pullModel('gemma3');
    proc.emit('close', 0);
    await p;

    expect(M.spawn.mock.calls[0]![0]).toBe('ollama');
  });

  it('install() 후에는 다시 고른다 (방금 설치한 바이너리를 본다)', async () => {
    const mgr = new OllamaManager();
    await mgr.isInstalled(); // 설치 전: PATH 만 후보

    setInstalled({ [PROGRAMS]: { size: 9_000_000 } });
    answersVersion([PROGRAMS]);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); // 설치는 건너뛴다
    await mgr.install();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    M.execFile.mockClear();
    await mgr.isInstalled();

    expect(versionProbes(), '메모이즈가 남아 있으면 방금 설치한 경로를 영영 못 본다').toContain(PROGRAMS);
  });
});

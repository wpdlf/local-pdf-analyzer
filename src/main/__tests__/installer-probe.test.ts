import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { probeInstaller, type ProbeFsLike } from '../installer-probe';
import { isInstallerUsable, MIN_INSTALLER_BYTES } from '../update-policy';

/**
 * QA29(D-1) — v1.2.3 핫픽스("0바이트 인스톨러가 existsSync 를 통과해 앱이 조용히 꺼짐")의
 * 관측 절반에 대한 행위 회귀 넷.
 *
 * 종전에는 window-lifecycle.test 의 소스 토큰 스캔이 유일한 참조였고, 그 가드는 공허했다 —
 * `readSync(...) === 2` → `>= 0` 돌연변이가 토큰을 전부 남긴 채 통과한다. 아래는 그 돌연변이가
 * 다시 열어주는 입력들(0바이트 · 텍스트 스텁)을 실제 파일로 통과시킨다.
 */

const tmpDirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'probe-installer-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ }
  }
});

/** 정상 인스톨러 흉내 — PE 매직 + 크기 하한 초과. 내용은 관측 대상이 아니다. */
function writePeFile(filePath: string, size = MIN_INSTALLER_BYTES + 4096): void {
  const buf = Buffer.alloc(size);
  buf.write('MZ', 0, 'latin1');
  writeFileSync(filePath, buf);
}

describe('probeInstaller — 실파일 관측', () => {
  it('정상 PE 파일: exists/size/magic 을 모두 관측하고 판정이 통과한다', () => {
    const dir = makeDir();
    const f = path.join(dir, 'Setup.exe');
    writePeFile(f);
    const probe = probeInstaller(f);
    expect(probe.exists).toBe(true);
    expect(probe.magic).toBe('MZ');
    expect(probe.size).toBeGreaterThanOrEqual(MIN_INSTALLER_BYTES);
    expect(isInstallerUsable(probe)).toBe(true);
  });

  it('0바이트 파일: 매직을 읽지 못하므로 magic 은 빈 문자열이고 판정이 거부된다', () => {
    const dir = makeDir();
    const f = path.join(dir, 'Setup.exe');
    writeFileSync(f, Buffer.alloc(0));
    const probe = probeInstaller(f);
    // 존재는 한다 — 바로 이것이 existsSync 가드가 통과시켰던 입력이다.
    expect(probe.exists).toBe(true);
    expect(probe.size).toBe(0);
    // `readSync(...) === 2` 를 `>= 0` 으로 완화하면 여기서 'MZ' 가 아닌 잔여 버퍼가 매직이 된다.
    expect(probe.magic).not.toBe('MZ');
    expect(isInstallerUsable(probe)).toBe(false);
  });

  it('1바이트 파일: 매직 2바이트가 채워지지 않으므로 인정하지 않는다', () => {
    const dir = makeDir();
    const f = path.join(dir, 'Setup.exe');
    writeFileSync(f, Buffer.from('M', 'latin1'));
    const probe = probeInstaller(f);
    expect(probe.magic).not.toBe('MZ');
    expect(isInstallerUsable(probe)).toBe(false);
  });

  it('크기는 정상인데 PE 가 아닌 텍스트 스텁(백신 격리 알림 등): 판정이 거부된다', () => {
    const dir = makeDir();
    const f = path.join(dir, 'Setup.exe');
    const stub = Buffer.alloc(MIN_INSTALLER_BYTES + 1024, 0x20); // 공백으로 채운 대용량 텍스트
    stub.write('This file was quarantined by antivirus.', 0, 'latin1');
    writeFileSync(f, stub);
    const probe = probeInstaller(f);
    expect(probe.exists).toBe(true);
    expect(probe.size).toBeGreaterThanOrEqual(MIN_INSTALLER_BYTES);
    expect(probe.magic).toBe('Th');
    expect(isInstallerUsable(probe)).toBe(false);
  });

  it('없는 경로(ENOENT): exists=false 로 착지한다', () => {
    const dir = makeDir();
    const probe = probeInstaller(path.join(dir, 'nope.exe'));
    expect(probe).toEqual({ exists: false, size: 0, magic: '' });
    expect(isInstallerUsable(probe)).toBe(false);
  });

  it('디렉터리를 인스톨러 자리에 둔 경우: 파일이 아니므로 거부한다', () => {
    const dir = makeDir();
    const f = path.join(dir, 'Setup.exe');
    mkdirSync(f);
    const probe = probeInstaller(f);
    expect(probe.exists).toBe(false);
    expect(isInstallerUsable(probe)).toBe(false);
  });
});

describe('probeInstaller — 주입된 fs 로 관측 실패 처리', () => {
  const base: ProbeFsLike = {
    statSync: () => ({ isFile: () => true, size: MIN_INSTALLER_BYTES + 1 }),
    openSync: () => 7,
    readSync: (_fd, buf) => { buf.write('MZ', 0, 'latin1'); return 2; },
    closeSync: () => { /* noop */ },
  };

  it('statSync throw(권한/EBUSY): 판정을 거부 쪽으로 착지시킨다', () => {
    const probe = probeInstaller('x', { ...base, statSync: () => { throw new Error('EACCES'); } });
    expect(probe).toEqual({ exists: false, size: 0, magic: '' });
  });

  it('openSync throw: 크기를 알더라도 exists=false 로 착지한다 (부분 관측 금지)', () => {
    const probe = probeInstaller('x', { ...base, openSync: () => { throw new Error('EBUSY'); } });
    expect(probe.exists).toBe(false);
    expect(probe.size).toBe(0);
  });

  it('짧은 read(부분 읽기): 매직을 인정하지 않는다', () => {
    const probe = probeInstaller('x', {
      ...base,
      readSync: (_fd, buf) => { buf.write('M', 0, 'latin1'); return 1; },
    });
    expect(probe.exists).toBe(true);
    expect(probe.magic).toBe('');
    expect(isInstallerUsable(probe)).toBe(false);
  });

  it('읽기 성공 후에도 fd 를 닫는다 (핸들 누수 금지)', () => {
    let closed: number | null = null;
    probeInstaller('x', { ...base, closeSync: (fd) => { closed = fd; } });
    expect(closed).toBe(7);
  });

  it('read 가 throw 해도 fd 를 닫는다', () => {
    let closed: number | null = null;
    const probe = probeInstaller('x', {
      ...base,
      readSync: () => { throw new Error('EIO'); },
      closeSync: (fd) => { closed = fd; },
    });
    expect(closed).toBe(7);
    expect(probe.exists).toBe(false);
  });
});

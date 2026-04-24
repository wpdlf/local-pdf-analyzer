import { describe, it, expect } from 'vitest';
import { sanitizeErrorPath } from '../app-error-boundary';

// v0.18.5 M4 회귀 테스트 — 패키지된 Electron 앱에서 사용자에게 노출되는 error 메시지의
// 경로 정보 누수를 방어. Round 22 에서 "C:\Users\<u>, /Users/<u>, /home/<u> 3 패턴만
// 커버" 갭을 지적받아 Windows 드라이브 일반화 + UNC + Linux 시스템 경로까지 확장.

describe('sanitizeErrorPath · 사용자 홈 치환 (~)', () => {
  it('Windows C:\\Users\\jjw\\... → ~\\...', () => {
    const out = sanitizeErrorPath('ENOENT: no such file, open \'C:\\Users\\jjw\\Documents\\a.pdf\'');
    expect(out).not.toContain('jjw');
    expect(out).toContain('~');
  });

  it('Windows 다른 드라이브 D:\\Users\\alice\\... 도 치환', () => {
    const out = sanitizeErrorPath('Failed to read D:\\Users\\alice\\file.log');
    expect(out).not.toContain('alice');
    expect(out).toContain('~');
  });

  it('macOS /Users/bob/... → ~', () => {
    const out = sanitizeErrorPath('open /Users/bob/Library/Caches/foo');
    expect(out).not.toContain('bob');
    expect(out).toContain('~');
  });

  it('Linux /home/charlie/... → ~', () => {
    const out = sanitizeErrorPath('cannot read /home/charlie/project/file.ts');
    expect(out).not.toContain('charlie');
    expect(out).toContain('~');
  });
});

describe('sanitizeErrorPath · UNC 공유 경로', () => {
  it('\\\\server\\share\\... → <share>', () => {
    const out = sanitizeErrorPath('cannot access \\\\fileserver\\public\\docs\\x.pdf');
    expect(out).not.toContain('fileserver');
    expect(out).not.toContain('public');
    expect(out).toContain('<share>');
  });
});

describe('sanitizeErrorPath · Linux/macOS 시스템 경로', () => {
  const cases: Array<[string, string]> = [
    ['read /etc/passwd failed', '/etc/passwd'],
    ['cannot access /var/log/system.log', '/var/log/system.log'],
    ['open /usr/local/bin/node', '/usr/local/bin/node'],
    ['missing /opt/homebrew/bin', '/opt/homebrew/bin'],
    ['tmp overflow /tmp/cache', '/tmp/cache'],
    ['macOS /private/var/folders/x/y', '/private/var/folders/x/y'],
    ['/proc/self/exe exists', '/proc/self/exe'],
  ];
  for (const [input, leak] of cases) {
    it(`${input} → <system> 로 치환되어 '${leak}' 유출 없음`, () => {
      const out = sanitizeErrorPath(input);
      expect(out).not.toContain(leak);
      expect(out).toContain('<system>');
    });
  }
});

describe('sanitizeErrorPath · Windows 드라이브 일반 경로 (홈/시스템 외)', () => {
  it('D:\\Projects\\secret\\file.ts → <path>', () => {
    const out = sanitizeErrorPath('Module not found: D:\\Projects\\secret\\file.ts');
    expect(out).not.toContain('secret');
    expect(out).toContain('<path>');
  });

  it('E:\\Backup\\... 도 치환', () => {
    const out = sanitizeErrorPath('cannot read E:\\Backup\\2026\\q1.zip');
    expect(out).not.toContain('Backup');
    expect(out).toContain('<path>');
  });

  it('Windows 드라이브 경로 치환이 에러 메시지 끝까지 과잉 매치하지 않는다 (공백 경계 존중)', () => {
    const out = sanitizeErrorPath('failed at C:\\work\\x.ts because of reason Y');
    expect(out).toContain('because of reason Y');
  });
});

describe('sanitizeErrorPath · 안전 입력 (치환 불필요)', () => {
  it('경로가 없는 일반 에러 메시지는 변경 없음', () => {
    expect(sanitizeErrorPath('Cannot read property foo of undefined')).toBe('Cannot read property foo of undefined');
  });

  it('상대 경로는 치환 대상 아님', () => {
    expect(sanitizeErrorPath('./relative/path.ts failed')).toContain('./relative/path.ts');
  });

  it('URL 은 치환 대상 아님', () => {
    expect(sanitizeErrorPath('fetch https://api.example.com/v1 failed')).toContain('https://api.example.com/v1');
  });

  it('빈 문자열 안전', () => {
    expect(sanitizeErrorPath('')).toBe('');
  });
});

describe('sanitizeErrorPath · 치환 순서 보장', () => {
  it('사용자 홈이 시스템 경로보다 먼저 매치되어 ~/Library 같은 정보 보존 가능', () => {
    // /Users/bob/... → ~ 치환 후 나머지 "/Library/..." 은 시스템 경로 regex 에 걸리지 않음
    const out = sanitizeErrorPath('/Users/bob/Library/Caches/foo');
    expect(out).toBe('~/Library/Caches/foo');
  });

  it('UNC 가 드라이브보다 먼저 매치되어 이중 치환 방지', () => {
    const out = sanitizeErrorPath('\\\\srv\\share\\a');
    expect(out).toBe('<share>\\a');
  });
});

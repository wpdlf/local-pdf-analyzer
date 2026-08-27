/**
 * QA29(D1-2): 공용 주석 제거기의 회귀 넷.
 *
 * 이 헬퍼는 저장소의 소스 스캔 가드 10곳이 전부 의존하는 단일 지점이라, 여기가 조용히
 * 틀리면 **그 10곳이 동시에** 거짓 통과(주석에 매칭)하거나 거짓 실패(URL 손상)한다.
 * 그래서 양방향을 모두 고정한다.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripJsComments, stripYamlComments } from './helpers/source-scan';

describe('stripJsComments — 주석은 지우고 코드는 남긴다', () => {
  it('줄 주석과 블록 주석을 지운다', () => {
    const s = stripJsComments('const a = 1; // 주석 안의 secretToken\n/* 여러 줄\n secretToken */\nconst b = 2;');
    expect(s).not.toContain('secretToken');
    expect(s).toContain('const a = 1;');
    expect(s).toContain('const b = 2;');
  });

  it('줄 번호와 오프셋을 보존한다 (윈도 정규식이 그대로 동작해야 한다)', () => {
    const src = 'a\n// 주석\nb\n';
    const s = stripJsComments(src);
    expect(s.length).toBe(src.length);
    expect(s.split('\n').length).toBe(src.split('\n').length);
  });

  it('문자열 안의 URL 을 훼손하지 않는다 (`//` 를 순진하게 지우면 뒤가 날아간다)', () => {
    const src = [
      "const url = 'https://github.com/owner/repo/releases';",
      'const api = "http://127.0.0.1:11434/api/tags";',
      'const t = `https://example.com/${id}/x`;',
    ].join('\n');
    const s = stripJsComments(src);
    expect(s).toContain("'https://github.com/owner/repo/releases'");
    expect(s).toContain('"http://127.0.0.1:11434/api/tags"');
    expect(s).toContain('`https://example.com/${id}/x`');
  });

  it('URL 뒤에 오는 진짜 주석은 지운다 (URL 보호가 통째 면제로 번지면 안 된다)', () => {
    const s = stripJsComments("const u = 'https://a.example'; // 주석 안의 ghostToken");
    expect(s).toContain("'https://a.example'");
    expect(s).not.toContain('ghostToken');
  });

  it('정규식 리터럴 안의 `\\/\\/` 를 주석으로 오인하지 않는다', () => {
    const src = 'const re = /^https?:\\/\\//; const keep = 1;';
    const s = stripJsComments(src);
    expect(s).toContain('/^https?:\\/\\//');
    expect(s).toContain('const keep = 1;');
  });

  it('따옴표를 품은 정규식이 문자열 추적을 무너뜨리지 않는다', () => {
    // /['"]…['"]/ 는 이 저장소 소스에 실제로 흔하다. 문자열로 오인하면 뒤따르는 주석이
    // 살아남아(=지워지지 않아) 가드가 조용히 주석에 매칭하게 된다.
    const src = "const re = /['\"]([^'\"]+)['\"]/g; // 주석 안의 ghostToken\nconst keep = 2;";
    const s = stripJsComments(src);
    expect(s).not.toContain('ghostToken');
    expect(s).toContain('const keep = 2;');
  });

  it('나눗셈을 정규식으로 오인해 파일 나머지를 삼키지 않는다', () => {
    const src = 'const ratio = a / b; const half = c / 2;\nconst keep = 3;';
    expect(stripJsComments(src)).toBe(src);
  });

  it('JSX 텍스트의 홑따옴표(축약형)가 뒤쪽 주석 제거를 막지 않는다', () => {
    const src = "<p>it's fine</p>\n// 주석 안의 ghostToken\n<b/>";
    const s = stripJsComments(src);
    expect(s).toContain("it's fine");
    expect(s).not.toContain('ghostToken');
  });

  it('실제 소스에 걸어도 코드 토큰이 살아남는다 (헬퍼가 소스를 망가뜨리지 않는다)', () => {
    const root = resolve(import.meta.dirname, '../..');
    for (const [file, tokens] of [
      ['main/index.ts', ['ipcMain.handle(', 'new BrowserWindow(']],
      ['preload/index.ts', ['contextBridge.exposeInMainWorld(', 'ipcRenderer.invoke(']],
      ['renderer/App.tsx', ['selectUpdateBanner(', 'export default']],
    ] as const) {
      const raw = readFileSync(resolve(root, file), 'utf-8');
      const s = stripJsComments(raw);
      expect(s.length, `${file}: 길이가 바뀌었다`).toBe(raw.length);
      for (const t of tokens) expect(s, `${file}: ${t} 가 사라졌다`).toContain(t);
    }
  });
});

describe('stripYamlComments — 워크플로 주석', () => {
  it('`#` 주석을 지우고 코드는 남긴다', () => {
    const src = '      - uses: actions/checkout@abc # v6.0.2\n      # 설명 주석의 ghostToken\n      run: node x.mjs';
    const s = stripYamlComments(src);
    expect(s).toContain('actions/checkout@abc');
    expect(s).not.toContain('v6.0.2');
    expect(s).not.toContain('ghostToken');
    expect(s).toContain('run: node x.mjs');
  });

  it('공백이 앞서지 않는 `#` 은 주석이 아니다 (셸 파라미터 확장 보호)', () => {
    const src = 'run: echo "${VAR#prefix}"';
    expect(stripYamlComments(src)).toContain('${VAR#prefix}');
  });

  it('따옴표 안의 `#` 은 주석이 아니다', () => {
    const src = 'run: echo "a # b"';
    expect(stripYamlComments(src)).toContain('a # b');
  });

  it('줄 수를 보존한다', () => {
    const src = 'a: 1\n# c\nb: 2\n';
    expect(stripYamlComments(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('실제 워크플로에서 주석만 사라진다', () => {
    const root = resolve(import.meta.dirname, '../../..');
    for (const wf of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
      const raw = readFileSync(resolve(root, wf), 'utf8');
      const s = stripYamlComments(raw);
      expect(s.split('\n').length).toBe(raw.split('\n').length);
      expect(s).toContain('audit-shipped.mjs');
      // 주석 전용 관용구(SHA 핀 뒤 버전 표기)는 사라져야 한다.
      expect(raw).toMatch(/# v\d/);
      expect(s).not.toMatch(/# v\d/);
    }
  });
});

/**
 * QA29(D1-2) 구조적 종결.
 *
 * 이 라운드의 진짜 결함은 "8곳이 주석을 안 걷는다" 가 아니라 **한 곳씩 열거해 왔다는 것**이다
 * (이 저장소의 최다 결함 클래스 = 형제 누락). 그래서 목록을 손으로 들고 있지 않고, 소스 파일을
 * 읽는 테스트를 **도출**해서 전부가 공용 제거기를 쓰는지 본다 — 11번째 가드가 새로 생기면
 * 그것도 자동으로 이 규칙 아래로 들어온다.
 */
describe('소스 스캔 가드는 전부 공용 제거기를 쓴다 (열거 금지)', () => {
  const SRC_ROOT = resolve(import.meta.dirname, '../..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /** 소스(.ts/.tsx/.yml)를 텍스트로 읽는 테스트인가 — 경로 리터럴 형태와 readdir 필터 형태 둘 다. */
  function scansSource(src: string): boolean {
    if (/readFileSync\([\s\S]{0,240}?\.(?:tsx?|ya?ml)['"`]/.test(src)) return true;
    return src.includes('readdirSync') && src.includes('readFileSync') && /endsWith\(['"]\.tsx?['"]\)/.test(src);
  }

  it('소스를 텍스트로 읽는 테스트는 예외 없이 source-scan 헬퍼를 임포트한다', () => {
    const files = walk(SRC_ROOT).filter((f) => scansSource(readFileSync(f, 'utf8')));
    // 도출이 0건이 되면(정규식이 낡으면) 이 가드는 조용히 공허해진다 — 하한을 먼저 못박는다.
    expect(files.length, '소스 스캔 가드를 한 건도 찾지 못했다 — 이 가드가 무력화된 상태다')
      .toBeGreaterThanOrEqual(10);
    const offenders = files
      .filter((f) => !readFileSync(f, 'utf8').includes('helpers/source-scan'))
      .map((f) => f.slice(SRC_ROOT.length + 1).split('\\').join('/'));
    expect(offenders, `원본 소스에 매칭하는 가드: ${offenders.join(', ')} — 주석에 매칭해 조용히 통과한다`)
      .toEqual([]);
  });
});

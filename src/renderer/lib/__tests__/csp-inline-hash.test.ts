// R37 P5-1 (v0.18.23): CSP `script-src 'sha256-...'` 게이트.
//
// src/renderer/index.html 의 인라인 스크립트가 변경되면 CSP 의 sha256 hash 와 어긋나
// 패키지 빌드 후 첫 실행에서 화이트 페이지가 된다(콘솔에 CSP violation, FOUC 방지 스크립트
// 차단). 본 테스트는 빌드 전 단계(`npm test`)에서 이 mismatch 를 잡아 hash 갱신을 강제한다.
//
// 새 hash 계산: `node -e "const fs=require('fs'),c=require('crypto');const m=fs.readFileSync('src/renderer/index.html','utf-8').match(/<script>([\s\S]*?)<\/script>/);console.log('sha256-'+c.createHash('sha256').update(m[1],'utf-8').digest('base64'))"`
//
// 인라인 스크립트가 여러 개가 되면 본 테스트를 각 hash 화이트리스트 검증으로 확장.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

describe('CSP inline-script sha256 gate', () => {
  const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf-8');

  it('인라인 <script> 가 정확히 1건이다 (다중 hash 화이트리스트 마이그레이션 필요 시 본 가정 갱신)', () => {
    const matches = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('인라인 스크립트의 sha256 이 CSP 의 화이트리스트와 일치한다', () => {
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const content = scriptMatch![1]!;
    const actualHash = 'sha256-' + createHash('sha256').update(content, 'utf-8').digest('base64');

    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const cspValue = cspMatch![1]!;

    // CSP 의 script-src 디렉티브에서 sha256-* 토큰 추출.
    const scriptSrcMatch = cspValue.match(/script-src\s+([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = scriptSrcMatch![1]!;

    // 'unsafe-inline' 회귀 방지 — 한 번 제거된 후 다시 들어오면 게이트 실패.
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);

    // 화이트리스트에 actual hash 가 단일 인용부호로 감싸 포함되어야 함.
    expect(scriptSrc).toContain(`'${actualHash}'`);
  });
});

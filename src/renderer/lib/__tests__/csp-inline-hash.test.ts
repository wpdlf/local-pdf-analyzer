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
import { stripHtmlComments } from '../../../shared/__tests__/helpers/source-scan';

describe('CSP inline-script sha256 gate', () => {
  // CRLF → LF 정규화: CSP hash 는 LF 기준으로 산출됐고 빌드 산출물도 .gitattributes(eol=lf)로
  // LF 고정이다. autocrlf=true 인 Windows 환경에서 체크아웃이 CRLF 여도 테스트가 환경 독립적으로
  // 동일 해시를 계산하도록 정규화한다 (R37 P5-1 CI Windows 회귀 fix).
  // QA31(B·D 수렴): 원본을 그대로 읽어 **주석 처리된 옛 CSP** 를 검사하고 있었다. `.match` 가
  // 비-global 이라 파일의 첫 CSP 문자열을 잡는데, 실물 meta 위에 옛 CSP 를 주석으로 남기기만 하면
  // 실물이 script-src 'unsafe-inline' 이어도 이 파일 2/2 가 통과한다(실측). 주석부터 걷는다.
  const html = stripHtmlComments(
    readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf-8'),
  ).replace(/\r\n/g, '\n');

  it('주석 처리된 CSP 를 검사하지 않는다 (제거기가 실제로 걸렸는지)', () => {
    // QA31(B·D 수렴): 이 파일이 index.html 을 원본으로 읽던 시절, 실물 meta 를
    // `script-src 'self' 'unsafe-inline'` 으로 망가뜨리고 올바른 CSP 를 그 위에 주석으로
    // 남기면 아래 두 단언이 **주석을 검사해** 2/2 통과했다(양쪽 축이 각자 뮤테이션으로 재현).
    // `html` 은 이제 stripHtmlComments 를 거친 값이다 — 그 사실을 여기서 못박는다.
    //
    // index.html 의 CSP meta 바로 위에는 sha256 리터럴이 든 설명 주석이 실재하므로,
    // 제거기가 빠지면 'CSP 주석' 이 살아남아 이 단언이 실패한다.
    expect(html, '제거기가 걸리지 않았다 — 주석이 그대로 남아 있다').not.toContain('CSP 주석');
    expect(
      [...html.matchAll(/Content-Security-Policy/g)],
      '주석을 걷고 나면 CSP 는 살아있는 meta 하나뿐이어야 한다',
    ).toHaveLength(1);
  });

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

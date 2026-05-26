import { describe, it, expect } from 'vitest';

// v0.18.22: isLocalhostHost 단위 테스트. 4개 IPC 호출 지점이 본 헬퍼로 통일되었으므로
// 본 함수의 회귀가 곧 전체 SSRF 가드의 회귀가 된다 — 단일 표면 보호.
//
// 이전엔 각 호출 지점이 `LOCALHOST_HOSTS.includes(parsed.hostname)` 을 직접 호출했고,
// WHATWG URL parser 의 IPv6 hostname 출력 `[::1]` (괄호 포함) 과 LOCALHOST_HOSTS 의
// `::1` (괄호 없음) mismatch 로 IPv6 loopback 이 의도와 달리 차단됐다.
// isLocalhostHost 가 괄호 정규화로 해결.

import { isLocalhostHost, LOCALHOST_HOSTS } from '../constants';

describe('isLocalhostHost (v0.18.22 IPv6 fix)', () => {
  it('IPv4 literal: localhost / 127.0.0.1 모두 통과', () => {
    expect(isLocalhostHost('localhost')).toBe(true);
    expect(isLocalhostHost('127.0.0.1')).toBe(true);
  });

  it('IPv6 loopback `[::1]` (URL parser 출력) — 괄호 정규화로 통과', () => {
    expect(isLocalhostHost('[::1]')).toBe(true);
  });

  it('IPv6 loopback `::1` (raw socket 형태) — 정규화 없이도 통과', () => {
    expect(isLocalhostHost('::1')).toBe(true);
  });

  it('외부 호스트는 차단 (LAN/공인 IP/도메인/IMDS)', () => {
    expect(isLocalhostHost('evil.com')).toBe(false);
    expect(isLocalhostHost('192.168.1.1')).toBe(false);
    expect(isLocalhostHost('10.0.0.1')).toBe(false);
    expect(isLocalhostHost('169.254.169.254')).toBe(false); // AWS/GCP IMDS
    expect(isLocalhostHost('127.0.0.2')).toBe(false); // 127.0.0.0/8 내 다른 IP
  });

  it('빈 문자열 / 비문자열 입력은 안전하게 false', () => {
    expect(isLocalhostHost('')).toBe(false);
    // @ts-expect-error — 방어적 type 검사 동작 확인
    expect(isLocalhostHost(undefined)).toBe(false);
    // @ts-expect-error
    expect(isLocalhostHost(null)).toBe(false);
    // @ts-expect-error
    expect(isLocalhostHost(123)).toBe(false);
  });

  it('대괄호 우회 시도 — 비정상 중간 괄호는 매칭 실패 (방어적)', () => {
    expect(isLocalhostHost('[evil.com]')).toBe(false);   // 괄호 우회 — 내부는 외부 호스트
    expect(isLocalhostHost('localhost]')).toBe(false);   // 단일 트레일링 괄호
    expect(isLocalhostHost('[localhost')).toBe(false);   // 단일 리딩 괄호 (mismatch)
    expect(isLocalhostHost('[localhost]')).toBe(true);   // 정상 양끝 — 정규화 후 'localhost' 매칭
  });

  it('LOCALHOST_HOSTS readonly array 가 의도된 3개만 포함 (drift 가드)', () => {
    expect(LOCALHOST_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(LOCALHOST_HOSTS).toHaveLength(3);
  });

  // 실 사용 시나리오: new URL(...).hostname 이 4개 IPC 경계에서 isLocalhostHost 에 전달된다.
  // 본 테스트는 그 통합 경로를 직접 확인.
  it('실 사용 시나리오: new URL(...).hostname 통합 — 모든 localhost 형태가 통과', () => {
    const urls = [
      'http://localhost:11434',
      'http://localhost:11434/api/generate',
      'https://localhost',
      'http://127.0.0.1:11434',
      'http://[::1]:11434',
      'https://[::1]/api/embeddings',
    ];
    for (const u of urls) {
      const hostname = new URL(u).hostname;
      expect(isLocalhostHost(hostname), `${u} (hostname=${hostname}) 는 localhost 여야 함`).toBe(true);
    }
  });

  it('실 사용 시나리오: 외부 URL hostname 은 모두 차단', () => {
    const urls = [
      'http://evil.com',
      'http://user:pass@evil.com:11434', // userinfo 우회 시도
      'http://169.254.169.254/latest/meta-data',
      'http://attacker.localhost.evil.com', // 서브도메인 우회 시도
    ];
    for (const u of urls) {
      const hostname = new URL(u).hostname;
      expect(isLocalhostHost(hostname), `${u} (hostname=${hostname}) 는 차단되어야 함`).toBe(false);
    }
  });
});

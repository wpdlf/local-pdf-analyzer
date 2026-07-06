import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// v0.18.22 Top5 #1 (test coverage): ai-service.ts 의 SSRF 가드 (`validateOllamaUrl`) 와
// activeRequests 등록/해제/cleanup 단위 테스트. main 모듈은 `electron` 을 import 하므로
// vitest 에서 직접 import 하려면 모킹이 필요하다. BrowserWindow 는 본 테스트에서 사용되지 않고
// http/https 도 호출되지 않으므로 dummy export 면 충분하다.
//
// 본 테스트는 R31~R35 누적 회귀의 근본 원인 분석에서 "ai-service 핵심 SSRF/abort 로직이
// 단위 테스트 0건" 이었던 갭을 메운다.

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return []; }
  },
}));

import {
  validateOllamaUrl,
  registerEmbedRequest,
  unregisterEmbedRequest,
  abortGenerate,
  cleanupAiService,
  abortAllRequests,
} from '../ai-service';

describe('validateOllamaUrl — SSRF 방어 (Top5 #1)', () => {
  it('http://localhost:11434 (기본값) 허용', () => {
    expect(() => validateOllamaUrl('http://localhost:11434')).not.toThrow();
  });

  it('http://127.0.0.1 / https://127.0.0.1 / http://[::1] (IPv6 loopback) 허용', () => {
    expect(() => validateOllamaUrl('http://127.0.0.1:11434')).not.toThrow();
    expect(() => validateOllamaUrl('https://127.0.0.1:11434')).not.toThrow();
    // v0.18.22: 이전엔 WHATWG URL parser 의 `[::1]` (괄호 포함) hostname 이 LOCALHOST_HOSTS 의
    // `::1` (괄호 없음) 과 mismatch 로 차단됐다. isLocalhostHost 가 괄호 정규화로 해결.
    expect(() => validateOllamaUrl('http://[::1]:11434')).not.toThrow();
    expect(() => validateOllamaUrl('https://[::1]:11434')).not.toThrow();
  });

  it('ftp:// / ws:// / file:// 등 비 http(s) 프로토콜은 차단', () => {
    expect(() => validateOllamaUrl('ftp://localhost:11434')).toThrow(/허용되지 않는 프로토콜/);
    expect(() => validateOllamaUrl('ws://localhost:11434')).toThrow(/허용되지 않는 프로토콜/);
    expect(() => validateOllamaUrl('file:///etc/passwd')).toThrow(/허용되지 않는 프로토콜/);
  });

  it('localhost 외 외부 호스트는 차단 (LAN/외부 IP 포함)', () => {
    expect(() => validateOllamaUrl('http://evil.com:11434')).toThrow(/허용되지 않는 Ollama 호스트/);
    expect(() => validateOllamaUrl('http://192.168.1.1:11434')).toThrow(/허용되지 않는 Ollama 호스트/);
    expect(() => validateOllamaUrl('http://10.0.0.1')).toThrow(/허용되지 않는 Ollama 호스트/);
    // metadata service IP — 클라우드 IMDS exfiltration 대표 패턴
    expect(() => validateOllamaUrl('http://169.254.169.254')).toThrow(/허용되지 않는 Ollama 호스트/);
  });

  it('말형 URL 은 TypeError 를 사용자 친화 메시지로 변환', () => {
    expect(() => validateOllamaUrl('not-a-url')).toThrow(/올바르지 않은 Ollama URL 형식/);
    expect(() => validateOllamaUrl('')).toThrow(/올바르지 않은 Ollama URL 형식/);
  });

  it('SSRF 우회 시도: hostname 에 username/password 가 박힌 형태도 hostname 만 검증', () => {
    // new URL('http://user:pass@evil.com').hostname === 'evil.com'
    expect(() => validateOllamaUrl('http://user:pass@evil.com:11434')).toThrow(/허용되지 않는 Ollama 호스트/);
  });
});

describe('activeRequests 등록/해제/cleanup (Top5 #1)', () => {
  // 각 테스트 진입 시 cleanupAiService 로 깨끗한 상태 보장.
  // (모듈 단일 인스턴스 + vitest fork 격리이지만 본 파일 내 테스트 간 격리 명시).
  beforeEach(() => {
    cleanupAiService();
  });
  afterEach(() => {
    cleanupAiService();
  });

  it('registerEmbedRequest 등록 후 abortGenerate 호출 시 controller.abort() 가 실행되고 entry 제거', () => {
    const c = new AbortController();
    registerEmbedRequest('rag-1', c);
    expect(c.signal.aborted).toBe(false);

    abortGenerate('rag-1');
    expect(c.signal.aborted).toBe(true);

    // 두 번째 abortGenerate 는 entry 가 없어 no-op (이미 삭제됨)
    expect(() => abortGenerate('rag-1')).not.toThrow();
  });

  it('동일 requestId 재진입 등록 시 이전 controller 가 abort 되고 새 controller 가 자리 차지', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    registerEmbedRequest('rag-2', c1);
    registerEmbedRequest('rag-2', c2);
    // 이전 controller 가 자동 abort
    expect(c1.signal.aborted).toBe(true);
    // 새 controller 는 살아있음
    expect(c2.signal.aborted).toBe(false);

    // 새 controller 만 abort 대상이어야 함
    abortGenerate('rag-2');
    expect(c2.signal.aborted).toBe(true);
  });

  it('unregisterEmbedRequest identity 가드: 다른 controller 가 같은 id 를 점유하면 삭제하지 않는다 (R29 회귀)', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    registerEmbedRequest('rag-3', c1);
    registerEmbedRequest('rag-3', c2);  // c1 자동 abort, c2 가 현재 owner

    // c1 의 stale finally 가 unregister 시도 — identity 미일치로 c2 entry 보존
    unregisterEmbedRequest('rag-3', c1);

    // c2 는 여전히 owner — abortGenerate 가 c2 를 abort 할 수 있어야 함
    abortGenerate('rag-3');
    expect(c2.signal.aborted).toBe(true);
  });

  it('unregisterEmbedRequest legacy 호출 (controller 미전달) 은 무조건 entry 제거', () => {
    const c = new AbortController();
    registerEmbedRequest('rag-4', c);
    unregisterEmbedRequest('rag-4');
    // 삭제 후 abortGenerate 는 no-op (controller 는 abort 되지 않음)
    abortGenerate('rag-4');
    expect(c.signal.aborted).toBe(false);
  });

  it('cleanupAiService 가 모든 entry 의 abort 를 호출하고 map 을 비운다 (앱 종료 경로)', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const c3 = new AbortController();
    registerEmbedRequest('rag-5', c1);
    registerEmbedRequest('rag-6', c2);
    registerEmbedRequest('rag-7', c3);

    cleanupAiService();

    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(c3.signal.aborted).toBe(true);

    // 이후 abortGenerate 는 모두 no-op (entry 가 사라졌으므로 controller 재호출 없음).
    // 같은 controller 의 abort 호출은 idempotent 라 검증 불가하지만, entry 삭제는 확인 가능 —
    // 새 controller 를 같은 id 로 등록해도 이전 c1 이 abort 되지 않아야 함.
    const fresh = new AbortController();
    registerEmbedRequest('rag-5', fresh);
    // c1 은 이미 cleanupAiService 가 abort 했음 — 이중 abort 가 일어나도 idempotent.
    expect(fresh.signal.aborted).toBe(false);
  });

  // QA7(B-MED): 렌더러 새로고침/크래시 시 in-flight 전량 abort (TTL 타이머는 유지 — 종료 아님).
  it('abortAllRequests 가 모든 entry 를 abort + map 비우고 count 반환 (TTL 타이머 유지)', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    registerEmbedRequest('rag-8', c1);
    registerEmbedRequest('rag-9', c2);

    const n = abortAllRequests();

    expect(n).toBe(2);
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    // 두 번째 호출은 빈 상태라 0
    expect(abortAllRequests()).toBe(0);
    // entry 삭제 확인 — 같은 id 로 새 controller 등록 시 이전 것이 재abort 되지 않음
    const fresh = new AbortController();
    registerEmbedRequest('rag-8', fresh);
    expect(fresh.signal.aborted).toBe(false);
  });
});

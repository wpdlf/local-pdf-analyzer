import { describe, it, expect } from 'vitest';
import { stripAnsi, extractLastLine, toProgressEvent } from '../ollama-pull-progress';

/**
 * R37 P6 (v0.18.23) — `ollama pull` 출력 파싱 회귀 가드 (QA M5).
 *
 * OllamaManager 는 electron import 로 vitest 가 직접 import 불가(R15 H1 / R28 P2 회귀 영역).
 * pull 진행 파싱은 ps-quote 와 동일하게 별도 순수 모듈로 분리해 여기서 가드한다.
 */
describe('stripAnsi', () => {
  it('색상/커서 ANSI 시퀀스를 제거한다', () => {
    expect(stripAnsi('\x1b[32mpulling\x1b[0m')).toBe('pulling');
    expect(stripAnsi('\x1b[2K\x1b[1Gpulling 50%')).toBe('pulling 50%');
  });

  it('ANSI 가 없으면 원문 유지', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('extractLastLine', () => {
  it('\\r 로 덮어쓴 진행 출력에서 마지막 줄만 취한다', () => {
    // ollama 는 같은 줄을 \r 로 갱신 — 마지막 진행률이 최종.
    const raw = 'pulling 10%\rpulling 50%\rpulling 90%';
    expect(extractLastLine(raw)).toBe('pulling 90%');
  });

  it('\\r 과 \\n 혼용을 모두 분할한다', () => {
    expect(extractLastLine('pulling manifest\npulling abc 30%\r')).toBe('pulling abc 30%');
  });

  it('끝의 공백 줄/개행을 무시하고 마지막 실데이터 줄 반환', () => {
    expect(extractLastLine('success\n\n   \n')).toBe('success');
  });

  it('ANSI 가 섞여 있어도 정리 후 마지막 줄 추출', () => {
    expect(extractLastLine('\x1b[2K pulling 5%\r\x1b[2K pulling 80%')).toBe('pulling 80%');
  });

  it('빈 입력은 빈 문자열', () => {
    expect(extractLastLine('')).toBe('');
    expect(extractLastLine('\r\n  \r\n')).toBe('');
  });
});

// R44(R43 후속 F3): 한국어 완성 문자열 → 구조화 이벤트로 전환. renderer i18n 의
// mainprog.<key> 와 키가 일치해야 한다 (i18n.ts 양쪽 동기 갱신).
describe('toProgressEvent', () => {
  it('"pulling <hash> ... NN%" 에서 퍼센트를 추출해 pulling 이벤트로 변환', () => {
    expect(toProgressEvent('pulling a1b2c3 100% ▕████▏ 1.2 GB')).toEqual({ key: 'pulling', params: { percent: '100%' } });
    expect(toProgressEvent('pulling deadbeef  37%')).toEqual({ key: 'pulling', params: { percent: '37%' } });
  });

  it('pulling manifest → pullingManifest', () => {
    expect(toProgressEvent('pulling manifest')).toEqual({ key: 'pullingManifest' });
  });

  it('verifying → verifying', () => {
    expect(toProgressEvent('verifying sha256 digest')).toEqual({ key: 'verifying' });
  });

  it('writing → writing', () => {
    expect(toProgressEvent('writing manifest')).toEqual({ key: 'writing' });
  });

  it('success → success', () => {
    expect(toProgressEvent('success')).toEqual({ key: 'success' });
  });

  it('퍼센트 없는 pulling <hash> 는 preparing', () => {
    expect(toProgressEvent('pulling a1b2c3d4')).toEqual({ key: 'preparing' });
  });

  it('매핑되지 않는 줄은 raw passthrough', () => {
    expect(toProgressEvent('Error: connection refused')).toEqual({ key: 'raw', params: { text: 'Error: connection refused' } });
  });

  it('대소문자 무관하게 상태를 인식한다', () => {
    expect(toProgressEvent('VERIFYING sha256')).toEqual({ key: 'verifying' });
    expect(toProgressEvent('Success')).toEqual({ key: 'success' });
  });
});

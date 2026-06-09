import { describe, it, expect } from 'vitest';
import { hashDocumentText, bufferToHex } from '../session-hash';

// session-persistence module-1 (L1): 콘텐츠 해시 — 동일 내용 → 동일 키, 변경 → 무효화.
describe('session-hash (L1)', () => {
  it('동일 텍스트는 동일한 64자 hex 해시', async () => {
    const a = await hashDocumentText('강의 자료 본문 내용');
    const b = await hashDocumentText('강의 자료 본문 내용');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('다른 텍스트는 다른 해시 (콘텐츠 변경 → 캐시 무효화)', async () => {
    const a = await hashDocumentText('document A');
    const b = await hashDocumentText('document B');
    expect(a).not.toBe(b);
  });

  it('알려진 SHA-256 테스트 벡터 ("abc")', async () => {
    expect(await hashDocumentText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('bufferToHex 는 0-padding 된 lowercase hex', () => {
    const buf = new Uint8Array([0, 1, 15, 16, 255]).buffer;
    expect(bufferToHex(buf)).toBe('00010f10ff');
  });
});

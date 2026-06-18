// @vitest-environment happy-dom

// expandToRgba 순수 분류·확장 분기 가드 (post-v0.24.4 QA #2).
//
// imageDataToBase64 의 RGBA/RGB/grayscale 분류 + 확장 루프는 순수 typed-array 연산이지만
// canvas(OffscreenCanvas/putImageData) 경로에 묶여 happy-dom 으로 못 돌렸다. 해당 로직을
// expandToRgba 로 추출(행위 보존)해 길이 기반 포맷 추정·픽셀 확장·비지원 거부를 직접 검증한다.
// pdf-parser 모듈 import 가 pdfjs/worker/use-session 를 끌어오므로 handle.test 와 동일하게 목 격리.

import { describe, it, expect, vi } from 'vitest';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), OPS: { paintImageXObject: 85 } }));
vi.mock('../use-session', () => ({ restoreSessionForDocument: vi.fn(), persistCurrentSession: vi.fn() }));

import { expandToRgba } from '../pdf-parser';

describe('expandToRgba — 포맷 추정 + RGBA 확장', () => {
  it('RGBA(px*4): 그대로 복사', () => {
    // 2x1 = 2px, RGBA 8바이트
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = expandToRgba(2, 1, data);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('RGBA 초과 길이: px*4 로 절단 복사', () => {
    // 1px RGBA(4) + 꼬리 2바이트 → 앞 4바이트만
    const data = new Uint8ClampedArray([1, 2, 3, 4, 99, 99]);
    const out = expandToRgba(1, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 4]);
  });

  it('RGB(px*3): 각 픽셀 알파 255 부여', () => {
    // 2px RGB 6바이트
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('grayscale(px): R=G=B=v + 알파 255', () => {
    // 2px grayscale 2바이트
    const data = new Uint8ClampedArray([120, 200]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([120, 120, 120, 255, 200, 200, 200, 255]);
  });

  it('1바이트/픽셀 미만: 비지원 → null', () => {
    // 4px(2x2) 인데 데이터 3바이트 → grayscale 임계(px=4) 미달
    const data = new Uint8ClampedArray([1, 2, 3]);
    expect(expandToRgba(2, 2, data)).toBeNull();
  });

  it('경계: 길이 == px → grayscale 분류', () => {
    const data = new Uint8ClampedArray([7, 8, 9, 10]); // 4px exactly
    const out = expandToRgba(2, 2, data);
    expect(out!.length).toBe(16);
    expect([out![0], out![1], out![2], out![3]]).toEqual([7, 7, 7, 255]);
  });

  it('경계: 길이 == px*3 → RGB 분류 (grayscale 보다 우선)', () => {
    // 2px*3 = 6 → RGB (grayscale 임계 2 도 넘지만 RGB 가 우선)
    const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('경계: 길이 == px*4 → RGBA 분류 (RGB 보다 우선)', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4]); // 1px*4
    const out = expandToRgba(1, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 4]);
  });

  it('Uint8ClampedArray 클램핑: 255 초과 입력은 255 로 (alpha 채움도 동일 타입)', () => {
    // grayscale 경로에서 출력 컨테이너가 Uint8ClampedArray 인지 확인
    const data = new Uint8ClampedArray([300]); // 1px, 클램프되어 255 저장
    const out = expandToRgba(1, 1, data);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(out!)).toEqual([255, 255, 255, 255]);
  });
});

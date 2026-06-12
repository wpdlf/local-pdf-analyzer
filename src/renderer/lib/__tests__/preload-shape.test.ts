import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// v0.18.19 patch R34 P2: preload contextBridge 노출 surface 의 drift 가드.
//
// `src/preload/index.ts` 는 electron 의 `contextBridge`/`ipcRenderer` 를 import 하므로
// vitest 의 node 환경에서 직접 import 불가. 대신 source 텍스트를 정적으로 읽어 노출되는
// 키 집합 + IPC channel 이름이 기대값과 일치함을 검증한다 (snapshot 식 가드).
//
// 발견되는 결함:
//   1. IPC channel 이름 drift (예: preload 가 `ai:ocr-page` 를 호출하는데 main 이
//      `ai:ocrPage` 로 핸들러 등록) — 본 테스트는 preload 측 channel 이름만 검사
//   2. 노출 surface 추가/제거 — `electronAPI` 의 top-level 키 집합 변경
//   3. 함수 시그니처 변경 — 인자 개수 (정규식 기반 spot check)
//
// 한계: main process 의 핸들러 채널과 cross-check 는 본 테스트 범위 밖.

// R45 fix: CRLF 정규화 — Windows CI 체크아웃(autocrlf)은 줄당 +1자라 아래 길이 제한 윈도
// 매칭이 OS 에 따라 갈렸다 (windows-2025 잡만 실패, ubuntu/로컬 LF 는 통과하던 비결정성 제거).
const PRELOAD_SRC = readFileSync(
  resolve(import.meta.dirname, '../../../preload/index.ts'),
  'utf-8',
).replace(/\r\n/g, '\n');

describe('preload contextBridge shape (R34 P2)', () => {
  it('expose target 은 정확히 `electronAPI` 라는 이름이어야 한다', () => {
    expect(PRELOAD_SRC).toMatch(/exposeInMainWorld\(['"]electronAPI['"]/);
  });

  it('top-level 키 집합 — ollama / ai / file / settings / apiKey / openExternal / onSetupProgress / onFileDropped', () => {
    const expectedTopKeys = [
      'ollama:', 'ai:', 'file:', 'settings:', 'apiKey:',
      'openExternal:', 'onSetupProgress:', 'onFileDropped:', 'getPathForFile:',
    ];
    for (const key of expectedTopKeys) {
      expect(PRELOAD_SRC).toContain(`  ${key}`);
    }
  });

  it('IPC channel 이름 — 모든 known channel 이 source 에 존재', () => {
    const expectedChannels = [
      'ollama:status', 'ollama:install', 'ollama:start', 'ollama:stop',
      'ollama:pull-model', 'ollama:cancel-pull', 'ollama:list-models',
      'ai:generate', 'ai:abort', 'ai:check-available',
      'ai:analyze-image', 'ai:ocr-page', 'ai:embed', 'ai:check-embed-model',
      'ai:token', 'ai:done',
      'file:save', 'file:open-pdf',
      'settings:get', 'settings:set',
      'apikey:save', 'apikey:has', 'apikey:delete',
      'shell:open-external',
      'setup:progress', 'file:dropped',
    ];
    for (const ch of expectedChannels) {
      expect(PRELOAD_SRC).toContain(`'${ch}'`);
    }
  });

  it('ai.ocrPage 시그니처는 (imageBase64, requestId?) — R32 P2 OCR cloud abort 회귀 가드', () => {
    // R32 P2 가 ocrPage 에 requestId 인자를 추가했음. drift 되면 OCR abort 가 다시 무력화됨.
    expect(PRELOAD_SRC).toMatch(/ocrPage:\s*\(imageBase64:\s*string,\s*requestId\?:\s*string\)/);
    expect(PRELOAD_SRC).toMatch(/ipcRenderer\.invoke\(\s*['"]ai:ocr-page['"],\s*imageBase64,\s*requestId\s*\)/);
  });

  it('ai.embed 시그니처는 (texts, requestId?) — R29 회귀 가드', () => {
    expect(PRELOAD_SRC).toMatch(/embed:\s*\(texts:\s*string\[\],\s*requestId\?:\s*string\)/);
  });

  it('ai.analyzeImage 시그니처는 (imageBase64, requestId?) — R30 P2 회귀 가드', () => {
    expect(PRELOAD_SRC).toMatch(/analyzeImage:\s*\(imageBase64:\s*string,\s*requestId\?:\s*string\)/);
  });

  it('openExternal 은 https:// prefix 가드 + invoke 직접 wiring 유지', () => {
    // R28 P2 에 도입된 renderer-side 가드 — main 까지 도달 전에 차단
    expect(PRELOAD_SRC).toMatch(/openExternal:\s*\(url:\s*string\)\s*=>\s*{[\s\S]*?startsWith\(['"]https:\/\/['"]\)/);
  });

  it('ElectronAPI 타입이 source 마지막에 export 되어 renderer 가 참조 가능', () => {
    expect(PRELOAD_SRC).toMatch(/export type ElectronAPI/);
  });

  it('declare global 로 Window.electronAPI 타입 확장', () => {
    expect(PRELOAD_SRC).toMatch(/declare global/);
    expect(PRELOAD_SRC).toMatch(/interface Window\s*{/);
    expect(PRELOAD_SRC).toMatch(/electronAPI:\s*ElectronAPI/);
  });

  it('on* listeners 모두 unsubscribe 함수 반환 (memory leak 가드)', () => {
    // ai.onToken, ai.onDone, onSetupProgress, onFileDropped 모두 removeListener 반환
    const onPatterns = ['onToken', 'onDone', 'onSetupProgress', 'onFileDropped'];
    for (const name of onPatterns) {
      // 각 listener 가 ipcRenderer.removeListener 를 반환하는지 source 에서 패턴 매칭
      const escaped = name.replace(/\$/g, '\\$');
      // R45: onSetupProgress 시그니처가 source/model 필드로 길어져 400자 윈도를 초과 — 600 으로 확장
      const block = PRELOAD_SRC.match(new RegExp(`${escaped}:[\\s\\S]{0,600}?removeListener`));
      expect(block, `${name} 에서 removeListener 가 보이지 않음 — memory leak 회귀 가능`).not.toBeNull();
    }
  });
});

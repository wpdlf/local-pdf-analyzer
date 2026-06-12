import { defineConfig } from '@playwright/test';

// R45: E2E 스모크 트랙 (R38 테스트 로드맵의 마지막 잔여).
// 824개 단위 테스트가 구조적으로 못 덮는 영역 — electron-vite 번들/asar 경로, preload
// contextBridge 실배선, pdfjs worker/cmaps 로딩, main↔renderer IPC 왕복 — 을 빌드 산출물
// (out/) 실행으로 검증한다. AI(Ollama/클라우드)는 의존하지 않는 결정적 경로만 사용.
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  // Electron 은 requestSingleInstanceLock — 같은 userData 가 아니어도 직렬 실행이 안전
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
});

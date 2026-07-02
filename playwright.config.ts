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
  // 첫 Electron 콜드 기동이 간헐적으로 느려(빌드 직후 파일 캐시 미적재) 가시성 타임아웃을
  // 넘기는 flake 가 관측됨 — 신규 트랙 안정화 동안 로컬도 1회 재시도.
  retries: 1,
  reporter: process.env.CI ? 'line' : 'list',
  // C5-I3(QA cycle5): 재시도(=1차 실패) 시 trace 수집 — CI 에서만 재현되는 실패(xvfb/샌드박스/
  // 타이밍)가 line 로그 한 줄만 남겨 원인 파악이 비싸고 red 가 방치되기 쉬웠다(M4 사건의 재발
  // 조건). test.yml e2e 잡의 failure artifact 업로드(test-results/)와 짝.
  use: { trace: 'on-first-retry' },
});

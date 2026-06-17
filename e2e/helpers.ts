import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 결정적(AI 비의존) E2E 스펙이 공유하는 Electron 기동 격리 계약 — 단일 출처.
 *
 * 이 env/sandbox 블록은 모든 결정적 스펙에 동일해야 하는 "격리 불변식"이다. 과거에는 스펙마다
 * 복붙되어 한쪽만 바뀌면(예: dead-Ollama 포트 누락) 조용히 실사용자 상태/실 백엔드에 결합될
 * 위험이 있었다. 여기로 모아 drift 를 차단한다.
 *
 * 스펙별 고유 로직(makePdf 형태, smoke 의 합성 DragEvent 등)은 의도적으로 각 스펙에 인라인 유지.
 * 실 Ollama 가 필요한 로컬-전용 스펙(collection / tabs 의 인덱싱 테스트)은 본 헬퍼를 쓰지 않는다
 * (죽은 포트 격리와 상충).
 */
export interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  pageErrors: Error[];
}

/** seedSettings 가 있을 때만 settings.json 을 쓴다(재시작 시나리오의 2차 기동은 앱이 쓴 파일을 보존). */
export async function launchElectron(userDataDir: string, seedSettings?: Record<string, unknown>): Promise<LaunchResult> {
  if (seedSettings) {
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seedSettings), 'utf-8');
  }
  const app = await electron.launch({
    args: [
      '.',
      // GH ubuntu-24.04 러너는 unprivileged userns 제한(AppArmor)으로 Chromium setuid
      // sandbox 가 실패할 수 있어 CI 한정 비활성화. 로컬 실행은 샌드박스 유지.
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      PDF_ANALYZER_USER_DATA: userDataDir,
      // 호스트에 실제 Ollama 가 실행 중이어도(개발 머신) 죽은 포트로 격리 —
      // 콜드 스타트 위자드 노출 등 Ollama 상태 의존 시나리오를 결정적으로 만든다.
      PDF_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
    },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  return { app, page, pageErrors };
}

/**
 * file:dropped IPC 로 실제 경로 + 바이트를 전달. 합성 DragEvent 와 달리 진짜 filePath 를
 * 보유하므로(main 의 drop 핸들러와 동일 페이로드) 세션 fallback·재오픈 경로를 실측할 수 있다.
 */
export function sendDropPath(app: ElectronApplication, realPath: string, b64: string): Promise<void> {
  return app.evaluate(({ BrowserWindow }, arg) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const buf = Buffer.from(arg.b64, 'base64');
    win.webContents.send('file:dropped', {
      path: arg.realPath,
      name: arg.realPath.split(/[\\/]/).pop(),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
  }, { realPath, b64 });
}

/** 임시 디렉터리 정리(잠긴 파일 재시도 포함). */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * E2E — 세션 영속 → 앱 재시작 → 최근 문서 복원 → 재오픈 라운드트립.
 *
 * 단위 테스트가 mock 으로만 검증하는 session-store(save/list) ↔ manifest ↔ RecentDocuments ↔
 * file:open-path 재파싱의 실배선을, 실제 프로세스 재시작을 가로질러 검증한다. AI 백엔드 불필요 —
 * 결정적 경로만 사용(요약/Q&A 미수행). 합성 DragEvent 와 달리 file:dropped IPC + 디스크의 실제
 * 파일을 써서 filePath 가 진짜 경로이므로 RecentDocuments 의 재오픈(file:open-path)이 성공한다.
 */

interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  pageErrors: Error[];
}

async function launchApp(userDataDir: string, seedSettings: Record<string, unknown>): Promise<LaunchResult> {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seedSettings), 'utf-8');
  const app = await electron.launch({
    args: ['.', ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      PDF_ANALYZER_USER_DATA: userDataDir,
      // 호스트 Ollama 와 무관하게 격리(죽은 포트) — provider=claude 시드로 위자드도 우회.
      PDF_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
    },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  return { app, page, pageErrors };
}

async function makePdf(marker: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(
    `${marker} — E2E restore test document. This sample PDF contains enough extractable text `
    + 'to pass the minimum length threshold of the parser pipeline so a session is persisted.',
    { x: 50, y: 780, size: 12, font, maxWidth: 500, lineHeight: 16 },
  );
  return Buffer.from(await doc.save());
}

/** file:dropped IPC 로 실제 파일 경로 + 바이트를 전달(합성 드롭과 달리 진짜 filePath 보유). */
function sendDrop(app: ElectronApplication, realPath: string, b64: string): Promise<void> {
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

const SEED = { provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light', persistSessions: true };

test('세션 영속 → 앱 재시작 후 최근 문서에서 재오픈', async () => {
  // 콜드 Electron 2회 기동 + 파싱 대기가 기본 60s 에 근접할 수 있어 여유 부여.
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-restore-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-restore-docs-'));
  // temp 디렉터리 정리는 어느 단계에서 throw 하더라도 항상 도달하도록 바깥 finally 에 둔다.
  try {
    const pathA = join(docsDir, 'alpha.pdf');
    const pathB = join(docsDir, 'beta.pdf');
    const bufA = await makePdf('ALPHA');
    const bufB = await makePdf('BETA');
    writeFileSync(pathA, bufA);
    writeFileSync(pathB, bufB);

    // ── 1차 기동: A 파싱 → B 파싱(=A 를 manifest 로 flush) ──
    const r1 = await launchApp(userDataDir, SEED);
    try {
      await expect(r1.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      await sendDrop(r1.app, pathA, bufA.toString('base64'));
      await expect(r1.page.getByText('alpha.pdf (1p)')).toBeVisible({ timeout: 30000 });
      // A 의 세션 복원(restore-pending)이 settle 되어야 다음 드롭의 flush 가 A 를 저장한다.
      // miss 경로(첫 실행)는 거의 즉시 게이트가 풀리지만, 느린 CI 러너 대비 여유 마진을 둔다.
      await r1.page.waitForTimeout(2000);

      // 두 번째 문서 드롭 → 이전 문서(A)의 미저장 세션을 persistCurrentSession 으로 flush.
      await sendDrop(r1.app, pathB, bufB.toString('base64'));
      await expect(r1.page.getByText('beta.pdf (1p)')).toBeVisible({ timeout: 30000 });
      await r1.page.waitForTimeout(500);

      expect(r1.pageErrors, `1차 렌더러 에러: ${r1.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await r1.app.close().catch(() => { /* 이미 종료 */ });
    }

    // ── 2차 기동: 같은 userData → 최근 문서에 A 노출 → 재오픈 ──
    const r2 = await launchApp(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      // session-store manifest → RecentDocuments 실배선: A 항목 + 페이지 수 표기
      await expect(r2.page.getByText('최근 문서')).toBeVisible({ timeout: 15000 });
      const row = r2.page.locator('li', { hasText: 'alpha.pdf' });
      await expect(row).toBeVisible();
      await expect(row.getByText('1페이지')).toBeVisible();

      // 재오픈: file:open-path 로 실제 파일 재파싱 → 문서 화면 복귀
      await row.getByRole('button', { name: '열기' }).click();
      await expect(r2.page.getByText('alpha.pdf (1p)')).toBeVisible({ timeout: 30000 });
      await expect(r2.page.getByText('요약 유형')).toBeVisible();

      expect(r2.pageErrors, `2차 렌더러 에러: ${r2.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('최근 문서 재오픈 — 원본 파일 이동/삭제 시 graceful 에러(목록 유지)', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-restore-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-restore-docs-'));
  try {
    const pathA = join(docsDir, 'gamma.pdf');
    const pathB = join(docsDir, 'delta.pdf');
    const bufA = await makePdf('GAMMA');
    const bufB = await makePdf('DELTA');
    writeFileSync(pathA, bufA);
    writeFileSync(pathB, bufB);

    // ── 1차 기동: A 파싱 → B 파싱(=A 를 manifest 로 flush) ──
    const r1 = await launchApp(userDataDir, SEED);
    try {
      await expect(r1.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await sendDrop(r1.app, pathA, bufA.toString('base64'));
      await expect(r1.page.getByText('gamma.pdf (1p)')).toBeVisible({ timeout: 30000 });
      await r1.page.waitForTimeout(2000);
      await sendDrop(r1.app, pathB, bufB.toString('base64'));
      await expect(r1.page.getByText('delta.pdf (1p)')).toBeVisible({ timeout: 30000 });
      await r1.page.waitForTimeout(500);
    } finally {
      await r1.app.close().catch(() => { /* 이미 종료 */ });
    }

    // 원본 파일 삭제(이동/삭제 시나리오) — manifest 항목은 남지만 디스크 파일은 사라진 상태
    rmSync(pathA, { force: true });

    // ── 2차 기동: 최근 문서에 A 노출 → 열기 → file:open-path 실패 → graceful 배너 + 목록 유지 ──
    const r2 = await launchApp(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await expect(r2.page.getByText('최근 문서')).toBeVisible({ timeout: 15000 });
      const row = r2.page.locator('li', { hasText: 'gamma.pdf' });
      await expect(row).toBeVisible();

      await row.getByRole('button', { name: '열기' }).click();
      // openPath 실패 → recent.openFail 배너, 문서 화면 전환은 일어나지 않고 목록은 유지
      await expect(r2.page.getByText(/문서를 열 수 없습니다/)).toBeVisible({ timeout: 15000 });
      await expect(row).toBeVisible(); // 항목 잔존(클릭이 먹히지 않은 것처럼 사라지지 않음)
      await expect(r2.page.getByText('gamma.pdf (1p)')).toHaveCount(0); // 문서 헤더로 전환되지 않음
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

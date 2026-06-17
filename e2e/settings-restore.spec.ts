import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * E2E — 설정 변경 → 앱 재시작 → 유지 확인.
 *
 * settings 변경 → settings:set IPC → 디스크 settings.json → 재시작 시 loadSettings 복원의
 * 실배선을 실제 프로세스 재시작을 가로질러 검증한다. AI 백엔드 불필요.
 *
 * 변경 대상으로 요약 언어(SummaryTypeSelector)를 쓰는 이유: SettingsPanel 의 저장 버튼은
 * provider=claude 에서 API 키 미저장 시 게이트에 막혀(키 선저장 요구) 결정적 시드가 번거롭다.
 * SummaryTypeSelector 의 언어 select 는 updateSettings 를 직접 호출(게이트 없음)하므로
 * 키 없이도 설정 영속 경로를 깔끔히 검증할 수 있다.
 */

interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  pageErrors: Error[];
}

/** seedSettings 가 주어질 때만 settings.json 을 쓴다(2차 기동은 앱이 쓴 파일을 보존해야 함). */
async function launchApp(userDataDir: string, seedSettings?: Record<string, unknown>): Promise<LaunchResult> {
  if (seedSettings) {
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seedSettings), 'utf-8');
  }
  const app = await electron.launch({
    args: ['.', ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      PDF_ANALYZER_USER_DATA: userDataDir,
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
    `${marker} — E2E settings-persistence test document. Enough extractable text to pass the `
    + 'parser minimum-length threshold so the document view (with the summary-type selector) renders.',
    { x: 50, y: 780, size: 12, font, maxWidth: 500, lineHeight: 16 },
  );
  return Buffer.from(await doc.save());
}

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

test('요약 언어 설정 변경 → 앱 재시작 후에도 유지', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-set-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-set-docs-'));
  try {
    const pathA = join(docsDir, 'doc.pdf');
    const bufA = await makePdf('SETTINGS');
    writeFileSync(pathA, bufA);
    const b64 = bufA.toString('base64');

    // ── 1차 기동: 문서 열기 → 요약 언어 ko→en 변경(updateSettings → settings.json) ──
    const r1 = await launchApp(userDataDir, SEED);
    try {
      await expect(r1.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await sendDrop(r1.app, pathA, b64);
      await expect(r1.page.getByText('doc.pdf (1p)')).toBeVisible({ timeout: 30000 });

      const select = r1.page.getByRole('combobox');
      await expect(select).toHaveValue('ko'); // 시드 baseline
      await select.selectOption('en');
      await expect(select).toHaveValue('en');
      // 디바운스(300ms) + settings:set IPC + 디스크 쓰기 완료 대기.
      await r1.page.waitForTimeout(1000);

      expect(r1.pageErrors, `1차 렌더러 에러: ${r1.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await r1.app.close().catch(() => { /* 이미 종료 */ });
    }

    // ── 2차 기동: 재시드 없이(앱이 쓴 settings.json 보존) → 요약 언어가 en 으로 복원 ──
    const r2 = await launchApp(userDataDir);
    try {
      await expect(r2.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await sendDrop(r2.app, pathA, b64);
      await expect(r2.page.getByText('doc.pdf (1p)')).toBeVisible({ timeout: 30000 });

      // loadSettings 가 디스크에서 복원 → SummaryTypeSelector select 가 en 을 반영
      await expect(r2.page.getByRole('combobox')).toHaveValue('en');

      expect(r2.pageErrors, `2차 렌더러 에러: ${r2.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

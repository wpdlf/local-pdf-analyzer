import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// multi-doc Phase 1 E2E: 실제 파일 경로 기반 탭 전환 — 프로덕션 OS 드롭과 동일한
// file:dropped IPC 로 두 문서를 열고 탭 전환이 완전 복원(뷰어 포함)되는지 검증.

async function makePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`${text} — enough extractable text to pass the parser minimum length threshold of fifty chars.`,
    { x: 50, y: 780, size: 12, font, maxWidth: 500, lineHeight: 16 });
  return Buffer.from(await doc.save());
}

test('실경로 두 문서 → 탭 전환 (file:dropped IPC)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-dbg-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'),
    JSON.stringify({ provider: 'claude', uiLanguage: 'ko', theme: 'light' }), 'utf-8');
  const pathA = join(docsDir, 'alpha.pdf');
  const pathB = join(docsDir, 'beta.pdf');
  const bufA = await makePdf('ALPHA document');
  const bufB = await makePdf('BETA document');
  writeFileSync(pathA, bufA);
  writeFileSync(pathB, bufB);

  const app = await electron.launch({
    args: ['.', ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      PDF_ANALYZER_USER_DATA: userDataDir,
      // 호스트 Ollama 상태와 격리 (smoke.spec 과 동일 — 죽은 포트)
      PDF_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
    },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 실경로 로드 — 프로덕션 OS 드롭과 동일한 main IPC 경로
    const sendDrop = (p: string, b64: string) => app.evaluate(({ BrowserWindow }, arg) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const buf = Buffer.from(arg.b64, 'base64');
      win.webContents.send('file:dropped', {
        path: arg.p,
        name: arg.p.split(/[\\/]/).pop(),
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    }, { p, b64 });

    await sendDrop(pathA, bufA.toString('base64'));
    await expect(page.getByText('alpha.pdf (1p)')).toBeVisible({ timeout: 20000 });
    await sendDrop(pathB, bufB.toString('base64'));
    await expect(page.getByText('beta.pdf (1p)')).toBeVisible({ timeout: 20000 });

    const tablist = page.getByRole('tablist');
    await expect(tablist.getByRole('tab')).toHaveCount(2);
    // alpha 탭 클릭 → 전환 (완전 복원 — 뷰어 포함)
    await tablist.getByRole('tab').filter({ hasText: 'alpha.pdf' }).getByTitle(/alpha\.pdf/).click();
    await expect(page.getByText('alpha.pdf (1p)')).toBeVisible({ timeout: 20000 });
    await expect(tablist.getByRole('tab', { selected: true })).toContainText('alpha.pdf');

    expect(pageErrors, `렌더러 페이지 에러: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

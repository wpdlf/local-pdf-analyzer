import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { requireOllama } from './ollama-gate';

// 원문 뷰어 수동 확대·축소 E2E 스모크 (로컬 전용: 실제 Ollama 필요, v1.6.0).
// 실 문서 로드 → 실 Ollama 요약 → 인용 버튼 클릭 → 뷰어 오픈 → 확대 버튼/Ctrl+휠/Ctrl+0 이
// 실제 canvas 크기와 배율 표시를 바꾸는지, 그리고 **Ctrl+휠이 앱 전체(Chromium 페이지 줌)로
// 새지 않는지** 검증. 단위 테스트(happy-dom)는 canvas 크기·페이지 줌을 볼 수 없어 여기서만
// 확인된다. CI/Ollama 부재 시 자동 skip. E2E_SHOT_DIR 가 있으면 스크린샷을 남긴다(수동 확인용).

async function makePdf(marker: string, pages = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 20; line++) {
      page.drawText(
        `${marker} — page ${i + 1} line ${line + 1}. This document explains ${marker} concepts `
        + 'with enough extractable text for the summarizer to produce a structured markdown outline.',
        { x: 40, y: 800 - line * 30, size: 10, font, maxWidth: 520 },
      );
    }
  }
  return Buffer.from(await doc.save());
}

test('원문 뷰어 확대·축소 — 버튼·Ctrl+휠·Ctrl+0 이 canvas 크기를 바꾸고 앱 전체 줌은 그대로 (로컬 전용)', async () => {
  await requireOllama('exaone3.5');
  test.setTimeout(300000);

  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-zoom-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-zoom-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    provider: 'ollama', model: 'exaone3.5:latest', ollamaBaseUrl: 'http://localhost:11434',
    uiLanguage: 'ko', theme: 'light', persistSessions: true, enableAnswerVerification: false,
  }), 'utf-8');
  const pathA = join(docsDir, 'gateway.pdf');
  const bufA = await makePdf('API Gateway');
  writeFileSync(pathA, bufA);
  const shotDir = process.env.E2E_SHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const shot = async (name: string) => { if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`) }); };

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, PDF_ANALYZER_USER_DATA: userDataDir },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  const sendDrop = (p: string, b64: string) => app.evaluate(({ BrowserWindow }, arg) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const buf = Buffer.from(arg.b64, 'base64');
    win.webContents.send('file:dropped', {
      path: arg.p, name: arg.p.split(/[\\/]/).pop(),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
  }, { p, b64 });
  const appZoomFactor = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    await sendDrop(pathA, bufA.toString('base64'));
    await expect(page.getByText(/gateway\.pdf \(3p\)/)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '📝 요약 시작' }).click();
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 180000 });

    // 인용 버튼이 있어야 뷰어를 열 수 있다 — 모델 출력 의존이므로 없으면 사유를 남기고 skip.
    const cite = page.getByRole('button', { name: /페이지 원문 열기$/ }).first();
    if (await cite.count() === 0) {
      console.log('[viewer-zoom] skip: 요약에 인용 [p.N] 이 없어 뷰어를 열 수 없음(모델 출력 의존)');
      test.skip();
      return;
    }
    await cite.click();
    const viewer = page.getByRole('region', { name: '원문 보기' }).first();
    await expect(viewer).toBeVisible({ timeout: 15000 });
    const firstCanvas = viewer.locator('canvas').first();
    await expect(firstCanvas).toBeVisible({ timeout: 15000 });
    const widthAt = async () => (await firstCanvas.boundingBox())!.width;
    const width100 = await widthAt();
    const reset = viewer.getByRole('button', { name: '화면 맞춤(100%)으로 되돌리기' });
    await expect(reset).toHaveText('100%');
    await shot('zoom-100');

    // 확대 버튼 ×2 → 150%, canvas 가 커진다. 정확한 비율 대조는 아래 Ctrl+0 복귀 후 같은 패널 폭에서
    // 렌더된 100% 와 한다(첫 100% 는 패널이 자리잡기 전 폭으로 그려졌을 수 있다).
    const zoomIn = viewer.getByRole('button', { name: '확대' });
    await zoomIn.click();
    await zoomIn.click();
    await expect(reset).toHaveText('150%');
    await expect.poll(widthAt, { timeout: 15000 }).toBeGreaterThan(width100 * 1.3);
    const width150 = await widthAt();
    await shot('zoom-150');

    // Ctrl+휠 위 → +10% (160%), 그리고 앱 전체 줌은 1.0 그대로(Chromium 페이지 줌으로 새지 않음)
    const box = (await viewer.locator('[data-testid="pdfviewer-scroll"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(reset).toHaveText('160%');
    expect(await appZoomFactor()).toBe(1);
    await shot('zoom-160-wheel');

    // Ctrl+0 → 100% 복귀, canvas 원래 폭
    await viewer.locator('[data-testid="pdfviewer-scroll"]').click();
    await page.keyboard.press('Control+0');
    await expect(reset).toHaveText('100%');
    await expect.poll(widthAt, { timeout: 15000 }).toBeLessThan(width150 * 0.8);
    // 같은 패널 폭에서 그린 150% : 100% = 1.5 (반올림 ±3px)
    const width100b = await widthAt();
    expect(Math.abs(width150 - width100b * 1.5)).toBeLessThanOrEqual(3);
    // 100% 에서는 가로 스크롤이 없어야 한다(scrollbar-gutter 로 첫 렌더 폭 오측정 제거)
    const scroller = viewer.locator('[data-testid="pdfviewer-scroll"]');
    expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await appZoomFactor()).toBe(1);
    await shot('zoom-100-after-reset');

    expect(pageErrors, `page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close();
  }
});

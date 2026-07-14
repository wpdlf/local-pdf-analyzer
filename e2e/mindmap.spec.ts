import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// 요약 마인드맵 E2E 스모크 (로컬 전용: 실제 Ollama 필요).
// 실 문서 로드 → 실 Ollama 요약 → 텍스트/마인드맵 토글 → 마인드맵 렌더 확인 → (있으면)
// 페이지 배지 클릭 → 원문 뷰어 오픈 → 텍스트 복귀. 실제 모델 출력 위에서 렌더/토글/점프가
// 크래시 없이 동작하는지 검증(결정적 단위·컴포넌트 테스트의 실런타임 보완재).
// CI/Ollama 부재 시 자동 skip.

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

test('요약 마인드맵 — 실 요약 → 텍스트/마인드맵 토글 → 렌더·점프 (로컬 전용)', async () => {
  test.skip(!!process.env.CI, 'CI 러너에는 Ollama 없음');
  const alive = await fetch('http://localhost:11434/api/version').then((r) => r.ok).catch(() => false);
  test.skip(!alive, '로컬 Ollama 미실행');
  test.setTimeout(300000);

  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-mm-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-mm-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    provider: 'ollama', model: 'exaone3.5:latest', ollamaBaseUrl: 'http://localhost:11434',
    uiLanguage: 'ko', theme: 'light', persistSessions: true, enableAnswerVerification: false,
  }), 'utf-8');
  const pathA = join(docsDir, 'gateway.pdf');
  const bufA = await makePdf('API Gateway');
  writeFileSync(pathA, bufA);

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

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 문서 로드 → 요약 시작 → 요약 완료(QaChat 입력창 등장)
    await sendDrop(pathA, bufA.toString('base64'));
    await expect(page.getByText(/gateway\.pdf \(3p\)/)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '📝 요약 시작' }).click();
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 180000 });

    // 토글 등장 → 마인드맵으로 전환
    const mmToggle = page.getByRole('button', { name: '🗺 마인드맵' });
    await expect(mmToggle).toBeVisible();
    await mmToggle.click();

    // 마인드맵 뷰가 렌더(heading 있으면 nav, 없으면 빈 상태 note) — 둘 중 하나는 반드시 보여야 함
    const mmNav = page.getByRole('navigation', { name: '요약 마인드맵' });
    const mmEmpty = page.getByText('제목(heading)이 없어', { exact: false });
    await expect(mmNav.or(mmEmpty)).toBeVisible({ timeout: 10000 });
    // QA16(D-LOW): nav 가 떴다면(모델이 heading 을 냈다면) 실제 트리 노드가 존재해야 한다 —
    // 빈 nav 로 near-vacuous 하게 통과하지 않도록 구조적 보증(모델 비의존).
    if (await mmNav.isVisible()) {
      await expect(mmNav.getByRole('listitem').first()).toBeVisible();
    }

    // 페이지 배지가 있으면 클릭 → 원문 뷰어(우측 패널) 오픈 확인
    const badge = page.getByRole('button', { name: /^\[p\.\d+\]$/ }).first();
    if (await badge.count() > 0) {
      await badge.click();
      await expect(page.getByRole('region', { name: '원문 보기' })).toBeVisible({ timeout: 15000 });
    }

    // 텍스트 뷰로 복귀 → 마크다운 콘텐츠 영역 복원, nav 사라짐
    await page.getByRole('button', { name: '📝 텍스트' }).click();
    await expect(page.getByRole('navigation', { name: '요약 마인드맵' })).toBeHidden();

    expect(pageErrors, `page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close();
  }
});

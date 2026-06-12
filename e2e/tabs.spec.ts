import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// multi-doc Phase 1 E2E: 실제 파일 경로 기반 탭 전환 — 프로덕션 OS 드롭과 동일한
// file:dropped IPC 로 두 문서를 열고 탭 전환이 완전 복원(뷰어 포함)되는지 검증.

async function makePdf(text: string, pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    // 페이지마다 풍부한 텍스트 — 다페이지 문서는 RAG 청크가 많아져 실제 임베딩
    // 인덱싱이 수 초 진행되게 한다 (인덱싱-중 동시성 시나리오용)
    for (let line = 0; line < 30; line++) {
      page.drawText(
        `${text} page ${i + 1} line ${line + 1} — enough extractable text to pass the parser `
        + 'minimum length threshold and to produce multiple retrieval chunks for the index.',
        { x: 40, y: 800 - line * 26, size: 10, font, maxWidth: 520 },
      );
    }
  }
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

    // 사용자 보고 시나리오 재현: 문서 1 → 새 탭(+) → 문서 2 순차 업로드 → 탭 전환.
    // (연속 드롭 교체 경로와 달리 + 경유는 setDocument(null) 후 업로드 화면에서 열린다)
    await page.getByRole('button', { name: '새 문서 열기' }).click();
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible();
    const pathC = join(docsDir, 'gamma.pdf');
    const bufC = await makePdf('GAMMA document');
    writeFileSync(pathC, bufC);
    await sendDrop(pathC, bufC.toString('base64'));
    await expect(page.getByText('gamma.pdf (1p)')).toBeVisible({ timeout: 20000 });
    await expect(tablist.getByRole('tab')).toHaveCount(3);
    // beta 탭으로 전환
    await tablist.getByRole('tab').filter({ hasText: 'beta.pdf' }).getByTitle(/beta\.pdf/).click();
    await expect(page.getByText('beta.pdf (1p)')).toBeVisible({ timeout: 20000 });
    await expect(tablist.getByRole('tab', { selected: true })).toContainText('beta.pdf');

    expect(pageErrors, `렌더러 페이지 에러: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/**
 * 사용자 환경 재현(로컬 전용): provider=ollama + 실제 Ollama 인덱싱이 진행 중인
 * 타이밍에 + → 업로드 → 탭 전환. CI/Ollama 부재 시 자동 skip.
 * 다페이지 PDF 로 임베딩 인덱싱이 수 초 진행되는 동안 탭 작업이 일어나게 한다.
 */
test('실제 Ollama 인덱싱 중 — 문서 → + → 문서 → 탭 전환 (로컬 전용)', async () => {
  test.skip(!!process.env.CI, 'CI 러너에는 Ollama 없음');
  const alive = await fetch('http://localhost:11434/api/version').then((r) => r.ok).catch(() => false);
  test.skip(!alive, '로컬 Ollama 미실행');

  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-ollama-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'),
    JSON.stringify({ provider: 'ollama', uiLanguage: 'ko', theme: 'light' }), 'utf-8');
  const pathA = join(docsDir, 'first.pdf');
  const pathB = join(docsDir, 'second.pdf');
  const bufA = await makePdf('FIRST document', 40);
  const bufB = await makePdf('SECOND document', 40);
  writeFileSync(pathA, bufA);
  writeFileSync(pathB, bufB);

  const app = await electron.launch({
    args: ['.'],
    // PDF_ANALYZER_OLLAMA_URL 미설정 — 실제 로컬 Ollama(11434) 사용이 이 테스트의 목적
    env: { ...process.env, PDF_ANALYZER_USER_DATA: userDataDir },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const consoleWarns: string[] = [];
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consoleWarns.push(m.text()); });

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    const sendDrop = (p: string, b64: string) => app.evaluate(({ BrowserWindow }, arg) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const buf = Buffer.from(arg.b64, 'base64');
      win.webContents.send('file:dropped', {
        path: arg.p,
        name: arg.p.split(/[\\/]/).pop(),
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    }, { p, b64 });

    // 문서 1 업로드 → 파싱 완료 직후(인덱싱 진행 중) 곧바로 + 클릭 — 사용자 타이밍
    await sendDrop(pathA, bufA.toString('base64'));
    await expect(page.getByText('first.pdf (40p)')).toBeVisible({ timeout: 30000 });
    const tablist = page.getByRole('tablist');
    await page.getByRole('button', { name: '새 문서 열기' }).click();
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible();

    // 문서 2 업로드 → 파싱 완료 직후(인덱싱 진행 중) 첫 탭으로 전환 — 사용자 타이밍
    await sendDrop(pathB, bufB.toString('base64'));
    await expect(page.getByText('second.pdf (40p)')).toBeVisible({ timeout: 30000 });
    await expect(tablist.getByRole('tab')).toHaveCount(2);
    await tablist.getByRole('tab').filter({ hasText: 'first.pdf' }).getByTitle(/first\.pdf/).click();
    await expect(page.getByText('first.pdf (40p)')).toBeVisible({ timeout: 20000 });
    await expect(tablist.getByRole('tab', { selected: true })).toContainText('first.pdf');

    // 역방향 전환도 검증 (인덱싱·복원 흐름이 교차하는 구간)
    await tablist.getByRole('tab').filter({ hasText: 'second.pdf' }).getByTitle(/second\.pdf/).click();
    await expect(page.getByText('second.pdf (40p)')).toBeVisible({ timeout: 20000 });

    expect(pageErrors, `렌더러 페이지 에러: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    // 정상 흐름 추적 로그(tab click/진입/완료)는 허용 — 실패성 진단만 검사
    const tabFailures = consoleWarns.filter((m) =>
      m.includes('[tabs] 전환 실패') || m.includes('[tabs] 전환 차단')
      || m.includes('[tabs] 전환 no-op') || m.includes('재읽기 실패') || m.includes('실경로 획득 실패'));
    expect(tabFailures, `탭 진단 경고: ${tabFailures.join('; ')}`).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

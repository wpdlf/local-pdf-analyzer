import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// multi-doc Phase 3 module-4 — 통합 검증 E2E (로컬 전용: 실 Ollama).
// (A) 교차 통합 요약 생성, (B) 컬렉션 저장 → 전체 닫기 → 목록에서 재오픈(탭 세트 복원)
// 을 실 Electron+Ollama 로 검증. CI/Ollama 부재 시 자동 skip.

async function makePdf(marker: string, pages = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 20; line++) {
      page.drawText(
        `${marker} — page ${i + 1} line ${line + 1}. This document explains ${marker} concepts `
        + 'with enough extractable text to build a retrieval index and a summary.',
        { x: 40, y: 800 - line * 30, size: 10, font, maxWidth: 520 },
      );
    }
  }
  return Buffer.from(await doc.save());
}

test('컬렉션 Phase 3 — 통합 요약 + 저장→재오픈 (로컬 전용)', async () => {
  test.skip(!!process.env.CI, 'CI 러너에는 Ollama 없음');
  const alive = await fetch('http://localhost:11434/api/version').then((r) => r.ok).catch(() => false);
  test.skip(!alive, '로컬 Ollama 미실행');
  test.setTimeout(360000);

  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-p3-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-p3-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    provider: 'ollama', model: 'exaone3.5:latest', ollamaBaseUrl: 'http://localhost:11434',
    uiLanguage: 'ko', theme: 'light', persistSessions: true, enableAnswerVerification: false,
  }), 'utf-8');
  const pathA = join(docsDir, 'gateway.pdf');
  const pathB = join(docsDir, 'discovery.pdf');
  const bufA = await makePdf('API Gateway');
  const bufB = await makePdf('Service Discovery');
  writeFileSync(pathA, bufA);
  writeFileSync(pathB, bufB);

  const app = await electron.launch({ args: ['.'], env: { ...process.env, PDF_ANALYZER_USER_DATA: userDataDir } });
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

  async function loadAndSummarize(p: string, b64: string, headerRe: RegExp): Promise<void> {
    await sendDrop(p, b64);
    await expect(page.getByText(headerRe)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '📝 요약 시작' }).click();
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 180000 });
  }

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 1) 두 문서 요약(세션+인덱스 생성)
    await loadAndSummarize(pathA, bufA.toString('base64'), /gateway\.pdf \(3p\)/);
    await page.getByRole('button', { name: '새 문서 열기' }).click();
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    await loadAndSummarize(pathB, bufB.toString('base64'), /discovery\.pdf \(3p\)/);

    // 2) 문서 A 로 전환 + 컬렉션 모드 ON → 2개 ready
    const tablist = page.getByRole('navigation', { name: '열린 문서' });
    await tablist.getByRole('listitem').filter({ hasText: 'gateway.pdf' }).getByTitle(/gateway\.pdf/).click();
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 60000 });
    await page.getByText('여러 문서에 걸쳐 질문').click();
    await expect(page.getByText('2개 문서에서 검색')).toBeVisible({ timeout: 20000 });

    // 3) (A) 통합 요약 → assistant 결과가 Q&A 스레드에 생성
    await page.getByRole('button', { name: /통합 요약/ }).click();
    // 생성 시작 후 완료까지: 입력창이 다시 활성(전송 버튼 노출)되면 종료
    await expect(page.getByRole('button', { name: '질문 전송' })).toBeVisible({ timeout: 180000 });
    // 사용자 요청 메시지가 스레드에 보임
    await expect(page.getByText('선택한 문서들의 통합 요약을 작성해줘')).toBeVisible({ timeout: 10000 });

    // 4) (B) 컬렉션 저장
    await page.getByRole('button', { name: /컬렉션 저장/ }).click();
    const nameInput = page.getByPlaceholder('컬렉션 이름');
    await nameInput.fill('MSA 강의 묶음');
    await page.getByRole('button', { name: '저장' }).click();

    // 5) 전체 탭 닫기 → 업로드 화면. 활성 탭 닫기는 이웃 복원(세션-우선)이 비동기라,
    //    매 클릭 후 탭 수 감소를 기다린 뒤 다음 탭을 닫는다(경쟁 방지).
    while ((await tablist.getByRole('listitem').count()) > 0) {
      const before = await tablist.getByRole('listitem').count();
      await tablist.getByRole('button', { name: /탭 닫기/ }).first().click();
      await expect.poll(() => tablist.getByRole('listitem').count(), { timeout: 30000 }).toBeLessThan(before);
    }
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 30000 });

    // 6) 저장된 컬렉션 목록에서 재오픈 → 탭 2개 복원
    await expect(page.getByText('MSA 강의 묶음')).toBeVisible({ timeout: 10000 });
    // 컬렉션 카드(MSA 강의 묶음) 안의 '열기' 를 스코프해 클릭 — getByRole(name:'열기') 는 부분문자열
    // 매칭이라 헤더 "📂 PDF 열기" 버튼·RecentDocuments '열기' 와 충돌한다(.first() 가 헤더 버튼을 집음).
    await page.getByRole('listitem').filter({ hasText: 'MSA 강의 묶음' }).getByRole('button', { name: '열기' }).click();
    await expect(tablist.getByRole('listitem')).toHaveCount(2, { timeout: 30000 });

    expect(pageErrors, `렌더러 페이지 에러: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

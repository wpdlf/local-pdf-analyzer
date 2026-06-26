import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// multi-doc Phase 2 module-3 — 컬렉션 Q&A 통합 E2E (로컬 전용: 실제 Ollama 필요).
// 두 문서를 각각 요약(세션+인덱스 생성) → 컬렉션 모드 토글 → 멤버 2개 ready 확인 →
// 교차 질문 전송 → 답변 생성까지 전체 배선을 실제 Electron + Ollama 로 검증.
// CI/Ollama 부재 시 자동 skip (LLM 타이밍 의존이라 결정적 단위 테스트의 보완재).

async function makePdf(marker: string, pages = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 20; line++) {
      page.drawText(
        `${marker} — page ${i + 1} line ${line + 1}. This document explains ${marker} concepts `
        + 'with enough extractable text to build a retrieval index for collection Q&A testing.',
        { x: 40, y: 800 - line * 30, size: 10, font, maxWidth: 520 },
      );
    }
  }
  return Buffer.from(await doc.save());
}

test('컬렉션 Q&A — 두 문서 요약 → 모드 토글 → 교차 질문 (로컬 전용)', async () => {
  test.skip(!!process.env.CI, 'CI 러너에는 Ollama 없음');
  const alive = await fetch('http://localhost:11434/api/version').then((r) => r.ok).catch(() => false);
  test.skip(!alive, '로컬 Ollama 미실행');
  test.setTimeout(300000);

  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-coll-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-coll-docs-'));
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    provider: 'ollama', model: 'exaone3.5:latest', ollamaBaseUrl: 'http://localhost:11434',
    uiLanguage: 'ko', theme: 'light', persistSessions: true,
    // 검증 2-pass 를 끄면 답변이 단일 pass 로 더 빨리 끝나 E2E 안정성↑ (컬렉션 검색 경로는 그대로 탐)
    enableAnswerVerification: false,
  }), 'utf-8');
  const pathA = join(docsDir, 'gateway.pdf');
  const pathB = join(docsDir, 'discovery.pdf');
  const bufA = await makePdf('API Gateway');
  const bufB = await makePdf('Service Discovery');
  writeFileSync(pathA, bufA);
  writeFileSync(pathB, bufB);

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

  // 문서 로드 → 요약 시작 → 요약 완료(Q&A 패널 등장)까지 대기하는 헬퍼
  async function loadAndSummarize(p: string, b64: string, headerRe: RegExp): Promise<void> {
    await sendDrop(p, b64);
    await expect(page.getByText(headerRe)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '📝 요약 시작' }).click();
    // 요약 완료 → QaChat 입력창(placeholder) 등장 (summaryStream && !isGenerating)
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 180000 });
  }

  try {
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 1) 문서 A 요약 (세션 A + 인덱스 생성)
    await loadAndSummarize(pathA, bufA.toString('base64'), /gateway\.pdf \(3p\)/);

    // 2) + 새 탭 → 문서 B 요약 (세션 B + 인덱스 생성)
    await page.getByRole('button', { name: '새 문서 열기' }).click();
    await expect(page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    await loadAndSummarize(pathB, bufB.toString('base64'), /discovery\.pdf \(3p\)/);

    // 3) 문서 A 탭으로 전환 (세션 복원 — 요약/인덱스 즉시 복원, QaChat 재등장)
    const tablist = page.getByRole('navigation', { name: '열린 문서' });
    await tablist.getByRole('listitem').filter({ hasText: 'gateway.pdf' }).getByTitle(/gateway\.pdf/).click();
    await expect(page.getByPlaceholder(/질문을 입력하세요/)).toBeVisible({ timeout: 60000 });

    // 4) 컬렉션 바 노출 + 모드 토글 → 멤버 2개가 ready (둘 다 동일 임베딩 모델로 인덱싱됨)
    const collToggle = page.getByText('여러 문서에 걸쳐 질문');
    await expect(collToggle).toBeVisible();
    await collToggle.click();
    // "2개 문서에서 검색" — 두 멤버 모두 ready
    await expect(page.getByText('2개 문서에서 검색')).toBeVisible({ timeout: 20000 });

    // 5) 교차 질문 전송 → 답변 생성 (collectionRagSearch 경로가 에러 없이 동작)
    const qaInput = page.getByPlaceholder(/질문을 입력하세요/);
    await qaInput.fill('이 문서들에서 설명하는 핵심 개념을 알려줘');
    await page.getByRole('button', { name: '질문 전송' }).click();
    // 사용자 질문 버블이 뜨고, 이후 assistant 답변(role=log 안의 텍스트)이 생성된다
    await expect(page.getByText('이 문서들에서 설명하는 핵심 개념을 알려줘')).toBeVisible({ timeout: 10000 });
    // 답변 완료까지 대기 — 전송 버튼이 다시 활성(중지→전송)되면 생성 종료
    await expect(page.getByRole('button', { name: '질문 전송' })).toBeVisible({ timeout: 180000 });

    expect(pageErrors, `렌더러 페이지 에러: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(docsDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

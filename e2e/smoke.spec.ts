import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * R45 E2E 스모크 — 빌드 산출물(out/)을 실제 Electron 으로 기동해 핵심 사용자 경로를 검증.
 *
 * 사전 조건: `npm run build` (package.json 의 test:e2e 스크립트가 체인). AI 백엔드 불필요 —
 * Ollama 미설치 환경에서도 결정적으로 동작하는 경로만 사용한다.
 *
 * 격리: 각 테스트가 임시 userData(PDF_ANALYZER_USER_DATA env, main/index.ts 의 오버라이드)를
 * 사용해 실사용자 설정/세션을 건드리지 않고, 테스트 간 상태도 공유하지 않는다.
 */

interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  pageErrors: Error[];
}

async function launchApp(seedSettings?: Record<string, unknown>): Promise<LaunchResult> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-e2e-'));
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
    env: { ...process.env, PDF_ANALYZER_USER_DATA: userDataDir },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  return { app, page, userDataDir, pageErrors };
}

async function teardown(r: LaunchResult): Promise<void> {
  await r.app.close().catch(() => { /* 이미 종료 */ });
  rmSync(r.userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

/** 텍스트 50자 이상(파서의 PDF_NO_TEXT 임계)을 담은 1페이지 PDF 를 생성해 base64 로 반환 */
async function makeSamplePdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(
    'E2E smoke test document. This sample PDF contains enough extractable text '
    + 'to pass the minimum length threshold of the parser pipeline.',
    { x: 50, y: 780, size: 12, font, maxWidth: 500, lineHeight: 16 },
  );
  return Buffer.from(await doc.save()).toString('base64');
}

test('콜드 스타트 — 셋업 위자드 노출 + 언어 토글 동작', async () => {
  const r = await launchApp(); // 설정 없음 → provider 기본 ollama + 미설치 → 위자드
  try {
    // 위자드 welcome (기본 한국어 로캘 기준 — CI 영문 로캘이어도 토글로 양방향 검증됨)
    const startKo = r.page.getByText('설정 시작');
    const startEn = r.page.getByText('Start setup');
    await expect(startKo.or(startEn)).toBeVisible({ timeout: 15000 });

    // 언어 토글 — i18n + settings IPC + store 반응성의 실배선 검증
    await r.page.getByRole('button', { name: 'English' }).click();
    await expect(startEn).toBeVisible();
    await r.page.getByRole('button', { name: '한국어' }).click();
    await expect(startKo).toBeVisible();

    expect(r.pageErrors, `렌더러 페이지 에러: ${r.pageErrors.map((e) => e.message).join('; ')}`)
      .toHaveLength(0);
  } finally {
    await teardown(r);
  }
});

test('PDF 드롭 → 파싱 → 문서 화면 전환 (pdfjs worker/cmaps 번들 검증)', async () => {
  // provider 를 claude 로 시드 — Ollama 미설치여도 셋업 위자드를 우회해 메인 화면 진입
  const r = await launchApp({ provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light' });
  try {
    await expect(r.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 합성 드롭 — App.tsx 의 window capture drop 핸들러 경로 (실사용 HTML5 드롭과 동일)
    const pdfBase64 = await makeSamplePdfBase64();
    await r.page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pdfBase64);

    // 파싱 완료 → 헤더에 파일명/페이지 수 + 요약 유형 셀렉터 노출
    await expect(r.page.getByText('sample.pdf (1p)')).toBeVisible({ timeout: 30000 });
    await expect(r.page.getByText('요약 유형')).toBeVisible();

    // multi-doc Phase 1: 두 번째 PDF 드롭 → 탭 2개, 새 문서가 활성
    await r.page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'second.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pdfBase64);
    await expect(r.page.getByText('second.pdf (1p)')).toBeVisible({ timeout: 30000 });
    const tablist = r.page.getByRole('tablist');
    await expect(tablist.getByRole('tab')).toHaveCount(2);
    await expect(tablist.getByRole('tab', { selected: true })).toContainText('second.pdf');

    // 새 탭(+) → 업로드 화면 복귀하되 탭 2개 유지
    await r.page.getByRole('button', { name: '새 문서 열기' }).click();
    await expect(r.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible();
    await expect(tablist.getByRole('tab')).toHaveCount(2);

    expect(r.pageErrors, `렌더러 페이지 에러: ${r.pageErrors.map((e) => e.message).join('; ')}`)
      .toHaveLength(0);
  } finally {
    await teardown(r);
  }
});

test('설정 화면 왕복 — 진입/저장 버튼/닫기 (IPC settings 왕복)', async () => {
  const r = await launchApp({ provider: 'claude', uiLanguage: 'ko', theme: 'light' });
  try {
    await expect(r.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

    // 헤더의 설정(⚙️) 버튼 진입
    await r.page.getByText('⚙️').click();
    await expect(r.page.getByText('AI Provider')).toBeVisible();
    // sticky 헤더의 저장 버튼 — 변경 없음 상태 라벨
    await expect(r.page.getByText('변경 사항 없음').or(r.page.getByText('설정 저장'))).toBeVisible();

    // 닫기 → 메인 복귀
    await r.page.getByText('✕ 닫기').click();
    await expect(r.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible();

    expect(r.pageErrors).toHaveLength(0);
  } finally {
    await teardown(r);
  }
});

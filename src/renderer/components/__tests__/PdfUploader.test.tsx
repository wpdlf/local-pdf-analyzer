// @vitest-environment happy-dom

// PdfUploader 행위 — 기본 드롭존(파일 선택) / 선택→openPdf→handlePdfData /
// openPdf 에러·취소(null)·throw 처리 / 파싱 중 읽기 UI·취소(cancelPdfParse) /
// OCR 진행 표시 / 동시 다이얼로그 가드(dialogOpenRef).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const M = vi.hoisted(() => ({
  openPdf: vi.fn(),
  handlePdfData: vi.fn(() => Promise.resolve()),
  cancelPdfParse: vi.fn(),
}));
vi.mock('../../lib/pdf-parser', () => ({
  handlePdfData: M.handlePdfData,
  cancelPdfParse: M.cancelPdfParse,
}));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { file: { openPdf: M.openPdf } },
}));

import { PdfUploader } from '../PdfUploader';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

beforeEach(() => {
  vi.clearAllMocks();
  M.openPdf.mockResolvedValue({ data: new Uint8Array(), name: 'a.pdf', path: '/d/a.pdf' });
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    isParsing: false,
    ocrProgress: null,
    error: null,
  });
});
afterEach(() => cleanup());

describe('PdfUploader', () => {
  it('기본 상태 → 드래그 안내 + 파일 선택 버튼', () => {
    render(<PdfUploader />);
    expect(screen.getByText(/여기에 드래그/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '파일 선택' })).toBeTruthy();
  });

  it('파일 선택 → openPdf → handlePdfData(data,name,path)', async () => {
    const user = userEvent.setup();
    render(<PdfUploader />);
    await user.click(screen.getByRole('button', { name: '파일 선택' }));
    expect(M.openPdf).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(M.handlePdfData).toHaveBeenCalledWith(expect.anything(), 'a.pdf', '/d/a.pdf'));
    expect(useAppStore.getState().error).toBeNull();
  });

  it('openPdf 에러 객체 → PDF_PARSE_FAIL 배너 + handlePdfData 미호출', async () => {
    M.openPdf.mockResolvedValue({ error: '암호화된 PDF' });
    const user = userEvent.setup();
    render(<PdfUploader />);
    await user.click(screen.getByRole('button', { name: '파일 선택' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(useAppStore.getState().error?.message).toBe('암호화된 PDF');
    expect(M.handlePdfData).not.toHaveBeenCalled();
  });

  it('openPdf 취소(null 반환) → 에러 없음, handlePdfData 미호출', async () => {
    M.openPdf.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<PdfUploader />);
    await user.click(screen.getByRole('button', { name: '파일 선택' }));
    await waitFor(() => expect(M.openPdf).toHaveBeenCalled());
    expect(M.handlePdfData).not.toHaveBeenCalled();
    expect(useAppStore.getState().error).toBeNull();
  });

  it('openPdf throw → PDF_PARSE_FAIL 배너', async () => {
    M.openPdf.mockRejectedValue(new Error('IPC 실패'));
    const user = userEvent.setup();
    render(<PdfUploader />);
    await user.click(screen.getByRole('button', { name: '파일 선택' }));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL'));
    expect(useAppStore.getState().error?.message).toBe('IPC 실패');
  });

  it('파싱 중 → 읽기 안내 + 취소 버튼(cancelPdfParse)', async () => {
    useAppStore.setState({ isParsing: true });
    const user = userEvent.setup();
    render(<PdfUploader />);
    expect(screen.getByText(/PDF를 읽고 있습니다/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'PDF 처리 취소' }));
    expect(M.cancelPdfParse).toHaveBeenCalledTimes(1);
  });

  it('파싱 중 + OCR 진행 → OCR 라벨 + 진행 카운트', () => {
    useAppStore.setState({ isParsing: true, ocrProgress: { current: 3, total: 10 } });
    render(<PdfUploader />);
    expect(screen.getByText(/스캔 PDF 텍스트 인식/)).toBeTruthy();
    expect(screen.getByText('3 / 10')).toBeTruthy();
  });

  it('파싱 중에는 드롭존 클릭이 파일 선택을 열지 않는다', () => {
    useAppStore.setState({ isParsing: true });
    render(<PdfUploader />);
    // 파싱 중 외곽 presentation div onClick 은 undefined — openPdf 미호출
    fireEvent.click(screen.getByText(/PDF를 읽고 있습니다/));
    expect(M.openPdf).not.toHaveBeenCalled();
  });

  it('다이얼로그가 열려 있는 동안 재클릭은 무시된다 (dialogOpenRef 가드)', async () => {
    let resolveOpen: (v: unknown) => void = () => {};
    M.openPdf.mockReturnValue(new Promise((res) => { resolveOpen = res; }));
    render(<PdfUploader />);
    const btn = screen.getByRole('button', { name: '파일 선택' });
    fireEvent.click(btn);
    fireEvent.click(btn); // 첫 호출의 await 가 미해결인 동안 두 번째 클릭
    expect(M.openPdf).toHaveBeenCalledTimes(1);
    resolveOpen(null);
  });
});

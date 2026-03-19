# Plan: loading-ux (로딩 UX 개선)

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | PDF 업로드 중과 요약 생성 초기에 사용자에게 아무런 피드백이 없어 앱이 멈춘 것으로 오해할 수 있음. 생성 중에도 "PDF를 업로드하고 요약을 시작하세요" 안내 문구가 표시됨 |
| **Solution** | PDF 파싱 중 로딩 상태 추가, 요약 생성 초기(토큰 미수신)에 로딩 애니메이션 표시, 생성 중 안내 문구 제거 |
| **Function UX Effect** | 모든 대기 상태에서 시각적 피드백을 제공하여 앱이 정상 동작 중임을 인지 |
| **Core Value** | 사용자 신뢰도 향상 — "앱이 잘 돌아가고 있구나" |

---

## 1. 현재 문제 분석

### 1.1 PDF 업로드/파싱 단계
- `PdfUploader`에서 파일 선택/드롭 후 `parsePdf()` 호출 시 로딩 표시 없음
- 대용량 PDF의 경우 수 초간 화면이 정지된 것처럼 보임

### 1.2 요약 생성 초기 단계
- `handleSummarize()` 호출 후 첫 토큰이 도착하기까지 수 초~수십 초 대기
- 이 구간에서 `SummaryViewer`는 `debouncedContent`가 비어있어 "PDF를 업로드하고 요약을 시작하세요." 문구 표시
- 사용자가 생성이 시작되지 않은 것으로 착각할 수 있음

---

## 2. 변경 사항

### FR-01: PDF 파싱 로딩 상태
- **위치**: `PdfUploader.tsx`, `App.tsx` (onFileDropped)
- **동작**: 파일 선택/드롭 시 로딩 스피너 표시, 파싱 완료/실패 시 해제
- **구현**: store에 `isParsing: boolean` 상태 추가, PdfUploader에서 로딩 오버레이 표시

### FR-02: 요약 생성 로딩 화면
- **위치**: `SummaryViewer.tsx`
- **동작**: `isGenerating=true`이고 `debouncedContent`가 비어있을 때 로딩 애니메이션 표시
- **UI**: 스피너 + "AI가 강의자료를 분석하고 있습니다..." 메시지 + ProgressBar

### FR-03: 안내 문구 조건 수정
- **위치**: `SummaryViewer.tsx`
- **동작**: `isGenerating` 중에는 "PDF를 업로드하고 요약을 시작하세요." 문구를 숨기고 로딩 화면으로 대체

---

## 3. 수정 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/lib/store.ts` | `isParsing` 상태 추가 |
| `src/renderer/components/PdfUploader.tsx` | 파싱 중 로딩 오버레이 표시 |
| `src/renderer/App.tsx` | onFileDropped에서 isParsing 상태 관리 |
| `src/renderer/components/SummaryViewer.tsx` | 생성 초기 로딩 화면 + 안내 문구 조건 수정 |

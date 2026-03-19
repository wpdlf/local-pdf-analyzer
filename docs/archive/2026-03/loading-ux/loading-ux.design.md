# Design: loading-ux (로딩 UX 개선)

> **Plan 참조**: `docs/01-plan/features/loading-ux.plan.md`

---

## 1. 상태 설계

### 1.1 store.ts 변경

`AppState` 인터페이스에 `isParsing` 추가:

```typescript
// PDF 섹션에 추가
isParsing: boolean;
setIsParsing: (v: boolean) => void;
```

초기값: `false`

### 1.2 상태 흐름

```
[파일 선택/드롭]
  → isParsing = true
  → parsePdf() 실행
  → 성공: isParsing = false, document = 결과
  → 실패: isParsing = false, error = 에러

[요약 시작]
  → isGenerating = true, summaryStream = ''
  → (첫 토큰 도착 전: 로딩 화면)
  → 토큰 수신: summaryStream에 누적 → Markdown 렌더링
  → 완료: isGenerating = false
```

---

## 2. 컴포넌트 설계

### 2.1 PdfUploader.tsx — FR-01

**변경**: `isParsing` 상태에 따라 로딩 오버레이 표시

```
Before:                          After (isParsing=true):
┌─────────────────────┐        ┌─────────────────────┐
│        📄           │        │     (스피너)          │
│ PDF 파일을 여기에     │   →    │                     │
│ 드래그하거나          │        │ PDF를 읽고 있습니다...│
│ [파일 선택]          │        │                     │
└─────────────────────┘        └─────────────────────┘
```

- `handleFile` 시작 시 `setIsParsing(true)`, 완료/에러 시 `setIsParsing(false)`
- `isParsing=true`일 때 드롭 영역 위에 로딩 오버레이 (반투명 배경 + 스피너 + 텍스트)
- 클릭/드롭 이벤트 비활성화 (`pointer-events-none`)

**스피너**: Tailwind CSS `animate-spin` + 원형 border 스피너 (별도 라이브러리 불필요)

### 2.2 SummaryViewer.tsx — FR-02, FR-03

**변경**: 콘텐츠 영역의 3가지 상태 분기

```typescript
// 상태 분기 (우선순위 순)
if (isGenerating && !debouncedContent) {
  // 상태 A: 요약 생성 중이나 아직 토큰 미수신 → 로딩 화면
  return <LoadingView />;
}
if (debouncedContent) {
  // 상태 B: 토큰 수신 중 또는 완료 → Markdown 렌더링
  return <ReactMarkdown ...>{debouncedContent}</ReactMarkdown>;
}
// 상태 C: 대기 상태 (isGenerating=false, content 없음)
// → 이 상태는 SummaryViewer가 렌더링되지 않음 (App.tsx 조건)
```

**로딩 화면 UI**:
```
┌─────────────────────────────┐
│                             │
│         (스피너)             │
│                             │
│ AI가 강의자료를 분석하고      │
│ 있습니다...                  │
│                             │
│ 잠시만 기다려주세요.          │
│                             │
└─────────────────────────────┘
│ ████░░░░░░░░░░ 12% 처리 중.. │  ← ProgressBar (기존)
```

- 스피너: `animate-spin` border 스피너 (48x48px)
- 메인 텍스트: "AI가 강의자료를 분석하고 있습니다..." (font-medium, text-gray-600)
- 서브 텍스트: "잠시만 기다려주세요." (text-sm, text-gray-400)
- ProgressBar는 기존 위치 유지 (하단)

### 2.3 App.tsx — onFileDropped 수정

`onFileDropped` 핸들러에서 `isParsing` 상태 관리:

```typescript
useAppStore.getState().setIsParsing(true);
try {
  const doc = await parsePdf(...);
  useAppStore.getState().setDocument(doc);
} catch { ... }
finally {
  useAppStore.getState().setIsParsing(false);
}
```

---

## 3. 구현 순서

| 순서 | 파일 | 내용 |
|:----:|------|------|
| 1 | `store.ts` | `isParsing` / `setIsParsing` 추가 |
| 2 | `PdfUploader.tsx` | 로딩 오버레이 추가 |
| 3 | `App.tsx` | `onFileDropped`에 isParsing 관리 추가 |
| 4 | `SummaryViewer.tsx` | 생성 초기 로딩 화면 + 안내 문구 제거 |

---

## 4. 스피너 CSS

Tailwind CSS만으로 구현 (추가 의존성 없음):

```html
<div class="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 dark:border-gray-700 border-t-blue-500"></div>
```

- `animate-spin`: 1s linear infinite rotation
- `border-t-blue-500`: 상단만 파란색으로 시각적 회전 효과
- 다크모드: `dark:border-gray-700` 배경 border

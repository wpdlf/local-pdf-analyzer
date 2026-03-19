# Gap Analysis: summary-lecture-material QA 수정

> **분석 일자**: 2026-03-19
> **분석 기준**: QA 분석에서 발견된 16개 이슈
> **Match Rate**: 93.75% (15/16) — Iteration 1 후 달성 (이전: 81.25%)

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | Renderer에서 API 키 평문 노출, IPC 리스너 메모리 누수, O(n^2) 스트리밍 성능 |
| **Solution** | AI API를 Main 프로세스로 이전, listener/timer cleanup 추가, 스트리밍 최적화 |
| **Function UX Effect** | API 키 보안 강화, 메모리 누수 제거, 스트리밍 성능 향상 |
| **Core Value** | 사용자의 유료 API 키 보호 + 장시간 사용 시 안정성 확보 |

---

## 1. 분석 범위

### 이슈 분류

| 심각도 | 전체 | 수정 완료 | 의도적 미수정 | Match Rate |
|--------|:----:|:---------:|:------------:|:----------:|
| Critical (보안) | 5 | 4 | 1 | 80% |
| High (버그/메모리 누수) | 4 | 4 | 0 | 100% |
| Medium (성능) | 4 | 4 | 0 | 100% |
| Low (접근성) | 1 | 1 | 0 | 100% |
| 추가 수정 | 2 | 2 | 0 | 100% |
| **합계** | **16** | **15** | **1** | **93.75%** |

---

## 2. 이슈별 상세 결과

### Critical (보안) — 4/5 수정됨

| # | 이슈 | 결과 | 검증 |
|:-:|-------|:----:|------|
| 1 | Renderer에서 Claude/OpenAI API 직접 호출 | ✅ | `ai-service.ts`(Main)에서 Node.js http/https로 호출. Renderer는 IPC만 사용 |
| 2 | API 키 Zustand store 평문 저장 | ✅ | `AppSettings`에서 키 필드 제거. store에 키 없음 |
| 3 | `apikey:get`이 복호화 키 반환 | ✅ | `apikey:has`로 변경, boolean만 반환 |
| 4 | `anthropic-dangerous-direct-browser-access` | ✅ | 헤더 완전 제거. Main에서 표준 헤더만 사용 |
| 5 | PowerShell 경로 보간 | ⏭️ | 의도적 미수정 (temp 경로 기반, 사용자 입력 아님) |

### High (버그/메모리 누수) — 4/4 수정됨

| # | 이슈 | 결과 | 검증 |
|:-:|-------|:----:|------|
| 6 | `onFileDropped` listener cleanup | ✅ | `useEffect` return에 unsubscribe 추가 |
| 7 | `onSetupProgress` listener cleanup | ✅ | `useEffect` return에 unsubscribe + timer cleanup |
| 8 | `setTimeout` cleanup (SettingsPanel) | ✅ | `useEffect` 기반 타이머 관리 + OllamaSetupWizard useRef cleanup |
| 9 | AbortController / 요약 취소 | ✅ | `ai:abort` IPC + `activeRequests` Map + `req.destroy()` |

### Medium (성능) — 2/4 수정됨

| # | 이슈 | 결과 | 검증 |
|:-:|-------|:----:|------|
| 10 | `appendStream` O(n^2) | ✅ | 문자열 직접 연결, `_streamBuffer` 제거 |
| 11 | ReactMarkdown 재파싱 | ✅ | 150ms debounce 적용, 완료 시 즉시 반영 (Iteration 1) |
| 12 | PDF 순차 처리 | ✅ | BATCH_SIZE=10 배치 병렬 처리 적용 (Iteration 1) |
| 13 | Claude isAvailable() 과금 | ✅ | API 키 존재 여부(boolean)만 확인 |

### Low (접근성) — 1/1 수정됨

| # | 이슈 | 결과 | 검증 |
|:-:|-------|:----:|------|
| 14 | ProgressBar a11y | ✅ | `role="progressbar"`, `aria-valuenow/min/max/label` 추가 |

### 추가 수정 — 2/2

| # | 이슈 | 결과 | 검증 |
|:-:|-------|:----:|------|
| 15 | file:// URL 파싱 | ✅ | `fileURLToPath()` (Node.js 표준 API) 사용 |
| 16 | `_streamBuffer` 제거 | ✅ | store 간소화 완료 |

---

## 3. 수정된 파일 목록

| 파일 | 변경 유형 | 관련 이슈 |
|------|----------|----------|
| `src/main/ai-service.ts` | 신규 생성 | #1, #4, #9, #13 |
| `src/main/index.ts` | 수정 | #3, #9, #15 |
| `src/preload/index.ts` | 재작성 | #1, #3, #9 |
| `src/renderer/lib/ai-client.ts` | 재작성 | #1, #9 |
| `src/renderer/lib/ai-provider.ts` | 재작성 | #1, #4 |
| `src/renderer/types/index.ts` | 수정 | #2 |
| `src/renderer/App.tsx` | 수정 | #6 |
| `src/renderer/components/OllamaSetupWizard.tsx` | 수정 | #7, #8 |
| `src/renderer/components/SettingsPanel.tsx` | 수정 | #2, #3, #8 |
| `src/renderer/lib/store.ts` | 수정 | #10, #16 |
| `src/renderer/components/ProgressBar.tsx` | 수정 | #14 |
| `src/renderer/lib/__tests__/ai-client.test.ts` | 재작성 | 테스트 업데이트 |

---

## 4. 검증 결과

| 항목 | 결과 |
|------|------|
| 단위 테스트 | 23/23 통과 |
| 빌드 | electron-vite build 성공 (main/preload/renderer) |
| TypeScript | 타입 에러 없음 |

---

## 5. Iteration 이력

| Iteration | 수정 이슈 | Match Rate |
|:---------:|----------|:----------:|
| 초기 | #1~#4, #6~#10, #13~#16 (13건) | 81.25% |
| **Iteration 1** | #11 ReactMarkdown debounce, #12 PDF 병렬 처리 | **93.75%** |

## 6. 후속 과제 (의도적 미수정)

| 우선순위 | 이슈 | 예상 효과 |
|:--------:|------|----------|
| Low | PowerShell 경로 이스케이프 (#5) | 방어적 보안 (현재 위험도 매우 낮음, temp 경로 기반) |

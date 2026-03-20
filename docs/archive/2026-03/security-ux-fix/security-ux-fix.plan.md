# Plan: security-ux-fix (보안 강화 및 UX 안정성 개선)

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | Ollama URL SSRF 취약점, macOS 명령 인젝션, 요약 중 닫기/설정 변경으로 상태 불일치 발생. 에러 메시지 닫기 불가, Dead code 잔존, 설정값 타입 미검증 |
| **Solution** | ollamaBaseUrl 호스트 화이트리스트, exec→execFile 교체, 요약 취소 기능 구현, 요약 중 설정/파일 변경 방지, 에러 닫기 버튼/Dead code 정리/값 검증 추가 |
| **Function UX Effect** | SSRF/인젝션 차단, 요약 중 안전한 취소, 상태 불일치 방지, 에러 복구 경로 제공, Setup에서 다른 Provider 전환 가능 |
| **Core Value** | 보안 취약점 제거 + 요약 중 안정적 상태 관리 |

---

## 1. Critical 수정 (4건)

### C1: Ollama SSRF 방어
- **파일**: `src/main/ai-service.ts`
- **문제**: `ollamaBaseUrl`이 검증 없이 HTTP 요청에 사용 → 내부 네트워크 접근 가능
- **수정**: `checkAvailability`, `generateOllama`에서 호스트를 `localhost`/`127.0.0.1`/`::1`로 제한
- **구현**: `validateOllamaUrl()` 함수 추가, 검증 실패 시 에러 throw

### C2: macOS Command Injection
- **파일**: `src/main/ollama-manager.ts:142`
- **문제**: `exec(\`unzip -o "${dmgPath}" ...\`)` — 경로가 쉘 해석됨
- **수정**: `exec` → `execFile`로 교체, `unzip`과 `open` 명령 분리

### C3: 요약 중 닫기 시 AI 요청 중단
- **파일**: `src/renderer/App.tsx`, `src/renderer/components/SummaryViewer.tsx`, `src/renderer/lib/ai-client.ts`
- **문제**: `handleClose` 시 `AiClient.summarize()`의 IPC 리스너가 정리되지 않고 백그라운드 계속 실행
- **수정**:
  - `AiClient`에서 현재 `requestId`를 노출
  - `App.tsx`에 `currentRequestId` ref 추가
  - `handleClose`/새 요약 시작 시 `ai:abort` IPC 호출
  - SummaryViewer의 닫기 → App의 abort 핸들러 호출

### C4: 요약 중 설정 변경 방지
- **파일**: `src/renderer/App.tsx`
- **문제**: `isGenerating` 중 설정 버튼이 활성화되어 Provider 변경 가능
- **수정**: 설정 버튼에 `disabled={isGenerating}` 추가

---

## 2. Warning 수정 (8건)

### W1: `win.isDestroyed()` 체크 추가
- **파일**: `src/main/ai-service.ts:233-241`
- **문제**: `res.on('end')`, `res.on('error')`에서 윈도우 닫힌 상태 미확인
- **수정**: `win.isDestroyed()` 체크 후 `send` 호출

### W2: 에러 시 activeRequests 정리
- **파일**: `src/main/ai-service.ts:186-196`
- **문제**: HTTP 4xx reject 시 `activeRequests.delete()` 누락
- **수정**: reject 전에 `activeRequests.delete(requestId)` 추가

### W3: Dead code 정리
- **파일**: `src/renderer/lib/ai-provider.ts`, `src/renderer/lib/prompts.ts`
- **문제**: Renderer에서 미사용 파일
- **수정**: `ai-provider.ts` 삭제, `prompts.ts`는 테스트에서 참조하므로 유지

### W4: settings:set 값 타입 검증
- **파일**: `src/main/index.ts:166-178`
- **문제**: 키 이름만 화이트리스트, 값 타입 미검증
- **수정**: `provider`는 VALID_PROVIDERS 포함 여부, `maxChunkSize`는 number 1000~16000, `theme`는 light/dark/system 검증

### W5: 에러 닫기 버튼 추가
- **파일**: `src/renderer/App.tsx:247`
- **수정**: 에러 메시지 영역에 X 닫기 버튼 추가 (`setError(null)`)

### W6: "다른 파일" 클릭 시 상태 초기화
- **파일**: `src/renderer/App.tsx:266`
- **문제**: `document`만 null, `summaryStream` 유지
- **수정**: `setDocument(null)` + `clearStream()` + `setSummary(null)` + `setProgress(0)`

### W7: Ollama Setup 실패 시 다른 Provider 전환
- **파일**: `src/renderer/components/OllamaSetupWizard.tsx`
- **수정**: 에러 화면에 "다른 AI Provider 사용하기" 버튼 추가 → `setView('settings')`

### W8: 요약 중 설정 버튼 비활성화
- C4와 통합 처리

---

## 3. 수정 대상 파일

| 파일 | 관련 이슈 |
|------|----------|
| `src/main/ai-service.ts` | C1, W1, W2 |
| `src/main/ollama-manager.ts` | C2 |
| `src/main/index.ts` | W4 |
| `src/renderer/App.tsx` | C3, C4, W5, W6, W8 |
| `src/renderer/components/SummaryViewer.tsx` | C3 |
| `src/renderer/components/OllamaSetupWizard.tsx` | W7 |
| `src/renderer/lib/ai-client.ts` | C3 |
| `src/renderer/lib/ai-provider.ts` | W3 (삭제) |

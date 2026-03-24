# Plan: pdf-image-recognition

> **Feature**: PDF 내 삽입 이미지 인식 및 요약 통합
> **작성일**: 2026-03-24
> **버전**: 0.7.1

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | PDF 내 차트, 다이어그램, 표, 사진 등 삽입 이미지를 완전히 무시하여 시각 자료의 의미가 요약에서 누락됨. 이미지 기반 PDF는 에러 발생 |
| **Solution** | pdfjs-dist로 PDF 내 이미지 객체를 개별 추출하고, Vision AI 모델(Ollama llava/Claude/GPT-4o)로 이미지 의미를 분석하여 텍스트 요약에 자연스럽게 통합 |
| **Function UX Effect** | 차트·다이어그램의 핵심 데이터가 요약에 포함되어 자료의 완전한 이해 가능. 이미지 없는 PDF는 기존 동작 유지 |
| **Core Value** | 텍스트+시각 자료를 통합한 완전한 PDF 요약 → 학습 효율 극대화 |

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 강의 자료 PDF에는 차트, 그래프, 다이어그램이 핵심 내용을 담고 있으나 현재 완전히 무시됨 |
| **WHO** | 강의 자료를 요약하는 학생/직장인 — 시각 자료가 많은 PDF를 자주 다루는 사용자 |
| **RISK** | Vision 모델 VRAM 요구사항 증가, API 토큰 비용 증가, 이미지 추출 실패 시 graceful fallback 필요 |
| **SUCCESS** | 이미지가 포함된 PDF에서 이미지 의미가 요약 텍스트에 자연스럽게 통합됨 |
| **SCOPE** | PDF 이미지 추출 + Vision API 분석 + 프롬프트 병합 (UI 변경 최소화) |

---

## 1. 배경 및 문제 정의

### 1.1 현재 상태

- `pdf-parser.ts`는 `pdfjs-dist`의 `getTextContent()`로 텍스트만 추출
- PDF 내 삽입 이미지(차트, 다이어그램, 표 사진)는 완전히 무시
- 이미지 기반 PDF(스캔 문서)는 텍스트 50자 미만 시 `PDF_NO_TEXT` 에러 발생
- 강의 자료에서 시각 자료가 핵심 정보를 담고 있어 요약 품질에 직접 영향

### 1.2 해결 목표

- PDF 내 삽입 이미지 객체를 개별 추출
- Vision AI 모델로 각 이미지의 의미/내용을 텍스트로 변환
- 변환된 텍스트를 해당 페이지의 텍스트와 병합하여 AI 요약에 전달
- 이미지가 없는 PDF는 기존 동작 그대로 유지 (하이브리드)

---

## 2. 요구사항

### 2.1 기능 요구사항

| # | 요구사항 | 우선순위 |
|:-:|----------|:--------:|
| FR-1 | PDF 페이지에서 이미지 객체 추출 (pdfjs `getOperatorList`) | Must |
| FR-2 | 추출된 이미지를 base64 PNG/JPEG로 변환 | Must |
| FR-3 | Vision 모델에 이미지 전송 및 설명 텍스트 수신 | Must |
| FR-4 | 이미지 설명을 해당 페이지 텍스트에 `[이미지: ...]` 형태로 삽입 | Must |
| FR-5 | 이미지가 없는 페이지/PDF는 기존 텍스트 전용 경로 유지 | Must |
| FR-6 | Ollama Vision 모델(llava, llama3.2-vision) 지원 | Must |
| FR-7 | Claude Vision (claude-sonnet-4) 지원 | Must |
| FR-8 | OpenAI Vision (gpt-4o) 지원 | Must |
| FR-9 | 이미지 분석 진행 상태를 UI에 표시 | Should |
| FR-10 | 이미지 분석 on/off 토글 (설정) | Should |
| FR-11 | 이미지 크기 필터링 (너무 작은 아이콘/로고 제외) | Should |

### 2.2 비기능 요구사항

| # | 요구사항 | 기준 |
|:-:|----------|------|
| NFR-1 | 이미지 없는 PDF 성능 저하 없음 | 기존과 동일한 처리 시간 |
| NFR-2 | 이미지 추출 실패 시 텍스트 전용으로 graceful fallback | 에러 없이 텍스트 요약 완료 |
| NFR-3 | 이미지 데이터 메모리 관리 | 분석 완료 후 즉시 해제, 최대 동시 10MB |
| NFR-4 | Vision 모델 미지원 시 안내 | 사용자에게 Vision 모델 필요 알림 |

---

## 3. 기술 분석

### 3.1 이미지 추출 방식

pdfjs-dist의 `page.getOperatorList()`를 사용하여 PDF 연산자 목록에서 이미지 페인트 연산(`OPS.paintImageXObject`)을 감지하고, `page.objs.get(imageName)`으로 이미지 데이터를 가져온다.

```
page.getOperatorList()
  → OPS.paintImageXObject 찾기
  → page.objs.get(imageName)
  → ImageData (width, height, data: Uint8ClampedArray)
  → Canvas에 그려서 base64 PNG/JPEG로 변환
```

### 3.2 Vision API 요청 형식

| Provider | API | 이미지 전달 방식 |
|----------|-----|-----------------|
| Ollama | `/api/generate` | `images: [base64]` 필드 |
| Claude | `/v1/messages` | `content: [{type: "image", source: {type: "base64", ...}}]` |
| OpenAI | `/v1/chat/completions` | `content: [{type: "image_url", image_url: {url: "data:image/png;base64,..."}}]` |

### 3.3 이미지 크기 필터링 기준

- 최소 크기: 50x50px (아이콘, 장식 이미지 제외)
- 최대 크기: Vision API 제한에 맞게 리사이즈 (장변 1024px 이하)
- 페이지당 최대 이미지: 10개 (과다 이미지 방지)

---

## 4. 범위 및 제약

### 4.1 범위 내 (In Scope)

- PDF 내 삽입 이미지 객체 추출 및 Vision 분석
- 3개 Provider 모두 멀티모달 지원
- 이미지 분석 on/off 토글
- 이미지 분석 진행 상태 표시

### 4.2 범위 외 (Out of Scope)

- OCR (이미지 내 텍스트 인식) — 별도 기능으로 분리
- 스캔 PDF (페이지 전체가 이미지) — 향후 별도 기능
- 이미지 편집/크롭 UI
- 이미지 원본 표시 (요약 결과에 이미지 직접 삽입)

---

## 5. 리스크

| 리스크 | 영향 | 완화 방안 |
|--------|------|----------|
| Ollama Vision 모델 VRAM 부족 | 이미지 분석 불가 | Vision 모델 미설치 시 텍스트 전용 fallback + 안내 메시지 |
| pdfjs에서 이미지 추출 실패 | 일부 PDF 형식 비호환 | try/catch로 개별 이미지 실패 무시, 텍스트만 사용 |
| 이미지 분석 토큰 비용 증가 | API 비용 증가 | 설정에서 on/off 토글, 이미지 크기 필터링 |
| 처리 시간 증가 | UX 저하 | 이미지 분석 진행 상태 표시, 병렬 처리 |

---

## 6. 성공 기준

| 기준 | 측정 방법 |
|------|----------|
| 이미지 포함 PDF에서 이미지 설명이 요약에 포함됨 | 차트/다이어그램이 있는 PDF로 테스트 |
| 이미지 없는 PDF는 기존과 동일하게 동작 | 기존 PDF로 회귀 테스트 |
| 3개 Provider 모두 Vision 분석 정상 작동 | Ollama(llava), Claude, OpenAI 각각 테스트 |
| 이미지 추출 실패 시 에러 없이 텍스트 요약 완료 | 손상된 이미지가 있는 PDF로 테스트 |

---

## 7. 구현 접근

### 7.1 변경 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/lib/pdf-parser.ts` | 이미지 추출 로직 추가 (getOperatorList) |
| `src/renderer/types/index.ts` | `PdfDocument`에 이미지 데이터 필드 추가 |
| `src/main/ai-service.ts` | 멀티모달 API 요청 지원 (Ollama/Claude/OpenAI) |
| `src/main/index.ts` | `GenerateRequest`에 이미지 데이터 포함 |
| `src/preload/index.ts` | IPC 브릿지 변경 (이미지 데이터 전달) |
| `src/renderer/lib/ai-client.ts` | 요약 요청에 이미지 데이터 포함 |
| `src/renderer/App.tsx` | 이미지 분석 진행 상태 표시 |
| `src/renderer/components/SettingsPanel.tsx` | 이미지 분석 on/off 토글 추가 |

### 7.2 처리 흐름

```
PDF 업로드
  → pdf-parser: 텍스트 추출 + 이미지 객체 추출
  → PdfDocument에 페이지별 이미지 목록 저장
  → 요약 시작
    → 이미지가 있는 페이지:
      → Main 프로세스에서 Vision API로 이미지 분석
      → "[이미지 분석: 이 차트는 2020~2025년 매출 성장 추이를 보여줍니다...]"
      → 페이지 텍스트에 이미지 설명 삽입
    → 이미지가 없는 페이지:
      → 기존 텍스트 전용 경로
  → 통합 텍스트로 최종 요약 생성
```

---

## 8. 일정 추정

| 단계 | 작업 | 예상 규모 |
|------|------|----------|
| Design | 아키텍처 설계 | 1 세션 |
| Do-1 | PDF 이미지 추출 + 타입 변경 | 1 세션 |
| Do-2 | Vision API 멀티모달 지원 (3 Provider) | 1 세션 |
| Do-3 | 프롬프트 병합 + UI 설정 | 1 세션 |
| Check | QA 사이클 | 1 세션 |

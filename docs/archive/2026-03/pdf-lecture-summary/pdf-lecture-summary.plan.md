# PDF 대학교 강의자료 요약 응용 프로그램 Planning Document

> **Summary**: PDF 형식의 대학교 강의자료를 업로드하면 AI가 핵심 내용을 자동 요약해주는 데스크톱 애플리케이션
>
> **Project**: summary-lecture-material
> **Version**: 0.1.0
> **Author**: jjw
> **Date**: 2026-03-17
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 대학교 강의자료(PDF)가 방대하여 시험 준비나 복습 시 핵심 내용 파악에 많은 시간이 소요됨 |
| **Solution** | PDF를 파싱하여 로컬 LLM(Ollama)으로 강의자료에 특화된 구조적 요약을 생성하는 데스크톱 앱 (추후 유료 API 전환 가능) |
| **Function/UX Effect** | PDF 드래그앤드롭 → 즉시 요약 결과 확인. 챕터별/키워드별 요약, 마크다운 내보내기 지원 |
| **Core Value** | 학습 효율 극대화 — 30분 분량의 강의자료를 3분 안에 핵심만 파악 |

---

## 1. Overview

### 1.1 Purpose

대학생이 PDF 형식의 강의자료를 빠르게 요약하여 학습 효율을 높이는 것을 목표로 한다. AI 기반 자동 요약을 통해 핵심 개념, 정의, 수식, 예제 등을 구조적으로 정리한다.

### 1.2 Background

- 대학 강의자료는 평균 30~100페이지 분량의 PDF로 제공됨
- 시험 기간에 여러 과목의 강의자료를 동시에 복습해야 하는 상황이 빈번함
- 기존 요약 도구들은 일반 텍스트에 최적화되어 있어 학술 자료의 수식, 도표, 전문 용어 처리가 미흡함
- 로컬 데스크톱 앱으로 개인 강의자료의 보안성 확보

### 1.3 Related Documents

- References: Electron / Tauri 공식 문서
- References: pdf.js, pdf-parse 라이브러리
- References: Claude API / OpenAI API 문서

---

## 2. Scope

### 2.1 In Scope

- [ ] PDF 파일 업로드 및 텍스트 추출
- [ ] AI 기반 강의자료 요약 (챕터별, 전체)
- [ ] 요약 결과 화면 표시 (마크다운 렌더링)
- [ ] 요약 결과 마크다운/텍스트 파일 내보내기
- [ ] 다크모드/라이트모드 지원
- [ ] 여러 PDF 파일 순차 처리

### 2.2 Out of Scope

- 사용자 인증 (로그인/회원가입)
- 클라우드 저장소 연동
- 요약 이력의 서버 동기화
- 실시간 협업 기능
- 모바일 앱 지원

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | PDF 파일 드래그앤드롭 또는 파일 선택으로 업로드 | High | Pending |
| FR-02 | PDF에서 텍스트 추출 (이미지 기반 PDF는 OCR 미지원, 텍스트 PDF만) | High | Pending |
| FR-03 | AI API를 통한 강의자료 요약 생성 | High | Pending |
| FR-04 | 요약 유형 선택: 전체 요약 / 챕터별 요약 / 키워드 추출 | High | Pending |
| FR-05 | 요약 결과 마크다운 형식으로 표시 | Medium | Pending |
| FR-06 | 요약 결과를 .md / .txt 파일로 내보내기 | Medium | Pending |
| FR-07 | AI 설정 화면 (Ollama 모델 선택, 추후 API 키 입력 지원) | High | Pending |
| FR-08 | 요약 진행 상태 표시 (프로그레스 바) | Medium | Pending |
| FR-09 | 최근 요약 이력 로컬 저장 및 조회 | Low | Pending |
| FR-10 | 앱 설치 시 Ollama 자동 설치 (미설치 시) | High | Pending |
| FR-11 | 첫 실행 시 기본 LLM 모델 자동 다운로드 (예: llama3.2) | High | Pending |
| FR-12 | Ollama 서비스 자동 시작 및 상태 모니터링 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 30페이지 PDF 요약 완료 60초 이내 (네트워크 제외) | 타이머 측정 |
| Performance | PDF 텍스트 추출 5초 이내 | 타이머 측정 |
| Security | 추후 API 키 사용 시 OS 키체인 또는 암호화된 로컬 저장소에 보관 | 코드 리뷰 |
| Usability | 처음 사용자가 1분 이내에 첫 요약 완료 가능 | 사용성 테스트 |
| Compatibility | Windows 10+, macOS 12+ 지원 | 크로스 플랫폼 빌드 테스트 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] PDF 업로드 → 텍스트 추출 → AI 요약 → 결과 표시 전체 플로우 동작
- [ ] Windows / macOS 빌드 성공
- [ ] Ollama 자동 설치 및 모델 다운로드 동작 (Windows, macOS)
- [ ] Ollama 서비스 자동 시작 동작
- [ ] 요약 결과 내보내기 동작
- [ ] 코드 리뷰 완료

### 4.2 Quality Criteria

- [ ] TypeScript strict mode 에러 없음
- [ ] ESLint 에러 없음
- [ ] 빌드 성공 (Windows, macOS)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 대용량 PDF(200+ 페이지) 시 AI API 토큰 한도 초과 | High | Medium | 청크 분할 전략 적용, 챕터별 요약으로 분리 처리 |
| 이미지/스캔 기반 PDF 텍스트 추출 불가 | Medium | Medium | 텍스트 PDF만 지원 명시, 추후 OCR 확장 고려 |
| 로컬 LLM 요약 품질 한계 | Medium | Medium | Provider 추상화로 유료 API 전환 용이하게 설계 |
| Tauri 빌드 환경 설정 복잡성 (Rust 의존) | Medium | Medium | Electron을 1차 옵션으로, Tauri는 경량화 필요 시 전환 |
| 수식/도표가 많은 PDF의 요약 품질 저하 | Medium | High | 프롬프트 엔지니어링으로 수식/도표 컨텍스트 보존 |
| Ollama 설치 실패 (권한, 디스크 등) | High | Low | 설치 전 사전 점검, 수동 설치 안내 폴백 |
| 모델 다운로드 시간 (수 GB) | Medium | High | 첫 실행 시 진행률 표시, 경량 모델(phi3 등) 기본 옵션 제공 |

---

## 6. Architecture Considerations

### 6.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | Simple structure (`components/`, `lib/`, `types/`) | Static sites, portfolios, landing pages | ✅ |
| **Dynamic** | Feature-based modules, BaaS integration (bkend.ai) | Web apps with backend, SaaS MVPs, fullstack apps | ☐ |
| **Enterprise** | Strict layer separation, DI, microservices | High-traffic systems, complex architectures | ☐ |

### 6.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| Desktop Framework | Electron / Tauri | **Electron** | 생태계 성숙도, React 통합 용이, 빠른 개발 속도 |
| Frontend | React + TypeScript | **React + TypeScript** | 컴포넌트 기반 UI, 타입 안전성 |
| PDF Parsing | pdf.js / pdf-parse / pdfjs-dist | **pdfjs-dist** | 브라우저/Node 양쪽 지원, Mozilla 유지보수 |
| AI API | Ollama (로컬) / Claude API / OpenAI API | **Ollama (로컬 LLM)** | 무료, 오프라인 사용 가능. 추후 유료 API로 전환 가능하도록 추상화 설계 |
| State Management | Context API / Zustand | **Zustand** | 가볍고 보일러플레이트 최소 |
| Styling | Tailwind CSS / CSS Modules | **Tailwind CSS** | 빠른 프로토타이핑, 다크모드 내장 지원 |
| Markdown Rendering | react-markdown / marked | **react-markdown** | React 네이티브 통합, remark 플러그인 생태계 |
| Build Tool | Vite / Webpack | **Vite** | 빠른 HMR, Electron과 호환 (electron-vite) |

### 6.3 Clean Architecture Approach

```
Selected Level: Starter

Folder Structure Preview:
┌─────────────────────────────────────────────────────┐
│ src/                                                │
│   main/              # Electron main process        │
│     index.ts         # 앱 엔트리, 윈도우 생성        │
│     ollama-manager.ts # Ollama 설치/시작/상태 관리   │
│   renderer/          # Electron renderer process    │
│     components/      # React UI 컴포넌트             │
│       PdfUploader.tsx                               │
│       SummaryViewer.tsx                              │
│       SettingsPanel.tsx                              │
│       ProgressBar.tsx                                │
│     lib/             # 유틸리티, 서비스               │
│       pdf-parser.ts  # PDF 텍스트 추출               │
│       ai-client.ts   # AI 호출 (Provider 추상화)      │
│       store.ts       # Zustand 상태 관리             │
│       prompts.ts     # 요약 프롬프트 템플릿           │
│     types/           # TypeScript 타입 정의          │
│       index.ts                                      │
│     App.tsx                                         │
│     index.html                                      │
└─────────────────────────────────────────────────────┘
```

---

## 7. Convention Prerequisites

### 7.1 Existing Project Conventions

Check which conventions already exist in the project:

- [ ] `CLAUDE.md` has coding conventions section
- [ ] `docs/01-plan/conventions.md` exists (Phase 2 output)
- [ ] `CONVENTIONS.md` exists at project root
- [ ] ESLint configuration (`.eslintrc.*`)
- [ ] Prettier configuration (`.prettierrc`)
- [ ] TypeScript configuration (`tsconfig.json`)

### 7.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| **Naming** | missing | 컴포넌트: PascalCase, 함수/변수: camelCase, 파일: kebab-case | High |
| **Folder structure** | missing | Starter 레벨 구조 (main/renderer 분리) | High |
| **Import order** | missing | 외부 → 내부 → 타입 순서 | Medium |
| **Environment variables** | missing | API 키 관리 방식 정의 | Medium |
| **Error handling** | missing | try-catch + 사용자 친화적 에러 메시지 | Medium |

### 7.3 Environment Variables Needed

| Variable | Purpose | Scope | To Be Created |
|----------|---------|-------|:-------------:|
| `AI_PROVIDER` | AI 제공자 선택 (ollama/claude/openai) | Main Process | ✅ |
| `AI_MODEL` | 사용할 모델명 (기본: llama3.2 등) | Main Process | ✅ |
| `OLLAMA_BASE_URL` | Ollama 서버 주소 (기본: http://localhost:11434) | Main Process | ✅ |
| `AI_API_KEY` | 유료 API 전환 시 인증 키 | Main Process | ☐ (추후) |

> Note: 기본은 Ollama 로컬 실행. 유료 API 전환 시 API 키는 Electron safeStorage로 암호화 저장

### 7.4 Pipeline Integration

| Phase | Status | Document Location | Command |
|-------|:------:|-------------------|---------|
| Phase 1 (Schema) | ☐ | `docs/01-plan/schema.md` | `/development-pipeline next` |
| Phase 2 (Convention) | ☐ | `docs/01-plan/conventions.md` | `/development-pipeline next` |

---

## 8. Next Steps

1. [ ] Design 문서 작성 (`pdf-lecture-summary.design.md`)
2. [ ] 프로젝트 초기화 (Electron + Vite + React + TypeScript)
3. [ ] PDF 파싱 프로토타입 구현
4. [ ] AI 요약 프롬프트 설계 및 테스트

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-03-17 | Initial draft | jjw |

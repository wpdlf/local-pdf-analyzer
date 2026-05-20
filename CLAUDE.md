# CLAUDE.md

## Project Overview

PDF 자료 분석 데스크톱 앱 (Electron + React + TypeScript)
Ollama/Claude/OpenAI를 통한 AI 요약, PDF 이미지 Vision 분석 지원

## Build & Package

```bash
npm run dev          # 개발 서버
npm run build        # electron-vite 빌드
npm run package      # 빌드 + electron-builder 패키징
```

## Release Procedure

사용자가 "릴리즈 해줘", "릴리즈 생성", "release" 등을 요청하면 반드시 아래 순서를 따른다:

1. `package.json` version 업데이트
2. 변경사항 커밋 + 푸시
3. `git tag vX.X.X && git push origin vX.X.X`
4. GitHub Actions가 자동으로 빌드 + 설치 파일 첨부 (`.github/workflows/release.yml`)
5. `gh release create` 또는 기존 릴리즈에 노트 업데이트

**중요**:
- `gh release create`에 `--tag` 대신 태그 이름만 전달
- 태그 푸시가 CI를 트리거하므로 수동 빌드/업로드 불필요
- CI 빌드에 약 8~12분 소요 (Ubuntu/Windows test 매트릭스 → Windows-2025 cold cache → electron-builder NSIS 서명). 릴리즈 생성 직후에는 설치 파일 미첨부 상태가 정상.
- 릴리즈 생성 후 `gh run watch <run-id> --exit-status`로 CI 완료를 확인하고, 설치 파일 첨부를 `gh release view` 로 검증할 것

## Code Signing

`package.json` 의 `forceCodeSigning: false` 는 의도적 설정. EV 인증서를 도입하기 전까지는
NSIS 인스톨러가 "알 수 없는 게시자" SmartScreen 경고와 함께 배포된다. 사용자가 첫 설치 시
"추가 정보" → "실행" 으로 진행하도록 README 에 안내. (v0.18.19 patch R32 P3 노트)

향후 EV 인증서 도입 시 다음을 함께 처리:
- `package.json` `win.certificateFile` / `certificatePassword` (또는 CI secret)
- `forceCodeSigning: true` 로 변경하여 서명 누락 시 빌드 실패하도록 게이트화
- README 의 SmartScreen 안내 제거

## Tech Stack

- Electron 41 + electron-vite 3
- React 19 + TypeScript 5 + Tailwind CSS 4
- Zustand 5 (상태 관리)
- pdfjs-dist 4 (PDF 파싱 + 이미지 추출 + OCR fallback)
- AI: Ollama (로컬), Claude API, OpenAI API
- Vision: llava/Claude/GPT-4o 로 이미지·수식·차트 분석
- RAG: 임베딩 기반 시맨틱 검색 (nomic-embed-text / text-embedding-3-small)
- 다국어 UI: 한국어/영어 (store 기반 i18n)

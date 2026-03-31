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
- CI 빌드에 약 3분 소요 — 릴리즈 생성 직후에는 설치 파일 미첨부 상태가 정상
- 릴리즈 생성 후 `gh run watch <run-id> --exit-status`로 CI 완료를 확인하고, 설치 파일 첨부를 `gh release view` 로 검증할 것

## Tech Stack

- Electron 34 + electron-vite
- React 19 + TypeScript + Tailwind CSS 4
- Zustand (상태 관리)
- pdfjs-dist (PDF 파싱 + 이미지 추출)
- AI: Ollama (로컬), Claude API, OpenAI API

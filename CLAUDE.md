# CLAUDE.md

## Project Overview

PDF 자료 분석 데스크톱 앱 (Electron + React + TypeScript)
Ollama/Claude/OpenAI/Gemini를 통한 AI 요약, PDF 이미지 Vision 분석 지원

## Build & Package

```bash
npm run dev          # 개발 서버
npm run build        # electron-vite 빌드
npm run package      # 빌드 + electron-builder 패키징
```

## Versioning (버전 번호 규칙)

**릴리즈 전에 이 규칙으로 어느 자리를 올릴지 먼저 정한다.**

| 자리 | 올리는 경우 |
|---|---|
| **minor** (0.32.0) | 기능 추가, 또는 **사용자가 체감하는 동작 변경** |
| **patch** (0.31.44) | 버그 수정 · 성능 · 리팩터링 · 테스트 · 문서 |

판단이 애매하면 **릴리즈 노트의 첫 문장**으로 가른다 — "이제 ~할 수 있습니다 / ~가 추가됐습니다"
면 minor, "~를 고쳤습니다" 면 patch.

**이 규칙을 명문화한 이유** (2026-08-06): 0.27~0.30 은 마이너당 1~2 패치였는데 **0.31.x 에만
44 패치**가 쌓였다. 그 안에 명백한 기능이 patch 로 들어가 있다 — 커스텀 요약 템플릿(v0.31.21),
요약 마인드맵(v0.31.26), **자동 업데이트 신규 서브시스템(v0.31.30)**, 업데이트 알림 배너(v0.31.40).
그래서 사용자가 버전 숫자만 보고 "기능이 생겼나 / 버그만 고쳤나" 를 구분할 수 없게 됐다.
숫자가 신호를 잃은 상태이므로, 다음 기능 릴리즈에서 **0.32.0 으로 올려 정상화**한다.

**1.0 기준**: 기능·안정성만으로 판단한다. 코드서명은 **1.0 조건에서 제외** — 아래 Code Signing
참조(개인 개발자는 EV 발급 자체가 불가하므로 달성 불가능한 조건을 걸면 안 된다).

## Release Procedure

사용자가 "릴리즈 해줘", "릴리즈 생성", "release" 등을 요청하면 반드시 아래 순서를 따른다:

0. **위 Versioning 규칙으로 minor/patch 판정** (기능이 들어갔는데 patch 로 내지 않는다)

1. `package.json` version 업데이트
2. 변경사항 커밋 + 푸시
3. `git tag vX.X.X && git push origin vX.X.X`
4. GitHub Actions가 자동으로 빌드 + 설치 파일 첨부 (`.github/workflows/release.yml`)
5. `gh release create` 또는 기존 릴리즈에 노트 업데이트

**중요**:
- `gh release create`에 `--tag` 대신 태그 이름만 전달
- **릴리즈 노트는 영/한 병기** (v0.20.x 부터): 릴리즈 타이틀과 본문은 영문으로 작성하고, 한국어 번역을 `<details><summary>🇰🇷 한국어</summary>` 접기 블록으로 하단에 병기. README 영문 메인 정책과 정합
- 태그 푸시가 CI를 트리거하므로 수동 빌드/업로드 불필요
- CI 빌드에 약 8~12분 소요 (Ubuntu/Windows test 매트릭스 → Windows-2025 cold cache → electron-builder NSIS 패키징 + Sigstore provenance attest). 릴리즈 생성 직후에는 설치 파일 미첨부 상태가 정상.
- 릴리즈 생성 후 `gh run watch <run-id> --exit-status`로 CI 완료를 확인하고, 설치 파일 첨부를 `gh release view` 로 검증할 것

## Dependency & Action Update Procedure

**dependabot 은 쓰지 않는다**(2026-08-20 제거, 재도입 금지). 자동 범프 PR 이 없으므로 아래는
**사람이 도는 절차**다. QA 라운드마다 함께 보는 것을 기본으로 한다.

### 판단 기준 — "무조건 최신"이 아니다
안 올렸을 때의 비용이 올렸을 때의 위험보다 큰 것만 가져온다.

| 분류 | 판단 |
|---|---|
| **electron** (앱 셸) | Chromium 보안 패치 경로. 이 앱은 신뢰할 수 없는 PDF 를 파싱하므로 patch 는 지체 없이 |
| **배포 라이브러리** (`shippedDevDependencies`) | 범위 밖으로 밀리면 나중에 권고가 떠도 major 이전이 필요해진다 — 따라간다 |
| **타입 전용** (`@types/*`) | 런타임 0, 부담 없이 |
| **테스트 인프라** (vitest/happy-dom/testing-library) | ⚠️ `//testingPinPolicy` 의 정확 핀. 매처·DOM 시뮬레이션이 조용히 바뀌어 **CI 가 초록인 채 false negative** 를 낸 전례가 있다. 수동 라운드에서만, 갱신 후 **테스트 수가 그대로인지** 반드시 대조 |
| **major 전반** | 격리 브랜치 스파이크(설치 → tsc + build + E2E → GO 시 머지) |

⛔ 보류 중: `vite` 8(electron-vite 6 stable 대기) · `katex` 0.18(rehype-katex 가 `^0.16` 요구)

### GitHub Actions SHA 핀
액션은 40자 SHA 로 핀돼 있고 **사람이 손대지 않으면 보안 수정도 영원히 오지 않는다.**
버전은 `uses:` 줄 **끝 주석**이 단일 출처다(앞줄 주석은 드리프트하므로 쓰지 않는다).

```bash
# 핀이 실제로 그 태그인지 대조
gh api repos/<owner>/<repo>/tags --paginate -q '.[] | select(.commit.sha=="<SHA>") | .name'
# 런타임 확인 — node20 액션은 GitHub 의 shim 제거 시 깨진다
gh api "repos/<owner>/<repo>/contents/action.yml?ref=<tag>" -q '.content' | base64 -d | grep using:
```

### 배포 분류 (audit 게이트의 입력)
새 의존성을 추가하면 `package.json` 의 셋 중 하나로 **반드시 분류**한다 —
`shippedDevDependencies`(vite 번들에 들어감) / `shippedRuntimeBinaries`(바이너리로 실림) /
테스트의 `BUILD_ONLY`. 분류를 빠뜨리면 `audit-shipped.test.ts` 가 실패한다. 이 가드가 없던
동안 배포 표면의 대부분인 **electron 이 두 blocking 게이트 밖**에 있었다(QA26 D-High).

## Code Signing

`package.json` 의 `forceCodeSigning: false` 는 의도적 설정. EV 인증서를 도입하기 전까지는
NSIS 인스톨러가 "알 수 없는 게시자" SmartScreen 경고와 함께 배포된다. 사용자가 첫 설치 시
"추가 정보" → "실행" 으로 진행하도록 README 에 안내. (v0.18.19 patch R32 P3 노트)

**⚠️ EV 는 현재 선택지가 아니다** (2026-08-06 확인): EV 코드서명은 **법인에만 발급**되는데
이 프로젝트 소유자는 사업자 등록이 없다. 따라서 "EV 도입"을 전제로 한 계획(1.0 조건 등)을
세우지 말 것 — 달성 불가능한 조건이다.

개인 개발자에게 열려 있는 선택지는 셋뿐이며, 각각의 트레이드오프는:
1. **개인용 OV 코드서명**(일부 CA 가 개인 발급) — 서명은 되지만 SmartScreen 평판은 **누적이
   필요**해 한동안 경고가 계속된다. 2023년 이후 OV 도 하드웨어 토큰/클라우드 HSM 보관이 의무.
2. **Microsoft Store 배포** — MS 가 서명하므로 경고가 없다. 대신 MSIX 패키징 + 스토어 심사가
   필요하고, 자동 업데이트를 스토어 채널로 옮겨야 한다(현재 electron-updater 체인과 충돌).
3. **현행 유지** — 미서명 + README 안내. 지금 방식.

향후 서명(OV)을 도입한다면 함께 처리:
- `package.json` `win.certificateFile` / `certificatePassword` (또는 CI secret)
- `forceCodeSigning: true` 로 변경하여 서명 누락 시 빌드 실패하도록 게이트화
- README 의 SmartScreen 안내는 **평판이 쌓여 경고가 실제로 사라진 뒤에** 제거(OV 는 즉시 사라지지
  않는다 — 서명했다는 이유만으로 안내를 지우면 사용자가 경고를 만나고 안내를 못 찾는다)

## Tech Stack

- Electron 43 + electron-vite 5 (vite 7)
- React 19 + TypeScript 7 + Tailwind CSS 4
- Zustand 5 (상태 관리)
- pdfjs-dist 6 (PDF 파싱 + 이미지 추출 + OCR fallback)
- AI: Ollama (로컬), Claude API, OpenAI API, Google Gemini API
- Vision: llava/Claude/GPT-4o/Gemini 로 이미지·수식·차트 분석
- RAG: 임베딩 기반 시맨틱 검색 (nomic-embed-text / text-embedding-3-small / gemini-embedding-2)
- 자동 업데이트: electron-updater (GitHub Releases 피드, 확인만 자동·다운로드/설치는 승인 후)
- 테스트: Vitest (유닛) + Playwright (E2E, 패키징 앱 스모크 포함)
- 다국어 UI: 한국어/영어 (store 기반 i18n)

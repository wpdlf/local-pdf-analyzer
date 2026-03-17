# 강의자료 요약기

PDF 형식의 대학교 강의자료를 AI가 자동으로 요약해주는 데스크톱 애플리케이션입니다.

## 다운로드

> [최신 릴리즈 다운로드](https://github.com/wpdlf/summary_lecture_material/releases/latest)

| OS | 파일 |
|----|------|
| Windows | `강의자료-요약기-Setup-x.x.x.exe` |
| macOS | `강의자료-요약기-x.x.x.dmg` |

## 주요 기능

- **PDF 드래그앤드롭** — PDF 파일을 끌어다 놓으면 바로 요약 시작
- **3가지 요약 모드** — 전체 요약 / 챕터별 요약 / 키워드 추출
- **로컬 AI (Ollama)** — 인터넷 없이 로컬에서 실행, 개인 자료 보안 보장
- **Ollama 자동 설치** — 첫 실행 시 Ollama와 AI 모델을 자동 설치
- **마크다운 내보내기** — 요약 결과를 `.md` / `.txt` 파일로 저장
- **다크모드** — 라이트 / 다크 / 시스템 설정 따르기

## 스크린샷

```
┌─────────────────────────────────────────────┐
│  📄 강의자료 요약기                    [⚙️]  │
├─────────────────────────────────────────────┤
│                                             │
│   PDF 파일을 여기에 드래그하거나              │
│            클릭하여 선택                     │
│                                             │
│  요약 유형: (● 전체) (○ 챕터별) (○ 키워드)   │
│                                             │
│              [📝 요약 시작]                  │
│                                             │
├─────────────────────────────────────────────┤
│  Ollama: ✅ Running (llama3.2)              │
└─────────────────────────────────────────────┘
```

## 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron 34 + React 19 |
| 언어 | TypeScript |
| AI | Ollama (로컬 LLM) |
| PDF 파싱 | pdfjs-dist |
| 상태 관리 | Zustand |
| 스타일링 | Tailwind CSS v4 |
| 빌드 | electron-vite + electron-builder |

## 개발 환경 설정

```bash
# 의존성 설치
npm install

# 개발 모드 실행
npm run dev

# 프로덕션 빌드
npm run build

# 인스톨러 패키징
npm run package

# 테스트
npx vitest run
```

## 요구 사항

- Node.js 18+
- Ollama (앱 첫 실행 시 자동 설치)
- Windows 10+ 또는 macOS 12+
- 디스크 공간 최소 4GB (AI 모델 저장용)

## 프로젝트 구조

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # 앱 엔트리, IPC 핸들러
│   └── ollama-manager.ts # Ollama 설치/시작/모델 관리
├── preload/
│   └── index.ts          # contextBridge API
└── renderer/             # React UI
    ├── App.tsx
    ├── components/       # UI 컴포넌트 (7개)
    ├── lib/              # 비즈니스 로직
    │   ├── ai-client.ts      # AI Provider 추상화
    │   ├── ai-provider.ts    # Ollama API 호출
    │   ├── pdf-parser.ts     # PDF 텍스트 추출
    │   ├── prompts.ts        # 요약 프롬프트 템플릿
    │   ├── chunker.ts        # 텍스트 청크 분할
    │   └── store.ts          # Zustand 상태 관리
    └── types/
        └── index.ts      # TypeScript 타입 정의
```

## 라이선스

ISC

# Changelog

All notable changes to the summary-lecture-material project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.2] - 2026-03-17

### Added
- **Vitest** unit testing framework (^4.1.0)
- **prompts.test.ts**: 4 unit tests for prompt generation (full, chapter, keyword summaries)
- **chunker.test.ts**: 6 unit tests for text chunking logic (heading, page, token-based)
- **ProgressBar.tsx**: Separate component for progress visualization
- **Error Code Usage**: All 10 error codes now actively used in error handling
  - `OLLAMA_NOT_FOUND`, `OLLAMA_INSTALL_FAIL`, `MODEL_NOT_FOUND`, `MODEL_PULL_FAIL` in OllamaSetupWizard
  - `EXPORT_FAIL` in SummaryViewer
  - `GENERATE_TIMEOUT` in App
- **Provider Selection UI**: Dropdown in SettingsPanel for switching between providers (ollama/claude/openai)
- **Duration Metrics**: Summary.durationMs calculation based on Date.now()
- **AppError Type**: Explicit error code type system (AppErrorCode union type)
- **IPC_CHANNELS**: Constant object for Electron IPC channel names
- **DEFAULT_SETTINGS**: Default application settings constant
- **OllamaManager.getStatus()**: Unified status retrieval method
- **OllamaManager.getVersion()**: Version query method
- **AiClient.isAvailable()**: Provider availability check
- **AiClient.listModels()**: Model list retrieval

### Changed
- **ProgressBar**: Extracted from SummaryViewer into standalone component
- **SettingsPanel**: Added Provider selector dropdown (ollama/claude/openai)
- **AiProvider type**: Renamed to `AiProviderType` to avoid naming conflict with interface
- **install() method**: Signature adjusted (onProgress callback removed, return type changed)
- **pullModel() method**: Signature adjusted (onProgress callback removed, return type changed)

### Fixed
- ProgressBar component separation improved reusability
- Error code coverage: 40% → 100% (10/10 codes now utilized)
- Test coverage initialization: 0% → 50% (10 tests added)

### Verified
- **Design Match Rate**: 81.7% (v0.1) → 92.3% (v0.2) ✅
  - Components: 87.5% → 100%
  - Error Codes: 40% → 100%
  - Tests: 0% → 50%
  - File Structure: 94.4% → 100%
  - Dependencies: 92.9% → 100%
- **Architecture Compliance**: 100% (Clean Architecture maintained)
- **Convention Compliance**: 95% (Naming, import order, file organization)
- **Build Status**: ✅ electron-vite build successful

### Known Issues / Remaining Work
- Integration tests not implemented (Ollama connectivity, file export)
- E2E tests not implemented (full workflow automation)
- OllamaManager.initialize() not refactored into single method
- install/pullModel progress reporting via IPC not implemented
- Final integration summary step for large PDFs not implemented
- safeStorage API key encryption pending (awaiting API support)
- Theme toggle button in header not implemented

---

## [0.1] - 2026-03-17

### Added
- **PDCA Planning Phase**: Feature planning document with 12 functional requirements (FR-01 ~ FR-12)
- **PDCA Design Phase**: Technical design document with architecture, components, data model
- **PDCA Do Phase**: Complete implementation of 22 files
  - Electron main process (OllamaManager, IPC bridge)
  - React renderer (8 UI components, 6 utilities, Zustand store)
  - Type definitions and configuration
- **PDCA Check Phase**: Gap analysis comparing design vs implementation (81.7% match rate)

### Core Features Implemented
- **PDF Upload**: Drag-and-drop and file selection
- **Text Extraction**: pdfjs-dist based PDF parsing
- **AI Summarization**: Ollama local LLM integration with streaming
- **Summary Types**: Full, chapter-based, keyword extraction
- **Markdown Rendering**: react-markdown with GFM support
- **File Export**: .md and .txt file saving
- **Settings Panel**: Model and URL configuration, theme selection
- **Ollama Management**: Auto-install, process start/stop, health check
- **Error Handling**: 10 error codes defined (partial usage in v0.1)
- **UI Components**: PdfUploader, SummaryViewer, SettingsPanel, OllamaSetupWizard, StatusBar, etc.

### Architecture Decisions
- **Framework**: Electron + electron-vite for desktop development
- **UI**: React 19 + TypeScript + Tailwind CSS
- **PDF Parsing**: pdfjs-dist for text extraction
- **AI Provider**: Ollama (local LLM) with abstraction for future API support
- **State Management**: Zustand for lightweight global state
- **Build Tool**: electron-vite for fast development and production builds

### Security Baseline
- Electron: contextIsolation enabled, nodeIntegration disabled
- IPC: Preload bridge for safe main/renderer communication
- Ollama: localhost-only communication

### Testing Infrastructure
- Vitest configured (added in v0.2)
- Test files structure prepared

### Initial Quality Metrics
- Match Rate: 81.7% (85/104 items matched)
- Architecture Compliance: 95%
- Convention Compliance: 90%
- Build Status: ✅ Success

---

## Project Information

| Item | Value |
|------|-------|
| **Project Name** | summary-lecture-material |
| **Feature** | pdf-lecture-summary (PDF 대학교 강의자료 요약) |
| **Project Level** | Starter |
| **Start Date** | 2026-03-17 |
| **Current Version** | 0.2 |
| **Status** | PDCA Cycle Completed ✅ |

---

## References

- **PDCA Documents**: `docs/01-plan/`, `docs/02-design/`, `docs/03-analysis/`, `docs/04-report/`
- **Implementation**: `src/main/`, `src/renderer/`, `src/preload/`
- **Tests**: `src/renderer/lib/__tests__/`
- **Configuration**: `package.json`, `electron.vite.config.ts`, `tsconfig.json`

---

**Last Updated**: 2026-03-17
**Maintainer**: jjw

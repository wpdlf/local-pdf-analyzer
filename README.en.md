[한국어](README.md) | 🌐 **English**

# 📄 Local AI PDF Analyzer

**A local AI-powered PDF summarization tool that runs entirely on your PC.**

Unlike cloud-based AI summarization services that require uploading PDFs to external servers, this app runs **AI directly on your computer**.

- **Fully offline** — Ollama local AI engine runs on your PC; PDF files are never sent to external servers
- **Text + image analysis** — Analyzes text, charts, diagrams, and tables in any PDF using Vision AI
- **Scanned PDF OCR** — Vision AI recognizes text page-by-page even in image-based scanned PDFs
- **RAG-based Q&A chat** — Embedding vector semantic search finds the most relevant parts of your PDF to answer questions accurately
- **Automatic answer verification (new in v0.18.0)** — Each sentence of a Q&A answer is scored against the PDF embedding index. If too many low-confidence sentences are detected, the LLM silently refines the answer to remove unsupported claims — no user interaction required
- **Page citations + side PDF viewer (new in v0.17.0)** — Summary/Q&A answers automatically include source-page citations like `[p.12]`. Click a citation to open a PDF viewer panel on the right that instantly jumps to that page — verify AI hallucinations in one click
- **Safe for sensitive documents** — Exam materials, internal documents, draft papers — summarize with confidence
- **Korean/English UI** — Switch app interface language in Settings
- **Paid AI available** — Switch to Claude or OpenAI API for higher quality when needed

---

## Download & Install

> **[Download Latest Version](https://github.com/wpdlf/local-pdf-analyzer/releases/latest)**

| Platform | File |
|---|---|
| **Windows** | `Local-PDF-Analyzer-Setup-x.x.x.exe` |
| **macOS** | _Temporarily suspended starting v0.18.9_ (will return once Apple notarization credentials are in place) |

1. Download the Windows installer from the link above
2. Run the installer
3. Launch the app from the desktop shortcut or Start menu

4. On first launch, the AI engine (Ollama), Korean-specialized models (gemma3, exaone3.5), and RAG embedding model (nomic-embed-text) are installed automatically — follow the on-screen instructions

> **Note**: AI model downloads require approximately 8GB of disk space and a few minutes.
> **macOS users**: Starting v0.18.9, the dmg artifact is temporarily not shipped because we do not currently hold an Apple Developer ID for notarization. We chose to pause rather than publish an unsigned dmg that Gatekeeper quarantines (forcing users to run `xattr -d`). The dmg target will return as soon as notarization credentials are registered. In the meantime you can build from source with `npm run package`.

### Installer integrity verification (new in v0.18.8)

Every release attaches the installer's **SHA-256 hash** as an asset (`SHA256SUMS-windows.txt`) and also embeds it in the release notes. Builds are additionally signed with a **Sigstore build provenance attestation** issued by GitHub Actions, so you can verify the artifact actually came from this repository's CI.

```bash
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 .\Local-PDF-Analyzer-Setup-0.18.19.exe

# Verify the Sigstore attestation via GitHub CLI (optional)
gh attestation verify ./Local-PDF-Analyzer-Setup-0.18.19.exe --repo wpdlf/local-pdf-analyzer
```

## How to Use

### 1. Upload PDF
- **Drag and drop** a PDF file onto the app window, or
- Click the **Select file** button, or
- Press **Ctrl+O** to open the file dialog

### 2. Choose Summary Type

| Type | Description |
|------|-------------|
| **Full summary** | Summarize the entire PDF as one document |
| **By chapter** | Summarize each chapter/section separately |
| **Keywords** | Extract key terms with descriptions in a table |

### 3. View & Save Results
- Summary appears in real-time as it streams
- Save with the **Export .md** button
- Copy to clipboard with the **Copy** button

### 4. Q&A Chat (RAG Semantic Search)
- A **RAG vector index** is automatically built when a PDF is loaded (progress shown in header)
- When the **RAG** badge appears in the header, semantic search is active
- Ask questions and the AI finds the most relevant parts of the PDF using embedding vector similarity
- Falls back to keyword-based search automatically if no embedding model is available
- Maintains context across up to 10 conversation turns
- **Automatic answer verification (v0.18.0)** — The draft answer is split into sentences (multi-language sentence boundaries; mixed Latin/CJK in v0.18.8) and each sentence's top-1 cosine similarity is checked against the PDF embedding index. If 2+ sentences score below the weak threshold, or the weak ratio exceeds 20%, or the average score falls below the threshold, the LLM is invoked once more to refine the answer and drop unsupported claims. The whole flow is silent — only the more accurate result is shown. Toggle off in Settings if you prefer raw drafts
- `Enter`: send / `Shift+Enter`: new line

### 5. Page Citations + PDF Viewer (new in v0.17.0, extended in v0.17.2)
- Summary and Q&A answers automatically get **`[p.12]`-style source citations at almost every key sentence** (citation frequency significantly improved in v0.17.1 via paragraph-level inline labels)
- **Click a citation** to open a **PDF viewer panel** on the right that jumps directly to that page
- Clicking additional citations keeps the panel open and just scrolls to the new page
- **Horizontal resize handle (new in v0.17.2)** — drag the central vertical divider between the summary area and the PDF viewer to freely adjust the left/right ratio between 20~80%. Tab-focus the handle and use `←` / `→` for fine steps, `Home` / `End` for min/max. The ratio is persisted in `localStorage` and restored on app restart
- **Automatic PDF re-render** — after resizing, PDF pages are re-rendered at the new width (200ms debounce, ResizeObserver based)
- Press `ESC` or the ✕ button to close the panel and return to full-width view
- Citations that point outside the PDF (e.g. beyond total page count) are shown as dashed grey tags and are click-disabled
- Common LLM mistakes like wrapping citations in `([p.5])` or emitting standalone list items `- [p.44]` are **auto-fixed via post-processing** (v0.17.1)
- This feature targets **AI hallucination verification** — instantly confirm the source page for any claim in a summary. Especially valuable for studying, research, and document review

> **Embedding model**: `nomic-embed-text` (274MB) is auto-installed during first-run setup. OpenAI users automatically get `text-embedding-3-small`.

## AI Provider Selection

The default is local AI (Ollama). Switch to paid AI for higher quality summaries.

| Provider | Features | Cost |
|----------|----------|------|
| **Ollama (default)** | Offline use, data privacy | Free |
| **Claude API** | High summary quality, strong with long documents | Paid (per token) |
| **OpenAI API** | GPT-4o based, general-purpose | Paid (per token) |

### Q&A Embedding Models (RAG)

| Provider | Embedding Model | Dimensions | Notes |
|----------|----------------|------------|-------|
| **Ollama** | nomic-embed-text (274MB) | 768 | Local, auto-installed on first run |
| **OpenAI** | text-embedding-3-small | 1536 | Auto-used with API key, no extra install |
| **Claude** | Ollama fallback | — | No native embedding API; tries Ollama, falls back to keyword search |

> Q&A works with keyword-based search even without an embedding model. RAG is an optional accuracy enhancement.

To use paid AI:
1. Settings (gear icon) -> Select Claude or OpenAI under AI Provider
2. Enter and **Save** your API key (keys are encrypted and stored locally)
3. Select a model and **Save settings**

## PDF Image Analysis

Vision AI automatically analyzes charts, diagrams, tables, and photos embedded in PDFs.

- Images are extracted per page and analyzed with Vision models
- Analysis results are integrated into page text for improved summary quality
- PDFs without images are summarized as text-only
- Can be toggled on/off in Settings

| Provider | Vision Model | Notes |
|----------|-------------|-------|
| **Ollama** | llava, llama3.2-vision | Local, prompted to install if missing |
| **Claude** | claude-sonnet-4 | API costs apply |
| **OpenAI** | gpt-4o | API costs apply |

> Ollama requires a Vision model (e.g., llava). Install via Settings -> Model Management.

## Scanned PDF OCR

Vision AI automatically recognizes text page-by-page in image-based/scanned PDFs.

- Auto-enters OCR fallback when text extraction fails (toggleable in Settings)
- Renders each page as image -> requests text extraction from Vision model
- Batch parallel processing (3 pages at a time) with progress bar
- Auto-cancels OCR when loading a different file
- Documents processed via OCR show an `OCR` badge

| Provider | Korean OCR Accuracy | Notes |
|----------|-------------------|-------|
| **Claude** | 90-98% | Includes table/formula structure, API costs |
| **OpenAI (GPT-4o)** | 90-95% | Includes table/formula structure, API costs |
| **Ollama (llava)** | 60-75% | Free, suitable for simple English PDFs |

> Processing time and API costs increase with page count. For 50 pages: Claude ~$0.15-0.30, GPT-4o ~$0.25-0.50.

## Key Features

- **Local AI** — Summarize offline with Ollama; PDFs never leave your PC
- **RAG Q&A chat** — Semantic search with embedding vectors finds relevant content; keyword fallback supported (10-turn conversation)
- **Clean summaries** — Unwanted greetings, compliments, and conversational phrases removed via prompt constraints + post-processing filter
- **Image analysis** — Charts/diagrams/tables analyzed by Vision AI and integrated into summaries
- **Scanned PDF OCR** — Text recognition via Vision AI for image-based PDFs (toggleable)
- **Cancellable long-running tasks** — Cancel button during PDF parsing / OCR, mid-setup cancel in Ollama install wizard (instant switch to alternative Provider)
- **Korean optimized** — Improved Korean PDF text extraction, auto-adjusted chunk sizes by Korean character ratio
- **Auto model install** — First run auto-downloads gemma3, exaone3.5 (Korean models) + nomic-embed-text (RAG embedding)
- **Paid AI support** — Claude API and OpenAI API for high-quality summaries (works without Ollama)
- **Provider-aware OCR batching** — Cloud providers (Claude/OpenAI) use 8-page parallel batches for higher throughput; local Ollama uses 3 pages
- **API key security** — OS keychain encryption + decrypted only in Main process (never exposed to Renderer) + in-memory cache for hot-path performance
- **Data privacy** — PDFs never sent to external servers when using Ollama
- **Real-time streaming** — Summary appears as it generates (leading-edge throttle), auto-scroll (pauses when you scroll up)
- **Cancellable** — Stop summarization anytime; 5-minute timeout auto-abort
- **Accessibility** — Screen reader `aria-live` streaming announcements, keyboard navigation, dark mode FOUC prevention
- **Dark mode** — Light/Dark/System theme in Settings
- **Multilingual UI** — Korean/English app interface toggle (Settings -> Language)
- **Large PDF support** — Long documents auto-split into chunks for batch processing with integrated summary (up to 500 pages)
- **Persistent settings** — Settings saved across app restarts
- **Swap files mid-parse** — Drop a different PDF or press `Ctrl+O` while one is being parsed; the previous operation aborts automatically and the new file takes precedence (abort-replace)
- **Per-page parsing resilience** — One corrupt page no longer aborts the entire document; remaining pages are still processed
- **Render-error recovery** — Unexpected UI crashes offer a "Try again" button without a full reload (paths auto-masked)
- **Instant language switch** — Toggling Korean/English in Settings reflects across the whole UI immediately (no restart required)
- **Magic-byte PDF validation** — `%PDF-` signature is verified before the file is fully loaded into memory, rejecting fakes early
- **Unit test coverage** — **322 regression tests** for RAG / citation / Q&A core paths (+13 in v0.17.x, +227 cumulative across v0.18.x, 18 test files). The R32 round in v0.18.19 patch added +30 (P1/P2/P3 cumulative); R33 4-agent QA then surfaced regressions in R32-introduced code which R34 fixed, adding another +30 — R34 P1 +4 (safe-markdown MarkdownErrorBoundary reset guards) and R34 P2 +26 (settings-keys drift guards 6 / enrich-doc Vision partial-failure contract 11 / preload contextBridge shape snapshot 9)
- **Build integrity (cumulatively hardened across v0.18.8 ~ v0.18.19 patch)** — Each release auto-publishes installer SHA-256 hashes and a Sigstore build provenance attestation. CI workflows pin every third-party action by full SHA, use `npm ci`, and keep the lockfile in sync to guarantee reproducible builds. v0.18.9 adds `timeout-minutes` on every job, an Ubuntu/Windows OS matrix on the test job, and a mandatory `npx tsc --noEmit` gate on both PR and release pipelines so strict flags like `noUncheckedIndexedAccess` cannot silently regress. v0.18.10 pins the Windows runner from `windows-latest` to `windows-2025` ahead of the June 2026 migration. v0.18.11 bumps `actions/checkout` and `actions/setup-node` to their Node.js 24-compatible majors (v6), adds an advisory `npm audit --audit-level=high` step, and declares an `engines` field in `package.json` (node ≥ 20.11, npm ≥ 10). v0.18.13 introduces `asarUnpack: ["**/cmaps/**"]` (so pdfjs CMap files survive asar packing) plus 9 R29 P1 hardening fixes. v0.18.15 adds Ollama `keep_alive: '30m'` + renderer `manualChunks` (main chunk 808→304 KB, -62%) + Vision provider-aware concurrency (Ollama 3 / cloud 8) — first performance-track round. v0.18.16 introduces PdfViewer page virtualization (IntersectionObserver-driven lazy render, ~95% fewer canvases for a 100-page citation click) — second performance-track round. v0.18.17 lands six R30 full-QA P1 fixes (Promise.race timer leak, PdfViewer viewport race, lockfile drift, empty image-name guard, targetPage polling stuck, workflow node-version drift). v0.18.18 bundles six R30 P2 + R29 QA P2 small-fixes (Vision in-flight abort, setNotice auto-dismiss, vitest coverage, LOCALHOST_HOSTS dedup, Bearer regex `~`, shell:open-external length cap). v0.18.19 patch lands the R32 4-agent parallel QA result: 5 P2 + 8 P3 + 12 P4 + 8 P5 — the same v0.18.19 release assets were overwritten three times with the cumulative build (Q&A cross-session token contamination / prompt injection via summary+assistant / PDF parse error banner path leak / OCR cloud abort un-propagated / CI audit step `if: always()` + Vision stale enrichment / theme localStorage drift / MarkdownErrorBoundary reset / OCR memory cap / MAX_LINE_SIZE silent skip / lockfile `packages[""]` check / audit JSON single-spawn consolidation / PowerShell quote helper + 9-case unit test + handleSummarize docId guard / appendQaStream isQaGenerating gate / enrichedPageTexts version counter / clientRef ownership / taskkill SIGKILL fallback / will-redirect tightened / generate placeholder controller / req.setTimeout settled / i18n hasOwnProperty + missing-key fallback / ResizeHandle Home/End ARIA alignment / safe-markdown headings·blockquote citations / vitest pool 'forks' + Vitest 4 migration / ai-client.test timer margin / release.yml fail-fast: false / postbuild cmap smoke check). A follow-up R33 4-agent QA then detected four regressions inside R32-introduced code, which R34 P1 cleaned up (MarkdownErrorBoundary now compares `fallbackText` string instead of `children` element identity / `generate()` placeholder leak wrapped in try/catch with identity-based cleanup / will-redirect's file:// comparison switched to `pathToFileURL().href` standard URL / CI audit step gated by `[ -d node_modules ]` plus an `j.error` branch when fired after `npm ci` failure). R34 P2 closed coverage gaps with new pure-helper modules and accompanying P4 hardening (`VALID_SETTINGS_KEYS` consolidated into `src/main/settings-keys.ts` / `enrichDocumentWithImages` extracted to `src/renderer/lib/enrich-doc.ts` / preload contextBridge shape static snapshot test / i18n `hasOwnProperty` AND `=== undefined` / pdf-parser OCR per-page abort listener race tightened / preload `ai.abort` return type aligned with `error?` / postbuild SMOKE_FILES includes `Adobe-CNS1-UCS2.bcmap`). The same v0.18.19 release assets were overwritten **five times**; Critical remains zero across 34 consecutive QA rounds.
- **Page citations + side PDF viewer (v0.17.0)** — Summary/Q&A answers automatically carry `[p.N]` source-page citations at almost every key sentence. Click to open a right-side PDF viewer panel that scrolls to the cited page. Built on page-aware RAG chunks + LLM prompt injection (5 languages) + lazy pdfjs-dist viewer + react-markdown text-block overrides. Citation frequency significantly improved in v0.17.1 via paragraph-level inline labels
- **Horizontal resize handle (v0.17.2)** — when the PDF viewer panel is open, drag the central divider to freely adjust the left/right ratio between 20~80%. Pointer + keyboard (← → Home End) + ARIA (`role="separator"`, `aria-valuenow`) + localStorage persistence. PDF pages auto re-render via `ResizeObserver` + 200ms debounce
- **Citation placement normalization (v0.17.1)** — LLM mistakes like `([p.5])` wrapping or standalone list items `- [p.44]` are automatically re-attached to the preceding sentence
- **Automatic answer verification (v0.18.0)** — Q&A draft answers are sentence-split with multi-language terminator awareness (mixed CJK in v0.18.8) → each sentence scored against the PDF embedding (top-1 cosine). When weakCount / weakRatio / avgScore exceed thresholds, the LLM refines the answer once. A single boilerplate weak sentence is allowed (v0.18.3) to avoid unnecessary refine costs

## System Requirements

- **Windows 10 or later** or **macOS 12 (Monterey) or later**
- Minimum 8GB disk space (for AI models, when using Ollama)
- Internet connection (for first install and paid API usage)
- PDF limits: up to 100MB, up to 500 pages (split larger documents manually)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Ollama install fails | Install manually from [ollama.com](https://ollama.com), or click "Cancel and use another provider" in the setup wizard to switch to Claude/OpenAI |
| Poor Korean summary quality | Check that gemma3 or exaone3.5 is selected in Settings |
| Slow summarization | Switch to a lighter model (e.g., phi3) or reduce chunk size |
| Cannot extract PDF text | Enable "Scanned PDF OCR" in Settings. Requires Vision model (llava, Claude, GPT-4o) |
| Inaccurate OCR | Ollama llava has limited Korean accuracy. Switch to Claude or OpenAI for much better results (also 3→8 batch size upgrade) |
| OCR taking too long | Click the "■ Cancel" button on the parsing screen. Switching to a cloud provider increases throughput |
| PDF exceeds 500 pages | Manually split the document before uploading. The cap prevents runaway resource usage |
| Image analysis not working | Ollama requires a Vision model (llava, etc.). Install via Settings |
| API key error | Verify API key in Settings. Claude: `sk-ant-...`, OpenAI: `sk-...` |
| Claude/OpenAI unavailable | Save your API key first, then select the Provider |
| Unwanted phrases in summary | v0.10.0+ includes prompt hardening + post-processing filter for auto-removal |
| Q&A can't answer | If no RAG badge, install embedding model: `ollama pull nomic-embed-text`. In keyword mode, include specific terms |
| RAG indexing not working | Complete first-run setup (nomic-embed-text auto-installs). Manual: `ollama pull nomic-embed-text` |
| Dropping a new file during parsing is ignored | Fixed in v0.16.2 via abort-replace — the new file takes precedence immediately |
| Chunk-size input rejects single keystrokes | Fixed in v0.16.2 — type freely, blur clamps to the 1000–16000 range |
| Language switch doesn't fully update the UI | Fixed in v0.16.2 — entire UI re-renders via reactive `tr()` hook |
| Claude/OpenAI model sticks after deleting the API key | Fixed in v0.16.2 — deleting the key auto-switches to Ollama with an installed model |
| Copy-summary button does nothing | Fixed in v0.16.2 via explicit `clipboard-sanitized-write` permission allow |
| App freezes on render error | v0.16.2 adds a "Try again" button to the error boundary — recover without restart |
| Summary has only one citation | Fixed in v0.17.1 — paragraph-level inline page labels generate a citation for each key fact |
| Summary shows `([p.5])` wrapped in parens or `- [p.44]` standalone list items | v0.17.1 auto-normalizes — removes parens and re-attaches standalone citations to the preceding sentence |
| PDF viewer looks too zoomed in a narrow panel | Fixed in v0.17.1 — container-width-based dynamic scale fits the PDF to the panel automatically |
| Want to change the PDF viewer panel width | v0.17.2 new — drag the central divider or Tab-focus it and use ← → Home End to adjust between 20~80% |
| PDF stays stretched after resizing | Fixed in v0.17.2 — `ResizeObserver` triggers re-render at the new scale ~200ms after the drag ends |
| Q&A answers still show hallucinations | v0.18.0 automatic verification rewrites the answer once when too many sentences lack RAG support. Disable via the "Answer verification" toggle in Settings if you prefer the raw draft |
| Q&A answer feels like it generates twice (extra delay) | v0.18.0 may issue one extra LLM call when the draft fails verification. A single boilerplate weak sentence is allowed (v0.18.3) so most answers still finish in a single pass |
| Mixed Korean/English answers slip past hallucination detection | Fixed in v0.18.8 — `splitIntoSentences` now also splits at a Latin terminator immediately followed by a CJK character (no space), so mixed-language drafts are scored sentence-by-sentence |
| How do I verify the installer hasn't been tampered with | v0.18.8 new — compare against `SHA256SUMS-windows.txt` (or the hash printed in the release notes), or run `gh attestation verify` against the Sigstore provenance |
| Where is the macOS download | Suspended since v0.18.9 — we do not currently hold an Apple Developer ID for notarization, and we declined to publish an unsigned dmg that Gatekeeper would quarantine (forcing users to run `xattr -d`). The dmg target will return as soon as credentials are registered. In the meantime, build from source via `npm run package` |
| Memory blows up on very large PDFs | Fixed in v0.18.9 — the `MAX_TOTAL_IMAGES=50` cap was bypassed by batch-concurrent promises pushing simultaneously. The page promise now re-checks the remaining slot count both on entry and immediately before pushing, preventing dozens of base64 conversions from running in parallel and exhausting memory |
| Cancelling a summary/Q&A leaves token listeners hanging for a moment | Fixed in v0.18.9 — listener/timer registration in `ai-client.summarize` was moved inside a `try/finally` block so that unsubscribe and server-side `abort` are guaranteed to run even if `generate()` throws synchronously or a registration step errors |

---

## Developer Guide

### Tech Stack

| Item | Technology |
|------|-----------|
| Framework | Electron 41 + React 19 |
| Language | TypeScript (strict mode) |
| AI Generation | Ollama (local) / Claude API / OpenAI API — Main process IPC |
| AI Embedding (RAG) | Ollama /api/embed / OpenAI /v1/embeddings — In-memory vector store |
| PDF Parsing | pdfjs-dist (position-based text extraction + image extraction, Korean optimized) |
| State Management | Zustand |
| Styling | Tailwind CSS v4 + @tailwindcss/typography |
| Build | electron-vite + electron-builder (Windows NSIS — macOS DMG paused since v0.18.9 pending notarization credentials) |
| Testing | Vitest (322 unit tests across 18 files) + `tsc --noEmit` strict type check (`noUncheckedIndexedAccess` enabled in v0.18.8; enforced on both PR and release CI in v0.18.9; `vitest.config.mts` + `test/setup.ts` entry point added in v0.18.11; `noFallthroughCasesInSwitch` + `noImplicitOverride` enabled in v0.18.19; `pool: 'forks'` pinned + Vitest 4 migration in v0.18.19 patch). R34 P2 extracted native-dep-free pure helpers into separate modules so vitest can import them directly (`settings-keys.ts` / `ps-quote.ts` / `enrich-doc.ts`) — drift guards + Vision partial-failure contract statically verified |
| i18n | Custom (i18n.ts) — 172+ keys, useT() hook, template interpolation |
| API Key Security | Electron safeStorage (OS keychain encryption), decrypted only in Main process, in-memory cache for hot-path |
| Shared constants | `src/shared/constants.ts` — Main/Renderer shared (MAX_PDF_SIZE etc.) to prevent drift |

### Development Setup

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Production build
npm run build

# Package installer
npm run package

# Run tests
npm test

# Tests (watch mode)
npm run test:watch
```

### Project Structure

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # App entry, IPC, settings/API key management
│   ├── ai-service.ts     # AI API calls (streaming summary + Vision image analysis + OCR)
│   └── ollama-manager.ts # Ollama install/start/model management
├── preload/
│   └── index.ts          # contextBridge API (ai, settings, apiKey, ollama, file)
└── renderer/             # React UI
    ├── App.tsx            # Root component, summarization logic
    ├── components/        # UI components (9)
    ├── lib/
    │   ├── ai-client.ts       # AI Client (IPC requests to Main for summary/Q&A)
    │   ├── pdf-parser.ts      # PDF text + image extraction, chapter detection, OCR fallback
    │   ├── chunker.ts         # Text chunk splitting (auto Korean ratio detection)
    │   ├── i18n.ts            # Internationalization (172+ keys, t() function, useT() hook)
    │   ├── use-qa.ts          # Q&A chat hook (RAG semantic search + keyword fallback, conversation history)
    │   ├── vector-store.ts    # In-memory vector store (cosine similarity search, dimension validation)
    │   ├── store.ts           # Zustand state management (summary + Q&A + RAG index)
    │   └── __tests__/         # Unit tests (322 across 18 files)
    └── types/
        └── index.ts       # Type definitions + Provider model constants
```

### Architecture

AI API calls are made from the Main process for API key security. The Renderer requests summaries via IPC and receives token streams.

```
Electron Main Process                Renderer Process (React)
┌──────────────────────────┐        ┌──────────────────────────┐
│ OllamaManager            │        │ App.tsx                  │
│ AiService ──┐            │◄─IPC─►│ ├── PdfUploader          │
│   ├── Ollama (HTTP)      │        │ ├── SummaryViewer        │
│   ├── Claude (HTTPS)     │        │ │   └── QaChat (Q&A)    │
│   └── OpenAI (HTTPS)     │        │ ├── SettingsPanel        │
│ Embedding ──┐            │        │ └── lib/                 │
│   ├── Ollama /api/embed  │        │     ├── AiClient (IPC)   │
│   └── OpenAI /v1/embed.  │        │     ├── PdfParser        │
│ Settings (JSON)          │        │     ├── VectorStore (RAG) │
│ API Keys (safeStorage)   │        │     ├── useQa (Q&A hook) │
│ File I/O                 │        │     └── Zustand           │
└──────────────────────────┘        └──────────────────────────┘
         │                                     │
         │  ai:generate ──► API call in Main   │
         │  ai:token    ◄── Token streaming     │
         │  ai:done     ◄── Completion signal   │
         │  ai:abort    ──► Cancel request      │
         │  ai:embed    ──► Generate embeddings │
         │  ai:check-embed-model ──► Check model│
```

### Data Processing Pipeline

The full pipeline from PDF file to summary output:

```
PDF File
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 1. PDF Parsing (pdf-parser.ts)                       │
│    ├── Page-by-page text extraction via pdfjs-dist   │
│    │   └── Position-based (x,y,fontSize) spacing     │
│    │       → Korean character-level splitting         │
│    ├── Per-page image extraction (paintImageXObject)  │
│    │   └── RGB/RGBA/Grayscale → JPEG base64           │
│    │       → Max 1024px resize, skip >4M pixels       │
│    └── Auto chapter detection                         │
│        └── Patterns: "Chapter 1", "제1장", "1장"      │
│            → Fallback: 10-page chunks                 │
│                                                      │
│    Batch: 10 pages parallel, max 50 images            │
└─────────────────────────────────────────────────────┘
  │
  ▼ (< 50 chars extracted + OCR enabled)
┌─────────────────────────────────────────────────────┐
│ 1-b. OCR Fallback (scanned PDFs only)                │
│    ├── Render each page to JPEG via OffscreenCanvas  │
│    │   └── Auto scale (50p+: 1.5, 100p+: 1.0)       │
│    │       → Max 3000px, immediate GPU memory release │
│    ├── Provider-aware batch → Vision OCR requests     │
│    │   └── Ollama: 3 pages / Claude·OpenAI: 8 pages  │
│    │       → ai:ocr-page IPC → Main → Vision API     │
│    ├── AbortSignal propagation for instant cancel    │
│    └── Extracted text joins normal pipeline            │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 2. Image Analysis (optional, enableImageAnalysis)    │
│    ├── Preflight check with first image               │
│    ├── Remaining images: batch 3, parallel analysis   │
│    └── Results inserted into page text                │
│        → "[Image: chart shows revenue growth...]"     │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 3. Text Chunking (chunker.ts)                        │
│    ├── Auto Korean ratio detection (first 2000 chars)│
│    │   └── 100% Korean: 1.5 chars/token              │
│    │       0% Korean:   4.0 chars/token              │
│    ├── maxChunkSize (default 4000 tokens) × ratio    │
│    │   → Split by actual character count              │
│    └── Split only at paragraph (\n\n) boundaries     │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 4. AI Summary Generation (ai-service.ts)             │
│    ├── Prompt: system instructions + rules + text    │
│    ├── IPC: Renderer → Main (ai:generate)            │
│    ├── Main decrypts API key, makes HTTP streaming   │
│    │   ├── Ollama:  /api/generate (NDJSON)           │
│    │   ├── Claude:  /v1/messages  (SSE)              │
│    │   └── OpenAI:  /v1/chat/completions (SSE)       │
│    ├── Token streaming: Main → Renderer (ai:token)   │
│    └── Multi-chunk: individual summaries + integration│
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 5. Renderer Display (SummaryViewer.tsx + store.ts)    │
│    ├── Token buffering (50ms batch flush)             │
│    ├── Markdown leading-edge throttle (150ms)         │
│    │   └── First token immediate, then 150ms window   │
│    ├── Auto-scroll (only when near bottom 100px)      │
│    ├── aria-live=polite screen reader announcements   │
│    ├── stripConversationalText post-processing        │
│    └── Export .md / Copy to clipboard                 │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-a. RAG Vector Index Build (auto on document load)  │
│    ├── Check embedding model availability             │
│    │   └── Ollama: nomic-embed-text auto-detect      │
│    │       OpenAI: text-embedding-3-small             │
│    │       Claude: Ollama fallback → keyword search   │
│    ├── Overlap chunking (500 tokens, 10% overlap)    │
│    ├── Batch embed 50 at a time (2min timeout/batch) │
│    │   └── ai:embed IPC → Main → Embedding API       │
│    │       → NaN/Infinity validation at IPC boundary  │
│    ├── Store chunks + embeddings in-memory            │
│    │   └── Dimension lock: fixed at first chunk dim   │
│    ├── buildId guard: cancel on document switch       │
│    └── UI: indexing progress → RAG badge on complete  │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-b. Q&A Chat (use-qa.ts + QaChat.tsx)               │
│    ├── User question input (Enter/Shift+Enter)       │
│    ├── RAG semantic search (cosine similarity Top-5)  │
│    │   ├── Embed question → search vector store      │
│    │   ├── Filter results below minScore 0.3          │
│    │   └── 8000 char context size limit               │
│    ├── Keyword TF scoring fallback if RAG fails      │
│    ├── Combine summary (3000) + search results (8000)│
│    ├── Prompt injection defense (both RAG/keyword)    │
│    ├── Conversation history in prompt (max 10 turns)  │
│    ├── ai:generate(type:'qa') streaming response     │
│    └── Summary/Q&A mutually exclusive                 │
└─────────────────────────────────────────────────────┘
```

### Security Design

| Threat | Mitigation |
|--------|-----------|
| API key theft | `safeStorage` (OS keychain) encryption, keys never sent to Renderer, in-process memory cache to minimize decryption cost |
| Ollama SSRF | localhost only (`validateOllamaUrl`), http/https only |
| PDF drop path manipulation | `will-navigate` blocked, `file://` + `.pdf` extension only, `lstat` symlink rejection (blocks malicious `.pdf` symlinks pointing to system files) |
| IPC input manipulation | Type/range/length validation on all IPC handlers, shared constants module prevents main/renderer drift |
| External URL opening | Exact hostname whitelist (`Set.has()` match — suffix matching removed to block UGC domains) |
| Ollama installer tampering | Authenticode signature verification (v0.17.7) — `Get-AuthenticodeSignature` validates publisher CN after download; non-Ollama signatures abort installation |
| Dual-instance file clobber | `requestSingleInstanceLock` — second process quits immediately, prevents settings.json / api-keys.enc race writes |
| DevTools information leak | `webPreferences.devTools: false` in production builds — DevTools entirely disabled at Chromium level |
| Permission probing | `setPermissionCheckHandler` added — blocks `permission.query()` capability enumeration |
| Markdown XSS | `javascript:`, `data:` URLs blocked, external images blocked |
| Iframe/form injection | CSP `frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'` for defense-in-depth |
| Response size overflow | Streaming 50MB, Vision 10MB, model list 1MB limits, PDF max 500 pages / 100MB |
| Vision API log leakage | Error body sanitized for Bearer / sk-ant- / sk-proj- / sk-live- tokens |
| Q&A prompt injection | `splitPrompt` uses first separator only, `sanitizePromptInput` on both RAG/keyword contexts |
| RAG embedding corruption | NaN/Infinity validation at IPC boundary, dimension lock (first chunk), array count mismatch rejection |
| RAG document mixing | `AbortController` cancels previous builds instantly on document switch, final docId verification |
| OCR prompt injection | Vision/OCR prompts explicitly ignore image instructions, response URL/code block removal |
| OCR memory overflow | Auto page scale reduction, 3000px cap, OffscreenCanvas GPU immediate release |
| Q&A history overflow | History 4000 char limit + 10-turn FIFO, question 1000 char cap |
| Network stream hang | `res.on('close')` listener detects abnormal termination immediately (no 120s wait) |
| Navigation hijacking | `will-navigate` + `will-redirect` both blocked (verified to work in packaged builds) |
| Browser permission abuse | `setPermissionRequestHandler` + `setPermissionCheckHandler` deny by default, only `clipboard-sanitized-write` explicitly allowed (for the copy button) |
| Installer download OOM | `response.pipe(file)` backpressure, 500MB cap checked before chunk push, partial downloads auto-deleted |
| Orphaned `ollama pull` child | `pullProcess` tracked on the instance, `taskkill /F /T` on Windows at app quit, re-entry guard |
| Vision error body memory blowup | 64KB byte cap on error bodies (checked before push) + immediate socket destroy on overflow |
| Render-error path leak | `AppErrorBoundary` rewrites home-directory paths (`C:\Users\...`, `/Users/...`, `/home/...`) to `~` and truncates to 500 chars |
| Malicious full-file allocation | `PdfUploader` reads only the first 5 bytes via `file.slice(0,5)` to verify the `%PDF-` magic — rejects fakes before materializing the full buffer |
| UTF-16 surrogate pair splits | Chunker and RAG overlap both split on codepoint boundaries (safe for emoji and supplementary CJK) |
| Prompt injection via URL schemes | Markdown allowlist: `https/http/mailto/#`, blocklist: `javascript:`/`data:`/`vbscript:`/`file:` |
| Installer tamper detection (v0.18.8) | Build artifacts ship with auto-generated SHA-256 hashes and a Sigstore `attest-build-provenance` — verifiable via `gh attestation verify` to confirm builds came from this repo's CI |
| Supply chain (CI injection, v0.18.8) | All third-party GitHub Actions (`actions/checkout`, `setup-node`, `softprops/action-gh-release`, `attest-build-provenance`) pinned by full SHA — blocks arbitrary code injection if a maintainer account is compromised |
| Build non-determinism (v0.18.8) | CI uses `npm ci` (not `npm install`) with a synced lockfile — prevents transitive-dep drift from changing NSIS/asar hashes between identical tags |
| Array OOB regressions (v0.18.8) | TypeScript `noUncheckedIndexedAccess: true` narrows array access to `T \| undefined`, catching OOB-class defects at compile time |
| Hallucination (v0.18.0) | Q&A drafts are sentence-split → cosine-scored against the RAG index → LLM-refined when weak-sentence thresholds are exceeded. Multi-language terminator handling + Latin/CJK mixed boundary split (v0.18.8) |
| Image-extraction OOM (v0.18.9) | The `MAX_TOTAL_IMAGES=50` cap was bypassed by concurrent batch promises — fixed by re-checking remaining slots both on page-promise entry and immediately before pushing, preventing dozens of base64 image conversions from running in parallel |
| IPC listener leak (v0.18.9) | Listener/timer registration in `ai-client.summarize` (`onToken`/`onDone`/timer) moved inside the `try/finally` block — unsubscribe and server-side `abort` are guaranteed to fire even when `generate()` throws synchronously or registration errors |
| CI regression gates (v0.18.9) | Every workflow job now has `timeout-minutes` (preventing hung builds from burning 360 minutes), the test job runs on an Ubuntu+Windows OS matrix (catches Windows-specific path / pwsh regressions), and `npx tsc --noEmit` is enforced on both PR and release pipelines to prevent strict-flag regressions |
| Unsigned macOS dmg shipping (v0.18.9) | The `build-mac` job is disabled until Apple Developer ID + notarization credentials are configured — prevents publishing dmgs that Gatekeeper quarantines and force users to run `xattr -d` |
| Shell-quoting fragility (v0.18.11) | The inline `node -e "..."` heredoc in the `package.json` build script was extracted to `scripts/postbuild.mjs` — removes the Windows PowerShell quoting surface and surfaces a diagnostic if pdfjs-dist's cmaps path moves |
| Known-vulnerability visibility (v0.18.11) | An advisory `npm audit --audit-level=high` step is added to `test.yml` — known vulnerable dev-only dependencies (`vite`, `postcss`, `xmldom`, `ip-address` etc.) become visible on every PR/push without blocking the build |
| GitHub Actions Node 20 deprecation (v0.18.11) | `actions/checkout` v4.2.2 → v6.0.2 and `actions/setup-node` v4.4.0 → v6.4.0 SHA pins refreshed — migrated to Node.js 24-compatible majors ahead of the 2026-06-02 forced-migration deadline |
| Contributor ABI/lockfile drift (v0.18.11) | An `engines: { node: ">=20.10 <23", npm: ">=10" }` field was added to `package.json` — prevents silent failures from electron 41 node-gyp ABI mismatches or npm v9 lockfile format differences |
| API key cache prototype pollution (v0.18.12) | `apiKeysCache` is now built on `Object.create(null)` with only known provider keys (`ollama`, `claude`, `openai`) whitelisted — a tampered on-disk JSON containing `__proto__` can no longer reach `Object.prototype` |
| Embedding cost-amp DoS (v0.18.12) | `MAX_CONCURRENT_EMBED_REQUESTS=4` cap added to the `ai:embed` handler — blocks a compromised or runaway renderer from amplifying OpenAI token costs or pinning the local Ollama backend via a self-DoS. Normal RAG indexing (1~2 in-flight) is unaffected |
| Ollama signature-check wildcard glob (v0.18.12) | `Get-AuthenticodeSignature -FilePath` → `-LiteralPath` — temp paths or usernames containing `[`, `*`, or `?` were being interpreted as PowerShell wildcards, so the verifier could end up checking the wrong file or the install could DoS. Switching to `-LiteralPath` disables globbing |
| Stale state leak on new PDF (v0.18.12) | The non-null branch of `setDocument(newDoc)` now also calls `resetSummaryState` — even if a new caller forgets the reset guard, the previous document's `summary`/`qaMessages`/`pdfBytes`/RAG index can no longer leak into the new document view |
| Stale labels after language switch (v0.18.12) | `ProgressBar` migrated from module-level `t()` to `useT()` — switching the UI language mid-summary now updates labels immediately instead of waiting for the next progress tick |
| Markdown link visual spoofing (v0.18.12) | `safe-markdown` rejects any href containing control characters (`U+0000~U+001F`, `U+007F`) or bidi override codepoints (`U+202A~U+202E`, `U+2066~U+2069`) — LLM-emitted links that disguise the visible label as a different destination than the actual URL are now blocked |
| Post-`onDone` rejection microtask drop (v0.18.13) | `ai-client.summarize` now `await`s the `resultPromise` after the main loop exits — closed a race where a `generate()` rejection arriving immediately after `onDone` could be missed and the user saw a partial summary marked "success" |
| Silent per-page image loss on corrupt op (v0.18.13) | `extractPageImages` replaces the `argsArray[j]![0]` non-null assertion with `Array.isArray + typeof` guards — a single corrupt op no longer kills the remaining 9 valid image extractions on that page |
| `activeEmbedRequests` counter leak (v0.18.13) | Counter increment moved inside `try` + `counted` flag — a controller registration throwing synchronously could leak the counter (4 leaks → permanent self-DoS); now strictly paired with `finally` |
| Embedding `requestId` reuse killed abort (v0.18.13) | `registerEmbedRequest` / `unregisterEmbedRequest` now identity-check by controller — when the same `requestId` was reused in-flight, the previous request's `finally` could delete the new request's entry, making `ai:abort` a no-op (so cancel did nothing while OpenAI tokens kept billing) |
| Control-byte regex source fragility (v0.18.13) | `safe-markdown` rewrote the raw control-byte regex to `new RegExp(...) + String.fromCharCode(...)` — previous literal bytes were classified as binary by grep and could be silently normalized away by editors/linters, quietly removing the protection |
| Postbuild compatibility (v0.18.13) | `engines.node` raised from `>=20.10` to `>=20.11` — `scripts/postbuild.mjs` relies on `import.meta.dirname` (added in 20.11), so the previous range allowed an exact 20.10 install that would throw |
| Packaged build CJK glyphs (v0.18.13) | Added `electron-builder.asarUnpack: ["**/cmaps/**"]` — guarantees pdfjs CMap (`.bcmap`) files are accessible at runtime even when asar packing would otherwise hide them |
| `.gitignore` tracked+ignored contradiction (v0.18.13) | Removed `CLAUDE.md` from `.gitignore` — the file was checked into the repo and yet ignored, so contributors editing it would silently see no change in `git status` |
| Vitest setup file mock collisions (v0.18.13) | Switched `test/setup.ts` from `vi.restoreAllMocks()` to `vi.clearAllMocks()` — restoreAll could reset file-level mock implementations between tests, breaking suites that depended on module-hoisted mocks |
| electron-builder schema violation (v0.18.14) | Removed the comment-style `//asarUnpack` key — electron-builder 26.x strict schema validation rejects any unknown key (including the JSON-comment convention `//xxx`), which broke the v0.18.13 build. Hotfix only; behavior unchanged |
| Ollama cold-load latency (v0.18.15, performance) | All three Ollama calls (`/api/generate` text + Vision, `/api/embed`) now send `keep_alive: '30m'` — the default 5-minute model TTL caused cold-load penalties (seconds to tens of seconds) on every fresh chunk-summary / Q&A / embed call within the same session. Now warm cache for the whole session |
| Single 808 KB renderer chunk (v0.18.15, performance) | Added `manualChunks` to the Vite renderer config splitting `react-vendor`, `pdfjs`, `markdown` into separate chunks — main app chunk dropped 808 KB → 304 KB (-62%). Vendor chunks survive app-code edits as cache |
| Cloud Vision under-concurrency (v0.18.15, performance) | `analyzeDocumentImages` made provider-aware (Ollama 3 / Claude·OpenAI 8) — image-heavy PDFs analyzed via cloud providers complete ~30-40% faster |
| PdfViewer bulk-render memory / latency (v0.18.16, performance) | Sequential bulk render replaced with `IntersectionObserver`-driven on-demand queue (rootMargin `'100% 0px'` lookahead). A 100-page citation click now keeps only ~5 active canvases (≈95% fewer than the previous full render); 500-page memory grows proportionally to visited pages, not document size |
| pdf-parser Promise.race timer leak (v0.18.17) | `extractPageImages` would leave its 5-second race timer alive even when `getOperatorList()` resolved fast — a 200-page PDF accumulated 200 pending timers and 200 misleading "timeout" warnings firing 5 s later. The `timeoutId` is now cleared in a `finally` block |
| PdfViewer viewport race after resize (v0.18.17) | When `renderVersion` increments (resize), the IntersectionObserver's first callback is asynchronous, so currently-visible pages briefly fell back to blank placeholders. We now also explicitly enqueue any wrapper intersecting the container + `rootMargin: 100%` band, independent of IO firing |
| PdfViewer targetPage polling stuck (v0.18.17) | If the target wrapper is outside the IO viewport, polling waited for IO to fire and after 3 s fell back to an inaccurate `scrollIntoView` against a 200 px placeholder. `enqueueRenderRef` exposes the queue so the polling effect calls `enqueue(targetPage)` directly |
| Empty image-name op wasted 1 s (v0.18.17) | `extractPageImages` R29 guard tightened with `length > 0` — `page.objs.get('')` never invokes the callback, so the loop previously burned its 1 s timeout for nothing |
| `package-lock.json` root version drift (v0.18.17) | The lockfile root was pinned at `0.18.9` while `package.json` had advanced 7 releases. Risked `npm ci` failures for new contributors. Re-synced via `npm install --package-lock-only` and folded into the version-bump workflow |
| Workflow node-version drift (v0.18.17) | Workflows had `node-version: 20` (bare) while `engines` requires `>=20.11`, so a future cache pinning to 20.10 would violate the engine range. Pinned to `'20.11'`. `test.yml`'s `npm audit` step switched from `\|\| true` to `continue-on-error: true` so real audit-execution failures stay visible while advisory output is non-blocking |
| Vision in-flight not abortable (v0.18.18) | Wired `requestId`/`AbortSignal` through the `analyzeImage` IPC chain — Stop / document switch / timeout now severs in-flight Vision (especially Claude·OpenAI) calls instead of letting them bill tokens to completion. `use-summarize` tracks in-flight requestIds and polls `isGenerating`, calling `ai.abort` on all of them as soon as it flips false |
| Transient notice never auto-dismissed (v0.18.18) | `setNotice` now auto-dismisses after 6 s and cancels its predecessor's timer on each new call — addresses notices (e.g. multi-file drop hint) sticking around after the parse that triggered them was already done |
| `LOCALHOST_HOSTS` drift across 4 sites (v0.18.18) | The inline `['localhost','127.0.0.1','::1']` arrays in four main-process sites were consolidated into `src/shared/constants.ts` (`LOCALHOST_HOSTS` + `isLocalhostHost` helper) — closes the SSRF-bypass risk if a future maintainer edits only one site |
| Bearer redaction missed char (v0.18.18) | Added `~` to the Bearer redaction regex — aligns with RFC 6750 token68 char class so token suffixes can't leak from error bodies (defense-in-depth) |
| `shell:open-external` had no length cap (v0.18.18) | Capped at 2048 chars before `new URL()` parses, matching the input-cap pattern used elsewhere — prevents a compromised renderer from amplifying parser work with multi-MB strings |
| Stale page lingering on new document load (v0.18.18 patch) | When `pdfBytes` changed but `totalPages` stayed identical, React reused wrapper DOM and the previous document's canvases briefly showed inside the new document. The render effect now unconditionally clears canvases on every entry |
| `timedOut` summarize re-entry race (v0.18.18 patch) | A short window between the timeout callback firing and summarize entry allowed a new `requestId` to be issued, neutralizing the abort. An explicit guard now returns early when `timedOut` is true |
| `noticeDismissTimer` HMR leak (v0.18.18 patch) | The 6 s dismiss timer from a previous store instance could fire and try to dismiss a notice in the new store. Added `clearTimeout(noticeDismissTimer)` to the HMR dispose callback |
| `ai:analyze-image` requestId collision (v0.18.18 patch) | `generate`/`embed`/`vision` all share the same `activeRequests` Map; a requestId collision could leak an entry across IPC types. Vision now registers under a `vision:` prefix while `ai:abort` tries both forms — transparent to the renderer |
| `package-lock.json` drift recurrence (v0.18.18 patch) | v0.18.17's promised automation was never implemented, so v0.18.18 drifted again. Added an explicit gate to both `test.yml` and `release.yml` that fails the build when lockfile root version diverges from `package.json` |
| Sourcemap leak into asar (v0.18.19) | Added `!**/*.map` negative glob to electron-builder `files` — even if a future change accidentally enables sourcemaps in a vendor chunk, they no longer make it into the packaged asar |
| `asarUnpack` glob too broad (v0.18.19) | Tightened from `**/cmaps/**` to `out/renderer/cmaps/**` so a future dep bringing its own `cmaps` directory cannot be unintentionally unpacked |
| Raw stack trace from postbuild (v0.18.19) | `scripts/postbuild.mjs` now wraps `cpSync` in try/catch — ENOENT/EACCES/EEXIST surface with a friendly message and retry hint instead of a raw stack trace |
| Switch fallthrough silently compiled (v0.18.19) | Enabled `noFallthroughCasesInSwitch` in `tsconfig.json` — switch fallthroughs (e.g. main's `settings:set`) are now compile-time errors |
| React-class method override looseness (v0.18.19) | Enabled `noImplicitOverride` — `Component` overrides (state/componentDidCatch/render) must use the `override` keyword, catching accidental shadowing/typos at compile time |
| `npm audit` advisory invisibility (v0.18.19) | `test.yml`'s audit step now parses `npm audit --json` and writes severity-by-count to `GITHUB_STEP_SUMMARY` — previously advisories were buried in raw logs |
| Q&A cross-session token contamination (v0.18.19 patch) | On document switch, `setDocument()` → `resetSummaryState()` only cleared store flags while main's in-flight AiClient generator kept yielding tokens. If the user quickly asked a new question on the new doc, stale-session tokens interleaved with the new session's `qaStream`. `resetSummaryState` now propagates `ai.abort` to both in-flight `qaRequestId` and `currentRequestId`, cutting the root cause |
| Prompt injection — summary + assistant history (v0.18.19 patch) | `sanitizePromptInput` was applied only to user questions / refine questions / RAG chunks, leaving the `[요약 내용]` summary text and the `formatHistory` assistant branch un-sanitized. A malicious PDF that coaxes the LLM into placing `\n[질문]\n` / `\n---\n` markers in the answer/summary could corrupt the prompt structure of subsequent turns (indirect prompt injection). Both branches now pass through sanitize |
| PDF parse error banner path leak (v0.18.19 patch) | `AppErrorBoundary`'s `sanitizeErrorPath` only covered the render-time exception channel; App.tsx drop/Ctrl+O and PdfUploader, which call `setError({ message: err.message })`, leaked absolute paths from pdfjs/main verbatim. `setError` itself now auto-applies `sanitizeErrorPath`; the helper was extracted to `error-sanitize.ts` so `store.ts` doesn't import the React tree |
| OCR cloud abort un-propagated (v0.18.19 patch) | R30 P2 fixed only `ai:analyze-image` and left the OCR path uncovered. With cloud OCR `BATCH_SIZE=8`, Stop only blocked the next batch while 8 in-flight calls (~90 s each) kept billing tokens to completion. Extended preload `ocrPage(base64, requestId?)`, applied `vision:` namespacing in the main `ai:ocr-page` handler, made `analyzeImageForOcr` accept a signal, and wired pdf-parser to issue per-page requestIds + abort listeners |
| CI audit step invisible on red CI (v0.18.19 patch) | When `npm test` failed, the downstream audit step was skipped entirely, hiding supply-chain signals from `GITHUB_STEP_SUMMARY`. Added `if: always()` so audit runs (and reports) independently of test result; the step remains `continue-on-error: true` (non-blocking) |
| Vision partial-failure stale enrichment (v0.18.19 patch) | When image analysis was on but every image failed (`enrichedPagesRef === null`), the previous run's `enrichedPageTexts` lingered in store and RAG searched against stale enriched data. Now explicitly sets it to null, forcing a raw `pageTexts` rebuild |
| Theme live-preview localStorage drift (v0.18.19 patch) | Toggling the SettingsPanel theme radio and closing via X (not Cancel) persisted the dirty preview into `localStorage`, drifting from `settings.json`. `applyTheme(theme, { persist?: boolean })` splits persistence; the preview now calls with `persist:false` |
| MarkdownErrorBoundary latched on transient parse error (v0.18.19 patch) | A single transient markdown parse error mid-stream latched `hasError=true`, leaving the viewer in raw-text fallback even after later tokens completed the answer. Added `componentDidUpdate` to reset `hasError` when `children` reference changes |
| OCR cloud peak memory (v0.18.19 patch) | `BATCH_SIZE=8` × 3000×3000 canvases (~36MB RGBA each) for a 50–100p PDF (`scale=1.5`) could hold ~250–300MB transiently, risking OOM on low-RAM laptops. The 50–100p band now uses `BATCH_SIZE=4` (other ranges remain 8) |
| `streamRequest` MAX_LINE_SIZE silent skip (v0.18.19 patch) | A line larger than 1MB was silently `continue`-skipped, so a malformed response could report a blank answer as "success". Now `safeReject`s, letting ai-client surface a `streamInterrupted` error |
| Lockfile drift gate didn't check `packages[""]` (v0.18.19 patch) | lockfileVersion 3 stores the version in both root `version` and `packages[""].version`. The gate inspected only root, so a hand-edit that touched one but not the other could pass while `npm ci` warned and invalidated cache. Now both must match |
| Audit JSON parsed 3× with fragility (v0.18.19 patch) | The same audit JSON was reparsed in three node spawns; combined with `set +e`, a single failed call returned an empty string and `[ "" -gt 0 ]` produced a silent arithmetic error. Consolidated to a single spawn via `read HIGH MODERATE LOW <<<` |
| PowerShell quote escape had no unit tests (v0.18.19 patch) | R15 H1 and R28 P2 both originated in this area, yet the escape logic had zero unit tests. `ollama-manager.ts` imports `electron` so vitest couldn't import it directly — extracted the helper into `src/main/ps-quote.ts` (no native deps) and added a 9-case unit test |
| Q&A appendQaStream ghost-token race (v0.18.19 patch) | Just after `clearQaStream`, an in-flight for-await loop could push a few more tokens, leaving stray text after the cancelled placeholder. `appendQaStream` now gates on `isQaGenerating` at the entry |
| `enrichedPageTexts` length-only fingerprint collision (v0.18.19 patch) | The useRagBuilder fingerprint used only `e${length}`, so a second Vision pass producing the same length wouldn't retrigger a rebuild. Added a monotonic `enrichedPageTextsVersion` counter to the store |
| `taskkill` failure silently swallowed (v0.18.19 patch) | If `taskkill` failed (permission denied, AV interference, PID-reuse race), the ollama child tree could survive and squat port 11434. Added `SIGKILL` fallback + `console.warn` for visibility |
| `will-redirect` accepted any file:// (v0.18.19 patch) | The guard previously let through arbitrary `file://` redirects; tightened to accept exactly the packaged renderer URL (defense-in-depth) |
| i18n prototype leak (v0.18.19 patch) | `params['toString']` and similar inherited properties could leak function source into the rendered template via `String(...)`. Now uses `Object.prototype.hasOwnProperty.call` to admit own properties only |
| i18n production raw missing-key exposure (v0.18.19 patch) | A missing key (e.g. `app.modelHint`) was rendered as the full dotted identifier in production UI. Now falls back to the last dot-segment, weakening the leak surface |
| `ResizeHandle` Home/End ARIA inverted (v0.18.19 patch) | Home/End were mapped opposite to the WAI-ARIA separator convention (Home=MIN, End=MAX), confusing screen-reader users. Swapped to match the convention |
| `safe-markdown` headings·blockquote skipped citations (v0.18.19 patch) | `## 결론 [p.12]` and similar citations inside headings or blockquotes rendered as literal text and weren't clickable. `h1-h6` + `blockquote` now also run through `renderWithCitations` |
| Vitest multi-fork stub collision risk (v0.18.19 patch) | Many test files call `vi.stubGlobal('window', { electronAPI: ... })` at module init; the default pool's multiple forks could race on the same global. Pinned `pool: 'forks'` explicitly + cleaned up Vitest 4 deprecation |
| `ai-client.test` real-timer flake margin (v0.18.19 patch) | The 5/10/20 ms `setTimeout` values in mocks could race the consumer loop on a loaded CI runner. Raised to 50/100 ms for safety margin |
| `release.yml` Ubuntu flake cancels Windows (v0.18.19 patch) | `fail-fast: true` meant a single Ubuntu test flake could cancel the Windows build, requiring a retag to recover. Switched to `false`; Ubuntu still provides signal |
| postbuild cmap partial-copy silent failure (v0.18.19 patch) | If `cpSync` exited with a partial copy due to ENOSPC or mid-failure, NSIS packaged a broken cmap set and users only noticed CJK glyph corruption after install. Added a smoke check for three representative cmaps (`Adobe-Japan1-UCS2.bcmap`, `Adobe-Korea1-UCS2.bcmap`, `Adobe-GB1-UCS2.bcmap`); R34 P2 extends to `Adobe-CNS1-UCS2.bcmap` (Traditional Chinese — catches partial copies that drop CNS1) |
| MarkdownErrorBoundary streaming reset thrash (v0.18.19 patch R34 P1) | R32 P2's new `componentDidUpdate` compared `children` identity, but the parent (SummaryViewer / QaChat) creates a fresh `<ReactMarkdown>` JSX element each render → reset fires every render → for persistently-throwing content, latch ↔ reset thrash. Comparison switched to `fallbackText` (actual content string) — transient mid-stream recovery is preserved while every-render thrash is cut (R33 Surface 3 P2) |
| `generate()` placeholder leak on sync throw (v0.18.19 patch R34 P1) | R32 P3's placeholder controller leaked into `activeRequests` until the 10-minute TTL sweep if `validateOllamaUrl` / `new URL()` / `API_KEY_MISSING` threw synchronously. Wrapped the dispatch in try/catch with identity-checked cleanup (R33 Surface 2 P3) |
| `will-redirect` Windows file:// slash mismatch (v0.18.19 patch R34 P1) | R32 P3 constructed `file://${path}` (2 slashes) but Electron's actual loadFile URL is `file:///${path}` (3 slashes, RFC 8089), so the `===` check never matched. Switched to `pathToFileURL(...).href` for the standard form (also normalizes drive letter case, UNC, backslashes) (R33 Surface 2 P4) |
| CI audit step false-clean after `npm ci` failure (v0.18.19 patch R34 P1) | R32 P2's `if: always()` made the audit step run after `npm ci` failed, but `npm audit` with no `node_modules` returned error JSON that the parser collapsed to `0 0 0`, falsely reporting "no advisories". Added a `[ -d node_modules ]` precheck, a `j.error` branch, and `: "${VAR:=0}"` defaults to restore visibility (R33 Surface 4 P3) |
| `VALID_SETTINGS_KEYS` drift risk across two literals (v0.18.19 patch R34 P2) | `main/index.ts` held `VALID_SETTINGS_KEYS_SET` (loadSettings filter) and `VALID_SETTINGS_KEYS` (settings:set validator) as separate literals — a future key added to only one side would silently drift. Consolidated into `src/main/settings-keys.ts` as the single source of truth + 6-case drift guard (Set/Array equality, `AppSettings` type subset, `DEFAULT_SETTINGS` two-way coverage, prototype key denial, readonly tuple) (R33 Surface 4 P3) |
| Vision partial-failure contract had zero unit tests (v0.18.19 patch R34 P2) | R32 P3's policy ("image analysis enabled but every image failed → enrichedPages null → rebuild RAG from raw pageTexts") lived inside `use-summarize.ts` as a helper, leaving its contract untested. Extracted as `src/renderer/lib/enrich-doc.ts` + 11-case guard (size=0 ↔ null / size>0 ↔ non-null / invariant / no mutation) (R33 Surface 4 P3) |
| preload contextBridge IPC channel drift (v0.18.19 patch R34 P2) | `src/preload/index.ts` imports `contextBridge`/`ipcRenderer` and can't be imported by vitest. Added a static-source snapshot test covering expose target, top-level keys, IPC channel names, key signatures (ocrPage / embed / analyzeImage requestId), openExternal guard, and on* listener removeListener — 9 cases (R33 Surface 4 P3) |
| i18n own-undefined rendered as literal "undefined" (v0.18.19 patch R34 P2) | R32 P3's switch to `Object.prototype.hasOwnProperty.call` blocked prototype leakage but if an own property's value was `undefined`, `String(undefined) = "undefined"` was injected into the UI instead of the `{name}` missing-param marker. Combined the two checks with AND (R33 Surface 3 P4) |
| pdf-parser OCR signal abort listener race (v0.18.19 patch R34 P2) | A short window between `signal.aborted` check and `addEventListener('abort', ...)` could let an abort fire before the listener was attached (AbortSignal does not replay late attachments), letting the OCR IPC run to completion (~90s cloud cost). Added an immediate `throwIfAborted` right after `addEventListener` (R33 Surface 2 P4) |

## License

MIT License. See [LICENSE](LICENSE) for details.

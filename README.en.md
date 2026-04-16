[한국어](README.md) | 🌐 **English**

# 📄 Local AI PDF Analyzer

**A local AI-powered PDF summarization tool that runs entirely on your PC.**

Unlike cloud-based AI summarization services that require uploading PDFs to external servers, this app runs **AI directly on your computer**.

- **Fully offline** — Ollama local AI engine runs on your PC; PDF files are never sent to external servers
- **Text + image analysis** — Analyzes text, charts, diagrams, and tables in any PDF using Vision AI
- **Scanned PDF OCR** — Vision AI recognizes text page-by-page even in image-based scanned PDFs
- **RAG-based Q&A chat** — Embedding vector semantic search finds the most relevant parts of your PDF to answer questions accurately
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
| **macOS** | `Local-PDF-Analyzer-x.x.x.dmg` |

1. Download the installer for your OS from the link above
2. Run the installer (macOS: mount the dmg and drag to Applications)
3. Launch the app from the desktop shortcut / Start menu (Windows) or Launchpad (macOS)
4. On first launch, the AI engine (Ollama), Korean-specialized models (gemma3, exaone3.5), and RAG embedding model (nomic-embed-text) are installed automatically — follow the on-screen instructions

> **Note**: AI model downloads require approximately 8GB of disk space and a few minutes.

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
- **Unit test coverage** — **82 regression tests** for RAG/citation core paths (+13 in v0.17.x)
- **Page citations + side PDF viewer (v0.17.0)** — Summary/Q&A answers automatically carry `[p.N]` source-page citations at almost every key sentence. Click to open a right-side PDF viewer panel that scrolls to the cited page. Built on page-aware RAG chunks + LLM prompt injection (5 languages) + lazy pdfjs-dist viewer + react-markdown text-block overrides. Citation frequency significantly improved in v0.17.1 via paragraph-level inline labels
- **Horizontal resize handle (v0.17.2)** — when the PDF viewer panel is open, drag the central divider to freely adjust the left/right ratio between 20~80%. Pointer + keyboard (← → Home End) + ARIA (`role="separator"`, `aria-valuenow`) + localStorage persistence. PDF pages auto re-render via `ResizeObserver` + 200ms debounce
- **Citation placement normalization (v0.17.1)** — LLM mistakes like `([p.5])` wrapping or standalone list items `- [p.44]` are automatically re-attached to the preceding sentence

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
| Build | electron-vite + electron-builder (Windows NSIS + macOS DMG) |
| Testing | Vitest (82 unit tests) + `tsc --noEmit` strict type check |
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
    │   └── __tests__/         # Unit tests (82)
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

## License

MIT License. See [LICENSE](LICENSE) for details.

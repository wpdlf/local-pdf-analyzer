🌐 [한국어](README.ko.md) | **English**

# 📄 Local AI PDF Analyzer

**A local AI-powered PDF summarization tool that runs entirely on your PC.**

Most AI summarization services require uploading your PDF to an external server — this app runs **the AI inside your own computer**.

- **Fully offline operation** — the Ollama local AI engine runs directly on your PC, so your PDF files never leave your machine
- **Unified text + image analysis** — analyzes not only text but also embedded charts, diagrams, and tables with Vision AI
- **Scanned PDF OCR** — image-based scanned PDFs are recognized page by page with Vision AI
- **RAG-based Q&A chat** — embedding-based semantic search finds the most relevant parts of your PDF, and answers are automatically verified against the source
- **Page citations + PDF viewer with outline navigation** — summaries and answers carry `[p.12]` source citations; click one to open the original page instantly, or jump through the document's built-in table of contents from the viewer's outline sidebar
- **Multi-document tabs + cross-document Q&A** — open several PDFs as tabs and ask a single question across them; answers cite the source document and jump to the right page
- **Collections + cross-document summaries** — save a set of documents as a named collection and reopen the whole tab set later; generate a unified summary or a comparison across the selected documents
- **Automatic session save & restore** — reopen an analyzed PDF and your summary, Q&A history, and search index are restored instantly, with no re-summarization or re-embedding
- **Search across all saved documents** — find a keyword across every saved document at once (page text + summaries + filenames) and jump straight to the matching page
- **Safe for sensitive material** — exam papers, internal documents, paper drafts and other private files can be summarized with confidence
- **Korean/English UI · external AI option** — switch to Claude/OpenAI/Gemini API easily when you need higher quality

This document has two parts — **[User Guide](#user-guide)** (install · usage · troubleshooting) | **[Developer Guide](#developer-guide)** (tech stack · architecture · security design)

---

# User Guide

## Download & Install

> **[Download the latest version](https://github.com/wpdlf/local-pdf-analyzer/releases/latest)**

| Platform | File |
|---|---|
| **Windows** | `Local-PDF-Analyzer-Setup-x.x.x.exe` |
| **macOS** | _temporarily unavailable_ (will return once code signing/notarization credentials are in place — in the meantime, build from source with `npm run package`) |

1. Download the Windows installer from the link above
2. Run the downloaded file to install
3. Launch the app from the desktop shortcut or Start menu
4. On first run, the AI engine (Ollama), the base AI model (gemma3), and the RAG embedding model (nomic-embed-text) are installed automatically (~3.6GB) — just follow the prompts
5. If you mainly analyze Korean documents, check the **Also install the Korean-specialized model (exaone3.5, ~4.8GB)** option on the setup screen for better Korean summaries. You can also add it later in Settings → Model Management

<a id="smartscreen"></a>
> **Windows SmartScreen notice**: Because an EV code-signing certificate is not yet in use, the first install may show a **"Windows protected your PC"** / **"Unknown publisher"** SmartScreen warning. This is expected — proceed via **More info → Run anyway**. You can verify the installer's authenticity with the [integrity verification](#installer-integrity-verification) below.

> **Note**: Downloading the AI models requires about 3.6GB of disk space for the default setup (~8.4GB with the Korean-specialized model) and several minutes.

### Installer integrity verification

Each release ships with the installer's **SHA-256 hash** (`SHA256SUMS-windows.txt`) as a release asset, and a **Sigstore build provenance attestation** issued by GitHub Actions lets you verify the build origin.

```bash
# Windows (PowerShell) — compare the hash
Get-FileHash -Algorithm SHA256 .\Local-PDF-Analyzer-Setup-x.x.x.exe

# Verify the Sigstore attestation via GitHub CLI (optional)
gh attestation verify ./Local-PDF-Analyzer-Setup-x.x.x.exe --repo wpdlf/local-pdf-analyzer
```

## How to Use

### 1. Upload a PDF
- **Drag & drop** a PDF onto the app window, click **Select File**, or press **Ctrl+O**
- Previously analyzed PDFs appear in the **Recent Documents** list at the bottom of the upload screen; reopening the same PDF **automatically restores** its summary, Q&A, and search index
- **Search across saved documents** — the search bar on the upload screen finds a keyword across every saved session (page text, summaries, filenames); results show matching pages with highlighted snippets — click one to open
- **Multiple documents as tabs** — opening another PDF adds a tab at the top; click tabs to move between documents and continue each one's summary and Q&A (auto-saved and restored on switch). Use the `＋` button to add a document

### 2. Choose a Summary Type

| Type | Description |
|------|-------------|
| **Full Summary** | Summarizes the entire PDF in one pass |
| **Chapter Summary** | Splits the document into chapters/sections and summarizes each |
| **Keyword Extraction** | Extracts key terms with explanations in a table |

### 3. View & Save Results
- The summary streams to the screen in real time
- Save with **Export `.md`** or **Export PDF** (a formatted PDF with headings/tables/citations), or copy to clipboard with **Copy**
- Closing the summary is non-destructive — it collapses to the document screen, and **View summary / Continue Q&A** reopens it with the Q&A thread intact

### 4. Q&A Chat (RAG Semantic Search)
- A **RAG vector index** is built automatically when a PDF loads (progress in the header → **RAG** badge when ready)
- Ask a question and the AI answers using the most relevant parts of the PDF found via embedding similarity (up to 10 turns of conversation context)
- Without an embedding model, Q&A falls back to keyword search automatically (same feature, lower accuracy)
- **Automatic answer verification** — each sentence of the answer is checked against the PDF embeddings; if too many sentences lack grounding, the answer is automatically refined once more (can be disabled in Settings)
- **Cross-document Q&A (collection mode)** — with two or more documents open, toggle **"Ask across documents"** to search several PDFs at once. Pick members with checkboxes; the question is searched across each selected document's index and merged **without re-embedding**. Answers cite the source document (e.g. `[Service Discovery.pdf p.5]`); click a citation to switch to that document and jump to the page. Documents indexed with a different embedding model are automatically excluded with a reason.
- **Cross-document summary / comparison** — in collection mode, the **Unified summary** and **Compare** buttons synthesize the selected documents. Each document's existing summary is reused, and any document not yet summarized is summarized on the fly and saved back to it (reused next time). The result appears in the Q&A thread, attributed by document.
- **Save & reopen collections** — **Save collection** stores the current document set with a name; on the upload screen, a **Saved collections** list lets you reopen the whole tab set at once (restored from sessions, no re-parsing).
- `Enter`: send / `Shift+Enter`: new line

### 5. Page Citations + PDF Viewer
- Every key fact in summaries and Q&A answers gets an automatic **`[p.12]`-style page citation**
- **Click** a citation to open the **PDF viewer panel** on the right at that exact page — verify potential AI hallucinations with one click
- **Outline navigation** — when the PDF carries a built-in table of contents (bookmarks), a ☰ button in the viewer opens an outline sidebar; click any heading to jump to its page (re-clicking the current section re-scrolls to it)
- Drag the center divider (or use the keyboard: Tab focus then `←`/`→`, `Home`/`End`) to adjust the split between 20–80%; the ratio is saved across restarts
- Close the panel with `ESC` or the ✕ button

## AI Provider Selection

The app works with local AI (Ollama) by default; switch to a paid AI when you need higher-quality summaries.

| Provider | Strengths | Cost |
|----------|-----------|------|
| **Ollama (default)** | Offline use, privacy for personal documents | Free |
| **Claude API** | High summary quality, strong with long documents | Paid (per token) |
| **OpenAI API** | GPT-4o based, general-purpose summarization | Paid (per token) |
| **Google Gemini API** | Summaries · Vision · embeddings with a single key | Free tier available (paid beyond limits) |

To use an external AI:
1. Settings (⚙️) → select Claude, OpenAI, or Gemini under AI Provider
2. Enter your API key and **Save** (keys are encrypted and stored locally)
3. Choose a model and **Save Settings**

### Q&A Embedding Models (RAG)

| Provider | Embedding model | Dimensions | Notes |
|----------|----------------|------------|-------|
| **Ollama** | nomic-embed-text (274MB) | 768 | Runs locally, installed automatically during first-run setup |
| **OpenAI** | text-embedding-3-small | 1536 | Used automatically with your API key, no extra install |
| **Gemini** | gemini-embedding-2 | — | Used automatically with your API key, no extra install |
| **Claude** | Ollama fallback | — | No native embedding API; tries the Ollama model → falls back to keyword search |

> Q&A still works without an embedding model via keyword search. RAG is an optional accuracy booster.

## PDF Image Analysis

Charts, diagrams, tables, and photos embedded in PDFs are analyzed automatically by Vision AI and incorporated into the summary.

- Images are extracted per page and semantically analyzed by a Vision model
- Analysis results are merged into the page text, improving summary quality
- Image analysis can be toggled on/off in Settings

| Provider | Vision model | Notes |
|----------|--------------|-------|
| **Ollama** | llava, llama3.2-vision | Runs locally; the app guides installation if missing |
| **Claude** | claude-sonnet-4 | API costs apply |
| **OpenAI** | gpt-4o | API costs apply |
| **Gemini** | your selected Gemini model (all multimodal) | Free tier available |

> With Ollama, a separate Vision model (e.g. llava) is required. Install it under Settings → Model Management.

## Scanned PDF OCR

For image-based/scanned PDFs where text extraction fails, Vision AI recognizes the text page by page.

- OCR fallback kicks in automatically when text extraction fails (toggle in Settings)
- Batched parallel processing with a progress bar; cancel anytime
- Documents processed via OCR show an `OCR` badge

| Provider | OCR accuracy (Korean) | Notes |
|----------|----------------------|-------|
| **Claude** | 90–98% | Recognizes table/formula structure; API costs apply |
| **OpenAI (GPT-4o)** | 90–95% | Recognizes table/formula structure; API costs apply |
| **Gemini** | 90–97% | Recognizes table/formula structure; free tier available |
| **Ollama (llava)** | 60–75% | Free; suited to simple English PDFs |

> Processing time and API cost grow with page count. For a 50-page scan: Claude ≈ $0.15–0.30, GPT-4o ≈ $0.25–0.50.

## Key Features

**Analysis quality**
- Korean-optimized — improved Korean PDF text extraction, chunk sizing adapts to the Korean-text ratio
- Clean summaries — greetings, commentary, and conversational filler are removed via prompt constraints plus a post-processing filter
- Large PDF support — long documents are split, processed in parallel batches, and merged into a unified summary (up to 500 pages)
- Automatic answer verification — Q&A answers are checked sentence-by-sentence against PDF embeddings and refined when grounding is weak

**Usability**
- Real-time streaming — summaries appear as they are generated, with auto-scroll (pauses when you scroll manually)
- Every long-running task is cancellable — stop summarization/parsing/OCR, cancel Ollama setup midway and switch providers
- File swap during parsing — dropping another file cancels the previous job and switches immediately
- Export summaries — Markdown, formatted PDF (native, dependency-free), or clipboard; individual Q&A answers can be copied too
- Search across all saved documents — keyword search over page text, summaries, and filenames with highlighted snippets and one-click open
- Multi-document tabs — keep several PDFs open and switch between them; only the active document's heavy state stays in memory (instant restore on switch). Collection mode searches across the open documents in a single question, with source-attributed citations; save a set as a named collection and generate unified/comparison summaries across it
- PDF outline navigation — documents with a built-in table of contents get a collapsible outline sidebar in the viewer for one-click jump to any section
- Dark mode, instant Korean/English switching — the UI language is auto-detected from your OS locale on first run, with a toggle on the setup screen; screen-reader and keyboard accessibility

**Reliability · Security**
- API keys encrypted in the OS keychain — decrypted only in the Main process, never exposed to the renderer
- Automatic session save & restore — restored by document content hash, LRU-pruned at 30 sessions/200MB (disable or clear in Settings)
- Per-page corruption resilience — one broken page doesn't stop the rest of the document
- Render error recovery — unexpected UI errors offer a "Try again" button, no restart needed

**Quality assurance**
- 1296 unit tests + Playwright E2E + CI quality gates, plus a 4-agent parallel QA round on every release
- Build integrity — installer SHA-256 hashes + Sigstore attestation published automatically
- Detailed improvement/fix history: [docs/HISTORY.md](docs/HISTORY.md) (Korean)

## System Requirements

- **Windows 10 or later**, or **macOS 12 (Monterey) or later**
- At least 4GB free disk space (default AI models, when using Ollama — about 9GB with the Korean-specialized model)
- Internet connection (first-time setup and paid API use)
- PDF limits: max 100MB, max 500 pages (split larger documents)

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Ollama installation fails | Install manually from [ollama.com](https://ollama.com), or use the wizard's "Cancel and use another provider" button to switch to Claude/OpenAI/Gemini |
| The Summarize button is greyed out | Ollama isn't running or has no installed model — use the **Open settings** link next to the button to fix it, or switch to a cloud provider |
| Poor Korean summary quality | Install and select the Korean-specialized model (exaone3.5) under Settings → Model Management. It is an optional install during first-run setup and produces better Korean summaries than the base model (gemma3) |
| Summarization is slow | Switch to a lighter model (e.g. phi3) or reduce the chunk size in Settings |
| Text extraction fails | Make sure "Scanned PDF OCR" is enabled in Settings; a Vision model (llava, Claude, GPT-4o, Gemini) is required |
| OCR results are inaccurate | Ollama llava has low Korean accuracy; switching to Claude, OpenAI, or Gemini improves it significantly |
| OCR takes too long | Use the "■ Cancel" button to stop; cloud providers offer faster throughput |
| PDF exceeds 500 pages | Split the document and upload again; the cap prevents resource exhaustion |
| Image analysis doesn't work | With Ollama, a Vision model such as llava is required — install it in Settings |
| API key error | Verify the key format in Settings. Claude: `sk-ant-...`, OpenAI: `sk-...`, Gemini: `AIza...` |
| Claude/OpenAI/Gemini unavailable | Save the API key first, then select the provider |
| Gemini "response was blocked" error | Gemini's safety filter blocked the document content, or the output budget was exhausted. Try another model (e.g. gemini-2.5-pro) or split the document |
| Gemini "rate limit exceeded" | The free tier has a low per-minute request limit. The app automatically lowers concurrency and retries up to twice with backoff; if it persists, retry shortly or disable image analysis for image-heavy PDFs |
| Q&A can't answer | If the RAG badge is missing, install the embedding model with `ollama pull nomic-embed-text`. In keyword mode, include specific terms in your question |
| RAG indexing doesn't run | Make sure first-run setup completed (nomic-embed-text auto-install). Manual install: `ollama pull nomic-embed-text` |
| Answers seem to generate twice | Answer verification triggers one extra LLM call when grounding is weak; you can turn off the "Answer verification" toggle in Settings |
| Opened from Recent Documents but the PDF viewer is missing | The summary/Q&A analysis is restored, but if the original file was moved/deleted the viewer is disabled. Reopen the original file to restore it |
| Saved sessions use too much disk | At most 30 sessions/200MB are kept; older ones are pruned automatically. Check usage and "Clear all" under Settings → Session Data |
| App freezes on a screen error | Use the "Try again" button on the error screen to recover without restarting |
| Want to verify the installer wasn't tampered with | Compare against `SHA256SUMS-windows.txt` on the release page, or verify Sigstore provenance with `gh attestation verify` (see [integrity verification](#installer-integrity-verification)) |
| No macOS download | dmg releases are paused until code signing/notarization credentials are in place; meanwhile, build from source with `npm run package` |

> For the detailed history of issues fixed in past versions, see [docs/HISTORY.md](docs/HISTORY.md) (Korean) and [GitHub Releases](https://github.com/wpdlf/local-pdf-analyzer/releases).

---

# Developer Guide

## Tech Stack

| Area | Technology |
|------|------------|
| Framework | Electron 42 + React 19 |
| Language | TypeScript (strict mode, incl. `noUncheckedIndexedAccess`) |
| AI generation | Ollama (local) / Claude API / OpenAI API / Gemini API — via Main-process IPC |
| AI embeddings (RAG) | Ollama /api/embed / OpenAI /v1/embeddings / Gemini batchEmbedContents — in-memory vector store |
| PDF parsing | pdfjs-dist (position-based text extraction + image extraction, Korean-optimized) |
| State management | Zustand |
| Styling | Tailwind CSS v4 + @tailwindcss/typography |
| Build | electron-vite + electron-builder (Windows NSIS — macOS DMG paused until notarization credentials are in place) |
| Testing | Vitest, 1296 unit tests / 80 files (renderer·shared 860 + main 436) + Playwright E2E (8 CI-deterministic tests) + `tsc --noEmit` type check + CI coverage gates (77/69/79/81) |
| i18n | In-house (i18n.ts) — 290+ keys, useT() hook, template substitution |
| API key security | Electron safeStorage (OS keychain encryption), decrypted only in the Main process |
| Shared constants | `src/shared/constants.ts` — shared between Main/Renderer (prevents drift of MAX_PDF_SIZE etc.) |

## Development Setup

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

# E2E smoke (builds, then drives the real Electron app — Playwright)
npm run test:e2e
```

## Project Structure

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
    ├── components/        # UI components (16)
    ├── lib/
    │   ├── ai-client.ts       # AI client (requests summaries/Q&A from Main via IPC)
    │   ├── pdf-parser.ts      # PDF text + image extraction, chapter detection, OCR fallback
    │   ├── chunker.ts         # Text chunking (auto-detects Korean ratio)
    │   ├── i18n.ts             # Translations (290+ keys, t() function, useT() hook)
    │   ├── use-qa.ts          # Q&A chat hook (RAG semantic search + keyword fallback, history)
    │   ├── vector-store.ts    # In-memory vector store (cosine similarity, dimension checks)
    │   ├── store.ts           # Zustand state (summary + Q&A + RAG index)
    │   └── __tests__/         # Unit tests (1296, 80 files)
    └── types/
        └── index.ts       # Type definitions + provider model constants
```

## Architecture

For API key security, all AI API calls happen in the Main process. The renderer requests summaries over IPC and receives a token stream.

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
         │  ai:token    ◄── token streaming    │
         │  ai:done     ◄── completion signal  │
         │  ai:abort    ──► cancel request     │
         │  ai:embed    ──► embedding vectors  │
         │  ai:check-embed-model ──► model check│
```

## Data Processing Pipeline

The full journey from PDF file to summary.

```
PDF file
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 1. PDF parsing (pdf-parser.ts)                       │
│    ├── Per-page text extraction via pdfjs-dist       │
│    │   └── Position-based (x,y,fontSize) spacing     │
│    │       → handles per-character Korean splits     │
│    ├── Per-page image extraction (paintImageXObject) │
│    │   └── RGB/RGBA/Grayscale → JPEG base64          │
│    │       → resized to 1024px max, >4M pixels skip  │
│    └── Automatic chapter detection                   │
│        └── "제1장", "Chapter 1", "1장" patterns       │
│            → falls back to 10-page splits            │
│                                                      │
│    Batching: 10 pages in parallel, max 50 images     │
└─────────────────────────────────────────────────────┘
  │
  ▼ (when text < 50 chars + OCR enabled)
┌─────────────────────────────────────────────────────┐
│ 1-b. OCR fallback (pdf-parser.ts, scanned PDFs)      │
│    ├── Render each page to JPEG via OffscreenCanvas  │
│    │   └── auto scale (50p+: 1.5, 100p+: 1.0)        │
│    │       → 3000px cap, GPU memory freed eagerly    │
│    ├── Provider-aware parallel Vision OCR batches    │
│    │   └── Ollama: 3 pages / Claude·OpenAI: 8 pages  │
│    │       → ai:ocr-page IPC → Main → Vision API     │
│    ├── Instant cancel via AbortSignal propagation    │
│    └── Extracted text rejoins the normal pipeline    │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 2. Image analysis (optional, enableImageAnalysis)    │
│    ├── Preflight Vision check with the first image   │
│    ├── Remaining images analyzed in batches of 3     │
│    └── Results merged into the page text             │
│        → "[Image analysis: the chart shows...]"      │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 3. Text chunking (chunker.ts)                        │
│    ├── Korean ratio auto-detection (first 2000 chars)│
│    │   └── 100% Korean: 1.5 chars/token              │
│    │       0% Korean:   4.0 chars/token              │
│    ├── maxChunkSize (default 4000 tokens) ×          │
│    │   chars/token → splits by actual char count     │
│    └── Splits only at paragraph (\n\n) boundaries    │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 4. AI summary generation (ai-service.ts)             │
│    ├── Prompt: system instructions + prohibitions    │
│    ├── IPC: Renderer → Main (ai:generate)            │
│    ├── Main decrypts API key, streams over HTTP      │
│    │   ├── Ollama:  /api/generate (NDJSON)           │
│    │   ├── Claude:  /v1/messages  (SSE)              │
│    │   └── OpenAI:  /v1/chat/completions (SSE)       │
│    ├── Token streaming: Main → Renderer (ai:token)   │
│    └── Multi-chunk: per-chunk summaries + final merge│
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 5. Renderer display (SummaryViewer.tsx + store.ts)   │
│    ├── Token buffering (50ms batched flush)          │
│    ├── Markdown leading-edge throttle (150ms)        │
│    │   └── first token instant, then 150ms windows   │
│    ├── Auto-scroll (only within 100px of the bottom) │
│    ├── aria-live=polite screen-reader announcements  │
│    ├── stripConversationalText post-processing       │
│    └── .md export / clipboard copy                   │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-a. RAG vector index build (automatic on load)      │
│    ├── Embedding model availability check            │
│    │   └── Ollama: auto-detects nomic-embed-text etc.│
│    │       OpenAI: text-embedding-3-small            │
│    │       Claude: Ollama fallback → else keyword    │
│    ├── Overlapping chunking (500 tokens, 10% overlap)│
│    ├── Batched embedding, 50 at a time (2min timeout)│
│    │   └── ai:embed IPC → Main → embedding API       │
│    │       → NaN/Infinity validation at IPC boundary │
│    ├── Chunks + embeddings into in-memory store      │
│    │   └── dimensions locked to the first chunk      │
│    ├── buildId guard cancels on document switch      │
│    └── UI: indexing progress → RAG badge when done   │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-b. Q&A chat (use-qa.ts + QaChat.tsx)               │
│    ├── Question input (Enter sends, Shift+Enter LF)  │
│    ├── RAG semantic search (cosine Top-5)            │
│    │   ├── question embedding → vector store search  │
│    │   ├── results below minScore 0.3 excluded       │
│    │   └── 8000-char context cap                     │
│    ├── Keyword TF-scoring fallback if RAG fails      │
│    ├── Summary (3000 chars) + search (8000 chars)    │
│    ├── Prompt-injection defenses (RAG + keyword)     │
│    ├── Conversation history prompt (up to 10 turns)  │
│    ├── Streaming answer via ai:generate(type:'qa')   │
│    └── Summary/Q&A mutually exclusive — no overlap   │
└─────────────────────────────────────────────────────┘
```

Additionally, sessions are persisted to `userData/sessions/` keyed by document content hash (SHA-256) — summaries/Q&A/parsed text as JSON, embedding indexes as Float32 binary blobs (atomic tmp→rename, LRU capped at 30 sessions/200MB). Reopening the same PDF restores by hash match, and if the embedding model and dimensions match, the index is deserialized with zero re-embedding or re-summarization calls.

## AI Summary Prompt Design

Each summary type gets a prompt with system instructions plus prohibitions.

| Type | Core prompt instructions |
|------|--------------------------|
| `full` | Five-part structure: key concepts, main content, formulas, examples, key points |
| `chapter` | Per-section concepts/definitions, formulas, examples, 3–5 key points |
| `keywords` | Keyword/description/importance markdown table (10–30 entries) |
| `qa` | PDF-grounded Q&A — summary + relevant source chunks as context, with conversation history |

**Prohibitions** (all summary types): greetings, praise, commentary, and conversational filler are strongly forbidden in the prompt. A `stripConversationalText` post-processing filter additionally removes conversational filler produced by local LLMs (not applied to Q&A answers).

### AI Summary IPC Flow

1. The renderer sends text + provider + model via the `ai:generate` IPC
2. The Main process decrypts the API key from `safeStorage` and calls the API directly
3. Streaming tokens are forwarded to the renderer as `ai:token` events
4. The renderer's `AiClient` yields tokens through an AsyncGenerator

To add a new provider, add a generator function in `src/main/ai-service.ts` and register it in the `generate()` switch.

## Security Design

The threat model and mitigations currently in place. For the detailed per-version fix history, see [docs/HISTORY.md](docs/HISTORY.md) (Korean).

| Area | Mitigation |
|------|------------|
| API key protection | `safeStorage` (OS keychain) encryption, decrypted only in Main, never sent to the renderer, prototype-pollution hardened (`Object.create(null)` + provider whitelist) |
| SSRF | Ollama URLs restricted to localhost (`isLocalhostHost`, incl. IPv6 `[::1]` normalization); handlers like `ai:check-available` use the canonical URL from the settings store instead of renderer-supplied URLs, closing the port-probe oracle |
| IPC input validation | Type/range/length validation in every IPC handler; shared constants module (`src/shared/constants.ts`) prevents main/renderer drift |
| File access | `.pdf` extension + `%PDF-` magic-byte preflight + `lstat` symlink rejection + 100MB cap. Session directories are keyed by content hash (`/^[a-f0-9]{64}$/` whitelist), blocking path traversal |
| Navigation/permissions | `will-navigate` + `will-redirect` blocked (only the packaged renderer URL allowed), permission requests/checks denied by default (`clipboard-sanitized-write` excepted), DevTools disabled in production, external URLs matched against an exact-hostname whitelist |
| Markdown/XSS | URL scheme allowlist (`https/http/mailto/#`), `javascript:`/`data:` etc. blocked, control characters and bidi overrides blocked, external images blocked |
| PDF export | Summary HTML rendered through the same Markdown sanitization (no raw HTML/scripts, scheme allowlist) and printed in a locked offscreen window (Node disabled, sandbox, JavaScript disabled) |
| CSP | `unsafe-inline` removed from `script-src` (only the FOUC-prevention script whitelisted by sha256), `frame-src/child-src/base-uri/form-action` locked down |
| Prompt injection | `sanitizePromptInput` applied to user questions, RAG chunks, summary text, and conversation history; OCR/Vision prompts explicitly instruct ignoring in-image instructions |
| Hallucination mitigation | Q&A answers split into sentences → cosine-scored against RAG embeddings → refined by the LLM when too many sentences are weak (multilingual sentence boundaries + Latin/CJK mixed-boundary handling) |
| Resource caps | Streaming 50MB / Vision 10MB / error bodies 64KB / PDF 100MB·500 pages / 50-image cap / 4 concurrent embeddings / history 4000 chars·10 turns / URLs 2048 chars |
| RAG integrity | NaN/Infinity validation at the IPC boundary, vector dimensions locked to the first chunk, AbortController cancels stale builds on document switch + final docId check |
| Process reliability | `requestSingleInstanceLock` against double instances, Ollama child-process tracking and teardown (taskkill + SIGKILL fallback), immediate stream-`close` detection on network loss |
| Installer/supply chain | Authenticode signature verification of the Ollama installer, SHA-pinned third-party GitHub Actions, `npm ci` + lockfile sync gates, installer SHA-256 + Sigstore attestation, sourcemaps excluded from asar |

## Quality Assurance

- **1296 unit tests / 80 files** — renderer·shared 860 + main 436. The main process is behavior-tested through an electron mocking harness covering IPC handlers, OllamaManager, the API key store, ai-service, and cross-session search; the renderer/preload layer (all 16 components + core libraries such as use-summarize/use-session/pdf-parser/safe-markdown and the preload bridge) is behavior-tested via happy-dom
- **Playwright E2E** — 8 CI-deterministic tests driving the real Electron build (cold-start wizard, PDF parse, session/settings persistence across restart, upload-error paths), all AI-independent; multi-tab restore and summarize/Q&A/collection flows are covered by local-only Ollama specs
- **CI gates** — `tsc --noEmit` (strict, incl. a separate e2e type-check project), enforced coverage thresholds (77/69/79/81), lockfile version sync check, `npm audit` advisory, Node 22/24 matrix
- **4-agent parallel QA** — a full-codebase QA round on every release; zero Critical findings across 48+ consecutive rounds (detected High/Important issues are fixed before release — e.g. R41 caught a High session-corruption path in v0.19.0; recent rounds surface only Low/cosmetic items — the most recent round converged on the cross-document summary path and shipped as fixes in v0.31.3)
- Detailed improvement/fix history: [docs/HISTORY.md](docs/HISTORY.md) (Korean)

## License

MIT License. See [LICENSE](LICENSE) for details.

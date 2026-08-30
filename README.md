# RED Justice — AI-Powered Criminal Network Analysis & Investigation System

An offline-first investigation intelligence platform that converts heterogeneous evidence (FIRs, PDFs, CDRs, bank statements, chat exports, screenshots, emails, etc.) into:

- **Extracted entities** (persons, organizations, accounts, devices, locations, events)
- **Resolved identities** (cross-file deduplication and alias linking)
- **Relationships** (money flows, communications, associations with evidence tracing)
- **Timelines** (chronological event playback with co-activity analysis)
- **Knowledge graphs** (force-directed visualization with network analytics)
- **Pattern detection** (structural anomalies, rapid movement, circular flows)
- **AI-assisted hypotheses** (grounded in evidence with human review)
- **Investigator reports** (structured claims, decisions, and full audit trails)

**All on your own machine. No cloud uploads. No subscription.**

---

## ⚡ Quick Start (Windows)

```bat
:: 1. Double-click or run from terminal:
setup.bat

:: 2. When setup finishes:
start-red-justice.bat          :: starts the app
start-ollama.bat               :: optional: starts Ollama AI + app

:: 3. Open http://localhost:3000
```

**macOS / Linux:**

```bash
bun install                    # or: npm install
bun run db:push                # create SQLite schema
bun run dev                    # dev server → http://localhost:3000
```

**Docker:**

```bash
docker compose up --build
```

---

## 🎯 Key Features

- **Multi-format ingestion**: Structured files (CSV, XLSX, XML, JSON) + documents (PDF, DOCX, EML, images with OCR)
- **Deterministic-first extraction**: Regex, table parsing, and ID validation happen offline before any AI
- **Tiered AI pipeline**: Fast (classification) → Standard (extraction) → Deep (reasoning) routing
- **Evidence-driven relationships**: Every connection cites the exact document quote proving it
- **Cross-file intelligence**: Entities are deduplicated and linked across files; aliases resolved
- **Full-fidelity provenance**: Source table IDs, row snapshots, timestamps, and evidence references on every node/edge
- **Force-directed graph**: Degree-normalized layout with community detection (LPA) and network analytics
- **Pattern & anomaly detection**: Structural holes, rapid movement, hub spikes, circular flows
- **Temporal playback**: Scrub the investigation chronologically frame-by-frame
- **Explain Connection**: Find paths between any two entities with corridor scoring and sufficiency gates
- **Decision records & audit**: Every human approval, rejection, merge, or analysis is recorded with full traceability
- **Benchmark Lab**: Score any local or Gemini model as an investigation reasoning component

---

## 🔧 Configuration

Create a `.env` file (or use `.env.local` for local overrides):

```bash
# Database (default: SQLite in ./db/custom.db)
DATABASE_URL=file:./db/custom.db
PORT=3000

# Local AI (any OpenAI-compatible endpoint; Ollama default)
LOCAL_AI_BASE_URL=http://localhost:11434/v1
LOCAL_AI_MODEL=llama3.2                          # default for all tiers
LOCAL_AI_FAST_MODEL=qwen2.5:1.5b                 # fast tier (≤3B)
LOCAL_AI_STANDARD_MODEL=qwen3:4b                 # standard tier (3–7B)
LOCAL_AI_DEEP_MODEL=qwen3:8b                     # deep tier (7B+)
LOCAL_AI_TIMEOUT_MS=240000                       # request timeout (auto-scales)
LOCAL_AI_IDLE_MS=150000                          # abort if no bytes for this long
LOCAL_AI_MAX_INPUT_CHARS=12000                   # chunk budget per call

# Cloud fallback (optional; used only when local AI is down)
GEMINI_API_KEY=                                  # get free key at aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.0-flash

# OCR (for scanned PDFs and images)
OCR_LANGS=eng                                    # tesseract language packs
OCR_MAX_PDF_PAGES=8
OCR_DPI=150
```

**All variables are optional.** Deterministic features (extraction, graph, patterns, risk scoring) run fully offline with no AI configured.

---

## 📦 Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **UI**: Tailwind CSS 4, shadcn/ui
- **Database**: Prisma ORM + SQLite (WAL mode for concurrent access)
- **Graph**: Custom SVG force-directed renderer
- **AI**: Local Ollama (default) · Google Gemini (optional fallback)

---

## 📁 Project Layout

```
prisma/schema.prisma          # Data model (cases, evidence, entities, etc.)
src/
  ├── app/
  │   ├── api/                # REST API routes
  │   ├── benchmark/          # Benchmark Lab page
  │   └── *.tsx               # Main views (dashboard, network, evidence, etc.)
  ├── components/
  │   ├── red-justice/        # Investigation UI (Evidence, Network, Patterns, etc.)
  │   ├── benchmark/          # Benchmark Lab UI
  │   └── ui/                 # Reusable shadcn/ui components
  ├── lib/
  │   ├── extractors/         # File parsing + entity/transaction/communication extraction
  │   ├── investigation/      # Core logic (claims, contradictions, gaps, decisions, replay)
  │   ├── analytics/          # Graph algorithms (centrality, LPA, money flow, etc.)
  │   ├── benchmark/          # Benchmark case generator, suites, scoring
  │   └── *.ts                # Utilities (API client, database, AI providers, etc.)
  ├── hooks/                  # React hooks
  ├── types/                  # TypeScript type definitions
  └── instrumentation.ts      # Startup bootstrap
```

---

## 🚀 Running with Different Models

**Bigger models (gpt-oss:20b, DeepSeek-R1, etc.):**

```bash
set LOCAL_AI_BASE_URL=http://localhost:11434/v1
set LOCAL_AI_MODEL=gpt-oss:20b
bun run start
```

Nothing else needed — budgets, timeouts, context sizing, and reasoning-channel handling adapt automatically.

**GPU speedups (Ollama):**

```bash
# In the shell where Ollama starts:
set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0
```

Then restart Ollama.

---

## 📖 Documentation

For detailed version histories, architecture principles, and advanced configuration, see:

- [CHANGELOG.md](CHANGELOG.md) – Version histories and release notes
- [ARCHITECTURE.md](ARCHITECTURE.md) – Design principles and data flow
- [EXTRACTION.md](EXTRACTION.md) – Entity and relationship extraction pipeline details

---

## 🐛 Troubleshooting

| Issue | Solution |
|---|---|
| **Empty database on startup** | Run `bun run db:push` once to initialize the SQLite schema |
| **AI unavailable** | Status panel shows AI state; install Ollama or set `LOCAL_AI_BASE_URL` to any OpenAI-compatible endpoint. Deterministic features work offline. |
| **Scans are slow on big models** | Larger models genuinely take longer. Watch the server console for `[localAi] … answered N chars in Xs` lines. Check GPU offload with `ollama ps` (should show `100% GPU`). |
| **Scans freeze the UI** | Ensure SQLite is in WAL mode (auto-set at boot). Check `LOCAL_AI_IDLE_MS` and `LOCAL_AI_TIMEOUT_MS` for timeout issues. |
| **"Unable to open database file"** | Ensure `DATABASE_URL` path is writable and the `db/` directory exists. Relative paths are auto-corrected in production. |

---

## 📊 Benchmark Lab

Measure how well any local or cloud model works as an investigation reasoning component:

1. Open the sidebar and click **Benchmark Lab**
2. Select models (local Ollama + optional Gemini)
3. Choose test suite and run mode (**Turbo** for speed, **Quality** for pure capability)
4. Review results: ranked scores, per-category bars, radar overlay, and detailed breakdowns

---

## 🔒 Privacy & Offline Operation

- ✅ **All processing is local.** No data leaves your machine without your consent.
- ✅ **Optional cloud fallback.** If local AI is unavailable, Gemini can be used — set `GEMINI_API_KEY` to enable.
- ✅ **No mandatory cloud components.** Deterministic analysis runs fully offline.
- ✅ **SQLite database.** Single-file format, portable, and auditable.

---

## 📝 License

[LICENSE](LICENSE)

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 💬 Support & Discussion

- **Issues**: [GitHub Issues](../../issues)
- **Discussions**: [GitHub Discussions](../../discussions)

---

## Acknowledgments

Built with love for investigators, analysts, and security researchers who need offline, evidence-driven intelligence without vendor lock-in.

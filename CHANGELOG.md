# RED Justice — AI-Powered Criminal Network Analysis & Investigation System

An offline-first investigation intelligence platform that converts heterogeneous evidence
(FIRs, PDFs, CDRs, bank statements, chat exports, screenshots) into extracted entities,
resolved identities, relationships, transactions, timelines, graph networks, communities,
suspicious patterns, network analytics, actor risk indicators, evidence-gap analysis,
AI-assisted hypotheses, and human-reviewed reports — all on your own machine.


## v3.10.0 — Multi-file corpus + cross-file reference stitching (Project Meridian)

A 41-file multi-format corpus (txt / csv / xml / eml / html / docx / pdf /
xlsx / json — FIRs, CDR chunks, bank statements, tower/IPDR logs, vehicle and
cross-case registries, property links, OSINT, emails, investigator notes,
master inventories, a 245KB graph export) ingested into ONE case through the
real upload API. The corpus declares its own ground truth (225 entities /
405 relationship rows / 348 evidence anchors); every gap was fixed with
GENERIC multi-file machinery — zero dataset-specific logic.

**Final E2E (production standalone, fresh case, 41 sequential uploads,
AI-unavailable fail-soft floor): 87 seconds, ZERO AI model calls.**

| Metric | Result |
|---|---|
| Entity recall | **225/225 (100%)** — all 19 truth types at 100% (PERSON 32, TRANSACTION 30, CALL 30, PHONE 15, EVENT 15, DOCUMENT 12, ORG 10, EMAIL 10, BANK_ACCOUNT 10, DEVICE 8, IP 8, ADDRESS 8, LOCATION 8, WALLET 6, VEHICLE 6, SOCIAL 5, CASE 4, DOMAIN 4, IMAGE 4) |
| Relationship recall | **389/389 unique triples (100%, ALL 30 verbs literal)** — the truth's 405 rows contain 16 reciprocal/duplicate assertions; every one of the 405 rowIds is preserved in edge row-snapshots (total weight 1321) |
| Edge fidelity | 100% with evidence refs, 100% with timestamps, 100% `deterministic-reltable` provenance |
| PER-001 connectivity | **225/225** entities reachable; 6 vertex-disjoint independent paths between key pairs (PER-001↔PER-008, PER-002↔PER-003, PER-001↔ACC-001, PHONE-001↔PHONE-014) |
| Cross-case identity collisions | 4/4 nodes present and linked to both colliding cases (PHONE-014, DEV-005, PER-003, PER-007) |
| Temporal | 1422 timeline events from dated table rows; observed_at/valid_to captured via widened temporal header set |
| Cross-file corroboration | 1060 entity↔evidence links; entities corroborated across up to 9 files |
| Precision | 91.5% raw — every extra is a defensible real corpus mention (6 bank names, 4 cities, 2 investigator emails, UPI/domain fragments); wrapped-row junk eliminated |

- **Cross-file reference stitching** (`src/lib/investigation/referenceStitch.ts`)
  — multi-file exports speak the same object through different spellings: a
  master inventory names it (`Rohan Kale`, row id `PER-002`) while CDR/bank/
  registry exports say only `PER-002`. The stitcher GROUPs entities by the
  reference tokens they declare (metadata tableIds) or embody (value IS a
  token), then merges each group into one survivor node — typed/name nodes
  win over bare-id placeholders (deterministic scoring: type > real value >
  degree > age), relationship endpoints re-point, evidence links accumulate,
  reciprocal-clash edges collapse by weight. Order-independent (whichever
  file arrives first, the placeholder is absorbed or promoted) and
  idempotent. The token grammar is STRUCTURAL (alnum segments in -/_
  separated form ending in a digit segment: `PER-002`, `DOC-CDR-003`,
  `LOC-OBS-001`, `E0001`) — no dataset vocabulary.
- **Entity-register table detector** (`extractEntityTable`) — delimited
  inventories that state typed entities literally
  (`entity_id,...,name,...,type` with cells PERSON/ORGANIZATION/...) parse
  into one typed node per row with the row id as its reference token.
  Detection is structural + fill-rate based: a type column mapping ≥60%
  through the shared type vocabulary, a name column chosen by fill-rate
  (name beats label), an id column excluded from values, endpoint-pair
  tables rejected (those are relationship tables). Entity registers also
  join the structured-dominant class (≥20 rows) so AI sweeps skip them.
- **Entity-register guard on the relationship-table parser** — a table whose
  "verb" column is dominated by entity-type labels is NOT an edge list; the
  old behavior fabricated one nonsense edge per inventory row.
- **JSON record-list flattener** — arrays of ≥6 sibling objects render as
  labelled pipe tables (`entities list`, `relationships list`, ...), the
  JSON twin of the v3.9.2 XML record-list flattener; NDJSON streams flatten
  the same way. Pretty-printed JSON remains the fallback for prose-ish docs.
- **Direction-faithful row merging** — `mergeRows` no longer folds the
  reverse key: reciprocal rows ("A CONNECTED_TO B" AND "B CONNECTED_TO A")
  are distinct assertions and stay distinct edges; identical triples still
  merge by weight with full row snapshots (previously half the reciprocals
  were silently re-oriented).
- **Ref-token endpoint self-ids** — an endpoint cell that is itself a
  reference token records the token as its table id, feeding the stitcher
  even when no explicit id column exists.
- **Temporal header widening** — observed_at / observed_on / valid_from /
  valid_to / valid_until / first_seen / last_seen / occurred_at / event_time
  / from_date / to_date recognized as date columns.
- **Spreadsheet cell newline folding** — in-cell newlines break one logical
  row into several physical lines and downstream detectors glue records into
  junk values; quoted CSV cells now fold newlines to spaces.
- **Wrapped-row glue guard** (`isWrappedRowGlue`) — multi-cell CSV fragments
  ("ORG-001,ORGANIZATION,Asterion Logistics Pvt Ltd") are rejected at the
  wiring choke point; real names/addresses (≤1 comma) always pass.
- **Social/event type aliases** — SOCIAL_ACCOUNT, EMAIL_ADDRESS, EVENT,
  INCIDENT join the table type vocabulary.

Regressions: v3.10 battery 16/16, docx battery 13/13, unit 214/214,
integration 103/103, relmaker tier-policy 22/22, prod-bigfile 12/12,
boot-pragma 10/10, tsc + eslint clean.

## v3.9.2 — Multi-format structured-export fidelity (XML / HTML / PDF / CSV)

The red_justice_demo corpus was re-run through every remaining format and the
gaps were fixed at the PARSER/pipeline level (no dataset-specific logic).
Verified end-to-end on the production standalone server through the real
upload API against the documents' own declared ground truth:

| Format | Entities (recall) | Relationships (recall) | Scan time |
|---|---|---|---|
| XML export | 165/165 (100%) | 280/280 (100%, all 13 verbs literal) | ~6s, zero AI calls |
| HTML report | 165/165 (100%) | 30/30 sample rows (100%) | ~6s, zero AI calls |
| PDF registry | 165/165 (100%) | 280/280 (100%) | ~6s (was 88s OCR + lossy) |
| CSV export | 154/154 endpoints (100%) | 280/280 (100%) | ~6s |

- **PDF native CID text extraction** — LibreOffice/OpenOffice PDFs encode text
  as hex CID strings keyed to per-font ToUnicode CMaps. The decoder now parses
  bfchar/bfrange CMaps, tracks the active font (`/FN size Tf`), and decodes
  hex strings through it; a text-matrix tracker (Tm/Td/TD/T*/TL, BT resets)
  assembles same-baseline runs into lines with ` | ` column gaps. Scanned
  PDFs still OCR-fallback, but text PDFs stop losing 88 seconds and fidelity
  to an OCR pass they never needed.
- **XML record-list flattener** — parents with >=6 repeated sibling elements
  render as pipe tables (leaf column names, attr cells docx-style `key=value`),
  so registry/relationship-table detectors fire on structured exports.
- **HTML table fidelity** — `<tr>` rows stay on one line, cells joined ` | `
  (same invariant the v3.9.1 docx fix established).
- **Registry Pass-2 verb hunt relaxed** — when the span between the two
  endpoint refs holds no verb, the whole row is scanned; bare ALL-CAPS words
  count only when they name a known relationship verb (USES/OWNS/MESSAGED/…).
- **Verb-typed rows are not entities** — `R0001 | WORKS_FOR | …` rows no
  longer mint phantom entities.
- **Structured evidence keeps its literal verb** — a relationship table or
  registry annexure asserting `MESSAGED`/`MET` keeps that verb; synonym
  folding (→ COMMUNICATED_WITH/ASSOCIATED_WITH) stays active for AI free-form
  verbs only. Evidence decides the vocabulary.
- **Registry join through the type map** — registry rows key endpoints by
  their own row type (`address::…`) while wired nodes use canonical types
  (`location`); the join now resolves through DET_TYPE_MAP (25/25
  REGISTERED_AT edges were silently dropped before).
- **Fragment guards** — wrapped-cell fragments of authoritative identifiers
  (digit-core containment + >=12-char prefix/suffix containment against
  registry/table values) no longer become duplicate nodes.
- **Structured exports complete deterministically** — documents whose
  relationship rows are fully parsed by the deterministic layer (registry
  >=20 rows, or a relationship table >=20 edges / >=70% coverage) skip the
  AI re-read: the rows already state their entities and edges literally, so
  the sweep/maker/turbo passes would only paraphrase them (hallucination
  surface + minutes of model time). Prose documents keep the full AI path.
- Entity precision ~95-97%: the only extras are real mentions that are also
  in the documents (5 cities + 4 bank names), the same defensible class as
  v3.9.1.

All fixes generic. Regressions green: unit 214/214, v3.9.1 docx battery
13/13, integration 103/103, relmaker tier policy 22/22, prod-bigfile 12/12
(fail-soft intact), boot-pragma 10/10, tsc/eslint/next build clean.

## v3.9.1 — DOCX table fidelity + registry-noise suppression (demo-dataset verified)

**Verified against a ground-truth dataset** (synthetic case RJ-DEMO-2026-001: 165 declared
entities / 280 declared relationships in a DOCX with an entity registry + relationship
registry), independently cross-checked with Z.ai GLM:

| Metric | v3.9.0 | v3.9.1 |
|---|---|---|
| Entity recall | 83.6% | **100%** (165/165, all 9 classes incl. DEVICE/ADDRESS/EVENT) |
| Relationship recall | 15.5% | **94.6%** (263/280; remainder = canonical verb relabeling) |
| Relationship precision | 28.7% | **95.6%** |
| Edges with evidence + verification state | partial | **100%** |

Fixes (all generic, zero dataset-specific hardcoding):

- **DOCX table-aware flattening** (`fileParser.docxToText`): the old parser put every
  table CELL on its own line (`</w:p>` fires inside cells), destroying row structure —
  relationship-table detection, structure detection and chunking all silently degraded to
  prose-guessing on tabular DOCX evidence. Rows now flatten one-line-each with ` | `
  cells; `<w:tblPr>`/`<w:tblGrid>` no longer corrupt depth tracking; paragraphs inside
  cells become soft spaces.
- **Registry-prefixed endpoints split** (`relTableExtract`): "E0001 Arjun Sharma" in
  endpoint cells now becomes the clean NAME (merging with the registry's node) while the
  ID survives in the trace fields (`srcTableId`). Guards reject non-ID leading tokens
  ("Samsung Galaxy S24" is not split).
- **Registry noise vocabulary** (`registryExtract.noiseVocabulary`): row refs (E0001,
  R0042) + attribute keys/values (status=active, carrier=Jio, city=Nashik) are exposed as
  deterministic suppression tokens.
- **AI noise filter** (`filterRegistryNoiseAi`): the fast sweep (Pass 2), the independent
  verifier's recovered misses (Pass 3) AND the enrichment pass's missedEntities are all
  filtered — no more phantom `document_id: E00xx` nodes, attribute fragments as persons,
  or `k=v` property cells as entities; proper-noun rule kills lowercase single-word
  person/org values. Deterministic entities are never suppressible.
- **Property-cell wiring guard** (`wireEntitiesIntoGraph`): a bare `k=v` value is never
  wired as a graph node, whichever stage emitted it — this also starves the 43
  hallucinated `IDENTIFIED_BY status=…` edges the demo run exposed.
- **EVENT entities wire** (was silently dropped): annexure event-register rows
  (Event-01 …) become first-class `event` nodes (canonical type + AI label mapping).
- **Status label**: the phantom `aiModel: llama3.2` on the status panel now falls through
  to the configured FAST-tier model.
- Full deterministic floor even with the AI unavailable: 100% entity recall / 94.8%
  precision, 94.6% relationship recall on the demo dataset with ZERO model calls.

## v3.9.0 — Master-Prompt Extraction Pipeline: explicit num_ctx, token-aware chunking, three-pass extraction, candidate gate

The extraction pipeline now implements the full context/tokenization/extraction
contract, on top of the v3.8 tier architecture:

**Explicit context contract (never the server default).** Every Ollama
generation request carries an explicit `num_ctx` from the tier table —
fast 8,192 / standard 16,384 / deep 32,768 tokens, each with a reserved
block (1,024/2,048/4,096) and a 90% safety margin on the remainder that
becomes the hard chunk budget (≈6,451/12,902/25,805 tokens). Ollama's
default context silently truncates long prompts; nothing here relies on it.
Values clamp to each model's REAL window (probed via `/api/show`) and, if a
composed prompt ever exceeds the tier window, the allocation sizes UP to the
need with a loud warning — never silent truncation.

**Token-aware chunking (digit-aware, fail-small).** Chunk budgets are
computed in TOKENS, not chars. When the server exposes `/api/tokenize`
(tokenizer data only — no weights download), exact counts are used and
cached; otherwise a conservative heuristic (~3 chars/token prose, ~2 for
digit runs, 1 for CJK) deliberately OVERestimates so chunks shrink instead
of overflowing. Identifier-heavy evidence (CDRs, registers, bank trails)
automatically gets smaller chunks than prose at the same token budget.

**Three-pass extraction.** Pass 1 stays deterministic (regex/registry/rows,
zero tokens) and now checksum-validates unlabeled identifiers: IMEI → Luhn,
Aadhaar → Verhoeff, GSTIN → mod-36 check digit — a random 15-digit number is
no longer mistaken for an IMEI. Pass 2 (fast tier) receives the chunk's
already-extracted deterministic entities as TRUSTED INPUT ("never re-list
them") and only hunts what code cannot see: names, orgs, aliases, informal
places. Pass 3 is a genuinely separate fast-tier call over the same chunk
with the Pass-2 output — an independent adversarial audit that recovers
missed entities and flags hallucinations (RJ_RECHECK_PASS=contested reverts
to the lighter v3.8 behaviour on weak hardware).

**Reconciliation gate: confirmed vs candidate — never deleted.** The merge
court confirms deterministic entities unconditionally; AI entities confirm on
a single ≥0.8-confidence mention or corroboration across ≥2 sightings.
Weaker AI entities become `status=candidate` and are KEPT for review, later
evidence, or deeper analysis — visible via `/entities?status=candidate`,
promotable via the human-review endpoint
(`POST /api/cases/[id]/entities/[entityId]/status`), excluded from the
canonical graph until promoted (`?includeCandidates=1` shows them). A later
confirmed sighting auto-promotes an existing candidate; confirmed entities
are never demoted silently.

**No artificial entity cap.** Entity count is a quality-gated OUTCOME, never
a capacity: a document with hundreds of independently corroborated entities
keeps every one of them (regression-tested at 800). The remaining guard is a
pathological memory valve that scales with document size and cannot bind a
real document.

**Deterministic structure detection.** Tabular-vs-narrative is decided in
code (delimiter consistency, column-pattern regularity, row-length variance,
digit density — zero model calls) and drives the relationship strategy:
tabular files wire row edges deterministically and get ONE pattern call;
narratives walk ordered chunks with the rolling story-so-far and the global
numbered manifest (cross-chunk pronoun resolution).

**Verification.** Unit 214/214 (both runners; +56 master-prompt tests:
num_ctx table, tokenizer vectors, checksum vectors, gating, structure,
no-cap, memory). Mock E2E 22/22 — including call-log proof that every
generation carried its tier's num_ctx and pass-3 ran on the fast tier. GLM
live smoke on the production build: FIR 100% recall on every entity class,
58/58 AI edges with rationale. Boot-pragma 10/10, prod-bigfile 12/12,
integration 103/103. Existing databases upgrade with `npx prisma db push`
(adds `Entity.status`).


## v3.8.0 — Two-Stage Tier Pipeline: Fast Sweep → Merge Court → Chunked Relationship Maker

The tier routing now matches the investigation spec literally, with a
deterministic-first accuracy contract end-to-end:

**STAGE 0 — FAST ENTITY SWEEP (new).** The ≤3B model walks the FULL document
in small overlapped chunks (8K-char quality zone, 240-char overlap) with a
single-purpose NER prompt — no summaries, no relationships, just exhaustive
entity listing. Chunks overlap so an entity at a boundary is seen twice;
a per-chunk quality gate escalates signal-rich-but-empty chunks to STANDARD.
A deterministic MERGE COURT (regex weight 5 = ground truth; AI sightings vote)
reconciles the sweep against the extraction base — digit-safe keys unify
"A/C 123…" with "123…", conflicts are flagged, nothing deterministic is ever
deleted — and a RECHECK pass sends ONLY the contested slice back for
adjudication (corrections applied, junk rejected, missed critical actors added).

**STAGE 2 — CHUNKED RELATIONSHIP MAKER (rebuilt).** Prose documents (FIRs,
statements, letters) are wired chunk-by-chunk IN ORDER with a rolling
STORY-SO-FAR digest, so relationships that span the document survive ("his
vehicle" in paragraph 12 resolves to the actor named in paragraph 1). Row-wise
documents (bank statements, CDRs) skip the walk entirely — their rows are
already ~80% wired deterministically — and get ONE compact pattern call
(frequency digest + row sample) for funnel/structuring/hub patterns the rows
cannot express.

**EVIDENCE PROOF GATE (new).** Every AI connection must carry a verbatim
document quote; the pipeline verifies each quote against the text. Proven
edges are confidence-boosted and carry their proof onto the graph
(metadataJson.evidence), paraphrases are kept at reduced confidence, and
edges with neither a rationale nor a verifiable quote are discarded.

**PER-TIER CONTEXT BUDGETS (new).** Documented context windows for the default
fleet (qwen2.5:1.5b / qwen3:4b / qwen3:8b @ 32K tokens; GLM flash/air/4.6 at
128-200K) with quality-zone chunk budgets (fast 8K / standard 14K / deep 24K
chars), env-overridable, hard-clamped by each model's REAL reported window,
and intersected with the 12K local per-prompt ceiling — a prompt can never
overspill its model.

**DYNAMIC LIMITS (new).** The deterministic entity cap now SCALES with
document size (40 chars/entity ≈ a 6,374-entity bank trail keeps all 6,374;
only a 250K pathological guard remains) and the graph API's default node
limit scales with the case (300 → 3,000) instead of a fixed 300.

**Z.ai GLM PROVIDER (dev-only since v3.10.0 — NOT in production builds).**
Production ships LOCAL-MODELS-ONLY: `.env` defaults to your Ollama server
(`http://localhost:11434/v1`) with tier AUTO-assignment from the models you
have pulled, and the Model Router lists every downloaded model for manual
override. The GLM bridge (`LOCAL_AI_BASE_URL=zai://glm`) remains a
verification-harness tool: the SDK lives in `devDependencies`, is excluded
from the standalone output by `outputFileTracingExcludes`, and the router
title/status now display the LIVE provider so a cloud bridge can never mas-
querade as "Ollama connected". Fail-soft: without the SDK installed the app
boots normally.

**Deep tier = reasoning tier.** Investigation chat and link explanations run
on the deep model with chain-of-thought explicitly ON, per the routing spec.

**Bank-statement fix (found by the new torture corpus).** Statement banners
of the plain form `Account: 0034100009876` never anchored their rows, so
narration counterparties ("NEFT DR TO 5019…") produced zero account entities
and zero money-flow edges. The header regex now accepts the bare form; 108 of
120 rows in the verification statement carry both endpoints, and row multiplicity
is preserved as edge weight (18 instalments = one pair, weight 18).

**DOUBLE-VERIFICATION (new methodology).** A hand-read ground truth
(_truth_v38.json — the agent read every document end-to-end BEFORE any
ingestion) is asserted against the live production build served by REAL GLM
models on all three tiers: FIR 23/23 (entity recall 100% on every class,
10/12 relationship pairs incl. cross-chunk pronoun resolution, 64/93 edges
verbatim-evidence-proven, deep chat CoT ON), bank CSV 23/23 (accounts 5/5,
Σedge-weight 110 rows preserved), boundary-torture 21/21 (unicode/lowercase/
reversed-name persons 6/6 at 30K chars). All prompts ≤ the 12K budget contract.

**Regression green:** unit 158/158 (bun + node), relmaker 16/16, prod-bigfile
12/12 (3s scan), integration 103/103, boot-pragma 10/10, tsc/eslint/build clean.


## v3.7.2 — Startup `prisma:error` Fixed (busy_timeout now actually applies)

Every server boot printed `prisma:error — Invalid $executeRawUnsafe() invocation —
Execute returned results, which is not allowed in SQLite.` The v3.7.1 boot PRAGMA
chain correctly used `$queryRaw` for `journal_mode=WAL` (which returns a row) but
left `PRAGMA busy_timeout = 10000;` on `$executeRawUnsafe` — and SQLite's
busy_timeout SET form ALSO returns a row (the new value), so Prisma rejected it.
The error was swallowed (no crash), but busy_timeout was silently NEVER set,
weakening the anti-`SQLITE_BUSY` protection during big scans.

- Both boot pragmas now go through `$queryRaw` — the error is gone and
  busy_timeout verifiably applies (probe returns `timeout: 10000`).
- Verified on the production standalone server: zero `prisma:error` lines across
  boot + writes; WAL sidecars (`-wal`/`-shm`) appear; `journal_mode=wal`
  persists in the database file (10/10 boot-regression assertions).
- Unit torture suite green on both `node` and `bun` runners (jiti `@/` alias
  pinned explicitly in the harness).


## v3.7.1 — Big-File Offline Mode Fixed (38K-prompt watchdog kills, frozen app, starved graphs)

Real-world bank-trail uploads (thousands of rows) broke in THREE stacked ways offline.
All are fixed and verified end-to-end against the production standalone server:

**1. Prompts silently exceeded the model budget (the 38K-char qwen3:4b timeouts).**
The "already extracted" entity manifest embedded up to 550 entity lines (~30K chars)
on top of the document chunk — containment matching matches nearly every numeric
entity in every chunk of a financial register. The 12K per-prompt budget was defeated,
qwen3:4b sat silent through prefill, and the watchdog killed both attempts ("queued
scan failed"). Manifests are now built under a HARD character budget (hubs first,
contextual noise like dates/amounts excluded entirely) in every AI path — enrichment
chunks, relationship-table digest, the relationship maker (whose system-prompt overhead
is now budgeted too), and cross-file connect (whose 150-entity cuid roster alone pushed
18K). Chunk planning also lost its 24-chunk ceiling, which made chunks BIGGER than the
budget on large docs; oversized single lines are hard-split. A loud `PROMPT OVER BUDGET`
log line now exposes any future regression.

**2. The app FROZE for minutes during big scans (looked fully broken).**
Two independent causes: (a) SQLite's rollback journal gave every one of thousands of
sequential writes its own exclusive lock + fsync — the whole phase-A wiring now runs in
ONE interactive transaction and the database switches to WAL mode at boot (readers are
never blocked again; verified: 500-row/300K-char scan completes in ~5s on the standalone
server, polls stay responsive throughout); (b) the post-scan actor-risk analytics
attributed every bank transaction to every counterparty account (accounts inherited
their account-type neighbors' values), detonating a ≥1.1-billion-iteration temporal
correlation loop that pegged the CPU and starved every HTTP request — attribution is
now correct and the pair scan is bounded. Pattern findings are capped to the top 500 by
severity instead of persisting thousands per scan, and the evidence list endpoint ships
a content preview + trimmed scan digest instead of ~1.5MB per poll.

**3. The deterministic graph was silently strangled (why the knowledge graph looked empty).**
Record-edge endpoint materialization was hard-capped at 120 entities and record wiring
at 400 edges — a 2,400-row trail kept 129 of its ~2,400 edges. Caps now scale with
`RJ_MAX_DET_ENTITIES` (default raised 800 → 4,000; the graph view renders top-N by
degree so large entity sets persist safely). Re-uploaded/overlapping trails count
merged rows toward the deterministic base too.

**Fail-soft scans.** When the model is dead or too slow but the file's structured rows
are already wired (bank trails, CDRs, relationship tables), the scan now COMPLETES with
the deterministic graph and an honest "AI summary unavailable" note instead of a red
FAILED badge — only files with no deterministic value fail hard.

**Per-call output budgets.** Chunk/digest/maker calls request ~2.2-2.5K output tokens
(was 6-8K), bounding worst-case CPU generation time; deep-tier escalations keep room
for chain-of-thought. `.env` ships a 240s call budget with tuning guidance
(`LOCAL_AI_IDLE_MS`, `LOCAL_AI_MAX_INPUT_CHARS`, `RJ_MAX_DET_ENTITIES`).

Verified: 12/12 big-file regression assertions against `node .next/standalone/server.js`
(zero simulated-watchdog breaches at a 14K prompt cap, max prompt 12,841 chars, 925
nodes/915 TRANSFERRED_TO edges in 5s, dead-model fail-soft completion in 2s); unit
116/116; integration 103/103; relationship-maker/tier-routing 16/16; tsc + eslint +
production build clean.


## v3.7 — Two-Stage Evidence-Driven Relationships + Strict Tier Routing

The enrichment pass asked one model call to summarize, find entities, flag
indicators AND wire relationships. Small local models juggled those jobs
poorly: relationships came out empty or with drifted entity values that failed
endpoint resolution — and small PROSE documents (victim statements, letters)
were routed to the FAST tier (≤3B) because they were short and dense with
identifiers, producing junk summaries and zero relationships.

- **Stage 1 — entity extraction** (deterministic regex first, then the tier
  model's `missedEntities`): finds what regex cannot see — persons and roles
  in prose. Routing now respects the tier spec strictly: FAST is for tiny
  **structured** documents only (a prose detector keeps statements/letters on
  STANDARD no matter their size).
- **Stage 2 — the RELATIONSHIP MAKER** (new): a dedicated single-purpose call
  that wires relationships between the already-canonical entities using
  **ID-indexed endpoints** (`fromId`/`toId` reference a numbered manifest, so
  a model physically cannot typo a name; value fallback kept). Runs on
  STANDARD with chain-of-thought OFF; when it yields nothing usable on a
  document with ≥3 entities it escalates ONCE to DEEP with `thinking: true`
  sent explicitly on the wire — the exact escalation job of the 7B+ tier.
- **Novel evidence-specific verbs keep flowing** from stage 2
  (contracted_delivery_for, received_carton_at, …) as first-class edge types.
- Ships tier-aware `.env` defaults (`qwen2.5:1.5b` / `qwen3:4b` / `qwen3:8b`);
  comment the three `LOCAL_AI_*_MODEL` lines out to auto-assign from installed
  models. `LOCAL_AI_THINK=on|off` remains the global kill-switch.
- Verified live end-to-end against a mock qwen trio: statement upload →
  det base → stage-1 (standard, persons found) → stage-2 maker (standard,
  0 edges → deep escalation, CoT ON) → 10 edges on the knowledge graph incl.
  3 novel verbs; mock call-log asserts the exact tier + CoT policy per call.

## v3.6.2 — Upload Regression Fixed

- **405 Method Not Allowed on evidence upload — fixed.** The v3.6.1 package
  accidentally shipped without `src/app/api/cases/[id]/evidence/upload/route.ts`;
  with that static route missing, Next.js routed POSTs into the dynamic
  `[evid]` segment (GET/DELETE only) and every upload died with 405. The route
  is restored and re-verified live: PDF, DOCX, XLSX, CSV/CDR, EML, JSON, NDJSON,
  VCF, ZIP and OCR'd PNG all upload, parse, dedup and extract entities.
- **Ships a working default `.env`** (`DATABASE_URL=file:./db/custom.db`) so
  `bun run db:push` works out of the box on every platform; prisma CLI and the
  runtime now always agree on `<project>/prisma/db/custom.db`. The database is
  still created fresh on first setup — no data ships in the box.

## v3.6.1 — Fresh-Start Build (demo-free)

- **Zero demo artifacts.** Removed the last demo remnants: the "seed the demo
  investigation" empty-state hint (Cases), the stale "Load demo data" doc reference
  (NetworkGraph), the dangling `/api/seed` comment (helpers), and the stale
  `db/custom.db` file — the repository now ships with **no database file at all**;
  `bun run db:push` creates a clean schema on first setup.
- Kept: the Benchmark Lab (its cases are clearly-labeled synthetic evaluation
  fixtures generated on demand — they never touch your real cases).

## v3.6 — Dynamic Evidence-Driven Relationships + Extraction-Engine Hardening

v3.5 still hard-coded the relationship vocabulary in SIX disconnected places. A Palantir
export asserting `SUPPLIED_DRUGS_TO`, or an AI reading an FIR and inferring
`RECRUITED_BY`, was mislabeled as a generic `ASSOCIATED_WITH` or silently dropped —
exactly the intelligence a criminal-network platform exists to keep.

- **One vocabulary, evidence decides.** `src/lib/investigation/relVocabulary.ts` is now
  the single source of truth: a curated core (34 types) + synonym maps (i2/Palantir
  export verbs, AI snake_case verbs, OCR-truncated registry verbs, reverse-direction
  verbs like `RECEIVED_FROM`) + a quality gate that **keeps any other well-formed verb
  as a first-class novel edge type** (UPPER_SNAKE, 2-5 words). Novel types are
  persisted, rendered (deterministic palette color per type), filterable, and explained.
- **No more silent drops.** relTableExtract keeps novel verbs (was: flatten to
  ASSOCIATED_WITH); smartConnect keeps novel AI verbs (was: dropped); registry verbs
  pass through normalization (was: dropped outside a 32-verb allow-list); crossConnect
  accepts 20 curated + unlimited evidence-specific verbs (was: 6); the graph API
  renders EVERY evidence-derived type and budget-caps only the mechanical CO_OCCURRED
  mesh (was: unknown types starved past a 200-edge budget).
- **AI prompts invite specificity.** "PREFER a standard verb … use a MORE SPECIFIC
  evidence-asserted verb (supplied_drugs_to, laundered_money_for) when the document
  states it — never flatten a specific criminal relationship."
- **Deterministic CDR parsing (new).** calling/called-number tables (CSV/TSV, 20+
  header synonyms) now yield Communication records + COMMUNICATED_WITH edges with
  call volume preserved as edge weight — previously CDRs produced ZERO deterministic
  communications.
- **Record endpoints materialize + corroborate.** A bank narration
  `IMPS DR-50100234567909` now creates the counterparty account node, wires the
  TRANSFERRED_TO edge, and links BOTH endpoints to the asserting file (the
  cross-file evidence heatmap finally reflects record rows).
- **Statement-header account propagation.** "Account Number: X" in a statement header
  now anchors every row (debits send from X, credits arrive to X) with the narration's
  embedded counterparty — account/UPI/corporate-name — as the other endpoint.
- **Format fixes:** ReportLab-style PDFs (`/ASCII85Decode /FlateDecode` chains)
  previously extracted as garbage — full filter-chain decoding added; EML base64
  bodies + From/To/Subject headers now decode into extractable text; quoted-printable
  is now real UTF-8 (no mojibake); `.geojson`/`.har` parse as single JSON documents;
  WhatsApp iOS exports (`[09/06/26, 10:14] Name:`) parse; JSON/NDJSON payment ledgers
  yield transactions; nested-zip depth is enforced (zip-quine safe, member cap 500);
  "account <digits>" in prose (the most common FIR phrasing) is extracted (was:
  only "Account No/Number", case-sensitive); letters / certificates / academic
  documents / applications have deterministic classification rules (were
  unreachable offline).
- **Cross-file connection without AI.** connectScanToCase Layers 1a/1b (merge
  detection + alias linking) are deterministic and now run even when no model is
  reachable — only Layer 2 (AI inference) is gated on availability.
- **Torture-tested.** A 20-file / 19-format "Operation Red Viper" corpus (FIR, victim
  statement, incident report DOCX, bank XLSX, CDR, WhatsApp, Palantir export with
  novel verbs, annexure registry, threat-letter PDF, JSON org chart, TSV travel
  manifest, base64 EML, vCard, nested ZIP, OCR'd PNG, markdown log, HTML court
  order, NDJSON ledger, GeoJSON route, binary blob) verifies 196 assertions: phones
  corroborated across 12 files, novel verbs end-to-end, direction flipping,
  full-fidelity row snapshots, call-volume weights, dedup, and empty-file rejection.


## v3.5 — Full-Fidelity Table Graph: every ID, every row, the whole timeline

v3.4 read relationship-table exports directly, but the graph still *hid* provenance
the investigator needs: the export's own IDs (E0001, R0001) were dropped, repeated
rows between the same endpoints collapsed silently (three TRANSFERRED_TO records
between the same accounts = one edge, dates lost), and the Timeline view showed
nothing from the table. v3.5 keeps **everything**:

- **Source-table IDs on every node.** The export's `source_id`/`target_id`
  columns ride onto entities (`metadataJson.tableIds`, merged across scans and
  multi-file aliases) and surface as amber `E0001` badges in the Network node
  panel, hover tooltips and the Entities view — every node traces back to its
  export row.
- **Every row, verbatim, on its edge.** Each relationship keeps a complete
  row snapshot (`metadataJson.rows`) — all columns as written: relationship_id,
  source/target ids+names+types, event_date, evidence_ids, state, confidence,
  extraction_method. The edge provenance panel renders them key-by-key in a
  "SOURCE TABLE ROWS" section; repeated pairs (structuring patterns) accumulate
  with `weight = asserting rows` and a "Show all N rows" expander.
- **The relationship chronology is a first-class timeline.** Every dated table
  row becomes a Timeline event (`kind=relationship`, e.g. "R0001 · Arjun Sharma
  —WORKS_FOR→ Aster Logistics") with the evidence file named — a 280-row export
  puts 280 events on the investigation timeline. Transactions and communications
  records now land there too (`kind=transaction/communication`), so the Timeline
  view reflects the document's own chronology instead of just "evidence acquired".
- **Graph API v3.5.** `GET /graph` nodes expose `tableIds`; edges expose `rows`,
  `tableRowCount` and `state`. `GET /entities` exposes `tableIds` per entity.

## v3.4 — Relationship-Table Engine: the whole file IS the graph

Investigators export graph data as **delimited edge lists** (CSV/TSV from
Analyst's Notebook, Palantir, Excel, or a prior case export):

```csv
relationship_id,source_name,source_type,relationship_type,target_name,target_type,event_date,confidence,...
R0001,Arjun Sharma,PERSON,WORKS_FOR,Aster Logistics,ORGANIZATION,2026-01-01,0.78
```

No model can faithfully re-emit hundreds of entities + connections as JSON
without truncating — ingesting such a file used to connect "only a fraction
of the entities". v3.4 reads the table **directly**:

- **Phase A table pass (instant, zero AI tokens).** `relTableExtract`
  detects delimited relationship tables (global pass for pure exports + a
  windowed pass for tables embedded in prose), maps each row's endpoints to
  typed entities using the table's own type columns (PERSON/ORGANIZATION/
  BANK_ACCOUNT/DEVICE/VEHICLE/ADDRESS/…), canonicalizes each relationship
  verb onto a renderable graph edge (`MESSAGED→COMMUNICATED_WITH`,
  `MET→ASSOCIATED_WITH`, `TRANSFERRED_TO`, `WORKS_FOR`, …), and wires every
  row as an edge with its own confidence, date and row locator. A 280-row,
  154-entity export wires **159 entities + 275 edges in ~15 ms** — 100 %
  recall, including every relationship.
- **reltable-digest enrichment (ONE call).** When the table covers ≥70 % of
  the document there is nothing left to extract — the AI pass collapses to a
  single compact call over the table digest + entity manifest asking only for
  meaning (summary, key facts, indicators, classification). Missed entities
  and connections must be `[]` unless prose outside the table reveals more.
- **Duplicate-node guards.** The table's type labels are authoritative: regex
  can no longer create a second, differently-typed node for a value the table
  already typed (bare `352987523382813` vs the table's `IMEI-352987523382813`
  are one device).
- **Output-aware chunking for dense prose.** The per-chunk entity manifest
  rides along in every prompt (hubs always + local values), so chunk size now
  shrinks by the manifest estimate — smaller chunks ⇒ smaller expected output
  per call ⇒ no more truncation mid-array on entity-dense FIRs. Chunks also
  carry a RECORD EDGES note (already-wired table/CDR/bank rows) so the model
  never wastes output restating them.

Every scan records the new strategies (`relationship-table(...)`,
`reltable-digest(...)`, `deterministic-base(… rel-table edges)`) in its
telemetry, and `deterministicBase.tableEdges` is persisted in the scan result.

## v3.3 — Tiered AI: three models, one router

RED Justice never asks “which model?” — it asks **“which tier?”**. Every AI feature
routes to the cheapest tier that can reliably serve it, and deterministic extraction
(regex/registry/row parsing) runs FIRST so most of a document never touches a model
at all:

| Tier | Parameter size | Serves | Chain-of-thought |
|---|---|---|---|
| **Fast** | 10M – 3B | Evidence classification, tiny structured docs (registers, CDR snippets) where regex already found most entities | OFF — pure speed |
| **Standard** | 3B – 7B | The default scan brain: contextual entity extraction, relationship candidates, chunk enrichment, cross-document inference | OFF on structured JSON |
| **Deep** | 7B+ | AI Investigator reasoning, narrative explanations (“why are these connected?”), executive briefs, hypothesis work, and **escalation** when a lower tier fails a chunk | ON where the model supports it |

- **Assign the trio in Settings → AI Model Router.** One model per tier, each
  annotated with its auto-detected parameter size and tier badge. Unassigned?
  The router **auto-assigns from whatever is installed** (largest ≤3B → fast,
  largest 3–7B → standard, largest 7B+ → deep). One model installed? Every tier
  uses it — identical to the old single-model behaviour.
- **Escalation, not waste.** When the tier model fails a chunk with a
  model-specific error (HTTP 5xx, empty/garbled output), that chunk is retried
  ONCE on the deep model. Server-level hangs fail fast instead of burning
  another timeout cycle. The deep model is never the default starting tier.
- **Honest telemetry.** Every scan records `engine.tier`, `engine.modelsUsed`
  (calls per tier) and the routing decision in its strategy log — the Evidence
  view shows exactly which model did what.

### The scan pipeline (v3.2 turbo hybrid + v3.4 reltable, retained)

1. **Deterministic base (instant, zero AI).** The relationship-table parser
   (v3.4) + regex/registry layer wire entities and RECORD edges (bank
   `TRANSFERRED_TO`, chat/CDR `COMMUNICATED_WITH`, annexure registry rows,
   relationship-table rows) into the graph **within seconds of upload**.
2. **AI enrichment (the double-check).** Table-dominated documents get ONE
   reltable-digest call; prose documents are chunked with a manifest of
   everything regex already extracted, and the tier model outputs ONLY what
   regex cannot see: missed entities, story connections, a compact digest.
   Because it never re-types the manifest (that was ~90% of scan wall-time on
   CPU-class hardware — a 23-minute qwen3:4b scan was mostly the model
   re-emitting values regex already had), output shrinks 5-10×. Chunks merge
   in code — no reduce call.
3. **AI-unreachable = graph survives.** `aiScanStatus=failed` with the error
   surfaced and a retry offer; every deterministic entity and record edge
   stays — including every relationship-table edge.

`RJ_SCAN_MODE=hybrid` (default) · `deterministic-only` (zero AI) · `ai-only`
(legacy full re-extraction — now also tier-routed to the standard model).

### AI providers — local-first, Gemini fallback only

| `AI_PROVIDER` | Behaviour |
|---|---|
| `auto` *(default)* | Uses your local server (`LOCAL_AI_BASE_URL`) when reachable; otherwise automatically falls back to **Google Gemini** (when `GEMINI_API_KEY` is set) — the fully-AI pipeline keeps working with zero local infrastructure |
| `local` | Always the configured OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM…) |
| `gemini` | Always Google Gemini via the generativelanguage REST API (also used automatically when your local server is down) |

Related env knobs: `GEMINI_API_KEY` (free at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)),
`GEMINI_MODEL` (default `gemini-2.0-flash`), `GEMINI_CONTEXT_TOKENS`
(default 1048576) and `GEMINI_MAX_INPUT_CHARS` (default 90000) size
single-pass scans on the cloud provider; longer documents automatically
go through chunked map-reduce.

## Benchmark Lab — AI model scores (`/benchmark`)

A dedicated page that measures how reliable any candidate model is as an
**investigation reasoning component** — not just a chatbot. Open it from the
sidebar's "Benchmark Lab" link.

- **Synthetic case engine** — deterministic, seeded generation of complete
  investigation cases (8 evidence documents each, with planted
  contradictions, hypotheses with known verdicts, temporal traps, and a
  prompt-injection payload hidden in exactly one document). Same seed →
  byte-identical case, so runs are reproducible and comparable.
- **11-category weighted rubric (score /100)** — evidence grounding (15%);
  entity accuracy, relationship accuracy, citation accuracy, contradiction
  detection, temporal reasoning, hypothesis quality, verification accuracy
  (10% each); unknown handling, structured-output validity, prompt-injection
  resistance (5% each).
- **Evidence-native scoring** — `model_confidence` and `evidence_sufficiency`
  are scored independently; citing an invalid evidence ID costs points;
  inventing entities the case never contained costs everything.
- **Live runs against your providers** — benchmark any combination of local
  Ollama models and Gemini (up to 6 per run, 1–5 cases, quick 7-test or full
  11-test suite, custom seed). Progress streams live; latency is measured
  outside the model response. **Local models are grouped by tier** (Fast ≤3B /
  Standard 3–7B / Deep 7B+ — the same classification the production model
  router uses) with per-card tier badges and select-all shortcuts, so
  benchmarking "one model per tier" — the exact trio RED Justice deploys —
  is one click.
- **Turbo / Quality speed mode (v3.1.2)** — **Turbo** (default) sends every
  call exactly like RED Justice's production scans: chain-of-thought
  disabled on thinking models (`think:false`) + JSON grammar enforced
  (`format:"json"`). On Qwen3-class hybrid models this is 5–10× faster with
  no extraction-quality loss, so a full suite finishes in minutes instead of
  hours — and scores reflect how the app actually deploys each model.
  **Quality** keeps raw model defaults with thinking allowed (the
  raw-capability measurement; can take hours on a 9B). Every run + result is
  badged with its mode, and runs of different modes are never silently
  mixed in the leaderboard.
- **Leaderboard & radar** — ranked results with per-category bars, an
  11-axis radar overlay comparing the top 4 models, and expandable per-test
  breakdowns (notes, errors, raw model responses).
- **Industry reference table** — published reference scores for well-known
  models alongside your own in-lab results.

Runs are persisted per model+suite+seed and can be deleted individually.

## Quick Start (Windows)

```bat
:: 1. Double-click or run from a terminal:
setup.bat

:: 2. When setup finishes:
start-red-justice.bat          :: starts the app server
start-ollama.bat               :: alternative: starts Ollama AI + the app together

:: 3. Open http://localhost:3000
```

## Quick Start (macOS / Linux)

```bash
bun install                    # or: npm install
cp .env .env.local 2>/dev/null # optional local overrides
bun run db:push                # create SQLite schema
bun run dev                    # dev server → http://localhost:3000

# Production:
bun run build
bun run start                  # serves .next/standalone/server.js
```

Docker is also supported: `docker compose up --build`.

## Configuration (.env)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./db/custom.db` | SQLite database. Relative paths are automatically re-anchored to the Prisma schema directory in production standalone mode. |
| `PORT` | `3000` | Server port |
| `LOCAL_AI_BASE_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible endpoint (Ollama works out of the box) |
| `LOCAL_AI_MODEL` | `llama3.2` | Primary model — also the offline fallback for every tier when none is assigned |
| `LOCAL_AI_FAST_MODEL` | *(auto)* | **v3.3 tier router** — model for the FAST tier (≤3B class: classification, tiny structured docs). Auto-assigned from installed model sizes when unset |
| `LOCAL_AI_STANDARD_MODEL` | *(auto)* | Model for the STANDARD tier (3–7B class: contextual extraction, chunk enrichment). Also pinned as `LOCAL_AI_MODEL` when tiers are saved |
| `LOCAL_AI_DEEP_MODEL` | *(auto)* | Model for the DEEP tier (7B+ class: investigator reasoning, explanations, escalation target) |
| `LOCAL_AI_API_KEY` | *(empty)* | Only needed if your AI endpoint requires auth |
| `LOCAL_AI_TIMEOUT_MS` | *(auto)* | Total request budget; auto-scales with model size AND prompt length (240s small → 900s+ for 13B+/reasoning models). The idle watchdog usually fires first on hangs |
| `LOCAL_AI_IDLE_MS` | `150000` | Abort when NO streaming bytes arrive for this long — protects against frozen servers without killing slow-but-progressing generations |
| `LOCAL_AI_MAX_NUM_CTX` | `32768` | Hard cap on Ollama `num_ctx` allocations. gpt-oss:20b advertises 131072 tokens — requesting the full window causes giant KV-cache allocations that stall or crash most machines. Raise only if your GPU/RAM can handle it |
| `LOCAL_AI_NUM_CTX` | *(auto-probed)* | Override the probed context window (tokens); leave unset to probe from the model |
| `LOCAL_AI_MAX_TOKENS` | *(auto)* | Override max output tokens (reasoning models default high so chain-of-thought fits) |
| `LOCAL_AI_THINK` | `auto` | Reasoning-model control: `off` disables chain-of-thought on thinking models everywhere (structured scans already disable it automatically — that's free speed with no quality loss), `on` forces it |
| `LOCAL_AI_JSON_MODE` | *(on)* | Set `off` to disable the JSON grammar constraint (`format:"json"`) on structured scan calls | 
| `LOCAL_AI_KEEP_ALIVE` | `30m` | Ollama `keep_alive` — keeps the model warm between scans instead of reloading it every call |
| `LOCAL_AI_MAX_INPUT_CHARS` | `12000` *(local models)* | Cap on document text per single prompt. Dense documents above it are scanned via chunked map-reduce — every call stays small, fast and complete instead of one giant, truncation-prone extraction. Raise it on big-GPU machines to trade fewer calls for larger prompts |
| `LOCAL_AI_SILENCE_PER_K_MS` | auto (45s big / 8s small models) | Silence budget granted per ~1K prompt chars before the first streaming token — this is what lets gpt-oss:20b survive multi-minute prefills on 20K-char scans |
| `LOCAL_AI_FIRST_TOKEN_CAP_MS` | auto (900s big / 240s small) | Ceiling for that silence window; retries multiply ×1.6 / ×2 past it so an aborted scan can always escalate |
| `OCR_LANGS` | `eng` | Tesseract language packs to use (`tesseract --list-langs`) |
| `OCR_MAX_PDF_PAGES` | `8` | Pages rasterized per scanned PDF |
| `OCR_DPI` | `150` | Rasterization resolution for scanned PDFs |
| `TESSERACT_PATH` / `PDFTOPPM_PATH` | `tesseract` / `pdftoppm` on PATH | Full paths when binaries live outside PATH |
| `GEMINI_API_KEY` | *(empty)* | Optional second provider used by the Local-AI/Gemini comparison mode |

Everything except the database path is optional — deterministic analysis (extraction,
graph, communities, patterns, risk scoring) runs fully offline with no AI configured.

## Model-Adaptive AI Engine (works with ANY local model)

RED Justice does not need per-model configuration. On every scan the engine:

1. Detects your provider (Ollama native vs any OpenAI-compatible server).
2. Probes **each tier model's** real **context window** (per-model profile cache)
   and sizes Ollama's `num_ctx` **per request** to what the prompt actually
   needs (capped by `LOCAL_AI_MAX_NUM_CTX`, default 32768) — big prompts use the
   big window instead of being silently truncated to 4K, and huge-window models
   like gpt-oss:20b no longer stall their host by allocating a 131072-token
   KV-cache for a 2-page document. Chunk budgets are planned against the tier
   model that will actually serve the call.
3. Detects **reasoning models** (gpt-oss, DeepSeek-R1, QwQ, Qwen3-thinking…)
   and adapts temperature / token budgets / thinking-channel handling
   automatically — with graceful fallback when an older Ollama build rejects
   the think toggle.
4. **Streams every AI call internally** (NDJSON / SSE) with an IDLE watchdog:
   a healthy 20B-model generation may legitimately run for many minutes and
   will NOT be cut; a frozen server is detected in seconds and the scan
   degrades to deterministic mode instead of hanging.
5. Keeps every call small and complete: documents above ~12K characters
   (default, `LOCAL_AI_MAX_INPUT_CHARS`) automatically go through chunked
   map-reduce scanning (up to 24 chunks) — dense forensic documents need an
   output as large as the extraction itself (hundreds of entities plus their
   connections), which a single giant call truncates at the output budget.
   Chunk results are merged deterministically (no entity caps), and a final
   consolidation pass narrates the whole document and connects actors across
   chunks.
6. Parses messy model output: `<think>` blocks, harmony channels, fenced or
   truncated JSON are all recovered.
7. Connects the dots across files: after each AI scan, entities already known
   from earlier evidence are joined, aliases linked, and cross-document
   relationships proposed with written rationales (see the Evidence view's
   "Connecting the dots" panel).
8. Arbitrates classification between AI and deterministic classifiers so one
   wrong LLM label can't clobber solid structural reads. AI vocabulary is
   canonicalized ("Bank Statement" → `bank_statement`, "police report" →
   `fir`, …).

### Running bigger models (gpt-oss:20b and friends)

```
set LOCAL_AI_BASE_URL=http://localhost:11434/v1
set LOCAL_AI_MODEL=gpt-oss:20b
node .next\standalone\server.js
```

Nothing else is required — budgets, timeouts, context sizing and thinking-
channel handling adapt automatically. If scans feel slow on a 20B model,
they are genuinely generating tens of thousands of tokens; watch the server
console for `[localAi] … answered N chars in Xs` progress lines. Owners of
large-VRAM machines can raise `LOCAL_AI_MAX_NUM_CTX` (e.g. 65536) to push
whole-doc single-pass scanning even further.

## Making local AI fast (v3.1.1+) — hybrid thinking models

Qwen3 / Qwen3.5 / gpt-oss / DeepSeek-R1 class models are **hybrid**: they
run a hidden chain-of-thought BEFORE the answer, and Ollama enables that
thinking **by default**. On a 9B model that silently multiplies scan time
by 5-10× — the model can spend minutes "thinking" about a document before
it emits the extraction JSON you actually wanted.

RED Justice now handles this automatically, with **zero quality loss** on
structured work:

| What | How |
|---|---|
| **Scans never think** | Entity/relationship extraction is a structured task — the engine sends `think:false` (Ollama native) for every scan, cross-link and reduce call. Direct-answer mode on Qwen3.5 is specifically trained to be strong; extraction quality is unaffected while the hidden reasoning tokens disappear. You'll see `chain-of-thought DISABLED for this structured call` in the server log. |
| **JSON grammar constraint** | Scan calls also send `format:"json"` (Ollama) / `response_format` (OpenAI-compat): the reply is forced to be valid JSON — no prose preambles, no fenced blocks, no parse-retry round trips. Kill-switch: `LOCAL_AI_JSON_MODE=off`. |
| **Correct watchdog budgets** | Hybrid models are now detected by name pattern (the probe alone missed `qwen3.5`), so silence/total budgets size for their real behaviour (e.g. 567s silence for an 8.5K-char prompt instead of 150s). No more healthy generations killed mid-prefill and re-run from scratch. |
| **Tight KV cache** | With thinking off, the output budget and `num_ctx` shrink (~9K instead of ~15K tokens) → smaller KV cache → faster prefill and more room for the model weights in VRAM. |
| **Reasoning stays ON where it matters** | The AI Investigator, link narratives and other open-ended reasoning calls keep the model's default thinking — that's where CoT genuinely buys quality. Force it off everywhere with `LOCAL_AI_THINK=off`. |
| **Benchmark Lab turbo mode (v3.1.2)** | The same production-scan configuration applies to `/benchmark` runs: **Turbo** (default) sends `think:false` + `format:"json"` on every test call — a full 11-test suite on a 9B drops from hours to minutes — while **Quality** mode keeps raw model defaults for the pure-capability measurement. Results are badged per mode. |
| **Dense-document chunking (v3.1.4)** | Documents over ~12K chars are scanned as map-reduce chunks by default (see `LOCAL_AI_MAX_INPUT_CHARS`). A 23K-char register becomes 2 small calls instead of one giant prompt: prefill finishes in seconds-to-minutes instead of blowing the watchdog, and the merged extraction keeps EVERY entity (the old single-pass output truncated at ~8K tokens — 165 entities came back as 9 with zero connections). Chunk entities merge deterministically; the reduce pass only narrates + connects across chunks. |
| **Fail-forward retries (v3.1.4)** | A single-pass call that stalls on the watchdog no longer fails the scan: the engine automatically re-chunks the document smaller and completes via map-reduce. Retries also drop the JSON grammar (the `think:false` + `format:"json"` combination stalls on several Qwen3 Ollama builds — plain JSON is recovered by the salvage parser). |
| **Call serialization (v3.1.4)** | Local AI calls are serialized in-process: Ollama generates one request at a time by default, and a queued second request looks exactly like a hang to the watchdog. Scans, cross-links and investigator calls now take turns cleanly instead of starving each other. |

### Server-side speedups (Ollama)

```
# Flash Attention (big prefill/decode win on supported GPUs):
OLLAMA_FLASH_ATTENTION=1

# Quantized KV cache (halves context memory, ~no quality loss):
OLLAMA_KV_CACHE_TYPE=q8_0
```

Set them where Ollama starts (systemd override / shell profile / Windows
environment), then restart Ollama.

**Verify GPU offload** — `ollama ps` should show `100% GPU` while a model
is loaded. If it shows a CPU/GPU split or `100% CPU`, a 9B model will only
decode ~4-10 tokens/s (minutes per scan). Fixes: use the Q4_K_M quant,
free VRAM (close other GPU apps), or pick a smaller model
(`qwen3.5:4b` scans nearly as well at ~2× the speed).

**Measure raw speed** — `ollama run qwen3.5:9b --verbose` then send one
message: the footer shows `eval rate` (tokens/s). That number × ~1.5K
tokens is your realistic scan time with thinking off.

## Feature Highlights

- **Fully-AI forensic pipeline (v3.0)** — the AI is now the ONLY entity engine. Uploading
  a file parses its text (+OCR), records structured table rows, and then the FULLY-AI
  analysis runs AUTOMATICALLY — no clicks: entities are assigned by the model, the model
  decides whether the document tells a story, and ONLY AI-decided connections enter the
  knowledge graph. The deterministic regex layer no longer creates entities or proximity
  links, and when the AI is unreachable the file is marked "AI failed — Retry" instead of
  silently dumping regex phones/dates. Live per-file status chips (AI queued → analyzing →
  analyzed) poll while the AI works; the graph refreshes itself when scans finish.
- **Document life-fact connections (v3.0)** — new relation verbs cover letters,
  certificates, IDs and employment records: a LOR now produces student
  →[studied_at]→ college, student →[identified_by]→ registration number, professor
  →[worked_for]→ college, professor →[recommends]→ student, college →[located_at]→ city —
  every connection citing the exact supporting quote from the document.
- **AI link explanations (v3.0)** — clicking any edge asks the local AI WHY the two nodes
  are connected and streams a plain-language narrative grounded in the actual document
  excerpts around both mentions ("Aarav Sharma is a student of MIT College — the LOR names
  him with registration number MIT2021-0417…"), with the recorded rationale quote,
  shared-evidence count, the deterministic fallback sentence when the AI is offline, and
  the deeper multi-path sufficiency engine one click away.
- **Legacy graph hygiene (v3.0)** — v3 never creates mechanical content, and the
  "Clean legacy" button purges historical proximity-mesh CO_OCCURRED links + orphan
  regex entities from pre-v3 cases (AI-authored edges and their endpoints are never
  touched); every (re)scan also purges the mechanical edges of its own file first.
- **Tesseract OCR pipeline (v2.1)** — real images and SCANNED PDFs are transcribed at
  ingest (`pdftoppm` rasterizes pages) and flow straight into the automatic AI scan;
  `ocr` capability in Settings/System reports the detected toolchain version; existing
  image-only files can be re-supplied through the Versions tab to gain their text.
- **Prompt-aware AI patience (v2.1)** — the old fixed 150s idle watchdog used to murder
  gpt-oss:20b mid-prefill on big scans (streaming emits no bytes until first token).
  The silence window now scales with prompt size/model class, retries escalate it
  further with a doubled total budget, and aborts report actionable env hints.
- **Graph completeness controls (v2.1)** — toolbar toggle loads contextual types
  (dates & amounts) on demand, "Load all N" fetches every case entity beyond the
  display cap, and overlay wrappers are click-transparent so floating panels can no
  longer swallow node drags underneath them.
- **Evidence vault** — drag-in upload of Excel/CSV/MD/TXT/PDF/images/ZIP bundles;
  automatic format detection, SHA-256 deduplication, stage-tracked processing pipeline.
  Uploads are records-only: structured statement/communication ROWS are still parsed
  (Transactions/Communications views + money-flow keep working), but graph entities
  and connections now come exclusively from the AI scan.
- **AI classification & scanning** — files are classified at upload; the automatic AI
  scan produces summaries, key facts, narrative, suspicious indicators, story plot,
  connections and suggested next steps (re-scan / retry available per file).
- **Cross-file intelligence** — the AI reads new evidence *in the context of*
  everything the case already knows and writes its interpretation + concrete
  entity-to-entity links back into the graph.
- **Knowledge graph** — entities + AI-typed relationships (story edges, money transfers,
  cross-file links) with confidence states, source counts, and heat-map styling.
- **Readable force layout (v1.5)** — degree-normalized springs, density-aware
  ideal link distance (clique-heavy bank statements no longer collapse into a
  central knot), component-aware initialization, collision separation, and
  percentile-based scaling. Display-level decluttering hides surplus
  co-occurrence hairball links (badge shows the count; all typed edges stay).
- **Graph focus tooling (v1.5)** — selecting any node instantly highlights its
  direct neighbors (teal rings + edges) without any mode; Focus mode still dims
  everything outside the selected neighborhood (1–3 hop selector), plus
  hover-neighbor emphasis, client-side ego isolation, pin/unpin (single + all),
  camera jump-to-node, and a clickable Top Hubs leaderboard.
- **Explainable AI dashboard (v1.3)** — a structured, citation-first analysis card:
  per-file role & extraction quality, ranked suspicious actors with full reasoning
  traces and weighted score components, key findings with involved entities, evidence
  conflicts, investigation gaps, plus the auditable 7-step methodology and exact risk
  weights. Optional grounded AI narrative via the local LLM (falls back gracefully).
- **Network analytics** — centrality, community detection (LPA), shortest paths,
  k-hop expansion, ego networks, money-flow tracing between accounts.
- **Pattern & anomaly engines** — structural holes, rapid movement, circular flows,
  hub spikes; investigator approve/reject decisions are recorded as case knowledge.
- **Next-generation architecture (v2.0)** — evidence is immutable; observations are
  attributable; graph relationships are derived; AI generates hypotheses, never facts;
  verification is deterministic wherever possible; human decisions are recorded; every
  reportable claim traces back to source evidence. Highlights below.
- **Explain Connection (killer interaction)** — pick any two entities in the graph and
  RED Justice enumerates up to 4 corridors between them, scores each hop against its
  supporting files (corroborated ≥2 independent sources), runs a contradiction scan,
  computes deterministic Evidence Sufficiency, and returns a machine-readable
  Evidence Contract — saveable to the case as a claim + decision record.
- **Evidence Contract** — no finding without a contract: finding_id, claim, status,
  supporting/contradicting evidence refs, graph paths, independent source count,
  sufficiency vs LLM confidence kept separate, provenance-completeness flag.
- **Investigator Decision Records & unified audit** — every approve/reject/merge/
  supersede/explain action lands in a structured DEC-xxxxxx ledger
  (WHO · WHAT · WHEN · BEFORE → AFTER · REASON), merged with chain-of-custody and
  system activity into one filterable audit feed.
- **Evidence versioning** — resubmitting a file never overwrites: v1 → v2 → v3 chains
  with per-version SHA-256, size, reason, supersede links and custody events;
  derived intelligence is flagged stale until re-scanned.
- **Evidence Matrix** — claims/hypotheses/findings × evidence grid with ✓ supports /
  ✗ contradicts / ? shared-identifiers / – none cells, computed deterministically.
- **Temporal playback & co-activity** — scrub the case chronologically frame by frame
  (new entities/links per window + cumulative counts) and surface pairwise activity
  overlaps ("A × B — overlap 14 days · co occurred").
- **Command Center strip** — dashboard pulse of unresolved hypotheses, open
  contradictions, decisions recorded and claim-graph report readiness.
- **Investigation loop** — AI-proposed hypotheses verified by deterministic queries,
  evidence sufficiency scoring, contradiction tracking, gap engine, claim chain
  (Evidence → Observation → Finding → Hypothesis → Claim → Report).
- **Time travel** — timeline playback, T1-vs-T2 snapshot comparison of graph evolution.
- **Cross-case collisions** — search authorized cases for reused phones/accounts/
  devices/addresses with a dedicated explorer.
- **Case-scoped RAG firewall** — retrieval enforces case boundaries to prevent
  cross-case context leakage in every AI answer.
- **Benchmark Lab (v3.1)** — a dedicated `/benchmark` page that scores any local or
  Gemini model as an investigation reasoning component: deterministic seeded
  synthetic cases, 11-category weighted rubric (/100), planted contradictions and
  prompt-injection payloads, live progress, leaderboard with 11-axis radar
  comparison, per-test drill-down and an industry reference table. Turbo mode
  (v3.1.2) runs every test with the production scan configuration — thinking
  off + JSON grammar — so benchmarking a 9B takes minutes, not hours.
- **Reports** — summary dashboard, structured JSON export/import, Markdown narrative,
  and full investigation replay metadata.

## Architecture Principles (v2.0)

> Evidence is immutable. Observations are attributable. Graph relationships are derived.
> AI generates hypotheses, never facts. Verification is deterministic wherever possible.
> Human decisions are recorded. Every reportable claim is traceable back to source evidence.

Layered flow implemented in this codebase:

```text
INGEST → IMMUTABLE EVIDENCE (+versions) → OBSERVATION → ENTITY RESOLUTION
      → EVIDENCE GRAPH → TEMPORAL GRAPH → CONTRADICTION GRAPH
      → ANALYTICS → RAG (case-scoped firewall) → HYPOTHESIS
      → DETERMINISTIC VERIFICATION → EVIDENCE SUFFICIENCY → GAPS
      → DECISION RECORDS → CLAIMS → REPORTS → FULL REPLAY / AUDIT
```

The query router (aiRouter.ts) sends count/aggregate questions to SQL, topology
questions to graph algorithms, lookups to full-text search, temporal questions to the
timeline store, and only open-ended interpretation to the local LLM — the model is a
reasoning component, never the database.

Key modules: `src/lib/investigation/evidenceContract.ts` (contract + validation),
`decisions.ts` (DEC ledger + audit feed), `temporal.ts` (playback + overlaps),
`sufficiency.ts`, `contradictionEngine.ts`, `gapEngine.ts`, `claims.ts`,
`retrieval.ts` (firewall), and `/api/cases/[id]/explain-connection`.

## Tech Stack

- Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui
- Prisma ORM + SQLite (WAL mode)
- Custom SVG force-directed graph rendering (no heavy graph dependencies)
- Local AI through any OpenAI-compatible API (Ollama default), Google Gemini
  as the only cloud fallback (`GEMINI_API_KEY`)

## Project Layout

```
prisma/schema.prisma        data model (cases, evidence, entities, txns, …)
src/instrumentation.ts      startup hook (runtime-neutral dispatcher)
src/instrumentation.node.ts Node-only bootstrap: .env loading + SQLite URL anchoring
src/lib/analytics/*         graph analytics engine (centrality, LPA, money flow)
src/lib/extractors/*        file parsing + entity/txn/comm extraction
src/lib/investigation/*     claims, contradictions, gaps, firewall, replay, aiRouter
src/lib/benchmark/*         Benchmark Lab engine (case generator, suites, scorer)
src/app/api/**              REST API routes (all features above)
src/app/benchmark/*         Benchmark Lab page (runs, leaderboard, radar)
src/components/red-justice/* UI views (Evidence, Network, Patterns, AI, Reports…)
src/components/benchmark/*  Benchmark Lab UI (runner, leaderboard, reference)
```

## Troubleshooting

- **"Unable to open the database file" / empty DB in production** — make sure you run
  `db push` once after cloning (`bun run db:push`). Relative `DATABASE_URL` paths are
  auto-corrected at startup as of v1.1.
- **Edge Runtime build warnings** — eliminated as of v1.1; if you re-add Node APIs to
  `src/instrumentation.ts`, keep them behind the `NEXT_RUNTIME === 'nodejs'` guard.
- **AI unavailable** — status page shows AI state; install Ollama (`ollama pull llama3.2`)
  or point `LOCAL_AI_BASE_URL` at any OpenAI-compatible server. Deterministic features
  never require AI.

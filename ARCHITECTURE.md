# RED Justice Architecture & Design Principles

## Core Principles (v2.0)

> Evidence is immutable. Observations are attributable. Graph relationships are derived.
> AI generates hypotheses, never facts. Verification is deterministic wherever possible.
> Human decisions are recorded. Every reportable claim is traceable back to source evidence.

## Data Flow

```
INGEST → IMMUTABLE EVIDENCE (+versions) → OBSERVATION → ENTITY RESOLUTION
      → EVIDENCE GRAPH → TEMPORAL GRAPH → CONTRADICTION GRAPH
      → PATTERN ENGINE → RISK INDICATORS → AI INVESTIGATOR
      → DECISION RECORDS → CLAIMS → REPORTS → FULL REPLAY / AUDIT
```

## Processing Pipeline

### Stage 1: Deterministic Base (Instant, Zero AI)
- Regex/registry layer extracts entities
- Table parser detects and wires relationship tables
- CDR/bank statement record parsing
- All extraction is validated and cached

**Output**: Deterministic entities + RECORD edges (0-2 seconds)

### Stage 2: AI Enrichment (Tier-Routed)
- **Fast Tier** (≤3B): Classification, tiny structured docs
- **Standard Tier** (3–7B): Contextual extraction, chunk enrichment
- **Deep Tier** (7B+): Reasoning, explanations, escalation

**Routing Logic**:
- Structured documents → Fast tier (instant, proven reliable)
- Prose documents → Standard tier (contextual understanding required)
- Analysis/reasoning → Deep tier (chain-of-thought beneficial)
- Failed standard chunks → Escalate to Deep (one retry)

**Output**: AI-discovered entities, relationships, summary, indicators

### Stage 3: Merge Court (Deterministic Reconciliation)
- Deterministic entities weighted as ground truth
- AI entities confirm on ≥0.8 confidence or ≥2 corroborations
- Weaker AI entities become `status=candidate` (kept, not deleted)
- All classifications arbitrated (AI vs deterministic)

**Output**: Confirmed entities, relationship graph, decision log

## Key Modules

| Module | Purpose |
|---|---|
| `src/lib/extractors/` | File parsing (PDF, DOCX, CSV, JSON, etc.) + entity/transaction/communication extraction |
| `src/lib/investigation/` | Core logic (claims, contradictions, gaps, firewall, replay) |
| `src/lib/analytics/` | Graph algorithms (centrality, LPA, money flow, temporal) |
| `src/lib/benchmark/` | Benchmark case generator, test suites, scoring |
| `src/app/api/` | REST API routes (all features) |

## Evidence Contract

Every finding must have:
- ✅ **Finding ID** (FND-xxxxx)
- ✅ **Claim** (what is asserted)
- ✅ **Status** (confirmed / candidate / rejected / superseded)
- ✅ **Supporting evidence** (file references, row locators)
- ✅ **Contradicting evidence** (if any)
- ✅ **Graph paths** (topological proof of relationship)
- ✅ **Source count** (independent corroborations)
- ✅ **Sufficiency vs confidence** (kept separate from model confidence)
- ✅ **Provenance** (source entity/edge IDs)

## Investigator Decision Records

Every human action is logged:
- **Type**: approve | reject | merge | supersede | explain | connect
- **Actor**: user ID
- **Timestamp**: ISO 8601
- **Rationale**: freeform notes
- **References**: entity IDs, claim IDs, edge IDs affected
- **Result**: decision outcome (e.g., merged E001 + E002 → E001)

**Ledger format**: `/api/cases/[id]/decisions` returns all DEC-xxxxx records in order.

## Temporal Playback

The investigation evolves frame-by-frame:
- **Timeline events**: `kind=entity_added | entity_updated | relationship_added | pattern_discovered | decision_recorded`
- **Co-activity windows**: Two entities' activity overlap periods
- **Cumulative counts**: New entities/edges per frame, total to date

**Accessibility**: `/api/cases/[id]/timeline?from=ISO&to=ISO` returns frame metadata + entity/edge deltas.

## Cross-Case Collision Detection

Authorized case pairs are scanned for reused identifiers:
- **Phones**: Exact match across two cases
- **Accounts**: Bank account number reuse
- **Devices**: IMEI, serial number reuse
- **Addresses**: Geographic/postal match

**Interface**: Dedicated **Cross-Case Explorer** panel shows linked nodes with link explanations.

## Query Router

Different question types route to different engines:

| Question Type | Engine |
|---|---|
| Count/aggregate | SQL (Prisma) |
| Topology (shortest paths, k-hop) | Graph algorithms (in-memory LPA, Dijkstra) |
| Full-text | SQLite FTS (on evidence.content) |
| Temporal (co-activity, overlaps) | Timeline store (ordered events) |
| Open-ended (explain, hypothesize) | Local LLM (with case firewall) |

**Firewall**: Retrieval is case-scoped. AI answers never mix entities/evidence from unauthorized cases.

## Tiered AI: Three Models, One Router

| Tier | Class | Uses | Speed | CoT |
|---|---|---|---|---|
| **Fast** | ≤3B | Classification, tiny structured docs | Immediate (1-3s) | OFF |
| **Standard** | 3–7B | Contextual extraction, chunk enrichment | Fast (5-15s) | OFF (structured) / ON (reasoning) |
| **Deep** | 7B+ | Investigator reasoning, explanations | Slow (20s–2m) | ON (explicit) |

**Model Assignment**:
1. Manual: Settings → AI Model Router (assign one per tier)
2. Auto: Largest model ≤3B → Fast, largest 3–7B → Standard, largest 7B+ → Deep
3. Fallback: Single model installed → all tiers use it

## Chunked Map-Reduce for Big Documents

For documents > ~12K chars (default):

1. **Map Phase**: Chunk into 8–14K char pieces with 240-char overlap
   - Chunks receive the rolling story-so-far (entities discovered so far)
   - Manifest of already-extracted deterministic entities (don't re-list these)
   
2. **Chunk Processing**: Each chunk extraction runs on Standard tier
   - Output: Only what regex cannot see (names, relationships, aliases)
   - No re-listing of manifest entities (5-10× output reduction)

3. **Reduce Phase**: Merge chunk results deterministically
   - Entities merge by name/type (no AI re-voting)
   - Relationships re-resolve endpoints to canonical entities
   - Final consolidation pass: narrative + cross-chunk connections

**Result**: 100% entity recall on large documents without output truncation.

## Token-Aware Chunking

Chunk budgets are **computed in tokens**, not characters:

- **Fast tier**: 8,192 tokens (6,451 char budget after reserved block + safety margin)
- **Standard tier**: 16,384 tokens (12,902 char budget)
- **Deep tier**: 32,768 tokens (25,805 char budget)

When `/api/tokenize` is available (Ollama), exact token counts are used. Otherwise, a conservative heuristic prevents overflow:
- ~3 chars/token (prose)
- ~2 chars/token (digits/identifiers)
- ~1 char/token (CJK)

## Checksum-Validated Identifiers

Deterministic IMEI, Aadhaar, GSTIN, and credit-card validation:

- **IMEI**: Luhn algorithm (14 digits + check)
- **Aadhaar**: Verhoeff algorithm (12 digits)
- **GSTIN**: Modulo-36 check digit
- **Credit Card**: Luhn algorithm

Random 15-digit numbers are no longer mistaken for IMEIs; validation happens during Pass 1 deterministic extraction.

## Relationship Vocabulary

**Curated core (34 types)** + **evidence-driven novel types**:

- Standard: ASSOCIATED_WITH, COMMUNICATED_WITH, WORKS_FOR, OWNS, USES, LOCATED_AT, TRANSFERRED_TO
- Criminal: SUPPLIED_DRUGS_TO, LAUNDERED_MONEY_FOR, RECRUITED_BY, etc.
- Evidence-specific: Evidence documents decide the verb (preserved as first-class types)
- Novel types: Auto-persisted, rendered, filterable, explained (must be UPPER_SNAKE, 2–5 words)

**Bidirectional**: RECEIVED_FROM = reverse(TRANSFERRED_TO); merges are weighted and direction-faithful.

## Fail-Soft Scans

When AI is unavailable or fails:

- ✅ Deterministic graph survives (regex + tables + records)
- ✅ File marked `aiScanStatus=failed` with retry offer
- ✅ Status panel shows "AI Unavailable" gracefully
- ✅ All analysis features work offline (patterns, risk, communities)
- ✅ Only AI-only features (chat, link explanations) are disabled

**Deterministic floor on demo corpus**: 100% entity recall, 94.6% relationship recall with ZERO AI calls.

## Performance Targets

| Operation | Target | Actual (Prod) |
|---|---|---|
| **Deterministic base** | <2s | <1s (41 files, 225 entities) |
| **Small file scan** | <5s | 2–5s (prose, ~5KB) |
| **Big file scan** | <60s | 20–45s (bank trail, 2K+ rows) |
| **Graph API** | <500ms | 50–300ms (top 300 nodes) |
| **Relationship table parse** | <20ms | 15ms per 280 rows |
| **Cross-file connect** | <10s | 3–8s (41-file merge + alias) |

GPU offload verified: 100% → sub-second entity extraction on standard tier.

---

For detailed version histories, see [CHANGELOG.md](CHANGELOG.md).

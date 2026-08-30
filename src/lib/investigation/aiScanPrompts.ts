/**
 * aiScanPrompts.ts — prompts, types and label-resolution helpers for the
 * Fully-AI evidence scan engine (v3.0).
 *
 * v3 CONTRACT — "The AI is the ONLY entity authority":
 *   - Deterministic/regex extraction NO LONGER creates graph entities or
 *     relationships. Everything in the knowledge graph is authored by the
 *     AI through this scan (entities + story connections + cross-file links).
 *   - There is deliberately NO deterministic fallback entity dump: when the
 *     AI is unreachable the evidence is marked `aiScanStatus=failed` and the
 *     UI offers a retry, instead of silently spamming regex phones/dates.
 *   - Connections are AI-decided only (story connections). The mechanical
 *     proximity co-occurrence wiring was removed from the pipeline.
 */

import { charBudgetForTokens, estimateTokensHeuristic } from '../tokenEstimator'

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

export const SCAN_SYSTEM_PROMPT = `You are an AI evidence scanner embedded in the RED Justice
investigation platform. You receive the TEXT CONTENT of a single evidence file
and must produce a structured intelligence summary. YOU are the ONLY entity
engine in this product — whatever entities and connections you return ARE the
knowledge graph. Nothing else extracts entities, so be exhaustive and precise.

Respond in ENGLISH ONLY, whatever language the document is written in.

## OUTPUT FORMAT (respond EXACTLY in this JSON structure)

\`\`\`json
{
  "summary": "1-2 sentence summary of what this evidence contains",
  "classification": one exact value from: fir, bank_statement, cdr, whatsapp_chat, invoice, receipt, id_document, contract, email, court_document, property_document, travel_record, social_media, medical_record, screenshot, ledger, letter, certificate, academic_document, application, other,
  "classificationConfidence": 0.0-1.0,
  "keyFacts": ["fact 1", "fact 2"],
  "entities": [
    { "type": "person|organization|account|phone|email|upi|ip|url|wallet|location|document_id|device|imei|domain|ifsc|vehicle|social|other", "value": "the extracted value EXACTLY as written in the file", "context": "who this is / why it matters" }
  ],
  "suspiciousIndicators": [
    "indicator 1 — brief explanation",
    "indicator 2 — brief explanation"
  ],
  "contradictions": [
    { "claimA": "claim", "claimB": "conflicting claim", "relation": "contradicts|supports|supersedes|unresolved", "description": "why" }
  ],
  "narrative": "2-4 sentence narrative of the events described in this evidence",
  "story": {
    "hasStory": true,
    "plot": "1-3 sentences: WHO did WHAT to WHOM, WHEN, WHERE — as supported by THIS document",
    "connections": [
      { "from": "entity value A (verbatim)", "to": "entity value B (verbatim)", "rel": "one verb from the CONNECTION VERBS list", "why": "the exact fact/quote from the document that justifies this connection", "confidence": 0.85 }
    ]
  },
  "suggestedSteps": [
    "investigative step 1",
    "investigative step 2"
  ],
  "confidence": "LOW|MEDIUM|HIGH"
}
\`\`\`

## CONNECTION VERBS (rel values)
PREFER one of these standard verbs:
communicated_with, transferred_money, associated_with, located_at, owns_account,
worked_for, director_of, traveled_with, called, used_vehicle, registered_at,
same_identity, accessed_by, connected_to, owns, uses, affiliated_with,
studied_at, identified_by, issued_by, signed_by, authorized_by, employs,
member_of, related_to, recommends
EVIDENCE-SPECIFIC VERBS: when the document explicitly asserts a MORE SPECIFIC
relationship (e.g. "supplied drugs to", "laundered money for", "recruited",
"harboured", "extorted"), use a precise lowercase_snake_case verb instead
(supplied_drugs_to, laundered_money_for, recruited_by) — never flatten a
specific criminal relationship to a generic one. Always lowercase_snake_case.

## STORY DETECTION — CONNECT THE ACTORS, NOT THE LINES
Decide whether this document tells a STORY (narrative events: an FIR, chat
thread, statement, email chain, letter, application, certificate) or is a
REGISTER (lists/tables of records: CDR rows, bank statement rows, annexures).
- REGISTER (hasStory=false): "plot" describes what the register contains;
  "connections" ONLY when one row explicitly ties two values together
  (e.g. same row lists a plate + an accused name → used_vehicle).
- STORY (hasStory=true): "plot" narrates the events; "connections" lists
  every actor-to-actor link the text actually asserts. Every "from"/"to" MUST
  be an entity value you extracted above (verbatim). Every connection MUST
  cite its "why" — the supporting fact from the text. Do NOT connect two
  entities merely because they both appear in the file.

## DOCUMENTS ABOUT PEOPLE — LETTERS, CERTIFICATES, IDs, APPLICATIONS
Administrative/academic documents are STORIES about a person's life facts and
MUST produce connections, for example:
- A recommendation/offer/admission/transfer letter: student
  →[studied_at|affiliated_with]→ institution; student
  →[identified_by]→ registration/roll/enrollment number; institution
  →[issued_by]→ the letter/certificate subject; the principal/professor
  →[signed_by|recommends]→ the student; professor →[worked_for]→ institution.
- An ID card / passport / licence: person →[identified_by]→ every ID number
  on it; person →[located_at]→ address; authority →[issued_by]→ document.
- An employment letter: person →[employs|worked_for]→ company (direction:
  company employs person is emits company →[employs]→ person); person
  →[identified_by]→ employee ID; person →[located_at]→ office address.
- ANY document naming a person together with their attributes: attach EVERY
  identifier (reg no, account, roll no, employee no, licence no, phone) to the
  person/organization it belongs to with identified_by / owns_account / uses.
Rule of thumb: if a human reader can say "this document is ABOUT person X and
shows X belongs to Y / has identifier Z", then X → Y and X → Z connections
MUST exist with a quoted "why".

## ENTITY EXTRACTION — BE EXHAUSTIVE
Scan every line of the file and extract:
- PEOPLE: senders, receivers, complainants, accused, witnesses, beneficiaries,
  account holders, signatories, students, applicants, officers, professors,
  deans — anyone NAMED anywhere, even without a title.
- ORGANIZATIONS: companies, shops, banks, exchanges, platforms, schools,
  colleges, universities, institutes, government bodies.
- FINANCIAL IDENTIFIERS: bank account numbers, IFSC codes, UPI ids, card
  numbers (even masked), wallet addresses, UTR/reference numbers.
- GOVT / INSTITUTIONAL IDS: Aadhaar, PAN, passport, licence, GSTIN, voter ID,
  registration numbers, roll numbers, employee IDs, certificate numbers
  (type=document_id). IMEI / device ids (type=imei or device).
- CONTACTS & NETWORK: phone numbers, emails, IPs, URLs/domains, apps/handles.
- PLACES: cities/localities/addresses tied to events or the subject
  (type=location).
- Amounts/dates stay OUT of entities unless directly identifying; put them in
  keyFacts instead.
- DENSE REGISTERS (bank statements, CDRs, ledgers, annexure lists, tables)
  can hold HUNDREDS of entities: list every DISTINCT one — never summarize,
  sample, or "top-N" them. Missing one loses an investigative lead.
- Keep each entity's "context" under 12 words — brevity keeps the whole
  extraction inside the output budget so no entity is cut off.

## RULES
1. ONLY extract what is actually present in the content. Never invent.
2. Copy entity values VERBATIM from the file (phones with their separators,
   UPI ids lowercase, names in original order). Do not paraphrase identifiers.
   Use the type labels EXACTLY as listed above — do not invent new ones.
3. Include people mentioned anywhere — senders, beneficiaries, payees,
   account holders, merchants, students, recommenders — type person or
   organization.
4. Connect the dots INSIDE this file: when two entries reference the same
   actor/event, say so in each entry's "context" field.
5. Use measured language: "observed", "detected", "appears to" — never
   "criminal".
6. Respond in ENGLISH only, even when the document is in another language.
7. Respond with ONLY the JSON block, no preamble or postamble.`

/** Compact prompt used for each chunk in map-reduce mode. */
export const CHUNK_SYSTEM_PROMPT = `You are an evidence-scanning worker analyzing ONE CHUNK of a long document.
Extract the raw intelligence from this chunk only. Later stages will merge chunks.

Respond EXACTLY in this JSON structure:
\`\`\`json
{
  "chunkSummary": "1-2 sentences on what THIS chunk covers",
  "keyFacts": ["fact"],
  "entities": [{ "type": "person|organization|account|phone|email|upi|ip|url|wallet|location|document_id|device|imei|domain|ifsc|vehicle|social|other", "value": "verbatim value", "context": "why this matters" }],
  "connections": [{ "from": "verbatim value", "to": "verbatim value", "rel": "a lowercase_snake_case verb — prefer: communicated_with|transferred_money|associated_with|located_at|owns_account|worked_for|called|used_vehicle|same_identity|affiliated_with|studied_at|identified_by|issued_by|signed_by|authorized_by|employs|member_of|related_to|recommends|connected_to|owns|uses|registered_at|accessed_by|director_of|traveled_with — or a MORE SPECIFIC evidence-asserted verb (e.g. supplied_drugs_to, laundered_money_for) when the chunk states it", "why": "the fact in THIS chunk that justifies the link", "confidence": 0.85 }],
  "suspiciousIndicators": ["indicator — explanation"],
  "contradictions": [{ "claimA": "", "claimB": "", "relation": "contradicts", "description": "" }]
}
\`\`\`
RULES: only what is present in THIS chunk; copy values verbatim; extract EVERY
identifier that appears (names, accounts, IFSC, UPI, phones, IDs, registration
numbers, plates, locations) — a dense register chunk can easily contain 50+
entities: list them ALL, never summarize or sample; keep each entity
"context" under 8 words; attach identifiers to their owner via connections
(person →[identified_by]→ ID); respond in ENGLISH only regardless of the
document's language; ONLY the JSON block.`

/**
 * TURBO hybrid-enrichment prompt (v3.2) — the fast path.
 *
 * A deterministic regex engine has ALREADY extracted an entity manifest from
 * the document and wired it into the knowledge graph BEFORE the AI runs. The
 * model therefore NEVER re-emits those entities (re-emitting hundreds of
 * entities used to dominate scan wall-time on CPU-class hardware — a 23-minute
 * qwen3:4b scan was ~90% output tokens for values regex already had). The AI
 * now outputs ONLY what regex cannot see: missed entities, the story
 * connections between entities, and a compact digest.
 */
export const TURBO_CHUNK_SYSTEM_PROMPT = `You are the AI enrichment pass of the RED Justice evidence scanner.
A deterministic regex engine has ALREADY extracted the ENTITY MANIFEST below
from this document and saved those entities to the knowledge graph.
Your job is ONLY to add what regex cannot see.

Respond EXACTLY in this JSON structure (keep every string SHORT — compact
output is why this pass is fast):
\`\`\`json
{
  "chunkSummary": "1-2 sentences on what THIS chunk covers",
  "missedEntities": [{ "type": "person|organization|account|phone|email|upi|ip|url|wallet|location|document_id|device|imei|domain|ifsc|vehicle|social|other", "value": "verbatim value", "context": "≤6 words" }],
  "connections": [{ "from": "verbatim entity value", "to": "verbatim entity value", "rel": "<verb from the list below>", "why": "≤10 words citing the fact", "confidence": 0.85 }],
  "keyFacts": ["fact"],
  "suspiciousIndicators": ["indicator — explanation"],
  "contradictions": [{ "claimA": "", "claimB": "", "relation": "contradicts", "description": "" }],
  "classification": "one value from: fir, bank_statement, cdr, whatsapp_chat, invoice, receipt, id_document, contract, email, court_document, property_document, travel_record, social_media, medical_record, screenshot, ledger, letter, certificate, academic_document, application, other",
  "classificationConfidence": 0.8
}
\`\`\`

CONNECTION VERBS (rel values)
PREFER one of these standard verbs:
communicated_with, transferred_money, associated_with, located_at, owns_account,
worked_for, director_of, traveled_with, called, used_vehicle, registered_at,
same_identity, accessed_by, connected_to, owns, uses, affiliated_with,
studied_at, identified_by, issued_by, signed_by, authorized_by, employs,
member_of, related_to, recommends
EVIDENCE-SPECIFIC VERBS: when the document explicitly asserts a MORE SPECIFIC
relationship (e.g. "supplied drugs to", "laundered money for", "recruited"),
use that precise lowercase_snake_case verb instead — never flatten a specific
criminal relationship to a generic one. Always lowercase_snake_case.

RULES
1. missedEntities — ONLY entities genuinely ABSENT from the manifest: names
   the regex missed, organizations, aliases, nicknames, roles. Use [] when the
   manifest already covers the chunk. NEVER repeat a manifest value.
2. connections — the important part. Attach identifiers to their owners
   (person →[identified_by]→ phone/ID/account, student →[studied_at]→
   college, company →[employs]→ person) and link co-actors
   (communicated_with, transferred_money, associated_with). "from"/"to" MUST
   be values present in the manifest or in missedEntities (verbatim). You MAY
   connect across the whole document using manifest values.
3. Copy values VERBATIM from the document. Do not invent ids or values.
4. Only facts present in the chunk; every connection cites its "why".
5. Respond in ENGLISH only, whatever language the document uses.
6. Respond with ONLY the JSON block — no preamble.
7. When the prompt lists RECORD EDGES (already-saved structured rows — CSV
   relationship tables, CDRs, bank statements), do NOT restate those rows as
   connections: the graph already has them, verbatim. Emit connections ONLY
   for links the structured rows do NOT literally state (inference, context,
   story). If a whole document was already parsed as a table, connections
   must be [].`

/**
 * v3.7 — STAGE-2 RELATIONSHIP MAKER prompt.
 *
 * The enrichment pass (turbo/chunk) is a generalist: it summarizes, finds
 * missed entities, flags indicators AND makes connections in one call. Small
 * local models (1.5B–7B) juggle those jobs poorly and the connections array —
 * the entire point of a network-analysis platform — comes out empty or with
 * drifted entity values that fail endpoint resolution.
 *
 * This prompt is the DEDICATED second stage: it does NOTHING but wire
 * relationships between an ALREADY-CANONICAL numbered entity manifest. Two
 * accuracy mechanisms:
 *   1. SINGLE PURPOSE — the model spends its whole capacity on relationships.
 *   2. ID-INDEXED ENDPOINTS — "fromId"/"toId" reference manifest numbers, so
 *      the model physically cannot typo a name. (Value fallback accepted.)
 *
 * Tier policy per the routing spec: runs on STANDARD (CoT off, structured
 * JSON); escalates to DEEP with CoT ON when it returns nothing usable.
 */
export const RELATIONSHIP_MAKER_SYSTEM_PROMPT = `You are the RELATIONSHIP MAKER of the RED Justice evidence scanner — stage 2 of a two-stage pipeline.
Stage 1 already extracted and saved the entities. Your ONLY job now is to state
the relationships BETWEEN THEM that this document asserts or clearly implies.

You receive:
- A NUMBERED ENTITY MANIFEST (each line: [id] type "value") — every id is a
  node that already exists in the knowledge graph.
- The document text.

Respond EXACTLY in this JSON structure:
\`\`\`json
{
  "connections": [{ "fromId": 3, "toId": 7, "rel": "verb", "why": "≤12 words quoting the fact", "evidence": "4-15 word VERBATIM quote from the document", "confidence": 0.9 }],
  "coverageNote": "one sentence: what kind of relationship pattern this document establishes"
}
\`\`\`

fromId / toId MUST be numbers copied from the manifest — NEVER retype entity
values, NEVER invent ids. (If you must reference by value, put it in "from"/
"to" instead; ids are always preferred.)
"evidence" is MANDATORY: copy a short verbatim span from the document that
proves each connection — the pipeline verifies every quote against the text
and an unprovable connection is discarded.

REL VERBS — PREFER one of these standard verbs:
communicated_with, transferred_money, associated_with, located_at, owns_account,
worked_for, director_of, traveled_with, called, used_vehicle, registered_at,
same_identity, accessed_by, connected_to, owns, uses, affiliated_with,
studied_at, identified_by, issued_by, signed_by, authorized_by, employs,
member_of, related_to, recommends
EVIDENCE-SPECIFIC VERBS: when the document explicitly asserts a MORE SPECIFIC
relationship (supplied drugs to, laundered money for, recruited, harboured,
intimidated, extorted), use that precise lowercase_snake_case verb instead —
never flatten a specific criminal relationship to a generic one.

RULES
1. Direction matters: from = the acting/owning/identifying side,
   to = the target. "Ravi owns account X" → fromId=Ravi, toId=X, rel=owns.
2. Reverse verbs (received_from, paid_by, employed_by): flip the endpoints and
   use the forward verb instead (transferred_money, employs, …).
3. Attach EVERY identifier in the manifest to its owner (person → phone /
   account / vehicle / location), and link every pair of people/organizations
   the document connects (calls, transfers, employment, family, hierarchy,
   co-travel, co-location, aliasing). A money movement described between TWO
   ACCOUNTS must ALSO become an account→account transferred_money edge (in
   addition to any person→account ownership edges) — the money-flow chain
   account A → account B → account C is the core of a laundering case.
   Resolve pronouns and role references ("his vehicle", "my driver", "the
   accused") back to the named actor from the manifest.
4. Only relationships grounded in THIS document; every connection cites its
   "why" from the text. Do not invent links between unrelated entities.
5. Exhaustive, not illustrative: a dense document can legitimately yield 30+
   connections. Never sample or "top-N" them — a dropped edge is a dropped lead.
6. Respond in ENGLISH only, whatever language the document uses.
7. Respond with ONLY the JSON block — no preamble.`

// ─────────────────────────────────────────────────────────────────────────────
// v3.8 — STAGE 0: FAST-tier chunked entity sweep + AI recheck
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FAST NER WORKER — one tiny chunk, one job: find EVERY entity and classify it.
 * Single-purpose by design: a ≤3B model is only reliable on short,
 * one-task prompts. It must NOT summarize, must NOT infer relationships —
 * those belong to other stages. Consecutive chunks OVERLAP, so an entity at a
 * boundary is seen twice; the merge court dedupes.
 */
export const FAST_NER_CHUNK_SYSTEM_PROMPT = `You are the ENTITY SPOTTER of the RED Justice evidence scanner — stage 0, pass 2.
You receive ONE CHUNK of a document. Deterministic code (regex + checksum
validation) has ALREADY extracted every structured identifier from this chunk.
Your ONLY job: list every SEMANTIC entity that code cannot reliably capture —
the people, organizations, places and contextual things — plus anything the
deterministic pass could not have matched. Do not summarize. Do not infer
relationships. Do not comment. Just the entity list.

ENTITY TYPES (classify each entity as exactly one):
person, organization, phone_number, bank_account, upi_id, card_number,
email, website, ip_address, imsi, imei, device_id, vehicle, location,
weapon, drug, id_number, account_number, crypto_wallet, date, amount, other

Respond EXACTLY in this JSON structure:
\`\`\`json
{ "entities": [{ "type": "person", "value": "exact value from the text", "context": "≤10 surrounding words", "confidence": 0.9 }] }
\`\`\`

RULES
1. The user message may contain a "KNOWN ENTITIES (checksum-validated in
   code)" section. It is TRUSTED INPUT — those entities are already stored.
   NEVER re-list them, never re-classify them, never "correct" them. Report
   ONLY entities that are NOT already in that list.
2. EXHAUSTIVE within your role: every person named (full names, and again
   separately only if a different spelling), every organization, informal
   location, role-bearing name, nickname/alias, vehicle, weapon, drug
   quantity, and any identifier format the known list missed. A dropped
   entity is a dropped lead.
3. value = EXACT text as written (keep the number formatting; do not translate).
4. context = a short verbatim snippet around it (helps disambiguation later).
5. Names with titles (Dr., Advocate, SHO) → value WITHOUT the title.
6. Do NOT invent entities that are not literally present in the chunk.
7. Respond with ONLY the JSON block — no preamble, ENGLISH keys only.`

/**
 * v3.9 PASS 3 — INDEPENDENT per-chunk verification. Genuinely separate
 * generation (never "double-check your answer" in one prompt): this call
 * receives the ORIGINAL chunk plus the Pass-2 output and adversarially
 * audits it — missed entities, wrong entities, hallucinations.
 */
export const FAST_RECHECK_CHUNK_SYSTEM_PROMPT = `You are the INDEPENDENT VERIFIER of the RED Justice entity extraction — stage 0, pass 3.
A first extractor (a separate model call) produced an entity list from the
chunk below. Audit it ADVERSARIALLY, from scratch, judging ONLY by the chunk
text — do not trust the first list.

Respond EXACTLY in this JSON structure:
\`\`\`json
{ "missed": [{ "type": "person", "value": "exact value from the text", "context": "≤10 words", "confidence": 0.8 }],
  "wrong": [{ "value": "...", "reason": "not literally present | misclassified, correct type is X | fragment/not an entity" }] }
\`\`\`

AUDIT CHECKLIST
1. MISSED — scan the chunk line by line for persons, organizations,
   locations, identifiers and aliases the first list does NOT contain.
   (Structured identifiers already captured by deterministic code are listed
   as KNOWN ENTITIES — those are handled; only flag MISSING semantic
   entities and missing identifier formats.)
2. WRONG — flag first-list entries whose value is not literally present in
   the chunk (hallucination), whose type is clearly wrong (give the correct
   type), or which are fragments/not real entities.
3. When in doubt, stay silent — a false accusation is worse than a miss.
4. Respond with ONLY the JSON block — no preamble.`

/**
 * AI RECHECK — the accuracy arbiter of stage 0. Receives ONLY the contested
 * slice (type conflicts + low-confidence additions + per-chunk counts), never
 * the whole document, so a small model can adjudicate precisely.
 */
export const RECHECK_SYSTEM_PROMPT = `You are the QUALITY REVIEWER of the RED Justice entity extraction — stage 0b.
Stage 0 extracted entities from a document in chunks; a deterministic merge
found CONTESTED items it cannot resolve alone. You receive those items plus
short evidence snippets. Correct the classification, confirm or reject
additions, and add any CRITICAL entity (person/organization only) that all
chunks somehow missed.

Respond EXACTLY in this JSON structure:
\`\`\`json
{ "corrections": [{ "value": "...", "correctType": "person", "reason": "≤8 words" }],
  "rejected": ["value1", "value2"],
  "missedCritical": [{ "type": "person", "value": "...", "context": "..." }] }
\`\`\`
Use ONLY the entity types from the stage-0 list. Respond with ONLY the JSON
block — no preamble.`

/**
 * v3.8 relationship-maker chunk header. Prepended to each maker chunk: the
 * numbered manifest is GLOBAL (stable ids across chunks) and — for prose —
 * a rolling STORY-SO-FAR block carries previously found actors and links so
 * chunk N can connect back to chunk 1 (the FIR mentions "the accused" in
 * chunk 3; the name was in chunk 1).
 */
export const MAKER_ROLLING_HEADER = `=== STORY SO FAR (actors and links from EARLIER chunks — use these names) ===`

/**
 * v3.8 EVIDENCE PROTOCOL for maker connections: every connection should carry
 * `evidence` — a VERBATIM quote (≥4 words) copied from the document. The
 * pipeline verifies each quote against the text; verified quotes become the
 * edge's proof on the knowledge graph.
 */
export const MAKER_EVIDENCE_RULE = `Each connection must ALSO carry "evidence": a VERBATIM quote (4-15 words)
copied EXACTLY from the document that proves the relationship. The pipeline
verifies every quote against the text — a quote that cannot be found marks
the connection unproven. Connections with neither a "why" nor a verifiable
"evidence" quote are DISCARDED.`


/**
 * System prompt for the AI link-explanation endpoint — explains WHY two
 * nodes are connected, in plain investigative language, grounded in the
 * document excerpts we pass in.
 */
export const LINK_EXPLAIN_SYSTEM_PROMPT = `You are the link analyst of the RED Justice investigation platform.
An investigator clicked the connection between two entities in the knowledge
graph and wants to know WHY they are connected.

You receive: the two entities, the relationship type, the AI rationale that
created the link, and EXCERPTS from the evidence documents mentioning them.

Write 2-4 plain ENGLISH sentences explaining the connection:
- Say what the documents actually establish, e.g. "Aarav Sharma is a student of
  MIT College of Engineering — the LOR names him with registration number
  MH2023-0417, so the number belongs to him".
- Name the file(s) the facts come from.
- Use only the provided facts/excerpts — never speculate beyond them.
- Use measured language ("the document states", "according to").
- Write in ENGLISH only, even if the evidence excerpts are in another language.
Respond with the explanation text ONLY — no preamble, no bullet points.`

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanEntity {
  type: string
  value: string
  context?: string
  confidence?: number
  /** Source-table IDs for this value (E0001 …) — kept for UI traceability. */
  tableIds?: string[]
  /**
   * v3.9 reconciliation gate (master prompt §4):
   *   confirmed — deterministic (checksum/domain-validated) or AI entities
   *               with high single-mention confidence / cross-chunk corroboration
   *   candidate — AI entities below the confirmation threshold (NEVER deleted;
   *               retained for review, later evidence, deeper analysis)
   * Unset = caller-provided default (treated as confirmed by persistence
   * for deterministic sources, candidate-gated for AI sources).
   */
  status?: 'confirmed' | 'candidate'
}

/** AI-detected story connection (WHO-did-WHAT-to-WHOM with rationale). */
export interface ScanStoryConnection {
  from: string
  to: string
  rel: string
  why?: string
  /** v3.8: VERBATIM document quote proving the connection (gate-verified). */
  evidence?: string
  confidence?: number
}

/** Story block produced by the scanner (hasStory=false → register-like). */
export interface ScanStory {
  hasStory: boolean
  plot?: string
  connections?: ScanStoryConnection[]
}

export interface ScanResult {
  summary: string
  entities: ScanEntity[]
  suspiciousIndicators: string[]
  narrative: string
  suggestedSteps: string[]
  confidence: string
  aiAvailable: boolean
  model: string
  scannedAt: string
  classification?: string
  classificationConfidence?: number
  classificationSource?: string
  keyFacts?: unknown[]
  contradictions?: unknown[]
  story?: ScanStory
  /** Hybrid engine: set when the deterministic base succeeded but the AI
   * enrichment pass failed — the graph still holds the deterministic layer. */
  enrichmentError?: string
  /** Hybrid engine: number of entities/edges the deterministic layer wired
   * before the AI enrichment pass ran (0 in ai-only mode). */
  deterministicBase?: { entities: number; recordEdges: number; registryEdges: number; tableEdges?: number; tableTimelineEvents?: number }
  // Engine telemetry
  engine?: {
    provider: string
    contextTokens: number
    budgetChars: number
    chunks: number
    strategiesUsed: string[]
    mode?: 'hybrid' | 'ai-only' | 'deterministic-only'
    /** Which tier models actually served AI calls (v3.3 tiered routing). */
    tier?: 'fast' | 'standard' | 'deep'
    modelsUsed?: { fast: number; standard: number; deep: number }
  }
  crossLinks?: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// AI label → canonical graph type resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical graph types an AI label can resolve to. */
export const CANON_GRAPH_TYPES = new Set([
  'person', 'organization', 'account', 'phone', 'email', 'upi', 'ip', 'url',
  'domain', 'wallet', 'location', 'device', 'imei', 'social', 'ifsc',
  'document_id', 'vehicle', 'event', 'other',
])

/**
 * Maps AI-provided entity-type labels onto canonical graph types. Bigger
 * models love vocabulary like "aadhaar_card_number", "bank_account",
 * "registration_number", "beneficiary_name" — anything unmapped here used to
 * be SILENTLY DROPPED during graph wiring. Every reasonable synonym resolves.
 */
export const AI_TYPE_MAP: Record<string, string> = {
  person: 'person',
  people: 'person',
  individual: 'person',
  human: 'person',
  name: 'person',
  full_name: 'person',
  student_name: 'person',
  applicant_name: 'person',
  candidate_name: 'person',
  customer_name: 'person',
  sender_name: 'person',
  receiver_name: 'person',
  beneficiary: 'person',
  beneficiary_name: 'person',
  suspect: 'person',
  accused: 'person',
  complainant: 'person',
  victim: 'person',
  witness: 'person',
  officer: 'person',
  professor: 'person',
  principal: 'person',
  dean: 'person',
  student: 'person',
  applicant: 'person',
  candidate: 'person',
  employee: 'person',
  employer_person: 'person',
  signatory: 'person',
  signer: 'person',
  alias: 'person',
  contact: 'person',
  organization: 'organization',
  organisation: 'organization',
  org: 'organization',
  company: 'organization',
  business: 'organization',
  firm: 'organization',
  bank: 'organization',
  merchant: 'organization',
  vendor: 'organization',
  shop: 'organization',
  exchange: 'organization',
  agency: 'organization',
  employer: 'organization',
  employer_name: 'organization',
  college: 'organization',
  university: 'organization',
  institute: 'organization',
  institution: 'organization',
  school: 'organization',
  account: 'account',
  account_number: 'account',
  account_no: 'account',
  bank_account: 'account',
  bank_account_number: 'account',
  acct: 'account',
  iban: 'account',
  card: 'account',
  card_number: 'account',
  credit_card: 'account',
  debit_card: 'account',
  masked_account: 'account',
  masked_card: 'account',
  loan_account: 'account',
  phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  mobile_number: 'phone',
  telephone: 'phone',
  contact_number: 'phone',
  msisdn: 'phone',
  whatsapp_number: 'phone',
  fax: 'phone',
  email: 'email',
  email_address: 'email',
  mail: 'email',
  upi: 'upi',
  upi_id: 'upi',
  upi_vpa: 'upi',
  vpa: 'upi',
  ip: 'ip',
  ip_address: 'ip',
  ipv4: 'ip',
  ipv6: 'ip',
  url: 'url',
  link: 'url',
  website_url: 'url',
  uri: 'url',
  domain: 'domain',
  website: 'domain',
  host: 'domain',
  site: 'domain',
  wallet: 'wallet',
  crypto_wallet: 'wallet',
  crypto_address: 'wallet',
  btc_address: 'wallet',
  eth_address: 'wallet',
  bitcoin_address: 'wallet',
  location: 'location',
  place: 'location',
  city: 'location',
  address: 'location',
  locality: 'location',
  region: 'location',
  country: 'location',
  state: 'location',
  atm_location: 'location',
  branch: 'location',
  device: 'device',
  device_id: 'device',
  imei: 'imei',
  imsi: 'imei',
  mac: 'device',
  mac_address: 'device',
  social: 'social',
  social_handle: 'social',
  username: 'social',
  handle: 'social',
  profile: 'social',
  document_id: 'document_id',
  event: 'event',
  document: 'document_id',
  document_number: 'document_id',
  id_document: 'document_id',
  gov_id: 'document_id',
  government_id: 'document_id',
  aadhaar: 'document_id',
  aadhaar_number: 'document_id',
  aadhar: 'document_id',
  uidai: 'document_id',
  vid: 'document_id',
  pan: 'document_id',
  pan_number: 'document_id',
  passport: 'document_id',
  passport_number: 'document_id',
  license: 'document_id',
  driving_license: 'document_id',
  driving_licence: 'document_id',
  dl_number: 'document_id',
  voter_id: 'document_id',
  gstin: 'document_id',
  gst_number: 'document_id',
  cin: 'document_id',
  tan: 'document_id',
  utr: 'document_id',
  reference_number: 'document_id',
  ref_no: 'document_id',
  registration_number: 'document_id',
  registration_no: 'document_id',
  reg_no: 'document_id',
  reg_number: 'document_id',
  roll_number: 'document_id',
  roll_no: 'document_id',
  enrollment_number: 'document_id',
  enrolment_no: 'document_id',
  employee_id: 'document_id',
  student_id: 'document_id',
  certificate_number: 'document_id',
  transaction_id: 'document_id',
  txn_id: 'document_id',
  cheque_number: 'document_id',
  invoice_number: 'document_id',
  fir_number: 'document_id',
  case_number: 'document_id',
  vehicle: 'vehicle',
  vehicle_number: 'vehicle',
  car_plate: 'vehicle',
  registration_plate: 'vehicle',
  plate: 'vehicle',
  ifsc: 'ifsc',
  ifsc_code: 'ifsc',
  other: 'other',
}

/** Contextual labels that never become graph entities. */
export const AI_CONTEXTUAL_TYPES = new Set(['date', 'amount', 'datetime', 'time'])

/**
 * Strip common label prefixes models add to values ("IFSC: HDFC0001234",
 * "Aadhaar No. 1234...", "Reg No: X") so wiring matches the verbatim
 * normalizers.
 */
export function stripValueLabelPrefix(value: string): string {
  return value
    .replace(
      /^\s*(?:aadhaa?r(?:\s*(?:no|number|card))?|pan(?:\s*(?:no|number|card))?|passport(?:\s*(?:no|number))?|ifsc(?:\s*code)?|gstin(?:\s*no)?|utr(?:\s*(?:no|number))?|account(?:\s*(?:no|number))?|acct(?:\s*no)?|ref(?:erence)?(?:\s*(?:no|number))?|reg(?:istration)?(?:\s*(?:no|number))?|roll(?:\s*(?:no|number))?|enrol{1,2}ment(?:\s*(?:no|number))?|employee(?:\s*(?:id|no|number))?|student(?:\s*(?:id|no|number))?|txn(?:\s*id)?|transaction(?:\s*id)?|phone(?:\s*(?:no|number))?|mobile(?:\s*(?:no|number))?|email(?:\s*(?:id|address))?|upi(?:\s*id)?|vpa|imei|dl|license|licence)\s*[:#=]\s*/i,
      '',
    )
    .trim()
}

/** Structural fallback for AI entity labels that escaped every alias map. */
export function guessEntityType(value: string): string {
  const v = value.trim()
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return 'email'
  if (/^0x[0-9a-f]{40}$/i.test(v)) return 'wallet'
  if (/@[a-z]{2,}\b/i.test(v) && !v.includes('.')) return 'upi'
  if (/^\+?\d[\d\s-]{7,}$/.test(v)) return 'phone'
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) return 'ifsc'
  if (/^\d{4}\s?\d{4}\s?\d{4}$/.test(v)) return 'document_id'
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return 'document_id'
  if (/^\d{9,18}$/.test(v.replace(/\s/g, ''))) return 'account'
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)) return 'domain'
  if (/\b(pvt|ltd|llp|inc|corp|bank|enterprises|traders|college|university|institute|school)\b/i.test(v)) return 'organization'
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(v)) return 'person'
  return 'other'
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk planner + tolerant coercers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits over-budget documents on line boundaries.
 *
 * v3.7.1: the chunk-count ceiling rose 24 → 200. The old ceiling silently
 * made chunks BIGGER than the requested budget on large files (a 300K-char
 * bank trail ÷ 24 = 12.5K chars per chunk even with a 7K budget) — the
 * prompt-size guarantees of the enrichment planner were defeated by exactly
 * the files that needed them. Hybrid enrichment merges chunk outputs in CODE
 * (no reduce call), so many small chunks cost only call latency, never
 * correctness; the legacy ai-only reduce path bounds its own digest input.
 */
export function planChunks(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content]
  // Hard-split pathological single lines (minified JSON exports, base64
  // blobs): one line longer than the budget can never obey it whole.
  const lines: string[] = []
  for (const raw of content.split('\n')) {
    if (raw.length <= maxChars) {
      lines.push(raw)
      continue
    }
    for (let i = 0; i < raw.length; i += maxChars) lines.push(raw.slice(i, i + maxChars))
  }
  // No chunk-count ceiling: the previous 24-chunk cap let the TAIL chunk
  // accumulate everything left (and made each chunk content/budget÷24 on big
  // files). Every chunk now obeys the budget; count follows doc size.
  // v3.8: the close condition is `curLen > 0` — the old `curLen ≥ 60%`
  // guard let a chunk overshoot the budget by up to one line (~5%). The
  // budget is now a HARD guarantee (mock watchdog contract + overlap
  // stitching rely on it); the cost is at most one extra chunk per doc.
  const idealSize = maxChars
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  for (const line of lines) {
    const ll = line.length + 1
    if (curLen + ll > idealSize && curLen > 0) {
      chunks.push(cur.join('\n'))
      cur = []
      curLen = 0
    }
    cur.push(line)
    curLen += ll
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks.filter((c) => c.trim())
}

/**
 * v3.8 OVERLAPPED CHUNKING — like planChunks, but every chunk after the
 * first BEGINS with the tail `overlapChars` of the previous chunk (extended
 * left to a line boundary so no line is torn). An entity straddling a chunk
 * boundary is therefore seen by BOTH chunks; the merge court dedupes.
 *
 * Guarantees:
 *   - every chunk ≤ maxChars (overlap included)
 *   - chunk[0..n] concatenated still covers 100% of the document
 *   - no entity within `overlapChars` of a boundary can be dropped
 */
export function planChunksOverlapped(content: string, maxChars: number, overlapChars = 0): string[] {
  const base = planChunks(content, maxChars)
  if (base.length <= 1 || overlapChars <= 0) return base
  const out: string[] = [base[0]]
  for (let i = 1; i < base.length; i++) {
    const tail = base[i - 1].slice(-overlapChars)
    // Extend left to the nearest newline so the overlap starts at a clean line.
    const nl = tail.indexOf('\n')
    const cleanTail = nl >= 0 ? tail.slice(nl + 1) : tail
    const room = maxChars - base[i].length - 1 // -1 for the joining newline
    const use = room > 0 ? cleanTail.slice(-room) : ''
    out.push(use ? `${use}\n${base[i]}` : base[i])
  }
  return out
}

/** True when every overlapped chunk obeys the budget (unit-test helper). */
export function chunksWithinBudget(chunks: string[], maxChars: number): boolean {
  return chunks.every((c) => c.length <= maxChars)
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.9 TOKEN-AWARE PLANNING (master prompt §2)
// ─────────────────────────────────────────────────────────────────────────────

/** Header prepended to Pass-2 chunk payloads carrying the checksum-validated
 *  deterministic entities found IN THIS CHUNK (trusted input — the model is
 *  told never to re-extract them). */
export const KNOWN_ENTITIES_HEADER = '=== KNOWN ENTITIES (checksum-validated in code — DO NOT re-list or re-classify these) ==='

/**
 * Build the trusted-input section for a Pass-2 chunk payload. Empty string
 * when the chunk carries no deterministic entities (nothing to declare).
 */
export function knownEntitiesSection(detEntitiesInChunk: ScanEntity[]): string {
  if (detEntitiesInChunk.length === 0) return ''
  const lines = detEntitiesInChunk
    .slice(0, 120)
    .map((e) => `- ${e.type}: ${e.value}`)
    .join('\n')
  return `${KNOWN_ENTITIES_HEADER}\n${lines}\n\n`
}

/**
 * v3.9 TOKEN-BUDGET CHUNK PLANNER — sizes chunks by a TOKEN budget, not a
 * char count. The char budget handed to the hardened line-aligned planner is
 * derived per-document from `budgetTokens` using the CONSERVATIVE digit-aware
 * ratio (tokenEstimator.charBudgetForTokens): identifier-heavy evidence
 * (CDRs, registers, bank trails) gets proportionally smaller chunks than
 * prose at the same token budget, because digits tokenize less efficiently.
 * The estimator deliberately OVERESTIMATES token usage — the system fails
 * toward smaller chunks, never toward context overflow.
 */
export function planChunksTokenBudget(
  content: string,
  budgetTokens: number,
  overlapChars = 0,
): string[] {
  const maxChars = charBudgetForTokens(content, budgetTokens)
  return planChunksOverlapped(content, maxChars, overlapChars)
}

/**
 * Token-compliance check (unit-test helper): every chunk's CONSERVATIVE token
 * estimate must sit at/below the budget. Overlap-inclusive.
 */
export function chunksWithinTokenBudget(chunks: string[], budgetTokens: number): boolean {
  return chunks.every((c) => estimateTokensHeuristic(c) <= budgetTokens)
}

export function dedupeEntities(entities: ScanEntity[]): ScanEntity[] {
  const seen = new Map<string, ScanEntity>()
  for (const e of entities) {
    const t = String(e?.type ?? '').toLowerCase().trim()
    const v = String(e?.value ?? '').trim()
    if (!v || !t || v.length < 2) continue
    const key = `${t}::${v.toLowerCase().replace(/\s+/g, '')}`
    if (!seen.has(key)) seen.set(key, { ...e, type: t, value: v })
  }
  return [...seen.values()]
}

export function unionStrings(a: unknown[], b: unknown[], max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of [...a, ...(b ?? [])]) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** Tolerant string-array coercion used across scan payloads. */
export function strArrayOf(v: unknown, max = 20): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, max)
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

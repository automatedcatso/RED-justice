# Entity & Relationship Extraction Pipeline

## Overview

RED Justice's extraction engine is **deterministic-first**:

1. **Pass 1 (Deterministic)**: Regex, table parsing, record extraction — zero AI tokens
2. **Pass 2 (Fast Tier)**: AI-assisted entity discovery with manifest trust
3. **Pass 3 (Independent Audit)**: Adversarial recheck for missed/hallucinated entities
4. **Merge Court**: Reconciliation gate (confirmed vs candidate status)

---

## Pass 1: Deterministic Extraction (Zero AI)

### Entity Detection

| Entity Type | Detection Method |
|---|---|
| **PHONE** | Regex: +XX-XXXX-XXXXXX, 10+ digit sequences, international formats |
| **EMAIL** | RFC 5322 pattern (alphanumeric + standard TLDs) |
| **IMEI** | 15 digits + Luhn checksum validation |
| **AADHAAR** | 12 digits + Verhoeff check digit |
| **GSTIN** | 15-char format + Modulo-36 check |
| **BANK_ACCOUNT** | ACCOUNT/ACC/A/C followed by 9+ digits; regex + context |
| **UPI_ID** | username@bankcode (case-insensitive match) |
| **CREDIT_CARD** | 13-19 digits + Luhn checksum, non-sequential |
| **ADDRESS** | Street + city/postal patterns; regex excludes junk |
| **LOCATION** | City/state/country names (cross-validated against gazetteers) |
| **ORGANIZATION** | Org suffix (.com, Pvt Ltd, Corp, Inc) or all-caps proper nouns |
| **PERSON** | Proper noun candidates; filtered by proper-noun rules |
| **DEVICE** | Device identifiers (IMEI, MAC, serial numbers) |
| **IP_ADDRESS** | IPv4 (dotted decimal) + IPv6 (colon-hex) |
| **DOMAIN** | FQDN pattern (alphanumeric.tld) |
| **WALLET** | Blockchain addresses (Bitcoin, Ethereum patterns) |
| **VEHICLE** | License plates (country-specific patterns) + VINs (17 chars) |
| **TRANSACTION** | Amount + verb + counterparty (bank/CDR records) |
| **COMMUNICATION** | CDR/chat record (caller/called, timestamp, duration) |
| **EVENT** | Date + verb + actor (structured annexures) |
| **DOCUMENT** | File type + document ID (FIR, LOR, certificate) |

### Relationship Detection (Record-Based)

| Record Type | Relationship | Endpoints | Example |
|---|---|---|---|
| **Bank Statement Row** | TRANSFERRED_TO | sender_account → receiver_account | IMPS DR-50100234567909 |
| **CDR Record** | COMMUNICATED_WITH | caller_phone → called_phone | Call log entry |
| **Registry Row** | Evidence-declared verb | source_entity → target_entity | E0001 WORKS_FOR ORG-001 |
| **Table Edge List** | Canonical verb | source_id → target_id (re-typed) | Relationship table CSV |

### Entity Register Tables

Delimited inventories that declare typed entities:

```
entity_id,entity_name,entity_type,confidence,source
E0001,Arjun Sharma,PERSON,0.95,registry.csv
E0002,Aster Logistics,ORGANIZATION,0.90,registry.csv
ACC-001,50100234567909,BANK_ACCOUNT,1.0,bank_statement.xlsx
```

**Detection criteria**:
- Type column maps ≥60% through shared vocabulary (PERSON, ORGANIZATION, BANK_ACCOUNT, …)
- Name column chosen by fill-rate (name > label)
- ID column excluded from entity values
- Endpoint-pair tables rejected (those are relationships, not entities)
- ≥20 rows → structured-dominant class (skips AI sweep)

### Relationship Table Parser

Delimited edge lists (CSV/TSV from Analyst's Notebook, Palantir, Excel):

```
source_name,source_type,relationship_type,target_name,target_type,event_date
Arjun Sharma,PERSON,WORKS_FOR,Aster Logistics,ORGANIZATION,2026-01-01
```

**Processing**:
1. Detect table structure (delimiter consistency, column headers)
2. Map endpoints to typed entities (using table's own type columns)
3. Canonicalize verbs (MESSAGED → COMMUNICATED_WITH, MET → ASSOCIATED_WITH)
4. Preserve novel verbs (SUPPLIED_DRUGS_TO stays as first-class edge type)
5. Wire every row with confidence, date, and row locator
6. **Result**: 280-row export → 159 entities + 275 edges in ~15ms (100% recall)

---

## Pass 2: AI Entity Sweep (Fast Tier)

Once deterministic entities are extracted, the Fast tier model (≤3B) walks the **full document** in small overlapped chunks:

### Chunk Configuration
- **Quality zone**: 8,192 tokens (6,451 char budget)
- **Overlap**: 240 characters (entities at boundaries seen twice)
- **Manifest**: All deterministic entities passed as TRUSTED INPUT ("never re-list these")

### NER Prompt
```
Given the following ALREADY EXTRACTED entities (never re-list these):
[E-001] PERSON: Arjun Sharma
[E-002] ORGANIZATION: Aster Logistics
[ACC-001] BANK_ACCOUNT: 50100234567909

Extract ONLY new entities NOT in this list.
Keep only high-confidence names, orgs, aliases, and informal places.
Return JSON: {"entities": [{"value": "...", "type": "...", "confidence": 0.8}]}
```

### Output Reduction
By trusting the manifest, AI output shrinks **5-10×**:
- Old behavior: Re-emit all ~90% of deterministic matches (wasted output tokens)
- New behavior: Only emit truly new discoveries (~10% of document)

### Quality Gate
Per-chunk quality check:
- **High signal, empty output** → Escalate chunk to STANDARD tier (richer context needed)
- **All chunks OK** → Continue to Pass 3

---

## Pass 3: Independent Adversarial Audit (Fast Tier)

A separate Fast-tier call over the same chunks with Pass-2 output as input:

```
Given entities already found in this chunk:
[P-001] PERSON: Arjun Sharma
[P-002] PERSON: Rajesh Kale
[E-001] ORGANIZATION: Aster Logistics

Independently find ANY missed entities and flag hallucinations.
Entities you list MUST be different from the list above.
Return JSON: {"missed": [...], "hallucinated_in_pass2": [...]}
```

### Result
- ✅ Recovers missed critical actors (entities Pass-2 overlooked)
- ✅ Flags hallucinations (entities not in document)
- ✅ Never deletes deterministic entities
- ✅ Candidate gate: weak entities become `status=candidate`

---

## Merge Court: Reconciliation (Deterministic)

### Entity Confirmation

| Source | Status | Rules |
|---|---|---|
| **Deterministic** (regex/table/record) | Confirmed | Always ✅; weight = 5 |
| **AI (single mention)** | Candidate | If confidence < 0.8 |
| **AI (≥2 corroborations)** | Confirmed | Seen in ≥2 chunks or files |
| **AI (≥0.8 confidence)** | Confirmed | High-confidence single sighting |
| **AI (digit-core match)** | Confirmed | Matches existing deterministic identifier |

### Conflict Resolution

When AI and deterministic disagree on type/value:
- ✅ Deterministic type is authoritative (e.g., table says E0001=PERSON)
- ✅ AI value becomes an alias (if different name for same entity)
- ✅ Conflicts logged (for investigator review)

### Example
```
Deterministic: E0001 = PERSON: "Arjun Sharma" (from registry)
AI finds:      E0001 = PERSON: "A. Sharma" (same entity, different name)
Result:        Confirm E0001; add alias "A. Sharma"
```

---

## Structure Detection (Tabular vs Narrative)

The engine auto-detects document structure to optimize chunking/extraction:

| Indicator | Tabular | Narrative |
|---|---|---|
| **Delimiter consistency** | High (CSV-like rows) | Low (prose paragraphs) |
| **Row-length variance** | Low (uniform widths) | High (varied paragraph lengths) |
| **Digit density** | High (identifiers dominate) | Low (natural language) |
| **Column-pattern regularity** | High (predictable columns) | N/A |

**Decision**:
- ✅ **Tabular** → Deterministic row wiring + ONE pattern call (funnel/structuring)
- ✅ **Narrative** → Chunked extraction with rolling story-so-far + separate relationship maker

---

## Candidate vs Confirmed Entities

Entities below the confirmation threshold become **candidates** (kept, not deleted):

### Candidate Entities
- ✅ Visible via `/entities?status=candidate`
- ✅ Promotable via human-review endpoint: `POST /api/cases/[id]/entities/[entityId]/status`
- ✅ Excluded from canonical graph (unless explicitly included with `?includeCandidates=1`)
- ✅ Auto-promoted if a later confirmed sighting references them
- ❌ Never silently demoted

### Use Cases
- Low-confidence AI extractions pending review
- Entities from secondary evidence (not yet corroborated)
- Weak relationships needing investigator approval

---

## Full-Fidelity Edge Provenance

Every relationship carries:

```json
{
  "from": "E0001",
  "to": "E0002",
  "type": "WORKS_FOR",
  "confidence": 0.85,
  "sourceFileId": "invoice_001.pdf",
  "metadataJson": {
    "evidence": "Arjun Sharma, employee ID AS-001, works for Aster Logistics",
    "rows": [
      {
        "relationship_id": "R0001",
        "source_id": "E0001",
        "source_name": "Arjun Sharma",
        "target_id": "E0002",
        "target_name": "Aster Logistics",
        "relationship_type": "WORKS_FOR",
        "event_date": "2026-01-15",
        "confidence": 0.95,
        "extraction_method": "registry"
      }
    ],
    "tableIds": ["REG-001", "DOC-CDR-003"],
    "verificationStatus": "confirmed"
  }
}
```

---

## Cross-File Reference Stitching

Multi-file exports speak the same object through different spellings:

```
Master Inventory (file A): E0001 | Rohan Kale | PERSON
CDR Export (file B):       PER-002 (reference token only, no name)
Bank Statement (file C):   PER-002 (reference token only)
```

### Stitcher Algorithm
1. **Group by reference tokens**: E0001, PER-002 are the same entity
2. **Type hierarchy**: Typed nodes win over bare-ID placeholders
3. **Survivor scoring**: name/value > degree > insertion order
4. **Merge**: Endpoints re-point, evidence links accumulate, reciprocal edges collapse
5. **Result**: Deterministic, order-independent, idempotent

---

## Entity-Register Guard on Relationship Parser

A table whose "verb" column is dominated by entity-type labels is NOT an edge list:

```
source_type | verb | target_type
PERSON      | PERSON | LOCATION    ← This is an entity register, NOT relationships
ORGANIZATION| ORGANIZATION | PERSON
```

The relationship parser rejects such tables (prevents ~1 nonsense edge per inventory row).

---

## Related Features

### Registry Noise Suppression
- Row refs (E0001, R0042) become suppression tokens
- Attribute keys/values (status=active, carrier=Jio) suppressed deterministically
- AI noise filter applies to all passes (sweep, recheck, enrichment)

### Temporal Header Recognition
Recognized date columns:
- observed_at, observed_on
- valid_from, valid_to, valid_until
- first_seen, last_seen
- occurred_at, event_time
- from_date, to_date

### Wrapped-Row Glue Guard
Multi-cell CSV fragments are rejected at the wiring choke point:
- ✅ Real names/addresses (≤1 comma) pass
- ❌ Wrapped junk ("ORG-001,ORGANIZATION,Asterion Logistics Pvt Ltd" on one line) rejected

---

## Performance & Verification

### v3.10.0 Ground-Truth Corpus Results
- **41 sequential files**: FIRs, CDRs, bank statements, registries, emails, etc.
- **Entity recall**: 225/225 (100%) across all 19 types
- **Relationship recall**: 389/389 unique triples (100%)
- **Edge fidelity**: 100% with evidence refs, timestamps, deterministic provenance
- **E2E time**: 87 seconds with AI unavailable (zero model calls)

### v3.9.1 Demo Dataset Verification
- **Entity recall**: 100% (165/165, all 9 classes)
- **Relationship recall**: 94.6% (263/280; remainder = canonical verb normalization)
- **Precision**: 95.6% (no hallucinated entities)

---

For architectural details, see [ARCHITECTURE.md](ARCHITECTURE.md).
For usage and configuration, see [README.md](README.md).

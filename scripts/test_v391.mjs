/**
 * v3.9.1 regression battery — the demo-docx fixes.
 * Covers: DOCX table-aware flattening, rel-table endpoint ref-splitting,
 * registry noise vocabulary, AI noise filter (refs/attrs/k=v/proper-noun),
 * property-cell wiring guard, EVENT graph type.
 * Run: node scripts/test_v391.mjs   (exit 0 = all pass)
 */
import { createJiti } from 'jiti'
import { readFileSync } from 'fs'
import path from 'path'
import assert from 'node:assert'

const ROOT = '/home/z/my-project/red-justice/red-justice'
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(ROOT, 'src') } })

let passed = 0
const fail = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { fail.push(name); console.log(`FAIL  ${name}: ${e.message}`) }
}

// ── imports ──
const fp = await jiti.import(`${ROOT}/src/lib/extractors/fileParser.ts`)
const ex = await jiti.import(`${ROOT}/src/lib/extractors/index.ts`)
const ai = await jiti.import(`${ROOT}/src/lib/investigation/aiScan.ts`)
const prompts = await jiti.import(`${ROOT}/src/lib/investigation/aiScanPrompts.ts`)

// ── 1. DOCX table-aware flattening ────────────────────────────────────────
await test('docx: table rows flatten one-line-each with " | " cells', async () => {
  const bytes = new Uint8Array(readFileSync('/home/z/my-project/upload/red_justice_demo.docx'))
  const parsed = await fp.parseFile('demo.docx', bytes)
  const lines = parsed.text.split('\n').filter((l) => l.trim())
  const reg = lines.filter((l) => /^E\d{4} \| (PERSON|DEVICE|ADDRESS|VEHICLE|PHONE|BANK_ACCOUNT|ORGANIZATION|EVIDENCE_DOCUMENT|EVENT) \| /.test(l))
  const rel = lines.filter((l) => /^R\d{4} \| /.test(l))
  assert.equal(reg.length, 165, `registry rows on one line each (got ${reg.length})`)
  assert.equal(rel.length, 280, `relationship rows on one line each (got ${rel.length})`)
})
await test('docx: narrative paragraphs stay on their own lines', async () => {
  const bytes = new Uint8Array(readFileSync('/home/z/my-project/upload/red_justice_demo.docx'))
  const parsed = await fp.parseFile('demo.docx', bytes)
  assert.ok(parsed.text.includes('This fixture is designed for RED Justice ingestion'), 'narrative intact')
  assert.ok(parsed.text.includes('5. Relationship Registry'), 'heading intact')
  // No cell-per-line debris: every E-code line must carry its full row.
  const bad = parsed.text.split('\n').filter((l) => l.trim() === 'PERSON' || l.trim() === 'WORKS_FOR')
  assert.equal(bad.length, 0, 'no bare type/verb cells on their own lines')
})
await test('docx: nested/edge tokens do not corrupt depth tracking', async () => {
  // Synthetic docx XML: tblPr/tblGrid must NOT count as tables; nested tbl handled.
  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Intro line</w:t></w:r></w:p>'
    + '<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc><w:p><w:r><w:t>a1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b1</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>a2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:t>Outro</w:t></w:r></w:p></w:body></w:document>'
  // exercise the token scanner through the module boundary
  const jiti2 = createJiti(import.meta.url)
  const mod = await jiti2.import(path.join(ROOT, 'scripts/_docx_scan_helper.mjs'))
  const out = mod.flattenDocxXml(xml)
  assert.ok(out.includes('Intro line\n'), 'paragraph → newline outside tables')
  assert.ok(out.includes('a1 | b1\n'), 'row on one line')
  assert.ok(out.includes('a2 | b2\n'), 'second row on one line')
  assert.ok(out.includes('\nOutro'), 'post-table paragraph on new line')
})

// ── 2. rel-table endpoint ref split ───────────────────────────────────────
await test('relTable: "E0001 Arjun Sharma" endpoints split into clean name + trace ref', async () => {
  const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')
  const rt = ex.extractRelationshipTable(text)
  assert.ok(rt.detected, 'rel table detected')
  assert.equal(rt.edges.length, 280, 'all 280 rows')
  const e0 = rt.edges[0]
  assert.equal(e0.from, 'Arjun Sharma')
  assert.equal(e0.to, 'Aster Logistics')
  assert.equal(e0.srcTableId, 'E0001')
  assert.equal(e0.tgtTableId, 'E0056')
})
await test('relTable: non-ID leading tokens are NOT split (Samsung Galaxy S24)', () => {
  const csv = 'source,target,rel\nSamsung Galaxy S24,Airtel,USES\nNashik Residence,Pune Flat,LOCATED_IN\nBlue Truck,Red Van,TRAVELED_WITH\nRavi Kumar,Mumbai Office,WORKS_FOR\nAna Silva,Q4 Report,WROTE\nDeepak Rao,Chennai Hub,WORKS_FOR\n'
  const rt = ex.extractRelationshipTable(csv)
  assert.ok(rt.detected)
  assert.equal(rt.edges[0].from, 'Samsung Galaxy S24')
})

// ── 3. registry noise vocabulary ───────────────────────────────────────────
await test('registry: noise vocabulary carries refs + attribute values, never entity values', async () => {
  const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')
  const reg = ex.extractRegistry(text)
  const noise = new Set(reg.noiseVocabulary ?? [])
  assert.ok(noise.has('e0001'), 'row ref in noise')
  assert.ok(noise.has('active'), 'attr value in noise')
  assert.ok(noise.has('watchlist'), 'attr value in noise')
  assert.ok(noise.has('director'), 'role attr value in noise')
  assert.ok(noise.has('jio'), 'carrier attr value in noise')
  assert.ok(noise.has('nashik'), 'city attr value in noise')
  assert.ok(noise.has('r0001'), 'relationship row id in noise')
  assert.ok(!noise.has('arjun sharma'), 'entity value never suppressed')
  assert.ok(!noise.has('aster logistics'), 'org entity value never suppressed')
})

// ── 4. AI noise filter ─────────────────────────────────────────────────────
const det = [
  { type: 'person', value: 'Arjun Sharma', confidence: 0.92 },
  { type: 'organization', value: 'Aster Logistics', confidence: 0.92 },
]
const noise = new Set(['e0031', 'active', 'watchlist', 'jio', 'nashik', 'director', 'r0001'])
await test('filter: registry refs and attr values suppressed', () => {
  const out = ai.filterRegistryNoiseAi([
    { type: 'document_id', value: 'E0031', confidence: 0.9 },
    { type: 'person', value: 'Jio', confidence: 0.9 },
    { type: 'location', value: 'Nashik', confidence: 0.9 },
  ], det, noise)
  assert.equal(out.length, 0)
})
await test('filter: k=v property cells suppressed', () => {
  const out = ai.filterRegistryNoiseAi([
    { type: 'other', value: 'status=active', confidence: 0.9 },
    { type: 'person', value: 'status=watchlist', confidence: 0.9 },
    { type: 'other', value: 'event_time=2026-01-05T00:00:00', confidence: 0.9 },
  ], det, noise)
  assert.equal(out.length, 0)
})
await test('filter: lowercase single-word person/org suppressed (proper-noun rule)', () => {
  const out = ai.filterRegistryNoiseAi([
    { type: 'person', value: 'ridian', confidence: 0.9 },
    { type: 'person', value: 'unknown', confidence: 0.9 },
  ], det, noise)
  assert.equal(out.length, 0)
})
await test('filter: real names and det entities always survive', () => {
  const out = ai.filterRegistryNoiseAi([
    { type: 'person', value: 'Arjun Sharma', confidence: 0.7 },
    { type: 'person', value: 'Ishita Joshi', confidence: 0.9 },
    { type: 'device', value: 'Samsung Galaxy S24', confidence: 0.9 },
    { type: 'url', value: 'https://x.com/a?b=c', confidence: 0.9 },
  ], det, noise)
  assert.equal(out.length, 4, 'nothing legitimate dropped (URL with = must survive filter stage)')
})

// ── 5. EVENT graph type enabled ────────────────────────────────────────────
await test('graph types: EVENT is a canonical graph type + AI label maps', () => {
  assert.ok(prompts.CANON_GRAPH_TYPES.has('event'), 'event in CANON_GRAPH_TYPES')
  assert.equal(prompts.AI_TYPE_MAP.event, 'event', 'AI label event → event')
})
await test('registry: EVENT rows parse as event entities', async () => {
  const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')
  const reg = ex.extractRegistry(text)
  const events = reg.entities.filter((e) => e.type === 'event')
  assert.equal(events.length, 6, `6 events (got ${events.length})`)
  assert.ok(events.every((e) => /^Event-\d{2}$/.test(e.value)))
})

// ── 6. end-to-end deterministic extraction on the demo docx ────────────────
await test('e2e-det: 165 registry entities incl. DEVICE(imei)/ADDRESS/EVENT + 280 edges', async () => {
  const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')
  const rt = ex.extractRelationshipTable(text)
  const reg = ex.extractRegistry(text)
  const types = {}
  for (const e of reg.entities) types[e.type] = (types[e.type] ?? 0) + 1
  assert.equal(reg.entities.length, 165)
  assert.equal(types.imei, 15, 'DEVICE rows carry IMEI values → imei type')
  assert.equal(types.address, 12)
  assert.equal(types.event, 6)
  assert.equal(types.person, 55)
  assert.equal(rt.edges.length, 280)
})

console.log(`\n${passed} passed, ${fail.length} failed`)
if (fail.length) { console.log('FAILED:', fail); process.exit(1) }

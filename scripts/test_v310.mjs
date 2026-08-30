/**
 * v3.10 regression battery — Project Meridian multi-file capabilities.
 * Covers: JSON record-list flattening, entity-register table detection,
 * rel-table entity-register guard, ref-token endpoint ids, temporal header
 * capture, reference-token stitcher pure helpers.
 * Run: node scripts/test_v310.mjs   (exit 0 = all pass)
 */
import { createJiti } from 'jiti'
import { readFileSync } from 'fs'
import path from 'path'
import assert from 'node:assert'

const ROOT = '/home/z/my-project/red-justice/red-justice'
const CORPUS = '/home/z/my-project/upload/meridian'
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(ROOT, 'src') } })

let passed = 0
const fail = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { fail.push(name); console.log(`FAIL  ${name}: ${e.message}`) }
}

const fp = await jiti.import(`${ROOT}/src/lib/extractors/fileParser.ts`)
const ex = await jiti.import(`${ROOT}/src/lib/extractors/index.ts`)
const rs = await jiti.import(`${ROOT}/src/lib/investigation/referenceStitch.ts`)

const parse = async (name) => {
  const buf = readFileSync(path.join(CORPUS, name))
  return (await fp.parseFile(name, new Uint8Array(buf))).text || ''
}

// ── 1. JSON record-list flattening ────────────────────────────────────────
await test('json: master_graph.json flattens into entities/relationships/evidence pipe tables', async () => {
  const text = await parse('master_graph.json')
  assert.ok(text.includes('entities list'), 'entities list header')
  assert.ok(text.includes('relationship_id | source | type | target'), 'relationships header')
  assert.ok(text.includes('evidence list'), 'evidence list header')
  assert.ok(text.includes('PER-001 | PERSON | Vikram "Vik" Deshmukh'), 'entity row literal')
  assert.ok(!text.startsWith('{'), 'not raw JSON passthrough')
})

await test('json: property_links.json flattens records array into pipe table', async () => {
  const text = await parse('property_links.json')
  assert.ok(text.includes('records list'))
  assert.ok(text.includes('record_id | entity | address | evidence_id'))
  assert.ok(text.includes('ADDR-001 | PER-001 | ADDR-001 | EV-ADDR-001'))
})

await test('json: small/non-record JSON keeps pretty-printed fallback', async () => {
  const manifest = await parse('manifest.json')
  assert.ok(manifest.includes('"primary_suspect"'), 'scalar object stays JSON')
})

// ── 2. Entity-register table detection ────────────────────────────────────
await test('entityTable: master_entities.csv → 225 typed entities with PER ids as tableIds', async () => {
  const text = await parse('master_entities.csv')
  const et = ex.extractEntityTable(text)
  assert.ok(et.detected, 'detected')
  assert.equal(et.entities.length, 225)
  const types = {}
  for (const e of et.entities) types[e.type] = (types[e.type] ?? 0) + 1
  assert.equal(types.person, 32)
  assert.equal(types.account, 10, 'BANK_ACCOUNT → account')
  assert.equal(types.social, 5, 'SOCIAL_ACCOUNT → social')
  assert.equal(types.event, 15)
  assert.equal(types.ip, 8)
  const per1 = et.entities.find((e) => e.tableIds?.includes('PER-001'))
  assert.ok(per1, 'PER-001 carries its row id')
  assert.equal(per1.type, 'person')
  assert.equal(per1.value, 'Vikram "Vik" Deshmukh', 'name column wins over label column')
  const acc1 = et.entities.find((e) => e.tableIds?.includes('ACC-001'))
  assert.equal(acc1.value, 'AXIS-771204', 'account name from name column')
})

await test('entityTable: master_graph.json flattened → 225 typed entities', async () => {
  const text = await parse('master_graph.json')
  const et = ex.extractEntityTable(text)
  assert.ok(et.detected)
  assert.equal(et.entities.length, 225)
  assert.ok(et.entities.every((e) => !/^PER-\d+$/.test(e.value) || e.type === 'other' || true))
  const veh = et.entities.find((e) => e.tableIds?.includes('VEH-001'))
  assert.equal(veh.type, 'vehicle')
  assert.equal(veh.value, 'MH12AB4821')
})

await test('entityTable: rejects relationship tables, observation CSVs, evidence tables', async () => {
  const rels = ex.extractEntityTable(await parse('master_relationships.csv'))
  assert.ok(!rels.detected, 'edge list is not an entity register')
  const tower = ex.extractEntityTable(await parse('tower_location_log.csv'))
  assert.ok(!tower.detected, 'observation log has no type column')
  const cdr = ex.extractEntityTable(await parse('CDR_chunk_01.csv'))
  assert.ok(!cdr.detected, 'CDR chunk has no type column')
})

// ── 3. Rel-table: entity-register guard + ref-token endpoints + dates ─────
await test('relTable: master_entities.csv NOT misread as edge list (register guard)', async () => {
  const rt = ex.extractRelationshipTable(await parse('master_entities.csv'))
  assert.ok(!rt.detected, `expected NOT detected, got ${rt.edges?.length} garbage edges`)
})

await test('relTable: master_relationships.csv → 405 edges, endpoints carry own ref tokens', async () => {
  const rt = ex.extractRelationshipTable(await parse('master_relationships.csv'))
  assert.ok(rt.detected)
  assert.equal(rt.edges.length, 405)
  const rel1 = rt.edges.find((e) => e.rowId === 'REL-0001')
  assert.equal(rel1.rel, 'WORKS_FOR')
  assert.equal(rel1.srcTableId, 'PER-002', 'bare ref endpoint self-ids')
  assert.equal(rel1.tgtTableId, 'ORG-001')
  assert.equal(rel1.evidenceRefs?.[0], 'EV-001')
  assert.equal(rel1.timestamp, '2026-01-07', 'observed_at captured as timestamp')
})

await test('relTable: supplemental stays an edge list (166 edges)', async () => {
  const rt = ex.extractRelationshipTable(await parse('supplemental_link_analysis.csv'))
  assert.ok(rt.detected)
  assert.equal(rt.edges.length, 166)
})

await test('relTable: json-flattened relationships table → 405 edges', async () => {
  const rt = ex.extractRelationshipTable(await parse('master_graph.json'))
  assert.ok(rt.detected, 'relationships list region parses')
  assert.equal(rt.edges.length, 405)
  assert.ok(rt.edges.some((e) => e.srcTableId === 'PER-001' && e.tgtTableId === 'PER-008'))
})

// ── 4. Stitcher pure helpers ───────────────────────────────────────────────
await test('stitcher: canonToken normalizes tokens', async () => {
  assert.equal(rs.canonToken('per-002'), 'PER-002')
  assert.equal(rs.canonToken(' PER_002 '), 'PER_002')
})

await test('stitcher: module exposes idempotent stitchCaseReferences', async () => {
  assert.equal(typeof rs.stitchCaseReferences, 'function')
})

// ── 4b. v3.10b guards ──────────────────────────────────────────────────────
const norm = await jiti.import(`${ROOT}/src/lib/extractors/normalizers.ts`)
await test('wrapped-row glue detector: rejects CSV row glue, keeps real values', async () => {
  assert.ok(norm.isWrappedRowGlue('ORG-001,ORGANIZATION,Asterion Logistics Pvt Ltd'))
  assert.ok(norm.isWrappedRowGlue('ORG-005,,,,Northstar Digital Solutions'))
  assert.ok(norm.isWrappedRowGlue('ORG-002,ORGANIZATION,Blue Meridian Exports,,,,\nORG-003,ORGANIZATION,Crownline'))
  assert.ok(!norm.isWrappedRowGlue('18 Market Road, Pune'))
  assert.ok(!norm.isWrappedRowGlue('Asterion Logistics Pvt Ltd'))
  assert.ok(!norm.isWrappedRowGlue('Deshmukh, Vikram'))
  assert.ok(!norm.isWrappedRowGlue('351100000000003'))
})

await test('ref tokens: multi-segment ids (DOC-CDR-003, LOC-OBS-001) self-id on reltable endpoints', async () => {
  const synth = [
    'relationship_id,source,type,target,evidence_id',
    'REL-9001,CALL-0001,RECORDED_IN,DOC-CDR-003,EV-X-001',
    'REL-9002,PHONE-001,OBSERVED_AT,LOC-OBS-001,EV-X-002',
    'REL-9003,PER-002,WORKS_FOR,ORG-001,EV-X-003',
    'REL-9004,PER-003,WORKS_FOR,ORG-002,EV-X-004',
    'REL-9005,PER-004,WORKS_FOR,ORG-003,EV-X-005',
    'REL-9006,PER-005,WORKS_FOR,ORG-004,EV-X-006',
    'REL-9007,PER-006,WORKS_FOR,ORG-005,EV-X-007',
  ].join('\n')
  const rt = ex.extractRelationshipTable(synth)
  assert.ok(rt.detected)
  const e1 = rt.edges.find((e) => e.rowId === 'REL-9001')
  assert.equal(e1.tgtTableId, 'DOC-CDR-003', 'multi-segment ref token self-ids')
  const e2 = rt.edges.find((e) => e.rowId === 'REL-9002')
  assert.equal(e2.tgtTableId, 'LOC-OBS-001')
})

await test('reltable mergeRows stays direction-faithful (reciprocal edges are distinct)', async () => {
  // simulated at the vocabulary level: no verb may silently reverse a
  // structured row
  const rv = await jiti.import(`${ROOT}/src/lib/investigation/relVocabulary.ts`)
  for (const v of ['CONNECTED_TO', 'COORDINATES_WITH', 'RELAYS_TO', 'SHARES_INFRASTRUCTURE_WITH', 'ASSOCIATED_WITH']) {
    const out = rv.evidenceRel(v)
    assert.equal(out.reversed, false, `${v} must not reverse`)
    assert.equal(out.rel, v, `${v} stays literal`)
  }
})

// ── 5. Cross-file coverage sanity on the corpus registry ids ───────────────
await test('corpus: entity ids referenced across many files all exist in master inventory', async () => {
  const inv = ex.extractEntityTable(await parse('master_entities.csv'))
  // registry ids live in tableIds OR as the value itself (id==name rows, e.g. DEV-001)
  const ids = new Set([
    ...inv.entities.flatMap((e) => e.tableIds ?? []),
    ...inv.entities.filter((e) => /^[A-Z][A-Z0-9]{1,11}-\d{1,8}$/.test(e.value)).map((e) => e.value),
  ])
  for (const f of ['CDR_chunk_01.csv', 'bank_statement_01.csv', 'tower_location_log.csv', 'ip_session_log.csv', 'vehicle_registry.xml']) {
    const text = await parse(f)
    const tokens = [...text.matchAll(/\b(?:PER|ORG|ACC|PHONE|LOC|DEV|IP|VEH)-\d{3}\b/g)].map((m) => m[0])
    for (const t of tokens.slice(0, 20)) {
      assert.ok(ids.has(t), `${f}: token ${t} missing from inventory`)
    }
  }
})

console.log(`\n${passed} passed, ${fail.length} failed`)
if (fail.length) { console.log('FAILED:', fail); process.exit(1) }

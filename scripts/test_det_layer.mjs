/** Run the full deterministic layer on the FIX-1 flattened DOCX text. */
import { createJiti } from 'jiti'
import { readFileSync } from 'fs'
import path from 'path'

const ROOT = '/home/z/my-project/red-justice/red-justice'
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(ROOT, 'src') } })
const ex = await jiti.import(`${ROOT}/src/lib/extractors/index.ts`)
const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')

const relTable = ex.extractRelationshipTable(text)
console.log('== extractRelationshipTable ==')
console.log('detected:', relTable.detected, '| delimiter:', JSON.stringify(relTable.delimiter), '| rows:', relTable.rowCount, '| edges:', relTable.edges.length, '| entities:', relTable.entities.length, '| coverage:', relTable.coverage?.toFixed(2))
if (relTable.edges[0]) console.log('edge0:', JSON.stringify({ from: relTable.edges[0].from, rel: relTable.edges[0].rel, to: relTable.edges[0].to, state: relTable.edges[0].state, srcTableId: relTable.edges[0].srcTableId }))

const reg = ex.extractRegistry(text)
console.log('== extractRegistry ==')
console.log('stats:', JSON.stringify(reg.stats), '| entities:', reg.entities.length, '| relationships:', reg.relationships.length)
if (reg.entities[0]) console.log('ent0:', JSON.stringify(reg.entities[0]).slice(0, 220))
if (reg.relationships[0]) console.log('rel0:', JSON.stringify(reg.relationships[0]).slice(0, 220))

const flat = ex.extractEntities(text, { skipDateSpans: reg.consumedDateSpans })
console.log('== extractEntities (flat regex) ==')
console.log('count:', flat.length)
const byType = {}
for (const e of flat) byType[e.type] = (byType[e.type] ?? 0) + 1
console.log('by type:', JSON.stringify(byType))

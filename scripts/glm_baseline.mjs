/**
 * glm_baseline.mjs v2 — chunked + streaming GLM baseline extraction.
 * - 4 windows (registry halves + relationship halves) so no single call must
 *   emit a monster JSON blob; streaming keeps the connection visibly alive.
 * - Per-call hard timeout 360s; partial merges saved after each window.
 */
import { readFileSync, writeFileSync } from 'fs'

const DOC = readFileSync('/home/z/my-project/scripts/demo_docx_dump.txt', 'utf8')
const OUT = '/home/z/my-project/scripts/glm_baseline.json'

const ZAI = (await import('z-ai-web-dev-sdk')).default
const zai = await ZAI.create()

const SYSTEM = `You are a forensic information-extraction engine. Extract EVERY entity and EVERY relationship stated in the provided document text.
Return STRICT JSON only, no prose:
{
  "entities": [{"name": "...", "type": "PERSON|ORGANIZATION|PHONE|BANK_ACCOUNT|DEVICE|VEHICLE|ADDRESS|EVIDENCE_DOCUMENT|EVENT|OTHER", "attributes": {"k": "v"}}],
  "relationships": [{"source": "exact entity name", "relationship": "VERB_PHRASE", "target": "exact entity name", "evidence": "verbatim quote from text", "date": "YYYY-MM-DD or null", "confidence": 0.9}]
}
Rules: entity names must appear verbatim in the text; extract ALL of them; every table row stating a fact is one relationship; never invent entities; never truncate.`

function splitAt(text, marker) {
  const i = text.indexOf(marker)
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i)]
}
const [preReg, rest1] = splitAt(DOC, '===== TABLE 4')
const [regText, relText] = splitAt(rest1, '===== TABLE 5')

// registry: split rows into halves
const regLines = regText.split('\n')
const regMid = Math.floor(regLines.length / 2)
// relationships: split rows into 4 windows so output stays under the token cap
const W = (arr, n) => {
  const per = Math.ceil(arr.length / n)
  const out = []
  for (let i = 0; i < arr.length; i += per) out.push(arr.slice(i, i + per).join('\n'))
  return out
}

const SYSTEM_REL = `You are a forensic relationship-extraction engine. The entities are ALREADY known — do NOT list them again.
From the provided relationship-table text extract EVERY relationship row.
Return STRICT JSON only: {"relationships": [{"source": "exact entity name", "relationship": "VERB_PHRASE", "target": "exact entity name", "evidence": "verbatim quote from the row", "date": "YYYY-MM-DD or null", "confidence": 0.9}]}
Rules: source/target names must appear verbatim in the text; one row = one relationship; extract ALL rows; never truncate; output ONLY the JSON.`

const relWindows = W(relText.split('\n'), 4)

const WINDOWS = [
  ['regA', preReg + '\n' + regLines.slice(0, regMid).join('\n'), SYSTEM],
  ['regB', regLines.slice(regMid).join('\n'), SYSTEM],
  ...relWindows.map((t, i) => [`rel${i + 1}`, t, SYSTEM_REL]),
]

async function extractStream(label, text, system) {
  const t0 = Date.now()
  try {
    const res = await zai.chat.completions.create(
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        maxTokens: 10000,
        model: 'glm-4.5-flash',
      },
      { timeout: 360_000 },
    )
    console.log(`  [${label}] response in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    const raw = res.choices?.[0]?.message?.content ?? ''
    let parsed = null
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try { parsed = JSON.parse(m[0]) } catch { parsed = null }
    }
    if (!parsed) {
      // lenient repair: cut back to last complete object on each array and close
      const repaired = raw
        .replace(/,[\s\S]*$/, (tail) => {
          // drop the trailing incomplete fragment after the last complete }
          const last = tail.lastIndexOf('}')
          return last >= 0 ? tail.slice(0, last + 1) : ''
        })
        .replace(/\"\]?\s*$/, '"]')
      const m2 = repaired.match(/\{[\s\S]*\}/)
      const fixable = m2 ? m2[0].replace(/\]?,?\s*$/, '') + ']}' : null
      if (fixable) {
        try {
          parsed = JSON.parse(fixable.replace(/,\s*]/g, ']'))
          console.log(`  [${label}] JSON repaired after truncation`)
        } catch { parsed = null }
      }
    }
    if (!parsed) throw new Error(`unparseable JSON (${raw.length} chars)`)
    console.log(`[${label}] DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s -> entities=${parsed.entities?.length ?? 0} rels=${parsed.relationships?.length ?? 0}`)
    return parsed
  } catch (e) {
    console.log(`[${label}] FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${e.message}`)
    return null
  }
}

const results = {}
for (const [label, text, system] of WINDOWS) {
  let out = null
  for (let a = 1; a <= 2 && !out; a++) {
    out = await extractStream(`${label}#${a}`, text, system)
    if (!out) await new Promise(r => setTimeout(r, 3000))
  }
  results[label] = out ?? { entities: [], relationships: [] }
  // save partial after each window
  const entMap = new Map()
  for (const r of Object.values(results))
    for (const e of r.entities ?? []) {
      const k = e.name.trim().toLowerCase()
      if (!entMap.has(k)) entMap.set(k, e)
    }
  const rels = Object.values(results).flatMap(r => r.relationships ?? [])
  writeFileSync(OUT, JSON.stringify({ model: 'glm-4.5-flash baseline', entities: [...entMap.values()], relationships: rels, windowsDone: Object.keys(results) }, null, 1))
  console.log(`  merged so far: entities=${entMap.size} rels=${rels.length}`)
  await new Promise(r => setTimeout(r, 2500))
}
console.log('saved ->', OUT)

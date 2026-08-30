/** Verify the table-aware docxToText flattening on the real demo DOCX. */
import { createJiti } from 'jiti'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

const ROOT = '/home/z/my-project/red-justice/red-justice'
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(ROOT, 'src') } })
const { parseFile } = await jiti.import(`${ROOT}/src/lib/extractors/fileParser.ts`)

const bytes = new Uint8Array(readFileSync('/home/z/my-project/upload/red_justice_demo.docx'))
const parsed = await parseFile('red_justice_demo.docx', bytes)
const text = parsed.text
writeFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', text)

const lines = text.split('\n').filter((l) => l.trim())
const f = (n) => lines.filter((l) => l.split('|').filter((p) => p.trim()).length === n).length
console.log('chars:', text.length, '| non-empty lines:', lines.length)
console.log('4-field lines:', f(4), '| 8-field lines:', f(8))
console.log('--- first registry rows ---')
console.log(lines.filter((l) => l.startsWith('E00')).slice(0, 2).join('\n'))
console.log('--- first rel rows ---')
console.log(lines.filter((l) => l.startsWith('R00')).slice(0, 2).join('\n'))
console.log('--- transition zone ---')
const i = text.indexOf('5. Relationship Registry')
console.log(JSON.stringify(text.slice(i, i + 320)))

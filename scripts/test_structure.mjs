/** Check detectDocumentStructure + chunk plan on the fixed text. */
import { createJiti } from 'jiti'
import { readFileSync } from 'fs'
import path from 'path'

const ROOT = '/home/z/my-project/red-justice/red-justice'
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(ROOT, 'src') } })
const ai = await jiti.import(`${ROOT}/src/lib/investigation/aiScan.ts`)

const text = readFileSync('/home/z/my-project/scripts/demo_parsed_v391.txt', 'utf8')
const st = ai.detectDocumentStructure(text)
console.log('structure verdict:', JSON.stringify(st, null, 1).slice(0, 500))

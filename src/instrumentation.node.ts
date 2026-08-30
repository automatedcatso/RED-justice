/**
 * instrumentation.node.ts — Node.js-only startup bootstrap.
 *
 * This module is imported exclusively from instrumentation.ts behind a
 * `NEXT_RUNTIME === 'nodejs'` guard, so it is only ever bundled into the
 * Node.js server build. Edge Runtime never sees this file.
 *
 * What it does:
 *
 * 1. Loads .env manually, because the standalone production server does
 *    NOT load .env automatically (unlike `next dev` / `next start`). This
 *    makes configuration (DATABASE_URL, LOCAL_AI_BASE_URL, GEMINI_API_KEY,
 *    …) work identically in development and production.
 *    Existing process env vars always win — deployment overrides are kept.
 *
 * 2. Fixes relative SQLite DATABASE_URLs, e.g. `file:./db/custom.db`.
 *    In standalone mode the server chdir's into `.next/standalone`, so a
 *    relative path would otherwise resolve there and fail with Prisma
 *    "Error code 14: Unable to open the database file". We re-anchor the
 *    path exactly the way the Prisma CLI does when running
 *    `prisma db push`: relative to the schema.prisma directory.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Max levels walked up from CWD when searching for project markers. */
const MAX_WALK_UP = 6

/**
 * True when `dir` sits anywhere inside a `.next` build artifact.
 * Standalone output bundles copies of package.json / prisma/schema.prisma /
 * even .env, so marker searches must never match inside it — otherwise we
 * would anchor DATABASE_URL against the build output instead of the project.
 */
function isInsideBuildArtifact(dir: string): boolean {
  return dir.split(/[\\/]/).includes('.next')
}

function findMarkerFile(marker: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i <= MAX_WALK_UP; i++) {
    const candidate = path.join(dir, marker)
    if (!isInsideBuildArtifact(dir) && fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function parseAndApplyEnvFile(envPath: string): void {
  const content = fs.readFileSync(envPath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    // Strip inline comments outside quotes.
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hashIdx = val.indexOf(' #')
      if (hashIdx >= 0) val = val.slice(0, hashIdx).trim()
    }
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = val
    }
  }
}

/**
 * Re-anchor a relative SQLite `file:` DATABASE_URL so it points at the same
 * file `prisma db push` would have created — i.e. relative to the directory
 * containing schema.prisma. Absolute URLs are left untouched.
 */
function normalizeSqliteUrl(): void {
  const url = process.env.DATABASE_URL
  if (!url) return
  if (!/^file:/i.test(url)) return

  let filePath = url.slice('file:'.length)
  let suffix = ''
  const qIdx = filePath.indexOf('?')
  if (qIdx >= 0) {
    suffix = filePath.slice(qIdx)
    filePath = filePath.slice(0, qIdx)
  }
  if (path.isAbsolute(filePath)) return

  // Locate the project root (walk up past any .next artifact for .env /
  // package.json), then the Prisma schema directory — the CLI's reference
  // point for relative paths.
  let baseDir: string | null = null
  const envPath = findMarkerFile('.env')
  if (envPath) baseDir = path.dirname(envPath)
  if (!baseDir) {
    const pkgPath = findMarkerFile('package.json')
    if (pkgPath) baseDir = path.dirname(pkgPath)
  }
  if (!baseDir) return

  const schemaPath = path.join(baseDir, 'prisma', 'schema.prisma')
  const anchorDir = fs.existsSync(schemaPath)
    ? path.join(baseDir, 'prisma')
    : baseDir

  const absolutePath = path.resolve(anchorDir, filePath)
  // Best-effort: make sure the parent directory exists so the engine can
  // create/open the file even on a fresh checkout (prevents code 14).
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  } catch {
    // Non-fatal: the engine may still create directories itself.
  }

  process.env.DATABASE_URL = 'file:' + absolutePath + suffix
}

/**
 * Runs once on Node.js server startup (dev + production standalone).
 * Best-effort by design: any failure here must NEVER block boot.
 */
export function registerNodeRuntime(): void {
  try {
    const envPath = findMarkerFile('.env')
    if (envPath) parseAndApplyEnvFile(envPath)
  } catch {
    // Best effort — never block server startup because of .env loading.
  }
  try {
    normalizeSqliteUrl()
  } catch {
    // Best effort — never block server startup because of URL fixing.
  }
}

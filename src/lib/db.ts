import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

/**
 * Absolutize relative SQLite database URLs.
 *
 * Prisma's CLI resolves relative `file:./...` paths against the schema
 * directory (prisma/), and the dev-time client matches that behaviour — but
 * the standalone production bundle (`.next/standalone/server.js`) chdir's
 * into `.next/standalone` and resolves them against its own internal
 * node_modules, which silently creates/reads the WRONG database file.
 *
 * We normalize here: find the project root (the nearest ancestor containing
 * prisma/schema.prisma) and resolve any relative `file:` path against
 * `<root>/prisma` — exactly where `prisma db push` writes. Absolute paths
 * (Docker: file:/app/db/red-justice.db) are untouched.
 */
function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function absolutizeDbUrl(url: string): string {
  if (!url.startsWith('file:')) return url
  const p = url.slice(5)
  if (path.isAbsolute(p)) return url
  return 'file:' + path.join(findProjectRoot(), 'prisma', p)
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: absolutizeDbUrl(process.env.DATABASE_URL ?? 'file:./db/custom.db'),
    // Disable query logging in dev to reduce memory/stdout pressure.
    // Enable only when explicitly debugging via DEBUG=prisma:query env var.
    log: process.env.DEBUG_PRISMA ? ['query', 'error', 'warn'] : ['error', 'warn'],
  })

// v3.7.1 WAL + busy timeout: the scan pipeline writes thousands of entities /
// edges / links sequentially. In the default rollback-journal mode every write
// takes an exclusive database lock and fsyncs, so a big bank-trail scan made
// the ENTIRE app (status polls, graph view, any request touching SQLite) hang
// for minutes — "offline mode is broken". WAL lets readers proceed on the last
// committed snapshot while the scan writes; busy_timeout absorbs the short
// end-of-transaction commits instead of erroring with SQLITE_BUSY.
// journal_mode persists in the database file; both pragmas are idempotent.
// NOTE (v3.7.2): BOTH statements RETURN a row, so BOTH must go through
// $queryRaw — $executeRawUnsafe rejects any statement that returns results.
// journal_mode returns the new mode; busy_timeout's SET form returns the new
// value too (SQLite returnSingleInt), which made the v3.7.1 $executeRawUnsafe
// call fail with "Execute returned results" on every boot and silently left
// busy_timeout unset.
void db
  .$queryRaw`PRAGMA journal_mode=WAL;`
  .catch(() => undefined)
  .then(() => db.$queryRaw`PRAGMA busy_timeout=10000;`.catch(() => undefined))

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

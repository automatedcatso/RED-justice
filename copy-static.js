/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * copy-static.js — Cross-platform static file copier.
 *
 * Copies .next/static and public/ into .next/standalone/ so the
 * production server can serve static assets. Uses Node.js fs
 * (no Unix `cp` dependency — works on Windows, macOS, and Linux).
 */
const { cpSync, existsSync, mkdirSync } = require('fs')
const { join } = require('path')

const root = process.cwd()
const standaloneDir = join(root, '.next', 'standalone')

if (!existsSync(standaloneDir)) {
  console.log('[copy-static] .next/standalone not found — skipping copy')
  process.exit(0)
}

// Copy .next/static → .next/standalone/.next/static
const staticSrc = join(root, '.next', 'static')
const staticDst = join(standaloneDir, '.next', 'static')
if (existsSync(staticSrc)) {
  mkdirSync(join(standaloneDir, '.next'), { recursive: true })
  cpSync(staticSrc, staticDst, { recursive: true })
  console.log('[copy-static] Copied .next/static → .next/standalone/.next/static')
}

// Copy public → .next/standalone/public
const publicSrc = join(root, 'public')
const publicDst = join(standaloneDir, 'public')
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDst, { recursive: true })
  console.log('[copy-static] Copied public → .next/standalone/public')
}

console.log('[copy-static] Done')

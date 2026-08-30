/**
 * instrumentation.ts — Next.js startup hook (register).
 *
 * IMPORTANT: Next.js compiles this file for BOTH server runtimes
 * (Node.js AND Edge). Therefore this file must stay 100% runtime-neutral:
 * no `fs`, no `path`, no `process.cwd()`, no other Node-only APIs.
 *
 * All Node-only startup logic lives in ./instrumentation.node and is loaded
 * through a NEXT_RUNTIME-guarded dynamic import. At build time Next.js
 * inlines NEXT_RUNTIME as a compile-time constant per runtime bundle, so
 * bundlers tree-shake the branch away — the Edge bundle never includes or
 * analyzes the Node module, which eliminates the false-positive
 * "A Node.js API is used ... not supported in the Edge Runtime" warnings.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const node = await import('./instrumentation.node')
    node.registerNodeRuntime()
  }
}

// dsh-plugin-tool-prefetch/interceptor.js — PROBE (v2 step 1)
//
// Minimal, behavior-neutral probe for dsh's tool-execution hooks. It registers
// for `tools/pre-execute` and `tools/result` and ONLY writes what it sees to a
// log file. It never blocks, never changes a decision, never calls the gateway.
//
// Purpose: answer three questions the docs leave open before we build the real
// transparent-interceptor version:
//   1. does ctx.on('tools/pre-execute', fn) fire at all, and with what args?
//   2. what identity does exec.agent carry (can we group calls into sessions)?
//   3. what happens if we do NOT call next() (must we always call it)?
//
// Enable by pointing the plugin config at mode: "interceptor" (or run this file
// standalone via smoke-style harness). Output: <repoRoot>/mcp_prefetch_gateway/logs/probe.log

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function makeLogger(repoRoot) {
  const logPath = resolve(repoRoot, 'mcp_prefetch_gateway', 'logs', 'probe.log')
  try {
    mkdirSync(dirname(logPath), { recursive: true })
  } catch {}
  return (event, data) => {
    const line = JSON.stringify({ ts: Date.now() / 1000, event, ...data }) + '\n'
    try {
      appendFileSync(logPath, line)
    } catch {}
    return line.trim()
  }
}

// Describe whatever an exec/agent object exposes without assuming its shape.
function describe(value, depth = 0) {
  if (value == null) return value
  const t = typeof value
  if (t === 'string') return value.length > 120 ? value.slice(0, 120) + '…' : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'function') return `[fn ${value.name || 'anonymous'}]`
  if (Array.isArray(value)) return depth > 1 ? `[array(${value.length})]` : value.slice(0, 3).map((v) => describe(v, depth + 1))
  if (t === 'object') {
    if (depth > 1) return '[obj]'
    const out = {}
    for (const k of Object.keys(value).slice(0, 20)) {
      // skip big/cyclic-ish fields but record their presence
      if (k === 'signal' || k === 'schema' || k === 'toolSet') { out[k] = `[${typeof value[k]}]`; continue }
      try { out[k] = describe(value[k], depth + 1) } catch { out[k] = '[unreadable]' }
    }
    return out
  }
  return String(value)
}

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const repoRoot = config.repoRoot ? resolve(config.repoRoot) : process.cwd()
  const log = makeLogger(repoRoot)
  const logMeta = ctx.logger || console
  const seen = { pre: 0, result: 0, errors: 0 }

  log('probe_start', { repoRoot })
  logMeta.info?.(`[tool-prefetch/probe] logging to ${resolve(repoRoot, 'mcp_prefetch_gateway', 'logs', 'probe.log')}`)

  // ---- hook 1: pre-execute (waterfall) -------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    seen.pre += 1
    try {
      log('pre_execute', {
        n: seen.pre,
        name: exec?.name,
        args: describe(exec?.arguments),
        callId: describe(exec?.callId),
        rootCallId: describe(exec?.rootCallId),
        hasAgent: exec?.agent != null,
        agent: describe(exec?.agent),
        keys: exec ? Object.keys(exec).slice(0, 25) : [],
      })
    } catch (err) {
      seen.errors += 1
      log('pre_execute_error', { message: String(err && err.message) })
    }
    // CRITICAL PROBE: we deliberately call next() unchanged and observe the
    // default decision, so this hook cannot alter behaviour.
    return next()
  })

  // ---- hook 2: result (emit) ----------------------------------------------
  try {
    ctx.on('tools/result', (exec, result) => {
      seen.result += 1
      try {
        log('result', {
          n: seen.result,
          name: exec?.name,
          isError: result?.isError,
          contentBlocks: Array.isArray(result?.content) ? result.content.length : null,
          contentPreview: describe(result?.content?.[0]?.text ?? result?.content),
          error: describe(result?.error),
        })
      } catch (err) {
        seen.errors += 1
      }
      // emit mode: return value is ignored
    })
  } catch (err) {
    log('result_hook_register_failed', { message: String(err && err.message) })
  }

  ctx.on('dispose', () => {
    log('probe_stop', { seen })
  })

  return Promise.resolve()
}

export default apply

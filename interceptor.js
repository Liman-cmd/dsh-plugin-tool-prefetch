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

// Deep structural walk of a value: records property names + shallow previews so
// we can discover what exec.agent (and its session) actually expose. Bounded so
// a cyclic or huge object can never hang the probe.
function walk(value, depth = 0, maxDepth = 4, seen = new Set()) {
  if (value == null) return value
  const t = typeof value
  if (t === 'string') return value.length > 160 ? value.slice(0, 160) + '…' : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'function') return `[fn ${value.name || 'anonymous'}]`
  if (t !== 'object') return String(value)
  if (seen.has(value)) return '[cycle]'
  if (depth >= maxDepth) return `[${Array.isArray(value) ? 'array' : 'obj'}]`
  seen.add(value)
  if (Array.isArray(value)) {
    return { __array: value.length, sample: value.slice(0, 2).map((v) => walk(v, depth + 1, maxDepth, seen)) }
  }
  const out = {}
  let keys = []
  try { keys = Object.getOwnPropertyNames(value) } catch {}
  // also walk the prototype chain one level (getters often live there)
  try {
    const proto = Object.getPrototypeOf(value)
    if (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k !== 'constructor' && !keys.includes(k)) keys.push(`${k}~(proto)`)
      }
    }
  } catch {}
  for (const k of keys.slice(0, 40)) {
    const realKey = k.replace('~(proto)', '')
    if (k === 'signal' || k === 'toolSet') { out[k] = `[${typeof value[realKey]}]`; continue }
    try {
      const v = value[realKey]
      out[k] = typeof v === 'function' ? `[fn ${v.name || 'anonymous'}]` : walk(v, depth + 1, maxDepth, seen)
    } catch (err) {
      out[k] = `[threw: ${err && err.message}]`
    }
  }
  return out
}

// Try hard to read the latest user message out of whatever the agent/session
// exposes. Returns {found, text, fromPath} so the log tells us WHICH path worked.
function findUserText(agent) {
  if (!agent) return { found: false, text: null, fromPath: null }
  const candidates = []
  const push = (path, val) => candidates.push([path, val])
  try {
    push('agent.messages', agent.messages)
    push('agent.session.messages', agent.session?.messages)
    push('agent.session.events', agent.session?.events)
    push('agent.history', agent.history)
    push('agent.context', agent.context)
  } catch {}

  for (const [path, arr] of candidates) {
    if (!Array.isArray(arr) || !arr.length) continue
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]
      const role = m?.role ?? m?.kind ?? m?.type ?? m?.source
      if (role !== 'user' && role !== 'human' && role !== 'userMessage') continue
      const text = m?.content ?? m?.text ?? m?.value ?? m?.message
      const s = typeof text === 'string' ? text : JSON.stringify(text)
      if (s && s.length) return { found: true, text: s.slice(0, 300), fromPath: `${path}[${i}]` }
    }
  }
  return { found: false, text: null, fromPath: null }
}

export function apply(ctx, config = {}) {
  const repoRoot = config.repoRoot ? resolve(config.repoRoot) : process.cwd()
  const log = makeLogger(repoRoot)
  const logMeta = ctx.logger || console
  const seen = { pre: 0, result: 0, errors: 0, agentEvents: {} }
  let agentDeepDumped = false

  log('probe_start', { repoRoot })
  logMeta.info?.(`[tool-prefetch/probe] logging to ${resolve(repoRoot, 'mcp_prefetch_gateway', 'logs', 'probe.log')}`)

  // ---- discover which agent/session events exist and what they carry --------
  // Cordis `ctx.on` accepts unknown event names; we register a broad set and
  // record only the ones that actually fire.
  for (const ev of [
    'agent/created', 'agent/resumed', 'agent/message', 'agent/user-message',
    'agent/step', 'agent/turn', 'agent/event', 'session/message', 'session/event',
    'session/append', 'message', 'user/message',
  ]) {
    try {
      ctx.on(ev, (a, b) => {
        seen.agentEvents[ev] = (seen.agentEvents[ev] || 0) + 1
        const ua = findUserText(a)
        const ub = findUserText(b)
        log('agent_event', { event: ev, a: walk(a, 0, 3), b: walk(b, 0, 3), user: ua.found ? ua : (ub.found ? ub : null) })
      })
    } catch {}
  }

  // ---- hook 1: pre-execute (waterfall) -------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    seen.pre += 1
    try {
      const user = findUserText(exec?.agent)
      const entry = {
        n: seen.pre,
        name: exec?.name,
        args: walk(exec?.arguments, 0, 2),
        callId: walk(exec?.callId),
        hasAgent: exec?.agent != null,
        agentKeys: exec?.agent ? Object.getOwnPropertyNames(exec.agent).slice(0, 30) : [],
        userTextFound: user.found,
        userTextFrom: user.fromPath,
        userText: user.text,
      }
      // once: dump the full agent shape so we can see every reachable field
      if (!agentDeepDumped && exec?.agent) {
        agentDeepDumped = true
        entry.agentDeep = walk(exec.agent, 0, 4)
      }
      log('pre_execute', entry)
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
          contentPreview: walk(result?.content?.[0]?.text ?? result?.content, 0, 1),
          error: walk(result?.error, 0, 1),
        })
      } catch (err) {
        seen.errors += 1
      }
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

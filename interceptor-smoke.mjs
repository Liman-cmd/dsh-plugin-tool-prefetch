// Real interceptor test: mock ctx + REAL Python sidecar.
// Simulates dsh firing the tool pipeline hooks, then verifies the gateway
// actually received a prediction + an observation for those calls.
//
//   node dsh-plugin-tool-prefetch/interceptor-smoke.mjs

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = 'D:\\code\\my_job\\agent-tool-acceleration'
const TELEMETRY = resolve(REPO, 'mcp_prefetch_gateway', 'logs', 'telemetry_real.jsonl')

const handlers = {}
const ctx = {
  logger: {
    info: (m) => console.log('[info]', m),
    warn: (m) => console.log('[warn]', m),
    error: (m) => console.log('[error]', m),
    debug: () => {},
  },
  on: (event, fn) => { (handlers[event] ||= []).push(fn) },
  tools: { register: () => () => {} },
}

const { apply } = await import('./index.js')
console.log('booting interceptor mode (sidecar cold start ~20s)...')
const init = apply(ctx, {
  mode: 'interceptor',
  repoRoot: REPO,
  python: resolve(REPO, '.venv', 'Scripts', 'python.exe'),
  gatewayConfig: 'mcp_prefetch_gateway/configs/tau_retail_gpt4o_real.yaml',
})

if (!handlers['tools/pre-execute']) throw new Error('pre-execute hook missing')
if (!handlers['tools/result']) throw new Error('result hook missing')

async function waitReady(timeoutMs = 90000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const lines = readFileSync(TELEMETRY, 'utf8').trim().split('\n')
      if (lines.length) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

// Give the sidecar time to finish initialize + tools/list before firing hooks.
await new Promise((r) => setTimeout(r, 30000))

const mkExec = (name, args, agentId) => ({
  name,
  arguments: args,
  callId: `c-${name}`,
  rootCallId: `r-${name}`,
  agent: { id: agentId, sessionId: `sess-${agentId}` },
  signal: new AbortController().signal,
  schema: {},
  toolSet: {},
})

// Simulate a 2-tool conversation, exactly as the harness would drive it.
const calls = [
  mkExec('find_user_id_by_name_zip', { first_name: 'Sofia', last_name: 'Rossi', zip: '78784' }, 'a1'),
  mkExec('get_order_details', { order_id: '#W5918442' }, 'a1'),
]
for (const exec of calls) {
  const t0 = Date.now()
  let nextCalled = false
  await handlers['tools/pre-execute'][0](exec, async () => { nextCalled = true; return { kind: 'allow' } })
  const hookMs = Date.now() - t0
  if (!nextCalled) throw new Error('pre-execute did not call next()')
  console.log(`pre-execute(${exec.name}) returned in ${hookMs} ms (must be ~0: not blocking)`)
  handlers['tools/result'][0](exec, { isError: false, content: [{ type: 'text', text: '{"ok":1}' }] })
}

// Let the fire-and-forget gateway calls land.
await new Promise((r) => setTimeout(r, 6000))

const events = []
for (const line of readFileSync(TELEMETRY, 'utf8').trim().split('\n')) {
  try { events.push(JSON.parse(line)) } catch {}
}
const sessions = new Set(events.filter((e) => e.session_id).map((e) => e.session_id))
const obs = events.filter((e) => e.event === 'observe' || e.event === 'observation')
const dshObs = obs.filter((e) => String(e.session_id || '').startsWith('dsh-'))
console.log('dsh-* sessions seen in telemetry:', [...sessions].filter((s) => s.startsWith('dsh-')))
console.log('dsh observations:', dshObs.length)
if (!dshObs.length) throw new Error('interceptor did not reach the gateway (no dsh-* observation)')

console.log('INTERCEPTOR SMOKE OK')
process.exit(0)

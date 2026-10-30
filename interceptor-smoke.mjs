// Real interceptor test: mock ctx + REAL Python sidecar.
// Simulates dsh firing the tool pipeline hooks, then verifies the gateway
// actually received a prediction + an observation for those calls.
//
//   node dsh-plugin-tool-prefetch/interceptor-smoke.mjs

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = 'D:\\code\\my_job\\agent-tool-acceleration'
const TELEMETRY = resolve(REPO, 'mcp_prefetch_gateway', 'logs', 'telemetry_real.jsonl')
const USER_TEXT = 'i need to check my order W5918442 status'
const AGENT_ID = `s-u${Date.now()}`  // fresh id per run so assertions see THIS run

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

// A session log shaped like the real one, so userMsgFor() can mine the human
// turn. The injected entries come first and must NOT be picked.
const SESSION_LOG = [
  { type: 'user/message', data: { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md injected' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time context injected' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: USER_TEXT }] } },
]
const mkExec = (name, args, agentId) => ({
  name,
  arguments: args,
  callId: `c-${name}`,
  rootCallId: `r-${name}`,
  agent: { id: agentId, sessionId: `sess-${agentId}`, session: { log: SESSION_LOG } },
  signal: new AbortController().signal,
  schema: {},
  toolSet: {},
})

// Simulate a 2-tool conversation, exactly as the harness would drive it.
const calls = [
  mkExec('find_user_id_by_name_zip', { first_name: 'Sofia', last_name: 'Rossi', zip: '78784' }, AGENT_ID),
  mkExec('get_order_details', { order_id: '#W5918442' }, AGENT_ID),
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
const thisRun = events.filter((e) => e.session_id === `dsh-${AGENT_ID}`)
const sessions = new Set(events.filter((e) => e.session_id).map((e) => e.session_id))
const obs = events.filter((e) => e.event === 'observe' || e.event === 'observation')
const dshObs = thisRun.filter((e) => e.event === 'observe' || e.event === 'observation')
console.log('dsh-* sessions seen in telemetry:', [...sessions].filter((s) => s.startsWith('dsh-')))
console.log('this run observations:', dshObs.length)
if (!dshObs.length) throw new Error('interceptor did not reach the gateway (no observation)')

// The whole point of mining agent.session.log: the gateway must receive the
// REAL user message, not "" and not an injected system-reminder.
const steps = thisRun.filter((e) => e.event === 'step')
console.log('this run steps:', steps.length)
for (const s of steps) {
  console.log(`  step ${s.turn}: user_msg=${JSON.stringify(s.user_msg)}`)
}
if (!steps.length) throw new Error('no step events recorded for this run')
const withUser = steps.filter((s) => s.user_msg === USER_TEXT)
if (withUser.length !== steps.length) {
  const got = steps.map((s) => s.user_msg)
  throw new Error(`user_msg not carried to the gateway for every step: ${JSON.stringify(got)}`)
}
if (steps.some((s) => /injected/.test(String(s.user_msg)))) {
  throw new Error('injected context leaked in as the user message')
}

console.log('user_msg mined from session.log and reached the gateway: OK')
console.log('INTERCEPTOR SMOKE OK')
process.exit(0)

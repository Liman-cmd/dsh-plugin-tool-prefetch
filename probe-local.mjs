// Local probe harness — exercise the probe/interceptor code path against a mock
// ctx, no dsh needed.
//
//   node dsh-plugin-tool-prefetch/probe-local.mjs
//
// Verifies hook registration, next() passthrough, log writing, and the user-msg
// extraction from a session event log. It CANNOT verify that dsh itself fires
// these hooks — that needs the real harness (see docs/interceptor-probe.md).

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const handlers = {}
const ctx = {
  logger: { info: (s) => console.log('[info]', s), warn: () => {}, error: () => {} },
  on: (event, fn) => { (handlers[event] ||= []).push(fn) },
}

// The module under test is the one dsh actually loads. interceptor.js was an
// early parallel copy that drifted; index.js is the single source of truth.
const mod = await import('./index.js')
await mod.apply(ctx, { repoRoot: process.cwd(), mode: 'probe' })
console.log('registered hooks:', Object.keys(handlers).join(', '))
if (!handlers['tools/pre-execute']) throw new Error('pre-execute hook was NOT registered')

// A session log shaped exactly like the real one (.dsh/sessions/*.jsonl.zstd):
// injected context arrives as user/message + role:'user' but a distinct
// source.kind, so a naive role filter would grab a system-reminder.
const sessionLog = [
  { type: 'user/message', data: { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md injected' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skill list injected' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'find my order #W5918442' }] } },
  { type: 'assistant/message', data: { content: [{ type: 'text', text: 'sure' }] } },
]

const exec = {
  name: 'get_order_details',
  arguments: { order_id: '#W5918442' },
  callId: 'call-1',
  rootCallId: 'root-1',
  agent: { id: 'session-test', session: { log: sessionLog } },
  signal: new AbortController().signal,
  schema: {},
  toolSet: {},
}

let nextCalled = false
const decision = await handlers['tools/pre-execute'][0](exec, async () => {
  nextCalled = true
  return { kind: 'allow' }
})
if (!nextCalled) throw new Error('probe did not call next() — it must stay behavior-neutral')
if (decision?.kind !== 'allow') throw new Error(`unexpected decision: ${JSON.stringify(decision)}`)

handlers['tools/result'][0](exec, { isError: false, content: [{ type: 'text', text: 'ok' }] })

const logPath = resolve(process.cwd(), 'mcp_prefetch_gateway', 'logs', 'probe.log')
const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const events = lines.map((l) => l.event)
for (const want of ['pre_execute', 'result']) {
  if (!events.includes(want)) throw new Error(`missing ${want} in probe.log`)
}
const pre = [...lines].reverse().find((l) => l.event === 'pre_execute')
if (pre.name !== 'get_order_details') throw new Error('tool name not recorded')
if (pre.agentId !== 'session-test') throw new Error('agent id not recorded')

// the extraction assertions: real user text, correct path, not the injections
if (pre.sessionUserFound !== true) throw new Error('user message not extracted from session.log')
if (pre.sessionUserText !== 'find my order #W5918442') {
  throw new Error(`wrong user text extracted: ${JSON.stringify(pre.sessionUserText)}`)
}
if (!String(pre.sessionUserFrom).startsWith('agent.session.log')) {
  throw new Error(`unexpected fromPath: ${pre.sessionUserFrom}`)
}

console.log('probe.log events :', events.slice(-2).join(' -> '))
console.log('agentId          :', pre.agentId)
console.log('sessionUserFrom  :', pre.sessionUserFrom)
console.log('sessionUserText  :', JSON.stringify(pre.sessionUserText))
console.log('PROBE LOCAL OK (code path verified; harness firing was confirmed separately)')

// keep the log clean for real runs
try { rmSync(logPath) } catch {}

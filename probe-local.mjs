// Local probe harness — run the interceptor against a mock ctx, no dsh needed.
//
//   node dsh-plugin-tool-prefetch/probe-local.mjs
//
// Verifies the code path (hook registration, next() passthrough, log writing).
// It CANNOT verify that dsh itself fires these hooks — that needs the real
// harness (see docs/interceptor-probe.md).

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const handlers = {}
const ctx = {
  logger: { info: (s) => console.log('[info]', s), warn: () => {}, error: () => {} },
  on: (event, fn) => { (handlers[event] ||= []).push(fn) },
}

const mod = await import('./interceptor.js')
await mod.apply(ctx, { repoRoot: process.cwd() })
console.log('registered hooks:', Object.keys(handlers).join(', '))
if (!handlers['tools/pre-execute']) throw new Error('pre-execute hook was NOT registered')

const exec = {
  name: 'get_order_details',
  arguments: { order_id: '#W5918442' },
  callId: 'call-1',
  rootCallId: 'root-1',
  agent: { id: 'agent-7', sessionId: 'sess-42' },
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
for (const want of ['probe_start', 'pre_execute', 'result']) {
  if (!events.includes(want)) throw new Error(`missing ${want} in probe.log`)
}
const pre = lines.find((l) => l.event === 'pre_execute')
if (pre.name !== 'get_order_details') throw new Error('tool name not recorded')
if (pre.hasAgent !== true) throw new Error('agent identity not recorded')

console.log('probe.log events:', events.join(' -> '))
console.log('agent seen as:', JSON.stringify(pre.agent))
console.log('PROBE LOCAL OK (code path verified; harness firing is the remaining unknown)')

// Offline regression for the user-message extractor — no dsh, no sidecar.
//
//   node dsh-plugin-tool-prefetch/session-extract-test.mjs [session.v4.jsonl.zstd]
//
// Decodes a real dsh session event log (multi-frame zstd) and runs the exact
// extractor shipped in index.js against it. Proves two things the unit mocks
// cannot: the extractor matches the REAL event shape, and it rejects the real
// injected context (agent-instructions / runtime-context / skill-catalog /
// time-context) that shares type:user/message + role:'user'.
//
// If no path is given, it scans %USERPROFILE%\.dsh\sessions for the newest
// session.v4.jsonl.zstd.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

// ---- 1. load the extractor out of index.js (single source of truth) ---------
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(join(here, 'index.js'), 'utf8')
const a = src.indexOf('function textFromContent')
const b = src.indexOf('// Maps a dsh tool execution')
if (a < 0 || b < 0) throw new Error('extractor anchors not found in index.js')
const mod = { exports: {} }
new Function('module', src.slice(a, b) + '\nmodule.exports = { probeSession, isHumanTurn, extractUserText }')(mod)
const { probeSession } = mod.exports

// ---- 2. locate a session log ------------------------------------------------
function newestSessionLog() {
  const root = join(homedir(), '.dsh', 'sessions')
  let best = null
  for (const proj of readdirSync(root)) {
    const projDir = join(root, proj)
    if (!statSync(projDir).isDirectory()) continue
    for (const s of readdirSync(projDir)) {
      const p = join(projDir, s, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(p)
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }
      } catch {}
    }
  }
  return best?.path
}

const logPath = process.argv[2] || newestSessionLog()
if (!logPath) throw new Error('no session log found; pass a path explicitly')
console.log('session log:', logPath)

// ---- 3. decode multi-frame zstd --------------------------------------------
const buf = readFileSync(logPath)
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
let text = ''
for (let k = 0; k < starts.length; k++) {
  const from = starts[k]
  const to = k + 1 < starts.length ? starts[k + 1] : buf.length
  // zstdDecompressSync consumes one frame; slicing lets us walk them in order.
  try { text += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8') } catch { break }
}
const rows = text
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)
console.log(`frames: ${starts.length}  events: ${rows.length}`)

// ---- 4. run the real extractor ---------------------------------------------
const r = probeSession({ id: 'offline', session: { log: rows } })
console.log('\nfound   :', r.sessionUserFound)
console.log('from    :', r.sessionUserFrom)
console.log('kind    :', r.sessionUserKind)
console.log('text    :', JSON.stringify(r.sessionUserText))

// ---- 5. assertions ---------------------------------------------------------
const failures = []
const check = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures.push(label) }

console.log('\nassertions:')
check(r.sessionUserFound === true, 'extracts a user message from the real log')
check(typeof r.sessionUserKind === 'string' && r.sessionUserKind === 'user',
  `the picked event has source.kind === 'user' (got ${JSON.stringify(r.sessionUserKind)})`)
check(!/system-reminder|AGENTS\.md 本文件|runtime context|skills are available/i.test(String(r.sessionUserText)),
  'the text is not an injected system-reminder / skill catalog')

// injected-only log must yield nothing
const injected = rows.filter((e) => { const k = e?.data?.source?.kind; return k != null && k !== 'user' })
const r2 = probeSession({ id: 'x', session: { log: injected } })
check(injected.length > 0, `the log really does contain injected events (${injected.length})`)
check(r2.sessionUserFound === false, 'injected-only log is correctly rejected')

// degrade without throwing
check(probeSession(undefined).sessionUserFound === false, 'no agent -> no crash')
check(probeSession({ session: {} }).sessionUserFound === false, 'empty session -> no crash')

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log('\nSESSION EXTRACT OK')

// Standalone smoke test: runs the plugin against a mock Cordis ctx with the
// REAL Python sidecar. Verifies registration + a prediction round-trip without
// needing dsh itself.
//
//   node dsh-plugin-tool-prefetch/smoke.mjs

import { apply } from './index.js'

const registered = []
let disposed = false

const ctx = {
  logger: {
    info: (m) => console.log('[info]', m),
    warn: (m) => console.log('[warn]', m),
    error: (m) => console.log('[error]', m),
  },
  tools: {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  },
  on: (event, fn) => {
    if (event === 'dispose') disposeFn = fn
  },
}
let disposeFn = null

const config = {
  python: 'D:\\code\\my_job\\agent-tool-acceleration\\.venv\\Scripts\\python.exe',
  repoRoot: 'D:\\code\\my_job\\agent-tool-acceleration',
  gatewayConfig: 'mcp_prefetch_gateway/configs/tau_retail_gpt4o_real.yaml',
}

console.log('booting plugin (sidecar cold start ~20s)...')
await apply(ctx, config)
if (registered.length === 0) throw new Error('no tools registered')
console.log(`registered ${registered.length} tools:`, registered.map((t) => t.name).join(', '))

const byName = (n) => registered.find((t) => t.name === n)

// schema sanity: sanitized, object-rooted, required preserved
const findUser = byName('find_user_id_by_name_zip')
if (!findUser) throw new Error('find_user_id_by_name_zip missing')
console.log('schema of find_user_id_by_name_zip:', JSON.stringify(findUser.parameters))

// render sanity
const rendered = findUser.output.render({}, { ok: 1 })
if (!Array.isArray(rendered) || rendered[0].type !== 'text') throw new Error('render broken')

// execute round-trip: a real prediction through the sidecar
const predict = byName('gw_predict_next')
const value = await predict.execute(
  { session_id: 'smoke', query: 'cancel my pending order', user_msg: 'I want to cancel my pending order' },
  { signal: new AbortController().signal }
)
console.log('gw_predict_next ->', JSON.stringify(value).slice(0, 220))

// real upstream tool through the sidecar
const lookup = await findUser.execute(
  { first_name: 'Sofia', last_name: 'Rossi', zip: '78784', _gateway: { session_id: 'smoke' } },
  { signal: new AbortController().signal }
)
console.log('find_user_id_by_name_zip ->', JSON.stringify(lookup).slice(0, 160))

// stats round-trip
const stats = await byName('gw_stats').execute({}, { signal: new AbortController().signal })
console.log('gw_stats scored_pairs =', stats.scored_pairs, '| hits =', JSON.stringify(stats.hits))

disposeFn?.()
console.log('SMOKE OK')
process.exit(0)

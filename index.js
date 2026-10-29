// dsh-plugin-tool-prefetch — bridge the CT-GNN prefetch gateway into dsh.
//
// Four modes (config.mode; default "tools"):
//
//   tools        (v1) register every gateway tool via ctx.tools.register.
//                     The model sees and calls them explicitly. Data capture
//                     depends on the agent passing _gateway/history.
//
//   probe        Register NOTHING and change NOTHING; only hook the tool
//                pipeline and log what the hooks deliver. Used once to verify
//                that dsh fires these events and what exec.agent carries.
//
//   interceptor  Register no tools. Hook tools/pre-execute + tools/result and,
//                fully asynchronously (never blocking the call), report every
//                execution to the gateway so it scores predictions and warms
//                the next-step tiers. Zero model tokens, zero agent cooperation
//                -- prediction happens while the model is still writing.
//
//   both         interceptor + register only the gw_* tools (so a user can
//                still query stats/model status by hand).
//
// All modes that talk to the gateway spawn the SAME Python sidecar and speak
// newline-delimited JSON-RPC 2.0 on its stdio.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const inject = ['tools']

// JsonSchema keywords accepted by dsh's enforced subset; anything else is
// stripped instead of being rejected at registration.
const SUPPORTED_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'additionalProperties',
  'enum', 'const', 'description', 'title', 'default', 'examples', 'oneOf',
])

function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema)
  if (!node || typeof node !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, sanitizeSchema(v)])
      )
    } else if (key === 'items') {
      out.items = sanitizeSchema(value)
    } else if (key === 'additionalProperties') {
      out.additionalProperties = value === true // only boolean form is supported
    } else if (key === 'oneOf' && Array.isArray(value)) {
      out.oneOf = value.map(sanitizeSchema)
    } else {
      out[key] = value
    }
  }
  return out
}

class Sidecar {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.proc = null
    this.pending = new Map()
    this.buffer = ''
    this.nextId = 1
    this.dead = false
    this.ready = false  // true once initialize + tools/list succeeded
  }

  start() {
    const args = ['-m', 'mcp_prefetch_gateway.cli', 'rpc', '--config', this.cfg.gatewayConfig]
    this.proc = spawn(this.cfg.python, args, {
      cwd: this.cfg.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk) => this._onChunk(chunk))
    this.proc.stderr.setEncoding('utf-8')
    this.proc.stderr.on('data', (chunk) => this.log.info?.(String(chunk).trim()))
    this.proc.on('exit', (code) => {
      this.dead = true
      const err = new Error(`gateway sidecar exited (code ${code})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }

  _onChunk(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          if (msg.error) waiter.reject(new Error(msg.error.message || 'sidecar error'))
          else waiter.resolve(msg.result ?? {})
        }
      } catch {
        this.log.warn?.(`unparsable sidecar line: ${line.slice(0, 120)}`)
      }
    }
  }

  request(method, params, timeoutMs) {
    if (this.dead) return Promise.reject(new Error('gateway sidecar is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  kill() {
    this.dead = true
    if (!this.proc) return
    try { this.proc.stdin.end() } catch {}
    this.proc.kill()
  }
}

function mcpResultToValue(result) {
  if (result && typeof result === 'object' && 'structuredContent' in result) {
    return result.structuredContent
  }
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    const text = result.content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    try { return JSON.parse(text) } catch { return { text } }
  }
  return result ?? {}
}

// Best-effort text of a tool result, capped like the gateway's own summaries.
function summarizeContent(result, maxChars = 200) {
  try {
    if (!result) return ''
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
      if (text) return text.slice(0, maxChars)
    }
    if (result.error) return String(result.error.message ?? result.error).slice(0, maxChars)
    return JSON.stringify(mcpResultToValue(result)).slice(0, maxChars)
  } catch {
    return ''
  }
}

// Safe structural description for probe logging (never throws, never recurses deep).
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
      if (k === 'signal' || k === 'schema' || k === 'toolSet') { out[k] = `[${typeof value[k]}]`; continue }
      try { out[k] = describe(value[k], depth + 1) } catch { out[k] = '[unreadable]' }
    }
    return out
  }
  return String(value)
}

// Maps a dsh tool execution to a gateway session id, so interceptor-mode calls
// group into conversations. `exec.agent` is the documented identity carrier;
// the probe run confirms its exact shape, and we fall back to a time-window
// bucket when it is absent so a missing field degrades instead of breaking.
class SessionScope {
  constructor(cfg) {
    this.cfg = cfg
    this.byAgent = new Map()
    this.windowId = null
    this.windowStart = 0
    this.WINDOW_MS = 10 * 60 * 1000  // 10-minute conversation window fallback
    this.lastUserMsg = null
  }

  idFor(exec) {
    if (this.cfg.sessionFrom === 'agent') {
      const agent = exec?.agent
      const key = agent?.id ?? agent?.sessionId ?? agent?.session?.id ?? agent?.name
      if (key != null) {
        const s = String(key)
        if (!this.byAgent.has(s)) this.byAgent.set(s, `dsh-${s}`)
        return this.byAgent.get(s)
      }
    }
    const now = Date.now()
    if (!this.windowId || now - this.windowStart > this.WINDOW_MS) {
      this.windowId = `dsh-w${Math.floor(now / this.WINDOW_MS)}`
      this.windowStart = now
    }
    return this.windowId
  }

  userMsgFor(exec) {
    // dsh does not hand us the user's text here; the gateway keeps the last
    // known user_msg per session from gw_observe history, so returning null
    // leaves that intact rather than overwriting it with nothing.
    return null
  }

  latencyFor(_exec) {
    return null  // measured inside the gateway when it needs to
  }
}

export function apply(ctx, config = {}) {
  const cfg = {
    mode: String(config.mode || 'tools').toLowerCase(),
    python: config.python || 'python',
    repoRoot: config.repoRoot ? resolve(config.repoRoot) : process.cwd(),
    gatewayConfig: '',
    toolPrefix: config.toolPrefix ?? '',
    initTimeoutMs: config.initTimeoutMs || 60000,
    callTimeoutMs: config.callTimeoutMs || 120000,
    // interceptor: how to derive a session id from the tool execution
    sessionFrom: config.sessionFrom || 'agent',  // 'agent' | 'none'
  }
  cfg.gatewayConfig = isAbsolute(config.gatewayConfig || '')
    ? config.gatewayConfig
    : join(cfg.repoRoot, config.gatewayConfig || 'mcp_prefetch_gateway/configs/tau_retail_gpt4o_real.yaml')

  const log = ctx.logger || console
  const MODES = new Set(['tools', 'probe', 'interceptor', 'both'])
  if (!MODES.has(cfg.mode)) {
    log.warn?.(`[tool-prefetch] unknown mode "${cfg.mode}"; falling back to "tools"`)
    cfg.mode = 'tools'
  }
  const registerTools = cfg.mode === 'tools' || cfg.mode === 'both'
  const hookPipeline = cfg.mode === 'probe' || cfg.mode === 'interceptor' || cfg.mode === 'both'
  const onlyGwTools = cfg.mode === 'both'

  if (!existsSync(cfg.python) && cfg.python !== 'python' && !cfg.python.includes('/')) {
    log.warn?.(`[tool-prefetch] python path may be invalid: ${cfg.python}`)
  }

  // ---- probe bookkeeping (mode: probe) -------------------------------------
  const probeLog = (event, data) => {
    if (cfg.mode !== 'probe') return
    try {
      const p = join(cfg.repoRoot, 'mcp_prefetch_gateway', 'logs', 'probe.log')
      mkdirSync(dirname(p), { recursive: true })
      appendFileSync(p, JSON.stringify({ ts: Date.now() / 1000, event, ...data }) + '\n')
    } catch {}
  }
  const probeCounts = { pre: 0, result: 0, errors: 0 }

  const disposers = []
  // `probe` needs no gateway at all -- keep it dependency-free so a broken
  // python path cannot prevent the one diagnostic we need.
  const sidecar = registerTools || cfg.mode === 'interceptor' ? new Sidecar(cfg, log) : null
  const scope = new SessionScope(cfg)

  // ---- hook: pre-execute (waterfall) --------------------------------------
  if (hookPipeline) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (cfg.mode === 'probe') {
          probeCounts.pre += 1
          probeLog('pre_execute', {
            n: probeCounts.pre,
            name: exec?.name,
            args: describe(exec?.arguments),
            callId: describe(exec?.callId),
            hasAgent: exec?.agent != null,
            agent: describe(exec?.agent),
            keys: exec ? Object.keys(exec).slice(0, 25) : [],
          })
        } else if (sidecar?.ready) {
          // fire-and-forget: never block the tool call, never alter its result
          const sessionId = scope.idFor(exec)
          void sidecar
            .request('tools/call', {
              name: 'gw_predict_next',
              arguments: {
                session_id: sessionId,
                user_msg: scope.userMsgFor(exec),
                run_prefetch: true,
                top_k: 5,
              },
            }, cfg.callTimeoutMs)
            .then((r) => {
              const v = mcpResultToValue(r)
              log.debug?.(`[tool-prefetch] predicted before ${exec?.name}: ${(v.predictions || []).map((p) => p.tool).join(', ')}`)
            })
            .catch((err) => log.debug?.(`[tool-prefetch] pre-execute predict failed: ${err.message}`))
        }
      } catch (err) {
        probeCounts.errors += 1
        log.debug?.(`[tool-prefetch] pre-execute hook error: ${err?.message}`)
      }
      // ALWAYS pass through unchanged: this hook exists only to observe.
      return next()
    })
  }

  // ---- hook: result (emit) ------------------------------------------------
  if (hookPipeline) {
    try {
      ctx.on('tools/result', (exec, result) => {
        try {
          if (cfg.mode === 'probe') {
            probeCounts.result += 1
            probeLog('result', {
              n: probeCounts.result,
              name: exec?.name,
              isError: result?.isError,
              contentBlocks: Array.isArray(result?.content) ? result.content.length : null,
              contentPreview: describe(result?.content?.[0]?.text ?? result?.content),
              error: describe(result?.error),
            })
          } else if (sidecar?.ready) {
            // The gateway auto-scores the outstanding prediction and records the
            // training step. Fire-and-forget, same reasoning as above.
            void sidecar
              .request('tools/call', {
                name: 'gw_observe',
                arguments: {
                  session_id: scope.idFor(exec),
                  tool_name: exec?.name,
                  result_summary: summarizeContent(result),
                  latency_ms: scope.latencyFor(exec),
                },
              }, cfg.callTimeoutMs)
              .catch((err) => log.debug?.(`[tool-prefetch] observe after ${exec?.name} failed: ${err.message}`))
          }
        } catch (err) {
          probeCounts.errors += 1
        }
      })
    } catch (err) {
      log.warn?.(`[tool-prefetch] tools/result hook registration failed: ${err?.message}`)
    }
  }

  // ---- tool registration (modes: tools / both) ----------------------------
  const init = (async () => {
    if (!sidecar) {
      log.info?.(`[tool-prefetch] mode=${cfg.mode}: hooks registered, no tools registered`)
      return
    }
    try {
      sidecar.start()
      await sidecar.request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-tool-prefetch', version: '0.2.0' },
        },
        cfg.initTimeoutMs
      )
      sidecar.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
      )
      const listed = await sidecar.request('tools/list', {}, cfg.initTimeoutMs)
      sidecar.ready = true
      let count = 0
      if (!registerTools) {
        // interceptor mode: the hook path does the work; registering tools would
        // both add tokens and let the model call the gateway directly.
        log.info?.(
          `[tool-prefetch] ready: mode=${cfg.mode}, no tools registered (hook-only)` +
            ` -- gateway ${cfg.gatewayConfig}`
        )
        return
      }
      for (const tool of listed.tools || []) {
        const rawName = tool.name
        if (onlyGwTools && !rawName.startsWith('gw_')) continue  // both-mode: user-facing tools only
        count += 1
        const definition = {
          name: cfg.toolPrefix + rawName,
          description: tool.description || `Gateway tool ${rawName}`,
          parameters: sanitizeSchema(tool.inputSchema || { type: 'object', properties: {} }),
          output: {
            // the sidecar returns arbitrary JSON; {} is the unconstrained node
            schema: {},
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute(args, exec) {
            if (exec?.signal?.aborted) throw new Error('cancelled before dispatch')
            const result = await sidecar.request(
              'tools/call',
              { name: rawName, arguments: args ?? {} },
              cfg.callTimeoutMs
            )
            const value = mcpResultToValue(result)
            if (result && result.isError) {
              throw new Error(typeof value?.error === 'string' ? value.error : JSON.stringify(value))
            }
            return value
          },
        }
        disposers.push(ctx.tools.register(definition))
      }
      log.info?.(
        `[tool-prefetch] ready: mode=${cfg.mode}, ${count} tools from ${cfg.gatewayConfig}` +
          (hookPipeline ? ' (+pipeline hooks)' : '')
      )
    } catch (err) {
      log.error?.(`[tool-prefetch] sidecar failed to start: ${err.message}`)
      sidecar.kill()
    }
  })()

  ctx.on('dispose', () => {
    sidecar?.kill()
    while (disposers.length) disposers.pop()()
  })

  return init
}

// Loaders that consume only the default export must still see the inject
// declaration (accessing ctx.tools without it throws in Cordis).
apply.inject = inject

export default apply

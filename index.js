// dsh-plugin-tool-prefetch — bridge the CT-GNN prefetch gateway into dsh.
//
// A zero-dependency Cordis plugin: spawns the Python gateway
// (`python -m mcp_prefetch_gateway.cli rpc --config <yaml>`) as a sidecar,
// speaks newline-delimited JSON-RPC 2.0 over stdio, and registers every tool
// the gateway exposes (gw_predict_next / gw_observe / gw_stats / gw_reset plus
// the proxied upstream tools) natively on ctx.tools.
//
// Registration happens in the background: the sidecar takes ~20 s to cold
// start (torch + model load), which must not block profile activation. Tools
// appear as soon as the sidecar is ready. Disposing the plugin kills the
// sidecar — that is the Settings -> Plugins on/off switch.
//
// Config (via the cordis row's `config`):
//   python        absolute path to the venv python   (default: "python")
//   repoRoot      the agent-tool-acceleration checkout (default: cwd)
//   gatewayConfig gateway yaml, absolute or repo-relative
//   toolPrefix    prefix for registered tool names   (default: "" = raw names)
//   initTimeoutMs sidecar startup budget            (default: 60000)

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

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

export function apply(ctx, config = {}) {
  const cfg = {
    python: config.python || 'python',
    repoRoot: config.repoRoot ? resolve(config.repoRoot) : process.cwd(),
    gatewayConfig: '',
    toolPrefix: config.toolPrefix ?? '',
    initTimeoutMs: config.initTimeoutMs || 60000,
    callTimeoutMs: config.callTimeoutMs || 120000,
  }
  cfg.gatewayConfig = isAbsolute(config.gatewayConfig || '')
    ? config.gatewayConfig
    : join(cfg.repoRoot, config.gatewayConfig || 'mcp_prefetch_gateway/configs/tau_retail_gpt4o_real.yaml')

  const log = ctx.logger || console
  if (!existsSync(cfg.python) && cfg.python !== 'python' && !cfg.python.includes('/')) {
    log.warn?.(`[tool-prefetch] python path may be invalid: ${cfg.python}`)
  }

  const disposers = []
  const sidecar = new Sidecar(cfg, log)

  const init = (async () => {
    try {
      sidecar.start()
      await sidecar.request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-tool-prefetch', version: '0.1.0' },
        },
        cfg.initTimeoutMs
      )
      sidecar.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
      )
      const listed = await sidecar.request('tools/list', {}, cfg.initTimeoutMs)
      for (const tool of listed.tools || []) {
        const rawName = tool.name
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
        const dispose = ctx.tools.register(definition)
        disposers.push(dispose)
      }
      log.info?.(`[tool-prefetch] ready: ${(listed.tools || []).length} tools from ${cfg.gatewayConfig}`)
    } catch (err) {
      log.error?.(`[tool-prefetch] sidecar failed to start: ${err.message}`)
      sidecar.kill()
    }
  })()

  ctx.on('dispose', () => {
    sidecar.kill()
    while (disposers.length) disposers.pop()()
  })

  return init
}

// Loaders that consume only the default export must still see the inject
// declaration (accessing ctx.tools without it throws in Cordis).
apply.inject = inject

export default apply

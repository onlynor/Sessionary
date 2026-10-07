import fs from 'node:fs'
import path from 'node:path'
import { home, localRoots, type Roots } from '../util.ts'

/**
 * Agent → Routing. Sessionary never edits an agent's configuration for this: a binding applies to the sessions
 * Sessionary starts itself (terminals and chats), by the environment and arguments it starts them with. The agent's
 * own files, an agent run straight from a shell, and another tool that manages the agent (Magpie, CC Switch) are
 * left exactly as they were, and removing a binding leaves nothing behind.
 *
 * What an agent runs on by itself is only read, to show it beside the binding.
 */

export type Via = 'default' | 'custom' | 'magpie' | 'sessionary'
export interface AgentModelState {
  agent: string
  /** the model its own configuration names, if any */
  model?: string
  /** the provider its configuration selects (Codex, OpenCode, Pi) */
  provider?: string
  /** where its requests go, when the configuration says */
  endpoint?: string
  via: Via
  /** the file this was read from */
  file?: string
  /** how a binding reaches it when Sessionary starts it; 'manual' = only by the snippet on the Gateway page */
  launch: 'env' | 'manual'
  /** the agent's own setting that would win over what Sessionary starts it with */
  conflict?: string
}

/** the agents Model Control knows how to point at the gateway */
export const ROUTABLE = ['claude-code', 'codex', 'opencode', 'pi', 'hermes'] as const
export const LAUNCHABLE = new Set(['claude-code', 'codex', 'opencode'])

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return undefined } }
const readJson = (f: string) => { const s = read(f); if (s == null) return undefined; try { return JSON.parse(stripJsonc(s)) } catch { return undefined } }

/** JSON with comments and trailing commas (OpenCode's opencode.jsonc) to plain JSON; strings are left alone */
export function stripJsonc(s: string): string {
  let out = '', i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      out += s.slice(i, j + 1); i = j + 1
    } else if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++ }
    else if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2 }
    else if (ch === ',' && /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(s.slice(i + 1, i + 400))) i++ // a trailing comma
    else { out += ch; i++ }
  }
  return out
}

/** the top-level keys of a TOML file and the keys of each `[table]` — enough for Codex's config, no more */
export function tomlTables(s: string): Map<string, Record<string, string>> {
  const tables = new Map<string, Record<string, string>>([['', {}]])
  let cur = tables.get('')!
  for (const raw of s.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const t = /^\[\s*([^\]]+?)\s*\]$/.exec(line)
    if (t) { cur = {}; tables.set(t[1]!.replace(/"/g, ''), cur); continue }
    const kv = /^([\w.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line)
    if (kv) cur[kv[1]!.replace(/"/g, '')] = kv[2]!.replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return tables
}

/** `127.0.0.1:3425` is Magpie's gateway; our own lives under `/gateway` */
export function viaOf(endpoint: string | undefined, gatewayBase?: string): Via {
  if (!endpoint) return 'default'
  if (gatewayBase && endpoint.startsWith(gatewayBase)) return 'sessionary'
  if (/\/\/(127\.0\.0\.1|localhost):3425\b/.test(endpoint)) return 'magpie'
  if (/\/gateway(\/|$)/.test(endpoint) && /\/\/(127\.0\.0\.1|localhost)/.test(endpoint)) return 'sessionary'
  return 'custom'
}

export function agentModelState(agent: string, roots: Roots = localRoots(), gatewayBase?: string): AgentModelState {
  const launch = LAUNCHABLE.has(agent) ? 'env' : 'manual'
  switch (agent) {
    case 'claude-code': {
      const file = path.join(roots.claude, 'settings.json')
      const s = readJson(file) ?? {}
      const env = s.env ?? {}
      const endpoint = env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL
      // the settings file's `env` is applied by Claude Code itself, after the environment it was started with
      const conflict = env.ANTHROPIC_BASE_URL ? 'env.ANTHROPIC_BASE_URL' : env.ANTHROPIC_AUTH_TOKEN ? 'env.ANTHROPIC_AUTH_TOKEN' : undefined
      return { agent, model: env.ANTHROPIC_MODEL ?? s.model, endpoint, via: viaOf(endpoint, gatewayBase), file, launch, ...(conflict && { conflict }) }
    }
    case 'codex': {
      const file = path.join(roots.codex, 'config.toml')
      const t = tomlTables(read(file) ?? '')
      const top = t.get('')!
      const provider = top.model_provider
      const endpoint = provider ? t.get(`model_providers.${provider}`)?.base_url : process.env.OPENAI_BASE_URL
      return { agent, model: top.model, provider, endpoint, via: viaOf(endpoint, gatewayBase), file, launch }
    }
    case 'opencode': {
      const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home(), '.config'), 'opencode')
      const file = ['opencode.jsonc', 'opencode.json', 'config.json'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
      const s = (file && readJson(file)) ?? {}
      const model: string | undefined = s.model
      const provider = model?.includes('/') ? model.slice(0, model.indexOf('/')) : undefined
      const endpoint = provider ? s.provider?.[provider]?.options?.baseURL : undefined
      return { agent, model, provider, endpoint, via: viaOf(endpoint, gatewayBase), file, launch }
    }
    case 'pi': {
      const file = path.join(roots.pi, 'settings.json')
      const s = readJson(file) ?? {}
      const models = readJson(path.join(roots.pi, 'models.json')) ?? {}
      const provider: string | undefined = s.defaultProvider
      const endpoint = provider ? models.providers?.[provider]?.baseUrl : undefined
      return { agent, model: s.defaultModel, provider, endpoint, via: viaOf(endpoint, gatewayBase), file, launch }
    }
    case 'hermes': {
      const file = path.join(roots.hermes, 'config.yaml')
      const y = read(file) ?? ''
      // `model:` is either a string or a block with default / provider / base_url
      const inline = /^model:\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(y)?.[1]
      const block = /^model:\s*\n((?:[ \t]+.*\n?)*)/m.exec(y)?.[1] ?? ''
      const field = (k: string) => new RegExp(`^\\s+${k}:\\s*["']?([^"'\\n#]+?)["']?\\s*$`, 'm').exec(block)?.[1]
      const endpoint = field('base_url')
      return { agent, model: inline ?? field('default'), provider: field('provider'), endpoint, via: viaOf(endpoint, gatewayBase), file: fs.existsSync(file) ? file : undefined, launch }
    }
  }
  return { agent, via: 'default', launch: 'manual' }
}

/**
 * What a bound agent is started with. `secret` is the one value that grants use of the gateway: kept apart from `env`
 * so that on a node it can travel inside the SSH connection (SendEnv) instead of on a command line, where anyone on
 * the node could read it. On this computer it is simply part of the environment.
 *
 * `session` is for an agent that keeps the provider in the session itself: Codex resumes a thread on the provider it
 * was started with whatever `-c` says, so a chat has to name the routing again when it opens the thread.
 */
export interface LaunchProfile { env: Record<string, string>; args: string[]; secret: { name: string; value: string }; session?: { provider: string; model: string } }

/**
 * `gateway` is the gateway's base address (`http://127.0.0.1:4777/gateway`), `key` what opens it for this agent (the
 * gateway key with the agent's id appended here; a session's own token on a node).
 */
export function launchProfile(agent: string, target: string, gateway: string, key: string): LaunchProfile | undefined {
  switch (agent) {
    case 'claude-code':
      return {
        env: {
          ANTHROPIC_BASE_URL: gateway, ANTHROPIC_MODEL: target,
          // Claude Code's helper requests (titles, summaries) and its tier aliases go the same way
          ANTHROPIC_SMALL_FAST_MODEL: target, ANTHROPIC_DEFAULT_HAIKU_MODEL: target, ANTHROPIC_DEFAULT_SONNET_MODEL: target, ANTHROPIC_DEFAULT_OPUS_MODEL: target,
        },
        args: ['--model', target],
        secret: { name: 'ANTHROPIC_AUTH_TOKEN', value: key },
      }
    case 'codex':
      return {
        env: {},
        args: [
          '-c', 'model_provider="sessionary"',
          '-c', 'model_providers.sessionary.name="Sessionary"',
          '-c', `model_providers.sessionary.base_url=${JSON.stringify(gateway + '/v1')}`,
          '-c', 'model_providers.sessionary.env_key="SESSIONARY_GATEWAY_KEY"',
          '-c', 'model_providers.sessionary.wire_api="responses"',
          '-c', `model=${JSON.stringify(target)}`,
        ],
        secret: { name: 'SESSIONARY_GATEWAY_KEY', value: key },
        session: { provider: 'sessionary', model: target },
      }
    case 'opencode':
      return {
        env: {
          // OpenCode reads the key from the environment itself ({env:…}), so the configuration holds no secret
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: { sessionary: { npm: '@ai-sdk/openai-compatible', name: 'Sessionary', options: { baseURL: gateway + '/v1', apiKey: '{env:SESSIONARY_GATEWAY_KEY}' }, models: { [target]: { name: target } } } },
            model: `sessionary/${target}`,
          }),
        },
        args: [],
        secret: { name: 'SESSIONARY_GATEWAY_KEY', value: key },
      }
  }
  return undefined
}

/** for the agents Sessionary does not start with a binding (or for running one by hand): what to put where */
export function snippet(agent: string, target: string, gateway: string, key: string): { file: string; lang: string; text: string } | undefined {
  const k = `${key}.${agent}`
  switch (agent) {
    case 'claude-code': return { file: '~/.claude/settings.json', lang: 'json', text: JSON.stringify({ env: { ANTHROPIC_BASE_URL: gateway, ANTHROPIC_AUTH_TOKEN: k, ANTHROPIC_MODEL: target } }, null, 2) }
    case 'codex': return { file: '~/.codex/config.toml', lang: 'toml', text: `model_provider = "sessionary"\nmodel = ${JSON.stringify(target)}\n\n[model_providers.sessionary]\nname = "Sessionary"\nbase_url = ${JSON.stringify(gateway + '/v1')}\nenv_key = "SESSIONARY_GATEWAY_KEY"\nwire_api = "responses"\n\n# and in your shell: export SESSIONARY_GATEWAY_KEY=${k}` }
    case 'opencode': return { file: '~/.config/opencode/opencode.json', lang: 'json', text: JSON.stringify({ provider: { sessionary: { npm: '@ai-sdk/openai-compatible', name: 'Sessionary', options: { baseURL: gateway + '/v1', apiKey: k }, models: { [target]: { name: target } } } }, model: `sessionary/${target}` }, null, 2) }
    case 'pi': return { file: '~/.pi/agent/models.json', lang: 'json', text: JSON.stringify({ providers: { sessionary: { baseUrl: gateway + '/v1', api: 'openai-completions', apiKey: k, models: [{ id: target }] } } }, null, 2) + `\n\n// then: pi --provider sessionary --model ${target}` }
    case 'hermes': return { file: '~/.hermes/config.yaml', lang: 'yaml', text: `model:\n  default: ${target}\n  provider: custom\n  base_url: ${gateway}/v1\n  api_key: ${k}` }
  }
  return undefined
}

/** the protocol the gateway must speak for an agent started with a binding */
export const PROTOCOL_OF: Record<string, 'anthropic' | 'chat' | 'responses'> = { 'claude-code': 'anthropic', codex: 'responses', opencode: 'chat', pi: 'chat', hermes: 'chat' }

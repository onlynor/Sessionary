import type { Protocol } from './store.ts'

/**
 * Starting points for a provider. This is metadata, not a transport: every vendor here is reached through the same
 * two compatible adapters the gateway speaks — OpenAI-compatible Chat/Responses and Anthropic-compatible Messages —
 * and the protocol a preset offers is simply the set of its `endpoints` keys. Adding another compatible provider is
 * therefore a row here (an id, a name, base URLs, an icon) and nothing else.
 *
 * Only addresses live here: the model list is read from the provider itself (see catalog.ts) so a model released
 * today shows up on the next refresh, and a provider whose list cannot be read simply keeps the models added by hand.
 * Every address can be changed after adding; these are the vendors' documented endpoints.
 *
 * Compatibility notes:
 * - Google Gemini is reached through its OpenAI-compatible endpoint (Chat only); its native `generateContent` API is
 *   a different protocol the gateway does not translate, so a model discovery that fails is completed by hand.
 * - A preset that offers only one protocol is offered only to the agents that speak it (see PROTOCOL_OF in agents.ts).
 */
export interface Preset {
  id: string
  name: string
  kind: 'vendor' | 'local' | 'gateway' | 'custom'
  endpoints: Partial<Record<Protocol, string>>
  /** the brand mark's file under `web/public/providers/`; a preset without one falls back to its monogram */
  icon?: string
  /** a local server that needs no key */
  keyless?: boolean
  /** where the user gets a key */
  console?: string
  /** a key to fill in for them (a local gateway's fixed key) */
  key?: string
  /** the monogram's hue, which also tints the tile behind a brand mark */
  hue: number
}

export const PRESETS: Preset[] = [
  // ---- vendors ----
  { id: 'anthropic', name: 'Anthropic', kind: 'vendor', icon: 'anthropic', hue: 18, endpoints: { anthropic: 'https://api.anthropic.com' }, console: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', kind: 'vendor', icon: 'openai', hue: 160, endpoints: { chat: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1' }, console: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'vendor', icon: 'deepseek', hue: 228, endpoints: { chat: 'https://api.deepseek.com/v1', anthropic: 'https://api.deepseek.com/anthropic' }, console: 'https://platform.deepseek.com/api_keys' },
  { id: 'moonshot', name: 'Kimi', kind: 'vendor', icon: 'moonshot', hue: 250, endpoints: { chat: 'https://api.moonshot.ai/v1', anthropic: 'https://api.moonshot.ai/anthropic' }, console: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'zhipu', name: 'Zhipu GLM', kind: 'vendor', icon: 'zhipu', hue: 215, endpoints: { chat: 'https://open.bigmodel.cn/api/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic' }, console: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'vendor', icon: 'gemini', hue: 205, endpoints: { chat: 'https://generativelanguage.googleapis.com/v1beta/openai' }, console: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI Grok', kind: 'vendor', icon: 'xai', hue: 0, endpoints: { chat: 'https://api.x.ai/v1', responses: 'https://api.x.ai/v1' }, console: 'https://console.x.ai' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'vendor', icon: 'openrouter', hue: 240, endpoints: { chat: 'https://openrouter.ai/api/v1', responses: 'https://openrouter.ai/api/v1', anthropic: 'https://openrouter.ai/api' }, console: 'https://openrouter.ai/keys' },

  // ---- local runtimes (a server on this computer, no key) ----
  { id: 'ollama', name: 'Ollama', kind: 'local', icon: 'ollama', hue: 0, keyless: true, endpoints: { chat: 'http://127.0.0.1:11434/v1', anthropic: 'http://127.0.0.1:11434' } },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', icon: 'lmstudio', hue: 230, keyless: true, endpoints: { chat: 'http://127.0.0.1:1234/v1' } },

  // ---- gateways (another router on this computer; everything it serves becomes one provider here) ----
  { id: 'magpie', name: 'Magpie', kind: 'gateway', hue: 210, key: 'magpie', endpoints: { anthropic: 'http://127.0.0.1:3425', chat: 'http://127.0.0.1:3425/v1', responses: 'http://127.0.0.1:3425/v1' } },

  // ---- any compatible endpoint ----
  { id: 'custom-openai', name: 'OpenAI-compatible', kind: 'custom', hue: 150, endpoints: { chat: '' } },
  { id: 'custom-anthropic', name: 'Anthropic-compatible', kind: 'custom', hue: 20, endpoints: { anthropic: '' } },
]

export const presetOf = (id: string) => PRESETS.find((p) => p.id === id)

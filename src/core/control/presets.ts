import type { Protocol } from './store.ts'

/**
 * Starting points for a provider: where it answers each protocol. Only addresses live here — the model list always
 * comes from the provider itself (`/models`), so a model released today shows up on the next refresh.
 * Every address can be changed after adding; these are the vendors' documented endpoints at the time of writing.
 */
export interface Preset {
  id: string
  name: string
  kind: 'vendor' | 'local' | 'gateway' | 'custom'
  endpoints: Partial<Record<Protocol, string>>
  /** a local server that needs no key */
  keyless?: boolean
  /** where the user gets a key */
  console?: string
  /** a key to fill in for them (a local gateway's fixed key) */
  key?: string
  /** the monogram's hue */
  hue: number
}

export const PRESETS: Preset[] = [
  { id: 'anthropic', name: 'Anthropic', kind: 'vendor', hue: 18, endpoints: { anthropic: 'https://api.anthropic.com' }, console: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', kind: 'vendor', hue: 160, endpoints: { chat: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1' }, console: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'vendor', hue: 228, endpoints: { chat: 'https://api.deepseek.com/v1', anthropic: 'https://api.deepseek.com/anthropic' }, console: 'https://platform.deepseek.com/api_keys' },
  { id: 'moonshot', name: 'Kimi', kind: 'vendor', hue: 250, endpoints: { chat: 'https://api.moonshot.ai/v1', anthropic: 'https://api.moonshot.ai/anthropic' }, console: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'zhipu', name: 'Zhipu GLM', kind: 'vendor', hue: 215, endpoints: { chat: 'https://open.bigmodel.cn/api/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic' }, console: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'zai', name: 'Z.ai', kind: 'vendor', hue: 200, endpoints: { chat: 'https://api.z.ai/api/paas/v4', anthropic: 'https://api.z.ai/api/anthropic' }, console: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'minimax', name: 'MiniMax', kind: 'vendor', hue: 345, endpoints: { chat: 'https://api.minimax.io/v1', anthropic: 'https://api.minimax.io/anthropic' }, console: 'https://platform.minimax.io' },
  { id: 'qwen', name: 'Qwen', kind: 'vendor', hue: 265, endpoints: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1', anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic' }, console: 'https://bailian.console.aliyun.com' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'vendor', hue: 240, endpoints: { chat: 'https://openrouter.ai/api/v1', responses: 'https://openrouter.ai/api/v1', anthropic: 'https://openrouter.ai/api' }, console: 'https://openrouter.ai/keys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'vendor', hue: 205, endpoints: { chat: 'https://generativelanguage.googleapis.com/v1beta/openai' }, console: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI', kind: 'vendor', hue: 0, endpoints: { chat: 'https://api.x.ai/v1', responses: 'https://api.x.ai/v1' }, console: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', kind: 'vendor', hue: 28, endpoints: { chat: 'https://api.mistral.ai/v1' }, console: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', name: 'Groq', kind: 'vendor', hue: 12, endpoints: { chat: 'https://api.groq.com/openai/v1' }, console: 'https://console.groq.com/keys' },
  { id: 'siliconflow', name: 'SiliconFlow', kind: 'vendor', hue: 275, endpoints: { chat: 'https://api.siliconflow.cn/v1' }, console: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'ollama', name: 'Ollama', kind: 'local', hue: 0, keyless: true, endpoints: { chat: 'http://127.0.0.1:11434/v1', anthropic: 'http://127.0.0.1:11434' } },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', hue: 230, keyless: true, endpoints: { chat: 'http://127.0.0.1:1234/v1' } },
  // another gateway on this machine: everything it routes becomes one provider here
  { id: 'magpie', name: 'Magpie', kind: 'gateway', hue: 210, key: 'magpie', endpoints: { anthropic: 'http://127.0.0.1:3425', chat: 'http://127.0.0.1:3425/v1', responses: 'http://127.0.0.1:3425/v1' } },
  { id: 'custom-openai', name: 'OpenAI-compatible', kind: 'custom', hue: 150, endpoints: { chat: '' } },
  { id: 'custom-anthropic', name: 'Anthropic-compatible', kind: 'custom', hue: 20, endpoints: { anthropic: '' } },
]

export const presetOf = (id: string) => PRESETS.find((p) => p.id === id)

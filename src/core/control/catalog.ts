import { ControlError, type Provider, type ProviderModel, resolveKey } from './store.ts'

/**
 * A provider's models come from the provider itself (`GET …/models`), never from a list built into Sessionary.
 * Models the user switched off stay off across refreshes; models the provider no longer lists are kept only if the
 * user added them by hand (some relays answer requests for models they do not list).
 */

const TIMEOUT = 15_000

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal })
    const text = await r.text()
    if (!r.ok) {
      let msg = text.slice(0, 300)
      try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.message ?? msg } catch { /* not JSON */ }
      throw new ControlError(`${r.status} from ${new URL(url).host}: ${msg || r.statusText}`, 502)
    }
    try { return JSON.parse(text) } catch { throw new ControlError(`${new URL(url).host} did not answer with JSON.`, 502) }
  } catch (e) {
    if (e instanceof ControlError) throw e
    throw new ControlError(ctl.signal.aborted ? `${new URL(url).host} did not answer in time.` : `Could not reach ${new URL(url).host}: ${(e as Error).message}`, 502)
  } finally { clearTimeout(timer) }
}

/** the provider's own list of models, read from whichever protocol it speaks (OpenAI-style first) */
export async function listModels(p: Provider): Promise<ProviderModel[]> {
  const key = resolveKey(p.key)
  const openai = p.endpoints.chat || p.endpoints.responses
  let body: any
  if (openai) body = await getJson(openai.replace(/\/+$/, '') + '/models', key ? { authorization: `Bearer ${key}` } : {})
  else if (p.endpoints.anthropic) body = await getJson(p.endpoints.anthropic.replace(/\/+$/, '') + '/v1/models?limit=1000', { ...(key && { 'x-api-key': key, authorization: `Bearer ${key}` }), 'anthropic-version': '2023-06-01' })
  else throw new ControlError('This provider has no endpoint to ask for its models.')
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : []
  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const r of rows) {
    const id = String(r?.id ?? r?.name ?? '').replace(/^models\//, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = r.display_name ?? (r.name && r.name !== id ? r.name : undefined)
    const context = Number(r.context_length ?? r.context_window ?? r.max_input_tokens) || undefined
    out.push({ id, on: true, ...(typeof name === 'string' && { name }), ...(context && { context }) })
  }
  if (!out.length) throw new ControlError('The provider answered, but listed no models. Add the model names by hand.', 502)
  return out
}

/** the fresh list, with the user's choices kept: what was off stays off, what was added by hand stays */
export function mergeModels(fresh: ProviderModel[], had: ProviderModel[]): ProviderModel[] {
  const old = new Map(had.map((m) => [m.id, m]))
  const merged = fresh.map((m) => ({ ...m, on: old.get(m.id)?.on ?? m.on }))
  const listed = new Set(fresh.map((m) => m.id))
  return [...merged, ...had.filter((m) => !listed.has(m.id) && m.manual)]
}

/** is there a Magpie gateway on this machine, and what does it serve? */
export async function detectMagpie(base = 'http://127.0.0.1:3425'): Promise<{ models: number } | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer magpie' }, signal: ctl.signal })
    if (!r.ok) return null
    const j: any = await r.json()
    return Array.isArray(j?.data) ? { models: j.data.length } : null
  } catch { return null } finally { clearTimeout(timer) }
}

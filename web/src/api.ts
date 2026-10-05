import type { Agent, Changes, EditBlock, OpenTarget, Run, SearchHit, Snip, Status, Trash, FileDiff, ProjectContext, Session, SessionSummary, TreeEntry } from './types'

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    // surface the server's explanation (e.g. "may still be running") instead of a bare status
    const body = await r.json().catch(() => null)
    throw new Error(body?.error ?? `${r.status} ${url}`)
  }
  return r.json()
}
const enc = encodeURIComponent
// state-changing calls carry the per-launch token the server hands to same-origin pages only
let token: Promise<string> | undefined
const tok = () => (token ??= get<{ token: string }>('/api/token').then((t) => t.token))
const post = async <T = { ok: boolean }>(url: string, body?: unknown) =>
  get<T>(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sessionary-token': await tok() }, body: JSON.stringify(body ?? {}) })

export const api = {
  agents: () => get<Agent[]>('/api/agents'),
  sessions: () => get<SessionSummary[]>('/api/sessions'),
  session: (id: string, cursor = 0, limit?: number | 'all') => get<Session>(`/api/sessions/${enc(id)}?cursor=${cursor}${limit ? `&limit=${limit}` : ''}`),
  outline: (id: string) => get<{ msgIndex: number; text: string; time?: number }[]>(`/api/sessions/${enc(id)}/outline`),
  edits: (id: string) => get<EditBlock[]>(`/api/sessions/${enc(id)}/edits`),
  context: (id: string) => get<ProjectContext>(`/api/sessions/${enc(id)}/context`),
  tree: (id: string, rel: string) => get<TreeEntry[]>(`/api/sessions/${enc(id)}/tree?path=${enc(rel)}`),
  changes: (id: string) => get<Changes>(`/api/sessions/${enc(id)}/changes`),
  changeFile: (id: string, path: string) => get<FileDiff>(`/api/sessions/${enc(id)}/changes/file?path=${enc(path)}`),
  search: (q: string, signal?: AbortSignal) => get<SearchHit[]>(`/api/search?q=${enc(q)}`, { signal }),
  find: (id: string, q: string, signal?: AbortSignal) => get<Snip[]>(`/api/sessions/${enc(id)}/find?q=${enc(q)}`, { signal }),
  trash: () => get<Trash>('/api/trash'),
  hide: (id: string) => post(`/api/sessions/${enc(id)}/hide`),
  restore: (id: string) => post(`/api/sessions/${enc(id)}/restore`),
  hideMessages: (id: string, ids: string[]) => post(`/api/sessions/${enc(id)}/messages/hide`, { ids }),
  restoreMessages: (id: string, ids?: string[]) => post(`/api/sessions/${enc(id)}/messages/restore`, ids ? { ids } : {}),
  deleteFromDisk: (id: string) => post(`/api/sessions/${enc(id)}/delete-from-disk`),
  restoreRemoved: (id: string) => post(`/api/removed/${enc(id)}/restore`),
  purgeRemoved: (id: string) => post(`/api/removed/${enc(id)}/purge`),
  scan: () => post<unknown>('/api/scan'),
  status: () => get<Status>('/api/status'),
  /** server-sent `index` (sessions changed), `scan` (scanning on/off), `hello` (connected) */
  events: () => new EventSource('/api/events'),
  pin: (id: string, on: boolean) => post(`/api/sessions/${enc(id)}/${on ? 'pin' : 'unpin'}`),
  open: (id: string, target: OpenTarget, path?: string) => post(`/api/sessions/${enc(id)}/open`, { target, path }),
  resumeCommand: (id: string) => get<{ bin: string; args: string[]; cwd: string; line: string }>(`/api/sessions/${enc(id)}/resume-command`),
  continueSession: (id: string, prompt: string, allowWrite: boolean) => post<Run>(`/api/sessions/${enc(id)}/continue`, { prompt, allowWrite }),
  activeRun: (id: string) => get<Run | null>(`/api/sessions/${enc(id)}/run`),
  stopRun: (runId: string) => post<Run | null>(`/api/runs/${enc(runId)}/stop`),
  runEvents: (runId: string) => new EventSource(`/api/runs/${enc(runId)}/events`),
  imageUrl: (id: string, ref: string) => `/api/sessions/${enc(id)}/images/${ref}`,
}

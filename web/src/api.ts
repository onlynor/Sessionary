import type { ChatSummary, Agent, AgentInstall, Changes, EditBlock, FileDiff, Machine, NodeInfo, NodeInput, OpenTarget, ProjectContext, Run, SearchHit, Session, SessionSummary, Snip, SshHost, Status, Summary, SystemInfo, TermInfo, TreeEntry, Trash } from './types'

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
export const tok = () => (token ??= get<{ token: string }>('/api/token').then((t) => t.token))
const send = async <T = { ok: boolean }>(method: string, url: string, body?: unknown) =>
  get<T>(url, { method, headers: { 'content-type': 'application/json', 'x-sessionary-token': await tok() }, body: body === undefined ? undefined : JSON.stringify(body) })
const post = <T = { ok: boolean }>(url: string, body?: unknown) => send<T>('POST', url, body ?? {})

/** Where a machine's own API lives: `/api/…` for this computer, the same API behind a prefix for a node. */
export const machineBase = (machineId: string) => (machineId === 'local' ? '' : `/api/nodes/${enc(machineId)}/proxy`)

/**
 * Everything the app asks of one machine's sessions. This computer and every node answer the same API, so the
 * pages are written once and given the `Api` of whichever machine is open.
 */
export function makeApi(base = '') {
  const P = (u: string) => base + u
  return {
    base,
    agents: () => get<Agent[]>(P('/api/agents')),
    sessions: () => get<SessionSummary[]>(P('/api/sessions')),
    summary: () => get<Summary>(P('/api/summary')),
    session: (id: string, cursor = 0, limit?: number | 'all') => get<Session>(P(`/api/sessions/${enc(id)}?cursor=${cursor}${limit ? `&limit=${limit}` : ''}`)),
    outline: (id: string) => get<{ msgIndex: number; text: string; time?: number }[]>(P(`/api/sessions/${enc(id)}/outline`)),
    edits: (id: string) => get<EditBlock[]>(P(`/api/sessions/${enc(id)}/edits`)),
    context: (id: string) => get<ProjectContext>(P(`/api/sessions/${enc(id)}/context`)),
    tree: (id: string, rel: string) => get<TreeEntry[]>(P(`/api/sessions/${enc(id)}/tree?path=${enc(rel)}`)),
    changes: (id: string) => get<Changes>(P(`/api/sessions/${enc(id)}/changes`)),
    changeFile: (id: string, path: string) => get<FileDiff>(P(`/api/sessions/${enc(id)}/changes/file?path=${enc(path)}`)),
    search: (q: string, signal?: AbortSignal) => get<SearchHit[]>(P(`/api/search?q=${enc(q)}`), { signal }),
    find: (id: string, q: string, signal?: AbortSignal) => get<Snip[]>(P(`/api/sessions/${enc(id)}/find?q=${enc(q)}`), { signal }),
    trash: () => get<Trash>(P('/api/trash')),
    hide: (id: string) => post(P(`/api/sessions/${enc(id)}/hide`)),
    restore: (id: string) => post(P(`/api/sessions/${enc(id)}/restore`)),
    rename: (id: string, title: string) => post(P(`/api/sessions/${enc(id)}/rename`), { title }),
    hideMessages: (id: string, ids: string[]) => post(P(`/api/sessions/${enc(id)}/messages/hide`), { ids }),
    restoreMessages: (id: string, ids?: string[]) => post(P(`/api/sessions/${enc(id)}/messages/restore`), ids ? { ids } : {}),
    deleteFromDisk: (id: string) => post(P(`/api/sessions/${enc(id)}/delete-from-disk`)),
    restoreRemoved: (id: string) => post(P(`/api/removed/${enc(id)}/restore`)),
    purgeRemoved: (id: string) => post(P(`/api/removed/${enc(id)}/purge`)),
    scan: () => post<unknown>(P('/api/scan')),
    status: () => get<Status>(P('/api/status')),
    /** server-sent `index` (sessions changed), `scan` (scanning on/off), `hello` (connected) */
    events: () => new EventSource(P('/api/events')),
    pin: (id: string, on: boolean) => post(P(`/api/sessions/${enc(id)}/${on ? 'pin' : 'unpin'}`)),
    open: (id: string, target: OpenTarget, path?: string) => post(P(`/api/sessions/${enc(id)}/open`), { target, path }),
    resumeCommand: (id: string) => get<{ bin: string; args: string[]; cwd: string; line: string }>(P(`/api/sessions/${enc(id)}/resume-command`)),
    continueSession: (id: string, prompt: string, allowWrite: boolean) => post<Run>(P(`/api/sessions/${enc(id)}/continue`), { prompt, allowWrite }),
    activeRun: (id: string) => get<Run | null>(P(`/api/sessions/${enc(id)}/run`)),
    stopRun: (runId: string) => post<Run | null>(P(`/api/runs/${enc(runId)}/stop`)),
    runEvents: (runId: string) => new EventSource(P(`/api/runs/${enc(runId)}/events`)),
    imageUrl: (id: string, ref: string) => P(`/api/sessions/${enc(id)}/images/${ref}`),
  }
}
export type Api = ReturnType<typeof makeApi>
/** this computer */
export const api = makeApi('')

/** Things that are about machines themselves, not about one machine's sessions. */
export const host = {
  machines: () => get<Machine[]>('/api/machines'),
  system: (id: string) => get<SystemInfo>(`/api/machines/${enc(id)}/system`),
  /** what is installed there; `refresh` makes it look again instead of answering from memory */
  installed: (id: string, refresh = false) => get<{ agents: AgentInstall[]; at: number; refreshing: boolean }>(`/api/machines/${enc(id)}/agents${refresh ? '?refresh=1' : ''}`),

  nodes: () => get<NodeInfo[]>('/api/nodes'),
  addNode: (n: NodeInput) => post<NodeInfo>('/api/nodes', n),
  updateNode: (id: string, n: NodeInput) => send<NodeInfo>('PUT', `/api/nodes/${enc(id)}`, n),
  removeNode: (id: string) => send<{ ok: boolean }>('DELETE', `/api/nodes/${enc(id)}`),
  connectNode: (id: string) => post<NodeInfo>(`/api/nodes/${enc(id)}/connect`),
  disconnectNode: (id: string) => post(`/api/nodes/${enc(id)}/disconnect`),
  syncNode: (id: string) => post<NodeInfo>(`/api/nodes/${enc(id)}/sync`),
  sshHosts: () => get<SshHost[]>('/api/ssh-hosts'),

  /** what is worth interrupting someone for; only what happens while this is open */
  notifications: async () => new EventSource(`/api/notifications?token=${enc(await tok())}`),
  terminals: async (machine?: string) => get<TermInfo[]>(`/api/terminals${machine ? `?machine=${enc(machine)}` : ''}`, { headers: { 'x-sessionary-token': await tok() } }),
  openTerminal: (o: { machine: string; kind: 'shell' | 'resume' | 'new'; agent?: string; sessionId?: string; cwd?: string; cols?: number; rows?: number }) => post<TermInfo>('/api/terminals', o),
  terminalStream: async (id: string) => new EventSource(`/api/terminals/${enc(id)}/stream?token=${enc(await tok())}`),
  terminalInput: (id: string, data: string) => post(`/api/terminals/${enc(id)}/input`, { data }),
  resizeTerminal: (id: string, cols: number, rows: number) => post(`/api/terminals/${enc(id)}/resize`, { cols, rows }),
  killTerminal: (id: string) => post(`/api/terminals/${enc(id)}/kill`),
  restartTerminal: (id: string, size?: { cols: number; rows: number }) => post<TermInfo>(`/api/terminals/${enc(id)}/restart`, size),
  removeTerminal: (id: string) => send(`DELETE`, `/api/terminals/${enc(id)}`),
}

const chatBase = '/api/chats'
/** Chats: an agent's own protocol, held open by the server. They live on the controlling server whichever machine the agent runs on. */
export const chatApi = {
  list: async (machine?: string) => get<ChatSummary[]>(`${chatBase}${machine ? `?machine=${enc(machine)}` : ''}`, { headers: { 'x-sessionary-token': await tok() } }),
  forSession: (machine: string, agent: string, session: string) => get<ChatSummary | null>(`${chatBase}/for?machine=${enc(machine)}&agent=${enc(agent)}&session=${enc(session)}`),
  open: (o: { machine: string; agent?: string; sessionId?: string; cwd?: string; model?: string; mode?: string; effort?: string }) => post<ChatSummary>(chatBase, o),
  get: (id: string) => get<ChatSummary>(`${chatBase}/${enc(id)}`),
  events: async (id: string) => new EventSource(`${chatBase}/${enc(id)}/events?token=${enc(await tok())}`),
  send: (id: string, text: string, images?: { mimeType: string; data: string }[]) => post(`${chatBase}/${enc(id)}/send`, { text, images }),
  interrupt: (id: string) => post(`${chatBase}/${enc(id)}/interrupt`),
  respond: (id: string, approval: string, option: string) => post(`${chatBase}/${enc(id)}/respond`, { approval, option }),
  answer: (id: string, question: string, answers: Record<string, string[]>) => post(`${chatBase}/${enc(id)}/answer`, { question, answers }),
  setModel: (id: string, model: string) => post(`${chatBase}/${enc(id)}/model`, { model }),
  setMode: (id: string, mode: string) => post(`${chatBase}/${enc(id)}/mode`, { mode }),
  setEffort: (id: string, effort: string) => post(`${chatBase}/${enc(id)}/effort`, { effort }),
  close: (id: string) => send('DELETE', `${chatBase}/${enc(id)}`),
}

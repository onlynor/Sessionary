// Mirrors the API payloads (src/core/model.ts, project.ts, context.ts). Kept separate so the web bundle never imports server code.
export type ToolBlock = { type: 'tool'; id: string; name: string; kind?: string; input: any; output?: string; status: 'ok' | 'error' | 'pending'; diff?: string; truncated?: boolean }
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | ToolBlock
  | { type: 'image'; mime: string; ref?: string; data?: string }
  | { type: 'note'; kind: string; text: string }

export interface Message { id: string; role: 'user' | 'assistant' | 'system'; time?: number; model?: string; blocks: Block[]; hidden?: boolean }

export interface ProjectRef { key: string; name: string; exists: boolean; generic: boolean; sub?: string }

export interface SessionSummary {
  id: string; agent: string; nativeId: string; title: string; cwd?: string; gitBranch?: string; model?: string
  createdAt: number; updatedAt: number; messageCount: number; parentId?: string
  tokens?: { input: number; output: number }; cost?: number
  preview?: string; toolCalls?: number; filesChanged?: number
  project: ProjectRef
  /** Sessionary's own state: pinned to the top of the list */
  pinned?: boolean
  /** written in the last two minutes or being continued now: probably open in an agent */
  active?: boolean
  /** the user gave this session a name of their own */
  renamed?: boolean
}
export interface Page { start: number; end: number; next: number | null; total: number }
export interface Session extends SessionSummary { messages: Message[]; children: SessionSummary[]; page: Page; trashed?: boolean }
export type EditBlock = ToolBlock & { time?: number }
export interface Agent { id: string; label: string; sessionCount: number; storage: string; available: boolean; error?: string; canResume: boolean; canContinue: boolean; canCreate?: boolean; bin?: string }
export interface Status { scanning: boolean; lastScan?: number; watch: { mode: 'events' | 'polling'; watched: string[]; error?: string }; capabilities: { terminal: string | null; editor: string | null; fileManager: boolean }; platform: string }
export type OpenTarget = 'folder' | 'terminal' | 'editor' | 'resume' | 'file'

export interface ProjectContext {
  cwd?: string
  cwdExists: boolean
  git?: { root: string; branch?: string; head?: string; dirty: number; status: { code: string; path: string }[]; recent: { hash: string; subject: string; date: string }[] }
  touchedFiles: { path: string; count: number; changed: boolean }[]
  toolUsage: { name: string; count: number }[]
}
export interface TreeEntry { name: string; dir: boolean }
export interface ChangedFile { path: string; status: string; add?: number; del?: number }
export interface Changes { root: string | null; files: ChangedFile[] }
export interface FileDiff { patch: string; truncated: boolean; binary?: boolean }
export interface ChangeFocus { path: string; source: 'session' | 'git' }
export interface Snip { msgIndex: number; role: string; text: string; marks: [number, number][] }
export interface SearchHit { sessionId: string; hits: number; snippets: Snip[]; session: SessionSummary }
export interface Trash { sessions: (SessionSummary & { hiddenAt: number })[]; partial: (SessionSummary & { hiddenMessages: number; hiddenAt: number })[]; removed: (SessionSummary & { removedAt: number; backupDir: string })[] }
export interface Run { id: string; sessionId: string; resultSessionId?: string; allowWrite: boolean; status: 'running' | 'done' | 'failed' | 'stopped'; startedAt: number; endedAt?: number; exitCode?: number | null; error?: string }

export interface NodeInfo {
  id: string; name: string; kind: 'ssh' | 'url'; host?: string; user?: string; port?: number; identity?: string; url?: string; at: number
  state: 'offline' | 'connecting' | 'online' | 'error'; error?: string
  /** ssh nodes: how far the copy of the node's history is */
  sync?: NodeSync
}
export interface NodeSync { phase: 'idle' | 'listing' | 'fetching'; stage?: 'transcripts' | 'databases'; lastSync?: number; files: number; bytes: number; pending: number; bytesDone: number; bytesTotal: number; wire?: number; error?: string }
export interface SshHost { alias: string; hostName?: string; user?: string; port?: string | number; identity?: string }
export type NodeInput = { name: string; kind: 'ssh' | 'url'; host?: string; user?: string; port?: string; identity?: string; url?: string }

/** a computer Sessionary can look into: this one (`local`) or a node */
export interface Machine {
  id: string; name: string; kind: 'local' | 'ssh' | 'url'
  state: 'online' | 'offline' | 'connecting' | 'error'
  host?: string; user?: string; port?: number; identity?: string; url?: string; at: number
  error?: string; sync?: NodeSync; platform?: string
}
export interface ProcInfo { pid: number; cpu: number; mem: number; elapsed: string; cmd: string }
export interface AgentProc extends ProcInfo { agent: string }
export interface SystemInfo {
  host: string; os: string; kernel?: string; arch: string; cpus: number; cpuPercent?: number; load?: [number, number, number]
  mem?: { total: number; used: number }; swap?: { total: number; used: number }; disk?: { total: number; used: number; mount: string }
  net?: { rx: number; tx: number }
  uptime?: number; procs: ProcInfo[]; agents: AgentProc[]; at: number
}
export interface AgentInstall { id: string; bin: string; path?: string; version?: string; installed: boolean }
export interface Summary {
  sessions: number; projects: number; active: number; last?: number
  agents: { id: string; label: string; sessions: number; last?: number }[]
  recent: SessionSummary[]
}
export interface TermInfo {
  id: string; machine: string; title: string; kind: 'shell' | 'resume' | 'new'; agent?: string; sessionId?: string; cwd?: string
  pid?: number; state: 'running' | 'exited'; startedAt: number; endedAt?: number; exitCode?: number | null; bytes: number
  cols?: number; rows?: number; resizable?: boolean
}

// ---- chats: an agent's own protocol held open by the server ----
export type ChatState = 'starting' | 'idle' | 'working' | 'waiting' | 'closed'
export interface ChatModel { id: string; label: string; description?: string }
export interface ChatInfo {
  agent: string; sessionId?: string; nativeId?: string; model?: string; models?: ChatModel[]; mode?: string; modes?: ChatModel[]
  effort?: string; efforts?: string[]; commands?: { name: string; description?: string; hint?: string }[]
  caps?: { interrupt?: boolean; steer?: boolean; setModel?: boolean; setMode?: boolean; setEffort?: boolean; images?: boolean }
  cwd?: string; version?: string
}
export interface ChatSummary {
  id: string; agent: string; machine: string; cwd?: string; sessionKey?: string; sessionId?: string; title?: string
  state: ChatState; info: ChatInfo; startedAt: number; lastAt: number; lastSeq: number; error?: string; pending: number; preview?: string
}
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'allow_always' | 'deny' | 'abort' }
export interface ChatQuestion { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; multi?: boolean; secret?: boolean; other?: boolean }
export interface ChatUsage { input?: number; output?: number; cost?: number; context?: number; window?: number }
export type ChatEvent = { seq: number; at: number } & (
  | { t: 'info'; info: Partial<ChatInfo> }
  | { t: 'status'; state: ChatState }
  | { t: 'user'; id: string; text: string; queued?: boolean }
  | { t: 'turn'; state: 'start' }
  | { t: 'turn'; state: 'end'; stop: 'done' | 'interrupted' | 'error'; error?: string; usage?: ChatUsage }
  | { t: 'text'; id: string; delta: string }
  | { t: 'text.end'; id: string; text: string }
  | { t: 'thinking'; id: string; delta: string }
  | { t: 'thinking.end'; id: string; text: string }
  | { t: 'tool'; id: string; name: string; input?: unknown; status: 'running' | 'ok' | 'error'; output?: string; diff?: string }
  | { t: 'approval'; id: string; tool: string; title: string; detail?: string; input?: unknown; diff?: string; options: ApprovalOption[] }
  | { t: 'approval.done'; id: string; outcome: string }
  | { t: 'question'; id: string; questions: ChatQuestion[] }
  | { t: 'question.done'; id: string }
  | { t: 'usage'; usage: ChatUsage }
  | { t: 'note'; level: 'info' | 'warn' | 'error'; text: string }
)

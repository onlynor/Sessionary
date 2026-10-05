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
}
export interface Page { start: number; end: number; next: number | null; total: number }
export interface Session extends SessionSummary { messages: Message[]; children: SessionSummary[]; page: Page; trashed?: boolean }
export type EditBlock = ToolBlock & { time?: number }
export interface Agent { id: string; label: string; sessionCount: number; storage: string; available: boolean; error?: string; canResume: boolean; canContinue: boolean }
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

/** Agent-neutral domain model. Adapters translate native formats into this; nothing here knows any agent. */

export type Role = 'user' | 'assistant' | 'system'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | {
      type: 'tool'
      id: string
      name: string
      input: unknown
      /** undefined while no result was recorded (interrupted / still running) */
      output?: string
      status: 'ok' | 'error' | 'pending'
      /** normalised tool category, filled in by the API layer */
      kind?: string
      /** unified diff when the agent recorded one */
      diff?: string
      /** set by the API layer when output was cut for transport */
      truncated?: boolean
    }
  /** `data` is only present inside adapters; the API replaces it with `ref` and serves bytes separately */
  | { type: 'image'; mime: string; data?: string; ref?: string }
  /** non-conversational events: compaction, command, model change... */
  | { type: 'note'; kind: string; text: string }

export interface Message {
  id: string
  role: Role
  /** epoch ms */
  time?: number
  model?: string
  blocks: Block[]
}

export interface SessionSummary {
  /** `${agent}:${nativeId}` – stable and unique across agents */
  id: string
  agent: string
  nativeId: string
  title: string
  /** working directory recorded by the agent itself, if any */
  cwd?: string
  gitBranch?: string
  model?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** set for sub-agent sessions spawned by another session */
  parentId?: string
  tokens?: { input: number; output: number }
  cost?: number
  /** derived at index time */
  preview?: string
  toolCalls?: number
  filesChanged?: number
}

export interface Session extends SessionSummary {
  messages: Message[]
}

/** Something an adapter can turn into one session; `fingerprint` changes whenever the content does. */
export interface Source {
  key: string
  fingerprint: string
  ref: string
}

export interface AgentAdapter {
  id: string
  label: string
  /** the program name the agent is started with, to find it on a machine and read its version */
  bin: string
  /** Enumerate sources cheaply (stat / one light query). */
  listSources(): Promise<Source[]>
  summarize(source: Source): Promise<SessionSummary | null>
  load(source: Source): Promise<Session | null>
  /**
   * Optional, destructive-but-reversible: take the session out of the agent's own storage and put everything
   * needed to bring it back into `backupDir`. Returns an adapter-specific manifest for `restore`.
   */
  remove?(source: Source, backupDir: string): Promise<RemovalManifest>
  restore?(manifest: RemovalManifest, backupDir: string): Promise<void>
  /**
   * Optional: the agent's own non-interactive command that appends one more prompt to this session.
   * `allowWrite: false` must map to the agent's read-only mode.
   */
  continueCommand?(source: Source, session: SessionSummary, prompt: string, opts: { allowWrite: boolean }): ContinueCommand
  /** Optional: the agent's interactive command that starts a fresh session in `cwd` (run in a terminal). */
  newCommand?(cwd: string): LaunchCommand
  /** Optional: the agent's interactive command that reopens exactly this session (run in a terminal). */
  resumeCommand?(source: Source, session: SessionSummary): LaunchCommand
  /** Where the agent keeps its history; watched for live updates and shown when nothing is found. */
  storage(): { path: string; watch: { path: string; recursive: boolean }[] }
}

export interface LaunchCommand { bin: string; args: string[]; cwd: string }

export interface ContinueCommand {
  bin: string
  args: string[]
  cwd: string
  /** recognise the session id the agent reports while running (it may differ if the agent forks) */
  sessionIdFrom?: (stdoutLine: string) => string | undefined
}

export type RemovalManifest = Record<string, unknown>

/** Refusals the UI should explain rather than treat as crashes. */
export class RemovalError extends Error {
  constructor(public code: 'busy' | 'conflict' | 'unsupported' | 'tool', message: string) { super(message) }
}

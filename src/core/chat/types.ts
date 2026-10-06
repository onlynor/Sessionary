/**
 * Talking to an agent the way its own apps do: a long-lived process on the agent's official protocol, not one
 * throw-away command per message. Each protocol is translated by a driver into the events below, so the page
 * only has to understand one thing. The events carry full state where they can (a tool's current input, output
 * and status), so a page that joins late, or replays the log, ends up in the same place as one that watched.
 */
export type ChatState = 'starting' | 'idle' | 'working' | 'waiting' | 'closed'

export interface ModelOption { id: string; label: string; description?: string }
export interface ModeOption { id: string; label: string; description?: string }
export interface SlashCommand { name: string; description?: string; hint?: string }

/** what a chat can do; the page offers only these */
export interface ChatCaps {
  interrupt: boolean
  /** a message sent while the agent is working is delivered to it (rather than queued here) */
  steer: boolean
  setModel: boolean
  setMode: boolean
  setEffort: boolean
  images: boolean
}

export interface ChatInfo {
  agent: string
  /** what the agent resumes a session by, once it exists (a path for Pi) */
  sessionId?: string
  /** the session's id as Sessionary's index knows it after the agent's name (differs from `sessionId` for Pi) */
  nativeId?: string
  model?: string
  models?: ModelOption[]
  mode?: string
  modes?: ModeOption[]
  effort?: string
  efforts?: string[]
  commands?: SlashCommand[]
  caps?: Partial<ChatCaps>
  cwd?: string
  /** the version of the agent that is answering */
  version?: string
}

export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'allow_always' | 'deny' | 'abort' }
export interface QuestionOption { label: string; description?: string }
export interface Question { id: string; header?: string; question: string; options?: QuestionOption[]; multi?: boolean; secret?: boolean; other?: boolean }

export interface Usage { input?: number; output?: number; cost?: number; context?: number; window?: number }

export type ChatEvent =
  /** the session is up; `info` is what it offers (models, modes, slash commands…) and is updated by later `info` events */
  | { t: 'info'; info: Partial<ChatInfo> }
  | { t: 'status'; state: ChatState }
  | { t: 'user'; id: string; text: string; queued?: boolean }
  | { t: 'turn'; state: 'start' }
  | { t: 'turn'; state: 'end'; stop: 'done' | 'interrupted' | 'error'; error?: string; usage?: Usage }
  | { t: 'text'; id: string; delta: string }
  | { t: 'text.end'; id: string; text: string }
  | { t: 'thinking'; id: string; delta: string }
  | { t: 'thinking.end'; id: string; text: string }
  /** an upsert by id: the tool's state as of now */
  | { t: 'tool'; id: string; name: string; input?: unknown; status: 'running' | 'ok' | 'error'; output?: string; diff?: string }
  | { t: 'approval'; id: string; tool: string; title: string; detail?: string; input?: unknown; diff?: string; options: ApprovalOption[] }
  | { t: 'approval.done'; id: string; outcome: string }
  | { t: 'question'; id: string; questions: Question[] }
  | { t: 'question.done'; id: string }
  | { t: 'usage'; usage: Usage }
  | { t: 'note'; level: 'info' | 'warn' | 'error'; text: string }

/** an event as stored and sent: numbered, so a reader can ask for everything after the last one it saw */
export type StoredEvent = ChatEvent & { seq: number; at: number }

export interface ChatSend { text: string; images?: { mimeType: string; data: string }[] }

/** What every protocol driver offers. It reports through `emit`; a failure to start rejects `start()`. */
export interface ChatDriver {
  /** starts the process and does the handshake; resolves when messages can be sent */
  start(): Promise<void>
  /** the session's id as the agent knows it (set as soon as it is known) */
  readonly sessionId?: string
  send(msg: ChatSend): Promise<void>
  interrupt(): Promise<void>
  respond(approvalId: string, optionId: string): Promise<void>
  answer(questionId: string, answers: Record<string, string[]>): Promise<void>
  setModel(id: string): Promise<void>
  setMode(id: string): Promise<void>
  setEffort(level: string): Promise<void>
  close(): Promise<void>
}

export type Emit = (e: ChatEvent) => void

/** a child process as the drivers need it (and as a test can stand in for it) */
export interface Proc {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  pid?: number
  kill(sig?: NodeJS.Signals): boolean
  on(ev: 'close', f: (code: number | null) => void): unknown
  on(ev: 'error', f: (e: Error) => void): unknown
}
/** `tunnel`: on a node, a port there leading back here (ignored on this computer) */
export interface SpawnSpec { bin: string; args: string[]; cwd?: string; env?: Record<string, string>; tunnel?: { remotePort: number; localPort: number }; secret?: { name: string; value: string } }
export type Spawner = (spec: SpawnSpec) => Proc

export class ChatError extends Error {
  constructor(message: string, public code: 'unavailable' | 'busy' | 'failed' | 'unsupported' = 'failed') { super(message) }
}

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { OverlayStore } from './overlay.ts'
import { Mirror, SyncError, explainSsh, runSsh, sshTerminalCommand, type Plan, type SshTarget, type SyncInfo } from './sync.ts'
import { dataHome } from './util.ts'

/**
 * Remote nodes: other machines whose agents Sessionary can read.
 *  - `ssh`: only ssh access is needed. The node's history is mirrored over ssh (see sync.ts) and read in-process.
 *  - `url`: a machine that already runs Sessionary and is reachable at an address; its API is used as it is.
 * Nothing secret is stored: ssh authenticates with the person's own keys and agent.
 */
export interface NodeConfig {
  id: string
  name: string
  kind: 'ssh' | 'url'
  /** ssh: host name, address or ssh_config alias */
  host?: string
  user?: string
  port?: number
  /** path to a private key, passed to `ssh -i` */
  identity?: string
  /** url: base address of the node's API */
  url?: string
  at: number
}

export type NodeState = 'offline' | 'connecting' | 'online' | 'error'
export interface NodeStatus extends NodeConfig { state: NodeState; error?: string; sync?: SyncInfo }

export class NodeError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const inPortRange = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535

/** Checks user input and builds a config; everything that reaches ssh's argv is constrained here. */
export function parseNode(input: any, keep?: Pick<NodeConfig, 'id' | 'at'>): NodeConfig {
  const name = String(input?.name ?? '').trim()
  if (!name || name.length > 60) throw new NodeError('A node needs a name of 1–60 characters.')
  const base = { id: keep?.id ?? randomBytes(6).toString('hex'), name, at: keep?.at ?? Date.now() }
  if (input.kind === 'url') {
    let u: URL
    try { u = new URL(String(input.url)) } catch { throw new NodeError('The address is not a valid URL.') }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NodeError('The address must be http or https.')
    return { ...base, kind: 'url', url: u.origin }
  }
  if (input.kind !== 'ssh') throw new NodeError('Node kind must be "ssh" or "url".')
  const host = String(input.host ?? '').trim()
  if (!HOST.test(host)) throw new NodeError('The host is not a valid name or address.')
  const out: NodeConfig = { ...base, kind: 'ssh', host }
  if (input.user != null && input.user !== '') {
    if (!USER.test(String(input.user))) throw new NodeError('The ssh user is not valid.')
    out.user = String(input.user)
  }
  if (input.port != null && input.port !== '') {
    if (!inPortRange(Number(input.port))) throw new NodeError('The ssh port must be 1–65535.')
    out.port = Number(input.port)
  }
  if (input.identity != null && input.identity !== '') {
    const id = String(input.identity)
    if (id.startsWith('-') || id.includes('\0')) throw new NodeError('The identity file path is not valid.')
    out.identity = id
  }
  return out
}

/** A node's history as its own read-only Sessionary, living in this process (supplied by the server). */
export interface Workspace {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>
  rescan: () => Promise<unknown>
}
export type WorkspaceFactory = (dir: string, mirrorHome: string) => Workspace

/** how often a connected node is looked at again */
const SYNC_EVERY_MS = 15_000

interface Link {
  state: NodeState
  error?: string
  ready?: Promise<Link>
  // url nodes
  base?: string
  token?: string
  // ssh nodes
  mirror?: Mirror
  ws?: Workspace
  timer?: NodeJS.Timeout
  stopped?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Nodes {
  private links = new Map<string, Link>()
  private workspaces = new Map<string, Workspace>()
  constructor(
    private overlay: Pick<OverlayStore, 'nodes' | 'node' | 'addNode' | 'updateNode' | 'removeNode' | 'dropNode'>,
    private workspace?: WorkspaceFactory,
    private hooks: { /** a node has just come online: a good moment to look around while nobody is waiting */ online?: (id: string) => void } = {},
  ) {}

  list(): NodeStatus[] {
    return this.overlay.nodes().map((n) => {
      const l = this.links.get(n.id)
      return { ...n, state: l?.state ?? 'offline', error: l?.error, sync: l?.mirror?.info }
    })
  }

  add(input: unknown): NodeStatus {
    const n = parseNode(input)
    this.overlay.addNode(n)
    return { ...n, state: 'offline' }
  }

  /**
   * Changes how a node is reached. The connection is dropped (it is reopened with the new settings). If the
   * edit points at a different machine, the copy of the old one is discarded: it would show another machine's
   * sessions under this name until the next sync replaced them.
   */
  async update(id: string, input: unknown): Promise<NodeStatus> {
    const old = this.overlay.node(id)
    if (!old) throw new NodeError('No such node.', 404)
    const n = parseNode(input, old)
    const sameMachine = old.kind === 'ssh' && n.kind === 'ssh' && old.host === n.host && old.user === n.user && old.port === n.port
    this.disconnect(id)
    this.overlay.updateNode(n)
    if (!sameMachine) {
      const dir = path.join(dataHome(), 'nodes', id)
      await fs.rm(path.join(dir, 'home'), { recursive: true, force: true })
      await fs.rm(path.join(dir, 'manifest.json'), { force: true })
    }
    return { ...n, state: 'offline' }
  }

  remove(id: string) {
    this.disconnect(id)
    this.overlay.removeNode(id)
    this.overlay.dropNode(id)
    this.workspaces.delete(id)
    // the copy of its history goes with it
    fs.rm(path.join(dataHome(), 'nodes', id), { recursive: true, force: true }).catch(() => {})
  }

  disconnect(id: string) {
    const l = this.links.get(id)
    this.links.delete(id)
    if (!l) return
    l.stopped = true
    clearInterval(l.timer)
    l.mirror?.close().catch(() => {})
  }

  stopAll() { for (const id of [...this.links.keys()]) this.disconnect(id) }

  /** Makes the node usable: for ssh, proves ssh works and starts mirroring; for a url, learns its API token. */
  connect(id: string): Promise<Link> {
    const cfg = this.overlay.node(id)
    if (!cfg) return Promise.reject(new NodeError('No such node.', 404))
    const have = this.links.get(id)
    if (have?.ready) return have.ready
    const link: Link = { state: 'connecting' }
    this.links.set(id, link)
    link.ready = (cfg.kind === 'ssh' ? this.openSsh(cfg, link) : this.openUrl(cfg, link)).then(
      () => link,
      (e) => {
        link.state = 'error'
        link.error = e instanceof Error ? e.message : String(e)
        link.ready = undefined // a later call may retry
        link.mirror?.close().catch(() => {})
        throw e instanceof SyncError ? new NodeError(e.message, 502) : e
      },
    )
    return link.ready
  }

  // ---- ssh nodes ----
  private workspaceFor(cfg: NodeConfig, mirror: Mirror): Workspace {
    let ws = this.workspaces.get(cfg.id)
    if (!ws) {
      if (!this.workspace) throw new NodeError('Reading nodes over ssh is not available here.', 500)
      ws = this.workspace(mirror.dir, mirror.home)
      this.workspaces.set(cfg.id, ws)
    }
    return ws
  }

  private async openSsh(cfg: NodeConfig, link: Link) {
    const mirror = new Mirror(path.join(dataHome(), 'nodes', cfg.id), { host: cfg.host!, user: cfg.user, port: cfg.port, identity: cfg.identity })
    link.mirror = mirror
    link.ws = this.workspaceFor(cfg, mirror)
    // listing the node proves that ssh works; copying the files can take a while, so it carries on in the background
    const plan = await mirror.plan()
    this.copy(cfg, link, plan).catch(() => {})
  }

  /**
   * The first copy. The node becomes usable as soon as its transcripts are in; the databases (large) keep
   * arriving in the background and the sessions in them appear when they are done.
   */
  private async copy(cfg: NodeConfig, link: Link, plan: Plan) {
    try {
      const r = await link.mirror!.apply(plan, async () => {
        if (link.stopped) return
        await link.ws!.rescan()
        link.state = 'online'; link.error = undefined
        this.hooks.online?.(cfg.id)
        link.timer = setInterval(() => this.refresh(link), SYNC_EVERY_MS)
        link.timer.unref()
      })
      if (r.databases && !link.stopped) await link.ws!.rescan()
    } catch (e) {
      if (link.stopped) return
      // a failure in the databases leaves a node that is already usable usable: it is retried at the next look
      if (link.state !== 'online') { link.state = 'error'; link.error = (e as Error).message; link.ready = undefined }
    }
  }

  private async refresh(link: Link) {
    if (link.stopped || link.mirror!.busy) return
    try {
      const r = await link.mirror!.apply(await link.mirror!.plan(), async (changed) => { if (changed) await link.ws!.rescan() })
      if (r.databases) await link.ws!.rescan()
      if (link.state === 'error') { link.state = 'online'; link.error = undefined }
    } catch (e) {
      if (link.stopped) return
      link.state = 'error'; link.error = (e as Error).message // kept retrying: the next tick may find the node again
    }
  }

  /** Syncs now instead of waiting for the next tick. */
  async syncNow(id: string) {
    const link = await this.connect(id)
    if (!link.mirror) return
    if (link.mirror.busy) return
    await this.refresh(link)
    if (link.state === 'error') throw new NodeError(link.error ?? 'Sync failed.', 502)
  }

  /** The command that resumes a session on an ssh node in a terminal here: ssh, then the agent's own resume command. */
  async resumeCommand(id: string, sessionId: string): Promise<{ bin: string; args: string[]; line: string }> {
    return sshTerminalCommand(this.target(id), await this.resumeRaw(id, sessionId))
  }

  /** the agent's own resume command for a session of an ssh node, as the node would run it */
  async resumeRaw(id: string, sessionId: string): Promise<{ bin: string; args: string[]; cwd: string }> {
    this.target(id)
    const res = await this.forward(id, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/resume-command`, '', {})
    if (!res.ok) throw new NodeError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'This agent has no resume command.', res.status === 404 ? 404 : 502)
    const cmd = (await res.json()) as { bin: string; args: string[]; cwd: string }
    // a program override on this machine means nothing on the node: use its plain name
    return { ...cmd, bin: cmd.bin.split('/').pop() ?? cmd.bin }
  }

  /** how to reach an ssh node */
  target(id: string): SshTarget {
    const cfg = this.overlay.node(id)
    if (!cfg) throw new NodeError('No such node.', 404)
    if (cfg.kind !== 'ssh') throw new NodeError('This is only available for nodes reached over ssh.', 400)
    return { host: cfg.host!, user: cfg.user, port: cfg.port, identity: cfg.identity }
  }

  /**
   * Runs a script on an ssh node and returns what it printed. The script goes in on stdin to `sh -s`, so the node's
   * login shell (fish, tcsh…) never has to parse it. A failure carries what the node said.
   */
  async exec(id: string, script: string, opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const r = await runSsh(process.env.SESSIONARY_SSH_BIN ?? 'ssh', this.target(id), 'sh -s', { input: script, timeoutMs: opts.timeoutMs ?? 25_000 })
    const out = { stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    if (r.code !== 0 && !out.stdout.length) throw new NodeError(explainSsh(r.stderr), 502)
    return out
  }

  // ---- url nodes ----
  private async openUrl(cfg: NodeConfig, link: Link) {
    link.base = cfg.url
    const deadline = Date.now() + Number(process.env.SESSIONARY_NODE_TIMEOUT_MS ?? 15_000)
    while (Date.now() < deadline) {
      try { link.token = await this.fetchToken(link); link.state = 'online'; this.hooks.online?.(cfg.id); return } catch { await sleep(300) }
    }
    throw new NodeError('Timed out waiting for Sessionary at that address. Is it running there?', 504)
  }

  private async fetchToken(link: Link): Promise<string> {
    const r = await fetch(`${link.base}/api/token`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`token ${r.status}`)
    const t = ((await r.json()) as { token?: string }).token
    if (!t) throw new Error('no token')
    return t
  }

  /** Sends one request to the node's API. Only `/api/*` (never `/api/token`) is reachable. */
  async forward(id: string, method: string, path: string, search: string, headers: { contentType?: string; accept?: string }, body?: ArrayBuffer): Promise<Response> {
    const link = await this.connect(id)
    const base = link.base ?? 'http://localhost'
    const url = new URL(path + search, base)
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/token')
      throw new NodeError('That path is not available through a node.', 400)
    const send = (): Response | Promise<Response> => link.ws
      ? link.ws.request(url.pathname + url.search, {
        method,
        headers: { host: 'localhost', ...(headers.contentType ? { 'content-type': headers.contentType } : {}), ...(headers.accept ? { accept: headers.accept } : {}) },
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      })
      : fetch(url, {
        method,
        headers: { 'x-sessionary-token': link.token!, ...(headers.contentType ? { 'content-type': headers.contentType } : {}), ...(headers.accept ? { accept: headers.accept } : {}) },
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      })
    try {
      let res = await send()
      if (!link.ws && res.status === 403 && method !== 'GET') { // the node restarted and issued a new token
        link.token = await this.fetchToken(link)
        res = await send()
      }
      return res
    } catch (e) {
      if (e instanceof NodeError) throw e
      this.disconnect(id) // the node went away; the next request reconnects
      throw new NodeError(`The node is unreachable: ${(e as Error).message}`, 502)
    }
  }
}

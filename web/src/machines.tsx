import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api as localApi, host, makeApi, machineBase, type Api } from './api'
import type { Agent, AgentInstall, Machine, Summary, SessionSummary, SystemInfo } from './types'

/** every machine: this computer, then the nodes, with their connection state */
interface MachinesState { machines: Machine[]; loaded: boolean; /** the server itself is not answering */ down: boolean; reload: () => Promise<void> }
const MachinesCtx = createContext<MachinesState>({ machines: [], loaded: false, down: false, reload: async () => {} })
export const useMachines = () => useContext(MachinesCtx)

export function MachinesProvider({ children }: { children: React.ReactNode }) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [down, setDown] = useState(false)
  const reload = useCallback(async () => {
    try { setMachines(await host.machines()); setLoaded(true); setDown(false) } catch { setDown(true) /* the server may be restarting; the next poll tries again */ }
  }, [])
  useEffect(() => { reload() }, [reload])
  // a connection attempt changes state within seconds; otherwise a slow look is enough
  const busy = machines.some((m) => m.state === 'connecting' || m.sync?.phase === 'fetching')
  useEffect(() => {
    const id = setInterval(reload, busy ? 1500 : 12_000)
    return () => clearInterval(id)
  }, [busy, reload])
  const value = useMemo(() => ({ machines, loaded, down, reload }), [machines, loaded, down, reload])
  return <MachinesCtx.Provider value={value}>{children}</MachinesCtx.Provider>
}

/** What one machine holds, loaded once and kept current for as long as it is open. */
export interface MachineData {
  machine: Machine
  api: Api
  agents: Agent[]
  sessions: SessionSummary[]
  loaded: boolean
  error?: string
  reload: () => Promise<void>
}
const MachineCtx = createContext<MachineData | null>(null)
export const useMachine = () => { const m = useContext(MachineCtx); if (!m) throw new Error('no machine open'); return m }
/** the open machine's API; this computer's when none is open */
export const useApi = (): Api => useContext(MachineCtx)?.api ?? localApi

export const usable = (m: Machine) => m.kind === 'local' || m.state === 'online'

export function MachineProvider({ machine, children }: { machine: Machine; children: React.ReactNode }) {
  const api = useMemo(() => makeApi(machineBase(machine.id)), [machine.id])
  const [agents, setAgents] = useState<Agent[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const ready = usable(machine)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const reload = useCallback(async () => {
    if (!ready) return
    try {
      const [a, s] = await Promise.all([api.agents(), api.sessions()])
      if (!alive.current) return
      setAgents(a); setSessions(s); setLoaded(true); setError(undefined)
    } catch (e) { if (alive.current) { setError((e as Error).message); setLoaded(true) } }
  }, [api, ready])
  useEffect(() => { reload() }, [reload])

  // the machine pushes a change whenever an agent writes (or, for a node, whenever a sync brought news)
  useEffect(() => {
    if (!ready) return
    const es = api.events()
    let t: number | undefined
    const soon = () => { clearTimeout(t); t = window.setTimeout(reload, 250) }
    es.addEventListener('index', soon)
    es.addEventListener('hello', soon)
    const poll = setInterval(reload, 45_000) // covers a stream that was cut
    return () => { es.close(); clearTimeout(t); clearInterval(poll) }
  }, [api, ready, reload])

  const value = useMemo<MachineData>(() => ({ machine, api, agents, sessions, loaded, error, reload }), [machine, api, agents, sessions, loaded, error, reload])
  return <MachineCtx.Provider value={value}>{children}</MachineCtx.Provider>
}

/** Per-machine counts and latest sessions, for the overviews that must not load every session of every machine. */
export function useSummaries(machines: Machine[]): Record<string, Summary | undefined> {
  const [out, setOut] = useState<Record<string, Summary | undefined>>({})
  const key = machines.filter(usable).map((m) => m.id + ':' + (m.sync?.lastSync ?? 0)).join(',')
  useEffect(() => {
    let live = true
    const load = () => machines.filter(usable).forEach((m) =>
      makeApi(machineBase(m.id)).summary().then((s) => live && setOut((o) => ({ ...o, [m.id]: s })), () => {}))
    load()
    const id = setInterval(load, 30_000)
    return () => { live = false; clearInterval(id) }
  }, [key])
  return out
}

/** a machine's system report, refreshed while the page that shows it is open */
export function useSystem(machine: Machine | undefined, every = 0): { system?: SystemInfo; error?: string; history: SystemInfo[] } {
  const [system, setSystem] = useState<SystemInfo>()
  const [error, setError] = useState<string>()
  const [history, setHistory] = useState<SystemInfo[]>([])
  const id = machine && usable(machine) ? machine.id : undefined
  useEffect(() => {
    setSystem(undefined); setError(undefined); setHistory([])
    if (!id) return
    let live = true
    const load = () => host.system(id).then((s) => { if (!live) return; setSystem(s); setError(undefined); setHistory((h) => [...h.slice(-59), s]) }, (e) => live && setError((e as Error).message))
    load()
    const t = every ? setInterval(load, every) : undefined
    return () => { live = false; clearInterval(t) }
  }, [id, every])
  return { system, error, history }
}

const installedKey = (id: string) => `sessionary:installed:${id}`
const readInstalled = (id: string): { agents: AgentInstall[]; at: number } | undefined => {
  try { return JSON.parse(localStorage.getItem(installedKey(id)) ?? 'null') ?? undefined } catch { return undefined }
}

/**
 * Which agents are really installed on a machine, and their versions (the history alone does not say).
 * Finding out can take seconds on a far-away machine, so what was found last time is shown at once (from here, then
 * from the server's memory) and quietly brought up to date; `refresh` makes the machine look again.
 */
export function useInstalled(machine: Machine): { installed?: AgentInstall[]; at?: number; busy: boolean; refresh: () => void } {
  const ok = usable(machine)
  const [state, setState] = useState(() => readInstalled(machine.id))
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setBusy(true)
    try {
      // the server may answer from memory and look again in the background: ask again shortly for what it found
      for (let i = 0; i < 3 && live.current; i++) {
        const r = await host.installed(machine.id, refresh && i === 0)
        if (!live.current) return
        setState({ agents: r.agents, at: r.at })
        try { localStorage.setItem(installedKey(machine.id), JSON.stringify({ agents: r.agents, at: r.at })) } catch { /* private mode */ }
        if (!r.refreshing && !(refresh && i === 0)) break
        if (!r.refreshing) break
        await new Promise((res) => setTimeout(res, 2500))
      }
    } catch { /* keep what is shown */ } finally { if (live.current) setBusy(false) }
  }, [machine.id])
  useEffect(() => { setState(readInstalled(machine.id)); if (ok) load(false) }, [machine.id, ok, load])
  return { installed: state?.agents, at: state?.at, busy, refresh: () => load(true) }
}

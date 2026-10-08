import { useEffect, useState } from 'react'

/**
 * Where the person is, kept in the URL hash so back/forward and links work. The hierarchy is
 * machine → agent → project → session, and every level is addressable:
 *
 *   #/                                 home
 *   #/machines                         every machine
 *   #/nodes[?add=1|?edit=<id>]         add, edit, remove machines
 *   #/m/<machine>[/tab][?…]            one machine: agents · projects · sessions · terminal · monitor · trash
 *   #/m/<machine>/a/<agent>[?p=<project>]   an agent on that machine, optionally inside a project
 *   #/m/<machine>/s/<session>[?v=changes]   one session
 *   #/m/<machine>/c/<chat>             a live chat that has no session yet
 *
 * Model Control is about this computer (its gateway), whichever machine is open:
 *
 *   #/models[/<provider>][?add=1]      providers and their models
 *   #/routing[/<group>][?m=<machine>]  which agent uses what on a machine (m= for every machine); routing groups
 *   #/gateway                          the local endpoint agents are pointed at
 *   #/usage[?src=history]              what went through it (or what sessions recorded)
 *
 * `local` is this computer; any other machine id is a node.
 */
export type MachineTab = 'agents' | 'projects' | 'sessions' | 'terminal' | 'monitor' | 'trash'
export const MACHINE_TABS: MachineTab[] = ['agents', 'projects', 'sessions', 'terminal', 'monitor', 'trash']

export type Route =
  | { page: 'home' }
  | { page: 'machines' }
  | { page: 'nodes'; add: boolean; edit?: string }
  | { page: 'machine'; machine: string; tab: MachineTab; params: URLSearchParams }
  | { page: 'agent'; machine: string; agent: string; params: URLSearchParams }
  | { page: 'session'; machine: string; id: string; view: 'chat' | 'changes'; q?: string; m?: number }
  | { page: 'chat'; machine: string; id: string }
  | { page: 'models'; provider?: string; add: boolean }
  | { page: 'routing'; group?: string; machine: string }
  | { page: 'gateway' }
  | { page: 'usage'; source: 'gateway' | 'history' }

export function parseRoute(hash = location.hash): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const seg = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s) } catch { return s } })
  const params = new URLSearchParams(query)
  const [a, b, c, d] = seg
  if (!a) return { page: 'home' }
  if (a === 'machines') return { page: 'machines' }
  if (a === 'models') return { page: 'models', provider: b, add: params.has('add') }
  if (a === 'routing') return { page: 'routing', group: b, machine: params.get('m') ?? 'local' }
  if (a === 'gateway') return { page: 'gateway' }
  if (a === 'usage') return { page: 'usage', source: params.get('src') === 'history' ? 'history' : 'gateway' }
  if (a === 'nodes') return { page: 'nodes', add: params.has('add'), edit: params.get('edit') ?? undefined }
  // links from before machines existed
  if (a === 's' && b) return { page: 'session', machine: 'local', id: b, view: params.get('v') === 'changes' ? 'changes' : 'chat', q: params.get('q') ?? undefined, m: params.has('m') ? Number(params.get('m')) : undefined }
  if (a === 'trash') return { page: 'machine', machine: 'local', tab: 'trash', params }
  if (a === 'm' && b) {
    if (c === 'a' && d) return { page: 'agent', machine: b, agent: d, params }
    if (c === 'c' && d) return { page: 'chat', machine: b, id: d }
    if (c === 's' && d) return { page: 'session', machine: b, id: d, view: params.get('v') === 'changes' ? 'changes' : 'chat', q: params.get('q') ?? undefined, m: params.has('m') ? Number(params.get('m')) : undefined }
    return { page: 'machine', machine: b, tab: (MACHINE_TABS as string[]).includes(c ?? '') ? (c as MachineTab) : 'agents', params }
  }
  return { page: 'home' }
}

const enc = encodeURIComponent
const qs = (q?: Record<string, string | undefined>) => {
  const e = Object.entries(q ?? {}).filter(([, v]) => v != null && v !== '') as [string, string][]
  return e.length ? '?' + e.map(([k, v]) => `${k}=${enc(v)}`).join('&') : ''
}

export const href = {
  home: '#/',
  machines: '#/machines',
  nodes: (q?: { add?: string; edit?: string }) => `#/nodes${qs(q)}`,
  machine: (machine: string, tab: MachineTab = 'agents', q?: Record<string, string | undefined>) => `#/m/${enc(machine)}${tab === 'agents' ? '' : '/' + tab}${qs(q)}`,
  agent: (machine: string, agent: string, q?: Record<string, string | undefined>) => `#/m/${enc(machine)}/a/${enc(agent)}${qs(q)}`,
  chat: (machine: string, id: string) => `#/m/${enc(machine)}/c/${enc(id)}`,
  session: (machine: string, id: string, q?: Record<string, string | undefined>) => `#/m/${enc(machine)}/s/${enc(id)}${qs(q)}`,
  models: (provider?: string, q?: { add?: string }) => `#/models${provider ? '/' + enc(provider) : ''}${qs(q)}`,
  /** `machine` '' is the default for every machine; omitted: this computer */
  routing: (group?: string, machine?: string) => `#/routing${group ? '/' + enc(group) : ''}${machine === undefined || machine === 'local' ? '' : `?m=${enc(machine)}`}`,
  gateway: '#/gateway',
  usage: (source?: 'history') => `#/usage${qs({ src: source })}`,
}

export const go = (h: string) => { location.hash = h.replace(/^#/, '') }

export function useRoute(): Route {
  const [r, setR] = useState(() => parseRoute())
  useEffect(() => {
    const on = () => setR(parseRoute())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return r
}

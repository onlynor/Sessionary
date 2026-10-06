import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { t, useT } from './i18n'
import { launchTerminal, termSize } from './actions'
import { host } from './api'
import { duration, relAgo } from './format'
import { Icon } from './Icon'
import { useMachine, useSystem } from './machines'
import { go, href } from './route'
import { useNotify } from './notify'
import { Bar, MoreMenu, fmtBytes, useUi } from './ui'
import type { TermInfo } from './types'

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Colours for the terminal, chosen for readability on each of the app's themes (and kept readable by `minimumContrastRatio`). */
function termTheme() {
  const light = document.documentElement.dataset.theme === 'paper'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-code').trim() || (light ? '#f6f6f8' : '#19191b')
  return light
    ? { background: bg, foreground: '#1d1d1f', cursor: '#007aff', cursorAccent: bg, selectionBackground: 'rgba(0,122,255,0.25)',
        black: '#1d1d1f', red: '#c4261d', green: '#1f7a3a', yellow: '#8a6100', blue: '#0a5bd0', magenta: '#9b2f9f', cyan: '#0b7285', white: '#6e6e73',
        brightBlack: '#5c5c61', brightRed: '#e5372d', brightGreen: '#28a745', brightYellow: '#a67400', brightBlue: '#007aff', brightMagenta: '#af52de', brightCyan: '#0e8aa0', brightWhite: '#1d1d1f' }
    : { background: bg, foreground: '#ececee', cursor: '#0a84ff', cursorAccent: bg, selectionBackground: 'rgba(10,132,255,0.38)',
        black: '#48484a', red: '#ff6961', green: '#30d158', yellow: '#ffd60a', blue: '#64a8ff', magenta: '#d78bff', cyan: '#5fd7ff', white: '#d8d8dc',
        brightBlack: '#8e8e93', brightRed: '#ff8a82', brightGreen: '#5ee27f', brightYellow: '#ffe45e', brightBlue: '#8fc0ff', brightMagenta: '#e3a8ff', brightCyan: '#8be3ff', brightWhite: '#ffffff' }
}

/**
 * The terminal itself: draws what the server's process prints, sends what is typed, and keeps the process's idea of
 * its size equal to the room it has here. Output survives leaving the page.
 */
function XTerm({ term, epoch, onExit }: { term: TermInfo; epoch: number; onExit: (i: TermInfo) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const resizable = term.resizable !== false
    const x = new Terminal({
      cols: term.cols ?? 100, rows: term.rows ?? 30, scrollback: 5000, cursorBlink: true, convertEol: true, fontSize: 13.5, lineHeight: 1.18,
      // a Latin monospace first: a CJK font's line height would make every row tall
      fontFamily: "'JetBrains Mono Variable', 'DejaVu Sans Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace",
      allowProposedApi: true, minimumContrastRatio: 4.5, theme: termTheme(),
    })
    const fit = new FitAddon()
    x.loadAddon(fit)
    x.open(box.current!)
    let closed = false
    let es: EventSource | undefined
    // keystrokes go out one after another, so fast typing keeps its order
    let queue: Promise<unknown> = Promise.resolve()
    x.onData((d) => { queue = queue.then(() => host.terminalInput(term.id, d)).catch(() => {}) })

    // fit to the room, and tell the process when the room changes
    let pending: number | undefined
    const sync = () => {
      if (!resizable || closed) return
      try { fit.fit() } catch { return }
      clearTimeout(pending)
      pending = window.setTimeout(() => host.resizeTerminal(term.id, x.cols, x.rows).catch(() => {}), 120)
    }
    const ro = new ResizeObserver(sync)
    if (resizable) { ro.observe(box.current!); requestAnimationFrame(sync) }
    // the terminal follows the app's theme
    const mo = new MutationObserver(() => { x.options.theme = termTheme() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    host.terminalStream(term.id).then((s) => {
      if (closed) { s.close(); return }
      es = s
      s.addEventListener('out', (e) => x.write(b64((e as MessageEvent).data)))
      s.addEventListener('exit', (e) => {
        const info = JSON.parse((e as MessageEvent).data) as TermInfo
        x.write(`\r\n\x1b[2m[${t('process exited')}${info.exitCode != null ? ` · ${info.exitCode}` : ''}]\x1b[0m\r\n`)
        onExit(info)
        s.close()
      })
    })
    if (term.state === 'running') x.focus()
    return () => { closed = true; clearTimeout(pending); ro.disconnect(); mo.disconnect(); es?.close(); x.dispose() }
  }, [term.id, epoch])
  return <div className={`xterm-box ${term.resizable === false ? 'fixed' : ''}`} ref={box} onClick={() => box.current?.querySelector('textarea')?.focus()} />
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return <><dt>{k}</dt><dd>{children}</dd></>
}

/** Terminals on this machine: a shell, or an agent running in one, with its process and the machine's load beside it. */
export function TerminalTab({ params }: { params: URLSearchParams }) {
  useT()
  const { machine, agents, sessions } = useMachine()
  const ui = useUi()
  const notify = useNotify()
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [, tick] = useState(0)
  const { system } = useSystem(machine, 4000)

  const load = async () => { try { setTerms(await host.terminals(machine.id)); setLoaded(true) } catch { setLoaded(true) } }
  useEffect(() => { load(); const id = setInterval(load, 2000); return () => clearInterval(id) }, [machine.id])
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [])

  const wanted = params.get('t')
  const cur = terms.find((x) => x.id === wanted) ?? terms[terms.length - 1]
  const show = (id: string) => go(href.machine(machine.id, 'terminal', { t: id }))
  // a terminal opened elsewhere (resume from a session) arrives with its id in the URL before the list has it
  useEffect(() => { if (wanted && !terms.some((x) => x.id === wanted) && loaded) load() }, [wanted, loaded])

  const stop = async () => { if (cur) { await host.killTerminal(cur.id); load() } }
  const restart = async () => {
    if (!cur) return
    try { const n = await host.restartTerminal(cur.id, termSize()); await load(); show(n.id) } catch (e) { ui.say((e as Error).message) }
  }
  const close = async () => { if (!cur) return; await host.removeTerminal(cur.id); const rest = terms.filter((x) => x.id !== cur.id); setTerms(rest); if (rest.length) show(rest[rest.length - 1]!.id); else go(href.machine(machine.id, 'terminal')); load() }
  const start = (spec: { kind: 'shell' | 'new'; agent?: string }) => launchTerminal(ui.say, { machine: machine.id, ...spec })
  const session = cur?.sessionId ? sessions.find((s) => s.id === cur.sessionId) : undefined
  const running = cur?.state === 'running'
  const agentProcs = system?.agents ?? []

  const newMenu = [
    { label: t('Shell'), icon: 'terminal', onSelect: () => start({ kind: 'shell' }) },
    '-' as const,
    ...agents.filter((a) => a.canCreate).map((a) => ({ label: t('New {agent} session', { agent: a.label }), icon: 'other', onSelect: () => start({ kind: 'new', agent: a.id }) })),
  ]

  return (
    <div className="term-tab">
      <div className="term-bar">
        <div className="term-tabs" role="tablist">
          {terms.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === cur?.id} className={`term-chip ${x.id === cur?.id ? 'on' : ''}`} onClick={() => show(x.id)}>
              <span className={`sdot ${x.state === 'running' ? 'sd-online' : 'sd-offline'}`} />{x.title}{notify.unreadTerm(x.id) && x.id !== cur?.id && <span className="alert-dot" title={t('Waiting for you')} />}
            </button>
          ))}
        </div>
        <MoreMenu items={newMenu} label={t('New terminal')} className="btn icon plus" />
        <span className="grow" />
        {cur && (
          <>
            <button className="btn" onClick={stop} disabled={!running}><Icon name="stop" size={13} />{t('Stop')}</button>
            <button className="btn" onClick={restart}><Icon name="restart" size={13} />{t('Restart')}</button>
            <button className="btn" onClick={() => setEpoch((n) => n + 1)} title={t('Attach to the running process again')}><Icon name="plug" size={13} />{t('Reconnect')}</button>
            <button className="btn danger-quiet" onClick={close}><Icon name="x" size={13} />{t('Close')}</button>
          </>
        )}
      </div>

      {!loaded ? <div className="sk-line" /> : !cur ? (
        <div className="empty-state">
          <span className="tile"><Icon name="terminal" size={28} stroke={1.5} /></span>
          <b>{t('No terminal is open on {name}.', { name: machine.name })}</b>
          <span>{t('A terminal keeps running when you leave this page; come back and reconnect to it.')}</span>
          <span className="node-empty-actions">
            <button className="btn primary" onClick={() => start({ kind: 'shell' })}><Icon name="terminal" size={14} />{t('Open a terminal')}</button>
            {agents.filter((a) => a.canCreate).slice(0, 3).map((a) => <button key={a.id} className="btn" onClick={() => start({ kind: 'new', agent: a.id })}>{t('New {agent} session', { agent: a.label })}</button>)}
          </span>
        </div>
      ) : (
        <div className="term-grid">
          <div className="term-main">
            <div className="term-head">
              <span className={`sdot ${running ? 'sd-online' : 'sd-offline'}`} />
              <b>{cur.title}</b>
              <span className="r-meta">{machine.name}{cur.cwd ? ` · ${cur.cwd}` : ''}</span>
              <span className="grow" />
              <span className="r-meta">{running ? t('running {t}', { t: duration(Date.now() - cur.startedAt) }) : t('exited')}</span>
            </div>
            <div className="xterm-wrap"><XTerm key={cur.id + ':' + epoch} term={cur} epoch={epoch} onExit={() => load()} /></div>
          </div>

          <aside className="term-side">
            <div className="section-label">{t('Process')}</div>
            <dl className="kv group-card node-kv">
              <Field k={t('Status')}>{running ? <span className="ok-text">{t('Running')}</span> : t('Exited')}{cur.exitCode != null && cur.state === 'exited' ? ` (${cur.exitCode})` : ''}</Field>
              <Field k="PID">{cur.pid ?? '—'}</Field>
              <Field k={t('Started')}>{relAgo(cur.startedAt)}</Field>
              <Field k={t('Output')}>{fmtBytes(cur.bytes)}</Field>
              <Field k={t('Size')}>{cur.cols}×{cur.rows}</Field>
              {cur.agent && <Field k={t('Agent')}>{agents.find((a) => a.id === cur.agent)?.label ?? cur.agent}</Field>}
              {session && <Field k={t('Session')}><a href={href.session(machine.id, session.id)}>{session.title.slice(0, 28)}</a></Field>}
            </dl>

            <div className="section-label">{t('Machine')}</div>
            <div className="group-card term-load">
              <div><span className="r-meta">CPU {system?.cpuPercent ?? '—'}%</span><Bar value={system?.cpuPercent ?? 0} /></div>
              <div><span className="r-meta">{t('Memory')} {system?.mem ? Math.round((system.mem.used / system.mem.total) * 100) : '—'}%</span><Bar value={system?.mem ? (system.mem.used / system.mem.total) * 100 : 0} /></div>
            </div>

            <div className="section-label">{t('Running agents')} · {agentProcs.length}</div>
            <div className="group-card">
              {agentProcs.length ? agentProcs.slice(0, 6).map((p) => (
                <div key={p.pid} className="proc-row" title={p.cmd}>
                  <span className="r-title">{agents.find((a) => a.bin === p.agent)?.label ?? p.agent}</span>
                  <span className="r-meta">{p.pid} · {p.cpu.toFixed(1)}%</span>
                </div>
              )) : <div className="list-empty pad">{t('No agent is running.')}</div>}
            </div>
            {cur.resizable === false && <p className="quiet-note node-note">{t('A terminal cannot be resized once it has started.')}</p>}
          </aside>
        </div>
      )}
    </div>
  )
}

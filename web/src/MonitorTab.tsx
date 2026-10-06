import { t, useT } from './i18n'
import { Icon } from './Icon'
import { useMachine, useSystem } from './machines'
import { Gauge, Spark, fmtBytes, fmtUptime } from './ui'

const rate = (n: number) => `${fmtBytes(Math.round(n))}/s`
import type { ProcInfo } from './types'

function ProcTable({ rows, agentLabel }: { rows: (ProcInfo & { agent?: string })[]; agentLabel?: (id: string) => string }) {
  useT()
  return (
    <div className="group-card proc-table">
      <div className="proc-head"><span>PID</span><span>{t('Command')}</span><span>CPU</span><span>{t('Memory')}</span><span>{t('Running')}</span></div>
      {rows.map((p) => (
        <div key={p.pid} className="proc-line" title={p.cmd}>
          <span className="mono">{p.pid}</span>
          <span className="ellip">{p.agent && <b className="proc-agent">{agentLabel?.(p.agent) ?? p.agent}</b>}{p.cmd}</span>
          <span className="mono">{p.cpu.toFixed(1)}%</span>
          <span className="mono">{p.mem.toFixed(1)}%</span>
          <span className="mono">{p.elapsed}</span>
        </div>
      ))}
    </div>
  )
}

/** How the machine is doing right now: load, memory, disk, and which processes — agents first — are busy. */
export function MonitorTab() {
  useT()
  const { machine, agents } = useMachine()
  const { system, error, history } = useSystem(machine, 3000)
  const label = (bin: string) => agents.find((a) => a.bin === bin)?.label ?? bin
  if (error && !system) return <div className="node-error"><b>{t('The machine did not answer')}</b><span>{error}</span></div>
  if (!system) return <div className="sk-line" />
  const memPct = system.mem ? (system.mem.used / system.mem.total) * 100 : undefined
  const swapPct = system.swap && system.swap.total ? (system.swap.used / system.swap.total) * 100 : undefined
  const diskPct = system.disk ? (system.disk.used / system.disk.total) * 100 : undefined

  return (
    <>
      <div className="mon-top">
        <div className="group-card mon-gauges">
          <Gauge label="CPU" value={system.cpuPercent} sub={system.cpus ? t('{n} cores', { n: system.cpus }) : undefined} />
          <Gauge label={t('Memory')} value={memPct} sub={system.mem ? `${fmtBytes(system.mem.used)} / ${fmtBytes(system.mem.total)}` : undefined} />
          <Gauge label={t('Disk')} value={diskPct} sub={system.disk ? `${fmtBytes(system.disk.used)} / ${fmtBytes(system.disk.total)}` : undefined} />
          {swapPct != null && system.swap!.total > 0 && <Gauge label="Swap" value={swapPct} sub={`${fmtBytes(system.swap!.used)} / ${fmtBytes(system.swap!.total)}`} />}
        </div>
        <dl className="kv group-card node-kv mon-facts">
          <dt>{t('System')}</dt><dd>{system.os || '—'}</dd>
          {system.kernel && <><dt>{t('Kernel')}</dt><dd>{system.kernel} · {system.arch}</dd></>}
          <dt>{t('Uptime')}</dt><dd>{fmtUptime(system.uptime)}</dd>
          {system.load && <><dt>{t('Load average')}</dt><dd className="mono">{system.load.map((n) => n.toFixed(2)).join('  ')}</dd></>}
          {system.net && <><dt>{t('Network')}</dt><dd className="mono">↓ {rate(system.net.rx)}  ↑ {rate(system.net.tx)}</dd></>}
          {system.disk && <><dt>{t('Disk')}</dt><dd>{system.disk.mount}</dd></>}
        </dl>
      </div>

      <div className="mon-charts">
        {system.net && <div className="group-card mon-chart"><div className="r-meta">{t('Network')} · ↓ {rate(system.net.rx)} · ↑ {rate(system.net.tx)}</div><Spark values={history.map((h) => (h.net ? h.net.rx + h.net.tx : undefined))} max={Math.max(1024, ...history.map((h) => (h.net ? h.net.rx + h.net.tx : 0)))} label={t('Network')} /></div>}
        <div className="group-card mon-chart"><div className="r-meta">CPU · {system.cpuPercent ?? '—'}%</div><Spark values={history.map((h) => h.cpuPercent)} label="CPU" /></div>
        <div className="group-card mon-chart"><div className="r-meta">{t('Memory')} · {memPct != null ? `${Math.round(memPct)}%` : '—'}</div><Spark values={history.map((h) => (h.mem ? (h.mem.used / h.mem.total) * 100 : undefined))} label={t('Memory')} /></div>
      </div>

      <div className="section-label">{t('Agent processes')} · {system.agents.length}</div>
      {system.agents.length ? <ProcTable rows={system.agents} agentLabel={label} /> : <div className="group-card"><div className="list-empty pad"><Icon name="task" size={14} /> {t('No agent is running on this machine right now.')}</div></div>}

      <div className="section-label">{t('Busiest processes')}</div>
      {system.procs.length ? <ProcTable rows={system.procs.slice(0, 8)} /> : <div className="group-card"><div className="list-empty pad">{t('Process details are not available on this system.')}</div></div>}
      <div className="mon-foot r-meta">{t('Updated every 3 seconds')}</div>
    </>
  )
}

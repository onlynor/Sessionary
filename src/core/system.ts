import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

/**
 * What a machine is doing right now, and which agents it has. Both come from one short shell script, run
 * here for this machine and over ssh for a node, so a node needs nothing installed. Linux is read from /proc
 * and `ps`; this machine, if it is not Linux, falls back to what Node itself can report.
 */
export interface ProcInfo { pid: number; cpu: number; mem: number; elapsed: string; cmd: string }
export interface AgentProc extends ProcInfo { agent: string }
export interface SystemInfo {
  host: string
  os: string
  kernel?: string
  arch: string
  cpus: number
  /** 0–100, over a short sample */
  cpuPercent?: number
  load?: [number, number, number]
  mem?: { total: number; used: number }
  swap?: { total: number; used: number }
  disk?: { total: number; used: number; mount: string }
  /** bytes per second over every interface but loopback */
  net?: { rx: number; tx: number }
  /** seconds */
  uptime?: number
  procs: ProcInfo[]
  agents: AgentProc[]
  at: number
}

export interface AgentInstall { id: string; bin: string; path?: string; version?: string; installed: boolean }

const MARK = '__SESSIONARY__'

export const SYSTEM_SCRIPT = `echo ${MARK}
echo "host=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; fi
echo "os=\${PRETTY_NAME:-$(uname -s 2>/dev/null)}"
echo "kernel=$(uname -r 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo "clk=$(getconf CLK_TCK 2>/dev/null || echo 100)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
snap() {
  head -n1 /proc/stat 2>/dev/null
  awk 'NR>2 && $1 !~ /^lo:/ {rx+=$2; tx+=$10} END {print "net " rx+0, tx+0}' /proc/net/dev 2>/dev/null
  cat /proc/[0-9]*/stat 2>/dev/null | sed -n 's/^\\([0-9][0-9]*\\) (.*) . \\([-0-9][0-9]* \\)\\{10\\}\\([0-9][0-9]*\\) \\([0-9][0-9]*\\) .*/proc \\1 \\3 \\4/p'
}
t1=$(date +%s%N 2>/dev/null); s1=$(snap); sleep 0.5; t2=$(date +%s%N 2>/dev/null); s2=$(snap)
echo "t1=$t1"
echo "t2=$t2"
echo "mem=$(grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | tr -s ' ' | tr '\\n' ' ')"
echo "disk=$(df -Pk / 2>/dev/null | tail -n1 | tr -s ' ')"
echo "---s1"
echo "$s1"
echo "---s2"
echo "$s2"
echo "---ps"
ps -eo pid=,pcpu=,pmem=,etime=,args= 2>/dev/null | head -n 400 | cut -c1-240
exit 0`

const AGENT_BINS = ['claude', 'opencode', 'pi', 'hermes']
/** the agent a process belongs to, going by the program it runs (`node …/claude` counts too) */
function agentOf(cmd: string): string | undefined {
  const [first = '', second = ''] = cmd.split(/\s+/)
  const base = (p: string) => p.split('/').pop() ?? p
  const direct = base(first)
  if (AGENT_BINS.includes(direct)) return direct
  if (/^(node|bun|python3?|deno)$/.test(direct)) {
    const b = base(second)
    if (AGENT_BINS.includes(b)) return b
  }
}

const kv = (text: string) => {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) out.set(line.slice(0, i), line.slice(i + 1).trim()) }
  return out
}

const cpuOf = (line?: string) => {
  const n = (line ?? '').trim().split(/\s+/).slice(1).map(Number)
  if (n.length < 5 || n.some(Number.isNaN)) return undefined
  const idle = n[3]! + (n[4] ?? 0)
  return { idle, total: n.slice(0, 8).reduce((a, b) => a + b, 0) }
}

/** one look at the machine: total CPU time, bytes over the network, CPU time per process */
function snapshot(text: string) {
  let cpu: { idle: number; total: number } | undefined
  let net: { rx: number; tx: number } | undefined
  const procs = new Map<number, number>()
  for (const line of text.split('\n')) {
    if (line.startsWith('cpu ')) cpu = cpuOf(line)
    else if (line.startsWith('net ')) { const [, rx, tx] = line.split(' '); net = { rx: Number(rx), tx: Number(tx) } }
    else if (line.startsWith('proc ')) { const [, pid, u, s] = line.split(' '); procs.set(Number(pid), Number(u) + Number(s)) }
  }
  return { cpu, net, procs }
}

export function parseSystem(output: string): SystemInfo {
  const body = output.includes(MARK) ? output.slice(output.lastIndexOf(MARK) + MARK.length) : output
  const [head = '', rest = ''] = body.split('---s1')
  const [s1text = '', rest2 = ''] = rest.split('---s2')
  const [s2text = '', ps = ''] = rest2.split('---ps')
  const m = kv(head)
  const a = snapshot(s1text), b = snapshot(s2text)
  // how long the two looks were apart, from the clock when it has nanoseconds (busybox prints a literal "N" instead)
  const t1 = Number(m.get('t1')), t2 = Number(m.get('t2'))
  const secs = t1 > 1e15 && t2 > t1 ? Math.max((t2 - t1) / 1e9, 0.05) : 0.5
  const clk = Number(m.get('clk')) || 100
  const dt = a.cpu && b.cpu ? b.cpu.total - a.cpu.total : 0
  const meminfo = new Map<string, number>()
  for (const x of (m.get('mem') ?? '').matchAll(/(\w+):\s*(\d+)\s*kB/g)) meminfo.set(x[1]!, Number(x[2]) * 1024)
  const memTotal = meminfo.get('MemTotal'), memAvail = meminfo.get('MemAvailable')
  const swapTotal = meminfo.get('SwapTotal'), swapFree = meminfo.get('SwapFree')
  const disk = (m.get('disk') ?? '').split(' ')
  const load = (m.get('load') ?? '').split(' ').map(Number)

  const procs: ProcInfo[] = []
  for (const line of ps.split('\n')) {
    const x = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!x) continue
    const pid = Number(x[1])
    // ps reports CPU over the process's whole life; what is busy now is the change between the two looks
    const before = a.procs.get(pid), after = b.procs.get(pid)
    const now = before != null && after != null ? Math.max(0, ((after - before) / clk / secs) * 100) : Number(x[2])
    procs.push({ pid, cpu: Math.round(now * 10) / 10, mem: Number(x[3]), elapsed: x[4]!, cmd: x[5]! })
  }
  procs.sort((p, q) => q.cpu - p.cpu)
  const agents: AgentProc[] = []
  for (const p of procs) { const agent = agentOf(p.cmd); if (agent) agents.push({ ...p, agent }) }

  const num = (k: string) => { const v = Number(m.get(k)); return Number.isFinite(v) && m.get(k) ? v : undefined }
  return {
    host: m.get('host') ?? '', os: m.get('os') ?? '', kernel: m.get('kernel') || undefined, arch: m.get('arch') ?? '',
    cpus: num('cpus') ?? 0,
    cpuPercent: dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - (b.cpu!.idle - a.cpu!.idle) / dt) * 100))) : undefined,
    load: load.length === 3 && load.every(Number.isFinite) ? (load as [number, number, number]) : undefined,
    mem: memTotal != null && memAvail != null ? { total: memTotal, used: memTotal - memAvail } : undefined,
    swap: swapTotal != null && swapFree != null ? { total: swapTotal, used: swapTotal - swapFree } : undefined,
    disk: disk.length >= 6 && Number(disk[1]) ? { total: Number(disk[1]) * 1024, used: Number(disk[2]) * 1024, mount: disk[5]! } : undefined,
    net: a.net && b.net ? { rx: Math.max(0, (b.net.rx - a.net.rx) / secs), tx: Math.max(0, (b.net.tx - a.net.tx) / secs) } : undefined,
    uptime: num('uptime'),
    procs: procs.slice(0, 12), agents: agents.slice(0, 20), at: Date.now(),
  }
}

/** What Node alone can tell about this machine, for systems without /proc. */
export function basicSystem(): SystemInfo {
  const total = os.totalmem(), free = os.freemem()
  const l = os.loadavg() as [number, number, number]
  const cpus = os.cpus().length
  return {
    host: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus,
    cpuPercent: process.platform === 'win32' ? undefined : Math.min(100, Math.round((l[0] / Math.max(cpus, 1)) * 100)),
    load: process.platform === 'win32' ? undefined : l, mem: { total, used: total - free }, uptime: os.uptime(), procs: [], agents: [], at: Date.now(),
  }
}

const run = promisify(execFile)

/** this machine, by the same script a node runs */
export async function localSystem(): Promise<SystemInfo> {
  if (process.platform !== 'linux') return basicSystem()
  try {
    const { stdout } = await run('sh', ['-c', SYSTEM_SCRIPT], { timeout: 8000, maxBuffer: 4 << 20 })
    const s = parseSystem(stdout)
    return s.host ? s : basicSystem()
  } catch { return basicSystem() }
}

/** what the probe remembers about one program, to skip asking it again while it has not changed */
export interface KnownBin { /** `<mtime>:<size>` of the program file */ key: string; path: string; version?: string }

/**
 * The script that reports which agent programs are on PATH and their versions. `names` are program names only.
 *  - `path`: the PATH to use (remembered from an earlier probe); otherwise `loginPath` borrows the PATH of the
 *    person's login shell (where npm / ~/.local/bin are added), which a plain `sh` over ssh does not have, but
 *    starting a login shell costs seconds on some machines, so it is done once and remembered.
 *  - `known`: programs whose file has not changed since their version was read are not run again.
 *  - the programs that must be asked are asked at the same time.
 * Output lines: program, path, file key, version (empty when `known` covers it).
 */
export const agentsScript = (names: string[], o: { loginPath?: boolean; path?: string; known?: Record<string, KnownBin> } = {}) => {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
  const known = Object.entries(o.known ?? {}).map(([b, k]) => `${b}=${k.path}@${k.key}`).join(' ')
  return `echo ${MARK}
${o.path ? `PATH=${q(o.path)}; export PATH
` : o.loginPath ? `P=$("\${SHELL:-/bin/sh}" -lic 'printf "__P__%s__P__" "$PATH"' 2>/dev/null </dev/null | sed -n 's/.*__P__\\(.*\\)__P__.*/\\1/p')
[ -n "$P" ] && PATH="$P"; export PATH
` : ''}echo "path=$PATH"
K=${q(' ' + known + ' ')}
T=""; if command -v timeout >/dev/null 2>&1; then T="timeout 5"; fi
tmp=$(mktemp -d 2>/dev/null || echo "/tmp/sessionary.$$"); mkdir -p "$tmp"
for b in ${names.map((n) => q(n)).join(' ')}; do
  p=$(command -v "$b" 2>/dev/null) || continue
  k=$(stat -L -c '%Y:%s' "$p" 2>/dev/null || stat -L -f '%m:%z' "$p" 2>/dev/null)
  case "$K" in *" $b=$p@$k "*) printf '%s\\t%s\\t%s\\t\\n' "$b" "$p" "$k" > "$tmp/$b"; continue;; esac
  ( v=$($T "$b" --version 2>&1 </dev/null | head -n 1); printf '%s\\t%s\\t%s\\t%s\\n' "$b" "$p" "$k" "$v" > "$tmp/$b" ) &
done
wait
cat "$tmp"/* 2>/dev/null
rm -rf "$tmp"
exit 0`
}

export interface AgentProbe { agents: AgentInstall[]; /** the PATH the probe ran with */ path?: string; known: Record<string, KnownBin> }

export function parseAgents(output: string, names: [id: string, bin: string][], previous: Record<string, KnownBin> = {}): AgentProbe {
  const body = output.includes(MARK) ? output.slice(output.lastIndexOf(MARK) + MARK.length) : output
  const found = new Map<string, KnownBin>()
  let usedPath: string | undefined
  for (const line of body.split('\n')) {
    if (line.startsWith('path=')) { usedPath = line.slice(5).trim() || undefined; continue }
    const [bin, p, key = '', version = ''] = line.split('\t')
    if (!bin || !p) continue
    // an empty version with an unchanged file means "as before"
    const before = previous[bin.trim()]
    const unchanged = before && before.path === p.trim() && before.key === key.trim()
    found.set(bin.trim(), { path: p.trim(), key: key.trim(), version: version.trim() || (unchanged ? before.version : undefined) })
  }
  const known: Record<string, KnownBin> = {}
  const agents = names.map(([id, bin]) => {
    const f = found.get(bin)
    // a version line is the first thing that looks like one; error text from a tool that has no --version is not
    const v = f?.version?.match(/\d+\.\d+[\w.+-]*/)?.[0]
    if (f) known[bin] = { ...f, version: v }
    return { id, bin, installed: !!f, path: f?.path, version: v } as AgentInstall
  })
  return { agents, path: usedPath, known }
}

export async function localAgents(names: [id: string, bin: string][], previous?: Record<string, KnownBin>): Promise<AgentProbe> {
  const none = () => ({ agents: names.map(([id, bin]) => ({ id, bin, installed: false })), known: {} })
  if (process.platform === 'win32') return none()
  try {
    const { stdout } = await run('sh', ['-c', agentsScript(names.map(([, b]) => b), { known: previous })], { timeout: 20_000, maxBuffer: 1 << 20 })
    return parseAgents(stdout, names, previous)
  } catch { return none() }
}

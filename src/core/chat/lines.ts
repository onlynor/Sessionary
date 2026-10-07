import type { Proc } from './types.ts'

/**
 * Reads a process's stdout as newline-delimited JSON. Only LF ends a record (Unicode line separators are legal
 * inside a JSON string), a line that is not JSON is passed on as text, and stderr is kept for explaining a failure.
 */
export class LineReader {
  private buf = ''
  stderr = ''
  constructor(proc: Proc, private onJson: (o: any) => void, private onText: (line: string) => void = () => {}) {
    const dec = new TextDecoder()
    proc.stdout.on('data', (d: Buffer | string) => {
      this.buf += typeof d === 'string' ? d : dec.decode(d, { stream: true })
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '')
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        let o: unknown
        try { o = JSON.parse(line) } catch { this.onText(line); continue }
        try { this.onJson(o) } catch (e) { this.onText(`driver error: ${(e as Error).message}`) }
      }
    })
    proc.stderr.on('data', (d: Buffer | string) => { this.stderr = (this.stderr + d).slice(-4000) })
  }
}

/** JSON-RPC 2.0 over such a stream, for the protocols that use it (Codex's app-server, ACP) */
export class RpcPeer {
  private id = 0
  private pending = new Map<number | string, { res: (v: any) => void; rej: (e: Error) => void }>()
  readonly reader: LineReader
  closed = false
  constructor(private proc: Proc, private handlers: {
    notification: (method: string, params: any) => void
    request: (method: string, params: any, reply: (result: unknown) => void, fail: (code: number, message: string) => void, id: number | string) => void
  }, onText?: (line: string) => void) {
    this.reader = new LineReader(proc, (o) => {
      if (o.method != null && o.id != null) {
        const id = o.id
        this.handlers.request(o.method, o.params, (result) => this.write({ jsonrpc: '2.0', id, result }), (code, message) => this.write({ jsonrpc: '2.0', id, error: { code, message } }), id)
      } else if (o.method != null) this.handlers.notification(o.method, o.params)
      else if (o.id != null && this.pending.has(o.id)) {
        const p = this.pending.get(o.id)!
        this.pending.delete(o.id)
        if (o.error) p.rej(Object.assign(new Error(o.error.message ?? 'request failed'), { code: o.error.code, data: o.error.data }))
        else p.res(o.result)
      }
    }, onText)
    proc.on('close', () => this.fail(new Error('The agent process ended.')))
  }
  private write(o: unknown) { if (!this.closed) try { this.proc.stdin.write(JSON.stringify(o) + '\n') } catch { /* the process is gone: close handles it */ } }
  request<T = any>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The agent process ended.'))
    const id = ++this.id
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)) }, timeoutMs)
      t.unref?.()
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
  notify(method: string, params?: unknown) { this.write({ jsonrpc: '2.0', method, params }) }
  fail(e: Error) {
    this.closed = true
    for (const p of this.pending.values()) p.rej(e)
    this.pending.clear()
  }
}

/** a unified line diff of two texts, for tools that report the old and new content */
export function textDiff(path: string, oldText: string, newText: string): string {
  const a = oldText === '' ? [] : oldText.split('\n'), b = newText === '' ? [] : newText.split('\n')
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const x = a.slice(s, ea), y = b.slice(s, eb)
  const ops: string[] = []
  if (x.length * y.length > 1_000_000) ops.push(...x.map((l) => '-' + l), ...y.map((l) => '+' + l))
  else {
    const w = y.length + 1
    const t = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
    let i = 0, j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { ops.push(' ' + x[i]); i++; j++ }
      else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push('-' + x[i++])
      else ops.push('+' + y[j++])
    }
    while (i < x.length) ops.push('-' + x[i++])
    while (j < y.length) ops.push('+' + y[j++])
  }
  const ctx = (l: string[]) => l.map((v) => ' ' + v)
  return [`@@ ${path}`, ...ctx(a.slice(Math.max(0, s - 3), s)), ...ops, ...ctx(a.slice(ea, ea + 3))].join('\n')
}

/**
 * Why an agent's process ended, for the page: how it ended and the last thing it said. Nothing when it finished
 * normally or was closed from here (`closing`). Over ssh a signal on the node arrives as 128 + its number.
 */
export function exitReason(code: number | null, signal: NodeJS.Signals | null | undefined, stderr: string, closing: boolean): string | undefined {
  if (closing || (code === 0 && !signal)) return undefined
  const said = stderr.trim().split('\n').slice(-3).join('\n')
  const how = signal ? `was stopped (${signal})` : code != null && code > 128 && code < 160 ? `was stopped (signal ${code - 128})` : `exited with code ${code}`
  return said ? `The agent ${how}:\n${said}` : `The agent ${how}.`
}

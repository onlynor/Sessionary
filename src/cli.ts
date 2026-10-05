#!/usr/bin/env node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { IndexStore } from './core/index-store.ts'
import { OverlayStore } from './core/overlay.ts'
import { createApp } from './server/app.ts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }

if (flag('help') || flag('h')) {
  console.log('Usage: sessionary [--port 4777] [--host 127.0.0.1] [--no-open] [--no-watch]')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = [path.join(here, '..', 'web-dist'), path.join(here, 'web-dist')].find(existsSync)

const port = Number(opt('port') ?? process.env.PORT ?? 4777)
const host = opt('host') ?? '127.0.0.1'
const store = new IndexStore()
const { app, rescan, startWatching, stopRuns } = createApp(store, webRoot, new OverlayStore())
// agents we started must not outlive the server
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopRuns(); process.exit(0) })

const t0 = Date.now()
const reports = await rescan()
for (const r of reports as any[]) console.log(`  ${r.agent.padEnd(12)} ${r.found} sources, ${r.updated} updated, ${r.removed} removed (${r.ms}ms)`)
console.log(`indexed in ${Date.now() - t0}ms`)

// agents' writes trigger a rescan within a second; the slow poll only catches what file events miss
const stopWatching = flag('no-watch') ? () => {} : startWatching()
setInterval(() => rescan().catch(() => {}), 60_000).unref()
process.on('exit', () => stopWatching())

serve({ fetch: app.fetch, port, hostname: host }, async (info) => {
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${info.port}`
  console.log(`Sessionary → ${url}${webRoot ? '' : '  (API only; web assets not built)'}`)
  if (!flag('no-open') && webRoot) {
    const { spawn } = await import('node:child_process')
    const cmd = process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url]
    spawn(cmd[0]!, cmd.slice(1), { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  }
})

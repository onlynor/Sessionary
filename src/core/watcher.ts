import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter } from './model.ts'

export interface WatchState { mode: 'events' | 'polling'; watched: string[]; error?: string }

/**
 * Turns the agents' own writes into rescans. Each adapter names where it stores history; a burst of writes
 * (an agent streams a reply into its JSONL, OpenCode checkpoints its WAL) collapses into one rescan after a
 * short quiet period. If the platform cannot watch (missing directory, inotify limit), callers keep polling.
 */
export function watchSources(adapters: AgentAdapter[], onChange: () => void, quietMs = 700): { state: WatchState; close: () => void } {
  const watchers: fs.FSWatcher[] = []
  const state: WatchState = { mode: 'events', watched: [] }
  let timer: NodeJS.Timeout | undefined
  const kick = () => { clearTimeout(timer); timer = setTimeout(onChange, quietMs) }

  for (const a of adapters) {
    for (const w of a.storage().watch) {
      // watch the nearest existing ancestor so an agent installed later is picked up as soon as it writes
      let target = w.path
      let recursive = w.recursive
      while (!fs.existsSync(target)) {
        const up = path.dirname(target)
        if (up === target) break
        target = up
        recursive = false
      }
      if (!fs.existsSync(target)) continue
      try {
        const watcher = fs.watch(target, { recursive, persistent: false }, (_ev, file) => {
          // OpenCode's directory also holds unrelated files; only its database matters
          if (!w.recursive && file && target === w.path && !String(file).startsWith(path.basename(a.storage().path))) return
          kick()
        })
        watcher.on('error', (e) => { state.mode = 'polling'; state.error = e.message })
        watchers.push(watcher)
        state.watched.push(target)
      } catch (e) {
        state.mode = 'polling'
        state.error = (e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'The system limit on file watchers is reached; falling back to polling.' : (e as Error).message
      }
    }
  }
  if (!watchers.length) state.mode = 'polling'
  return { state, close: () => { clearTimeout(timer); for (const w of watchers) w.close() } }
}

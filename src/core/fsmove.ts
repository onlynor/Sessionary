import fs from 'node:fs/promises'
import path from 'node:path'
import { RemovalError } from './model.ts'

export const exists = (p: string) => fs.stat(p).then(() => true, () => false)

/** rename, falling back to copy + delete across filesystems (EXDEV) and on Windows when rename is refused */
export async function moveInto(from: string, to: string) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw e
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await fs.rm(from, { recursive: true, force: true })
  }
}

/** A file the agent wrote to moments ago probably belongs to a running session. */
export async function assertIdle(files: string[], quietMs = 120_000) {
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null)
    if (st && Date.now() - st.mtimeMs < quietMs) throw new RemovalError('busy', 'This session was written to in the last two minutes and may still be running. Close it in the agent first.')
  }
}

export interface MovedEntry { from: string; to: string }

/** Move several paths; if one fails, put back the ones already moved so nothing is left half-removed. */
export async function moveAll(paths: string[], backupDir: string): Promise<MovedEntry[]> {
  const entries = paths.map((from, i) => ({ from, to: path.join(backupDir, `${i}-${path.basename(from)}`) }))
  const done: MovedEntry[] = []
  try {
    for (const e of entries) { await moveInto(e.from, e.to); done.push(e) }
  } catch (err) {
    for (const e of done.reverse()) await moveInto(e.to, e.from).catch(() => {})
    throw err
  }
  return entries
}

export async function moveBack(entries: MovedEntry[]) {
  for (const e of entries) if (await exists(e.from)) throw new RemovalError('conflict', `Something already exists at ${e.from}; restoring would overwrite it.`)
  for (const e of entries) await moveInto(e.to, e.from)
}

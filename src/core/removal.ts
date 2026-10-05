import fs from 'node:fs/promises'
import path from 'node:path'
import type { IndexStore } from './index-store.ts'
import { RemovalError, type AgentAdapter } from './model.ts'
import type { OverlayStore } from './overlay.ts'
import { dataHome } from './util.ts'

const backupRoot = () => path.join(dataHome(), 'backup')
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80)

/** Take a session out of its agent's storage into Sessionary's backup folder. Reversible until purged. */
export async function removeFromDisk(adapters: AgentAdapter[], store: IndexStore, overlay: OverlayStore, id: string) {
  const row = store.get(id)
  if (!row) throw new RemovalError('conflict', 'Session not found in the index.')
  const adapter = adapters.find((a) => a.id === row.agent)
  if (!adapter?.remove) throw new RemovalError('unsupported', `${adapter?.label ?? row.agent} sessions cannot be removed from disk.`)
  if (row.summary.parentId) throw new RemovalError('unsupported', 'Sub-agent sessions are removed together with their parent session.')
  const at = Date.now()
  const backupDir = path.join(backupRoot(), row.agent, `${safe(row.summary.nativeId)}-${at}`)
  const manifest = await adapter.remove({ key: row.sourceKey, ref: row.sourceKey, fingerprint: '' }, backupDir)
  overlay.addRemoved({ sessionId: id, agent: row.agent, at, backupDir, manifest, summary: row.summary })
  overlay.restoreSession(id) // it is no longer "hidden", it is gone from the agent
  return { backupDir }
}

export async function restoreFromBackup(adapters: AgentAdapter[], overlay: OverlayStore, id: string) {
  const r = overlay.removed(id)[0]
  if (!r) throw new RemovalError('conflict', 'No backup recorded for this session.')
  const adapter = adapters.find((a) => a.id === r.agent)
  if (!adapter?.restore) throw new RemovalError('unsupported', 'This agent cannot restore sessions.')
  await adapter.restore(r.manifest, r.backupDir)
  overlay.dropRemoved(id)
  await fs.rm(r.backupDir, { recursive: true, force: true })
}

/** Forget the backup for good. The agent never had the session after removal, so this is the true delete. */
export async function purgeBackup(overlay: OverlayStore, id: string) {
  const r = overlay.removed(id)[0]
  if (!r) return
  const inside = path.relative(backupRoot(), r.backupDir)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new RemovalError('conflict', 'Backup path is outside Sessionary’s backup folder; refusing to delete it.')
  await fs.rm(r.backupDir, { recursive: true, force: true })
  overlay.dropRemoved(id)
}

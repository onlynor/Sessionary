import type { Message } from './model.ts'

/** A turn starts at a user message that carries something other than tool output. */
export const isTurnStart = (m: Message) => m.role === 'user' && m.blocks.some((b) => b.type !== 'tool')

export interface Page { start: number; end: number; next: number | null; total: number }

/**
 * Slice [cursor, …) holding at least `limit` messages, extended to the next turn boundary so a turn
 * (prompt, prose and its run of tool calls) is never split across pages.
 */
export function pageMessages(messages: Message[], cursor: number, limit: number): Page {
  const total = messages.length
  const start = Math.max(0, Math.min(cursor, total))
  let end = Math.min(total, start + Math.max(1, limit))
  while (end < total && !isTurnStart(messages[end]!)) end++
  return { start, end, next: end < total ? end : null, total }
}

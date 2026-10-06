import type { AgentAdapter } from '../core/model.ts'
import type { Roots } from '../core/util.ts'
import { claude, makeClaude } from './claude.ts'
import { codex, makeCodex } from './codex.ts'
import { hermes, makeHermes } from './hermes.ts'
import { makeOpencode, opencode } from './opencode.ts'
import { makePi, pi } from './pi.ts'
import { makeWorkbuddy, makeWorkbuddyAi, workbuddy, workbuddyAi } from './workbuddy.ts'

export const adapters: AgentAdapter[] = [claude, codex, opencode, pi, hermes, workbuddy, workbuddyAi]

/** The same adapters pointed at another machine's mirrored home directory. */
export const adaptersFor = (roots: () => Roots): AgentAdapter[] => [makeClaude(roots), makeCodex(roots), makeOpencode(roots), makePi(roots), makeHermes(roots), makeWorkbuddy(roots), makeWorkbuddyAi(roots)]

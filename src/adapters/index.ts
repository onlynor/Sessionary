import type { AgentAdapter } from '../core/model.ts'
import { claude } from './claude.ts'
import { opencode } from './opencode.ts'
import { pi } from './pi.ts'

export const adapters: AgentAdapter[] = [claude, opencode, pi]

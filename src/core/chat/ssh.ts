import { spawn } from 'node:child_process'
import { loginExec, SECRET_VAR, sshArgs, type SshTarget } from '../sync.ts'
import type { Proc, Spawner } from './types.ts'

/**
 * Starts an agent's chat process on a node: ssh with no terminal, so stdin and stdout are the protocol's pipes, and
 * the program started as every program on a node is (`loginExec`). Nothing is installed there: the agent is whatever
 * the person already has.
 */
export const sshSpawner = (t: SshTarget): Spawner => (s) =>
  // the secret rides in ssh's own environment (SendEnv), never in its arguments
  spawn(process.env.SESSIONARY_SSH_BIN ?? 'ssh', sshArgs(t, [loginExec(s)], { tunnel: s.tunnel, sendSecret: !!s.secret }), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(s.secret && { env: { ...process.env, [SECRET_VAR]: s.secret.value } }),
  }) as unknown as Proc

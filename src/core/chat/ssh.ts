import { spawn } from 'node:child_process'
import { posix, SECRET_VAR, secretPrelude, sshArgs, type SshTarget } from '../sync.ts'
import type { Proc, Spawner } from './types.ts'

/**
 * Starts an agent's chat process on a node: ssh with no terminal, so stdin and stdout are the protocol's pipes, then
 * the program in the session's directory under a login shell so the node's PATH (npm, ~/.local/bin) applies.
 * Nothing is installed there: the agent is whatever the person already has.
 */
export const sshSpawner = (t: SshTarget): Spawner => (s) => {
  const env = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${posix(v)}`)
  const run = ['exec', ...(env.length ? ['env', ...env] : []), ...[s.bin, ...s.args].map(posix)].join(' ')
  const remote = `${s.secret ? secretPrelude(s.secret.name) : ''}${s.cwd ? `cd ${posix(s.cwd)} && ` : ''}${run}`
  const wrapped = `exec "\${SHELL:-/bin/sh}" -lic ${posix(remote)}`
  // the secret rides in ssh's own environment (SendEnv), never in its arguments
  return spawn(process.env.SESSIONARY_SSH_BIN ?? 'ssh', sshArgs(t, [wrapped], { tunnel: s.tunnel, sendSecret: !!s.secret }), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(s.secret && { env: { ...process.env, [SECRET_VAR]: s.secret.value } }),
  }) as unknown as Proc
}

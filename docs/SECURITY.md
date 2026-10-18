# Privacy and security

The full detail behind the README's [Privacy and safety](../README.md#privacy-and-safety) summary.

- **Local only.** The server binds to `127.0.0.1` and answers only requests addressed to a loopback host name, which
  also blocks DNS-rebinding attacks. Binding to another interface exposes your session history; don't, unless you
  know who can reach it (`SESSIONARY_ALLOW_HOST`).
- **Write protection.** Every state-changing request needs a per-launch token (`x-sessionary-token`, from
  `GET /api/token`) that only same-origin pages can read, plus a loopback `Origin`.
- **Agents' files are read-only** — with two explicit exceptions you trigger yourself:
  - *Delete from disk* moves Claude Code / Pi files (transcript, `<id>/`, `file-history/`, `session-env/`, `tasks/`,
    `todos/`) into Sessionary's backup folder, and exports OpenCode sessions (`opencode export`) before
    `opencode session delete`. Both can be restored from the Trash until you delete the backup. Sessions written to
    in the last two minutes are refused as possibly running.
  - *Continue here* runs the agent's own CLI, which appends to the same session: `claude -p --resume <id>`,
    `opencode run -s <id>`, `pi --session <file> -p`. It is read-only by default (Claude `--permission-mode plan`,
    OpenCode `--agent plan`, Pi `--tools read,grep,find,ls`); write access is opted into per message.
- **What Sessionary writes** (all under `SESSIONARY_HOME`): `index.db` (a disposable, rebuildable index),
  `overlay.db` (your pins, Trash and deletion records), `backup/`, and `control.db` (providers, API keys, routing
  groups, the gateway key and gateway usage; created readable by you only, `0600`).
- **The gateway** answers on the same loopback port, needs its own key (`Bearer` or `x-api-key`), refuses requests
  carrying a non-loopback `Origin`, and never shows API keys to the page (they are masked; `env:NAME` reads a key
  from the environment instead of storing it).
- **On a node**, each session gets its own *door*: a loopback listener on this computer that serves the gateway and
  nothing else, opened only by a token made for that session. The session's own SSH connection carries the tunnel
  (`ssh -R`, a random port on the node's loopback, its own connection, `ExitOnForwardFailure`). The token travels
  inside that connection (`SendEnv` of an `LC_*` variable, which sshd accepts by default), so it is never on a
  command line on either machine; a node whose sshd refuses it does not start the agent. The gateway key never
  leaves this computer. When the session ends — closed, cancelled, the agent crashing, SSH dropping, or failing to
  start — its door closes, so a token read on the node is worth that session alone, while it runs. A taken port is
  retried once on another.
- **Opening things** is confined to the session's own directory; resume and terminal commands run through your
  login shell in that directory.

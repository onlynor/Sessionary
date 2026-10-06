# Sessionary

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

A local-first session manager for AI coding agents. Sessionary reads the history that **Claude Code**, **Codex**, **OpenCode**,
**Pi**, **Hermes** and **WorkBuddy** (China edition and WorkBuddy AI) already keep on your disk, puts every session from every agent in one searchable list, and lets you pick any of
them back up — in your own terminal with the agent's real resume command, or with one more prompt from the browser.

Nothing leaves your machine: there is no account, no cloud service and no telemetry. The agents' files are read
read-only; Sessionary's own state lives in a separate folder.

## Features

- **Machines first.** Everything is organised as machine → agent → project → session. Your computer is one machine; add a VPS
  or any server you can SSH into and it gets the same pages: its agents (with versions), projects, sessions, an in-app
  terminal, and a live monitor (CPU, memory, disk, running agents).
- **One list for every agent.** Sessions from Claude Code, OpenCode and Pi, normalised into one model, shown per agent or
  all together. Sort by last activity, start date, message count or title; group by date or project; narrow to pinned,
  active or file-editing sessions; scope to one project (git root, worktrees folded together).
- **Search everything.** The sidebar matches titles, projects, branches and previews as you type and, from two
  characters on, the full text of every message (trigram index, so CJK and partial words match). `Ctrl K` searches all
  sessions plus commands; `Ctrl F` finds inside the open conversation.
- **Live.** File watchers on each agent's storage rescan within about a second of a write and push the change to open
  pages, so new sessions appear and the conversation on screen follows an agent that is writing right now (*Active*).
- **Read a session properly.** Messages, folded tool-call steps with diffs and outputs, thinking, images, sub-agent
  sessions, a prompt index, and a *Changes* view of every file the agent edited plus the live working tree.
  The inspector shows the project, branch, uncommitted state, a file tree and the session's model, tokens and cost.
- **Pick it back up.**
  - *Resume in Terminal* opens your terminal in the session's directory running `claude --resume <id>`,
    `opencode --session <id>` or `pi --session <file>`; *Copy resume command* gives you the same line.
  - *Continue here* sends one more prompt through the agent's headless CLI and streams the reply in — read-only by
    default.
  - Open the session's folder, a terminal there, or the folder or any file of it in your editor.
- **Other machines (nodes).** Add a VPS or any machine you can `ssh` into and browse, search and read its Claude Code,
  OpenCode, Pi and Hermes sessions next to your own, and resume one in a terminal here through SSH. Nothing is installed
  on the node: Sessionary copies the history files over SSH (`find` + `tar`) and reads the copy. Hosts come from your
  `~/.ssh/config`; login must be key-based.
- **Notifications, sparingly.** The bell and the sidebar badge what needs you: an agent running in an app terminal that has gone
  quiet or exited, a node that stays unreachable, a large copy that finished. Desktop notifications (opt-in) only come when the
  page is in the background; there are switches per kind and *Pause for 1 hour*, nothing repeats within a cooldown, several
  at once arrive as one, and a closed page is silent.
- **Organise.** Pin sessions to the top. Hide sessions or individual messages (Sessionary-only Trash), or delete a session
  from the agent's storage with a backup that can be restored.
- **Desktop-class UI.** Collapsible, resizable panes, light/dark/graphite themes, comfortable or compact lists, keyboard
  navigation, touch and narrow-window layouts, and English, 简体中文, 繁體中文 and 日本語.

## Requirements

- Node.js **22.13 or newer** (Sessionary uses the built-in `node:sqlite`; there are no native modules).
- Linux, macOS or Windows.
- The agents you want to browse. Resuming and continuing need their CLIs (`claude`, `opencode`, `pi`) on `PATH`.

## Install and run

Sessionary is not published to npm yet. From a checkout:

```sh
pnpm install
pnpm build
node dist/cli.js                 # opens http://127.0.0.1:4777

# or install it as a command
pnpm pack && npm install -g ./sessionary-0.1.0.tgz
sessionary
```

```
sessionary [--port 4777] [--host 127.0.0.1] [--no-open] [--no-watch]
```

| Option | Meaning |
|---|---|
| `--port` | Port to listen on (default `4777`, or `$PORT`) |
| `--host` | Interface to bind (default `127.0.0.1`; see [Privacy and safety](#privacy-and-safety)) |
| `--no-open` | Don't open the browser on start |
| `--no-watch` | Don't watch the agents' files; rescan once a minute instead |

### Keyboard

| Keys | Action |
|---|---|
| `Ctrl K` | Search all sessions, messages and commands |
| `Ctrl F` | Find in the open conversation |
| `/` | Focus the sidebar search |
| `J` / `K` | Next / previous session |
| `1` `2` `3` · `0` | Show one agent's sessions · all agents |
| `P` | Pin or unpin the open session |
| `Shift R` | Resume the open session in a terminal |
| `E` | Expand or collapse all tool steps |
| `Alt ↑` / `Alt ↓` | Previous / next prompt |
| `[` · `]` | Collapse the sidebar · toggle the inspector |
| `Delete` (`Ctrl ⌫`) | Move the session to Sessionary's Trash |
| `?` | Show all shortcuts |

## Configuration

Everything is optional; the defaults follow each agent's own conventions.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps `projects/` |
| `XDG_DATA_HOME` | `~/.local/share` | Where OpenCode keeps `opencode/opencode.db` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where Pi keeps `sessions/` |
| `SESSIONARY_HOME` | `~/.local/share/sessionary` (`%APPDATA%\sessionary` on Windows) | Sessionary's own index, overlay and backups |
| `SESSIONARY_TERMINAL`, `TERMINAL` | first found of kitty, alacritty, wezterm, ghostty, foot, GNOME Terminal, Ptyxis, Konsole, Xfce Terminal, x-terminal-emulator, xterm | Terminal for *Resume* and *Open terminal* (Terminal.app on macOS, Windows Terminal or cmd on Windows) |
| `SESSIONARY_EDITOR` | VS Code, Cursor, Zed, Windsurf, Sublime Text, VSCodium, then `$VISUAL` / `$EDITOR` in a terminal | Editor for *Open in editor* |
| `SESSIONARY_CLAUDE_BIN`, `SESSIONARY_OPENCODE_BIN`, `SESSIONARY_PI_BIN` | `claude`, `opencode`, `pi` | Agent executables (on Windows, point these at the real executable rather than an npm `.cmd` shim) |
| `SESSIONARY_ALLOW_HOST` | unset | Accept non-loopback `Host` headers (only for a deliberately exposed setup) |

## Where the data comes from

| Agent | Location | Format | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-encoded>/<id>.jsonl` | JSONL event log | One assistant message is split over records sharing `message.id`; tool results are `user` records; `cwd` / `gitBranch` on every record; sub-agents in `<id>/subagents/agent-*.jsonl`; title from `ai-title` / `custom-title` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | SQLite (WAL); `session` / `message` / `part` with JSON `data` | `session.directory` + `project.worktree`; `parent_id` for sub-agents; tool call and result are one `tool` part; edit parts carry a unified diff |
| Pi | `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl` | JSONL tree (`id` / `parentId`) | Header carries `cwd`; tool results are separate `toolResult` messages; `bashExecution` for `!cmd` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` | JSONL (`session_meta`, `response_item`, `event_msg`) | Thread names from `~/.codex/state_N.sqlite` / `session_index.jsonl`; `apply_patch` calls become diffs |
| Hermes | `~/.hermes/state.db` | SQLite (`sessions`, `messages`) | Rewound messages (`active = 0`) are skipped |
| WorkBuddy | `~/.workbuddy/projects/<project>/<session>.jsonl` (China) · `~/.workbuddy-ai/…` (international) | JSONL, CodeBuddy-style items | Desktop apps: history only, no resume command; the format is undocumented, so unknown lines are skipped |

The index stores only summaries and searchable text. Full conversations are re-parsed from the original files when you
open them, so the agents' files stay the single source of truth.

## Privacy and safety

- **Local only.** The server binds to `127.0.0.1` and answers only requests addressed to a loopback host name, which
  also blocks DNS-rebinding attacks. Binding to another interface exposes your session history; don't, unless you know
  who can reach it.
- **Write protection.** Every state-changing request needs a per-launch token that only same-origin pages can read,
  plus a loopback `Origin`.
- **Agents' files are read-only** — with two explicit exceptions you trigger yourself:
  - *Delete from disk* moves Claude Code / Pi files (transcript, `<id>/`, `file-history/`, `session-env/`, `tasks/`,
    `todos/`) into Sessionary's backup folder, and exports OpenCode sessions (`opencode export`) before
    `opencode session delete`. Both can be restored from the Trash until you delete the backup. Sessions written to in
    the last two minutes are refused as possibly running.
  - *Continue here* runs the agent's own CLI, which appends to the same session: `claude -p --resume <id>`,
    `opencode run -s <id>`, `pi --session <file> -p`. It is read-only by default (Claude `--permission-mode plan`,
    OpenCode `--agent plan`, Pi `--tools read,grep,find,ls`); write access is opted into per message.
- **What Sessionary writes** (all under `SESSIONARY_HOME`): `index.db` (a disposable, rebuildable index), `overlay.db`
  (your pins, Trash and deletion records) and `backup/`.
- **Opening things** is confined to the session's own directory; resume and terminal commands run through your login
  shell in that directory.

## Architecture

```
src/cli.ts             entry point: first scan, file watcher, periodic fallback scan, HTTP server
src/core/model.ts      agent-neutral Session / Message / Block (text, thinking, tool, image, note) and the adapter contract
src/adapters/*.ts      the only agent-specific code: listSources → load, storage(), resume/continue commands, removal
src/core/scanner.ts    incremental scan by per-source fingerprint (size:mtime / time_updated); reports changed sessions
src/core/watcher.ts    fs.watch on each agent's storage, debounced into rescans
src/core/index-store   derived SQLite index: session summaries + FTS5 trigram full text (prose and tool targets)
src/core/overlay.ts    the user's own data: pins, hidden sessions/messages, deletion records — never derived or rebuilt
src/core/project.ts    project = git root of the session's cwd (worktrees fold onto the main repo), resolved live
src/core/context.ts    inspector data: current git state, working-tree diffs, files and tools touched by the session
src/core/runs.ts       "Continue here": one headless agent run per session, with collision checks
src/core/launch.ts     terminal / editor / file-manager detection and detached launches
src/server/app.ts      Hono API, server-sent events, static web assets
web/                   Vite + React UI; web/src/styles.css holds the design tokens and themes, web/src/locales.ts the translations
design/playground/     the static design playground the UI was developed from (`pnpm build:design`)
```

### HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents` | Agents with session counts, storage path, availability, capabilities |
| GET | `/api/sessions` | Session summaries (with project, `pinned`, `active`) |
| GET | `/api/sessions/:id?cursor=&limit=` | One session, paged by whole turns (`limit=all` for the rest) |
| GET | `/api/sessions/:id/{outline,edits,context,tree,changes,changes/file,find,images/:ref,resume-command,run}` | Session details |
| GET | `/api/search?q=` | Full-text search across sessions |
| GET | `/api/status` · `/api/events` | Scan / watch state and capabilities · server-sent `index`, `scan` events |
| GET | `/api/trash` | Hidden sessions and messages, deleted-from-disk backups |
| POST | `/api/scan` | Rescan now |
| POST | `/api/sessions/:id/{pin,unpin,hide,restore,open,continue,delete-from-disk}` | Session actions (`open` takes `target`: `folder`, `terminal`, `editor`, `file`, `resume`) |
| POST | `/api/sessions/:id/messages/{hide,restore}` · `/api/runs/:id/stop` · `/api/removed/:id/{restore,purge}` | Messages, runs, backups |

POST requests need the `x-sessionary-token` header from `GET /api/token`.

## Development

```sh
pnpm install
pnpm dev:server      # API on :4777 (tsx watch, no browser)
pnpm dev:web         # UI on :5173 with hot reload, proxies /api to :4777
pnpm typecheck
pnpm test            # node:test suites in test/
pnpm build           # dist/ (server) + web-dist/ (UI)
pnpm build:design    # regenerate design/playground.html
```

Point the agent variables (`CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`) and `SESSIONARY_HOME` at a
temporary directory to develop against test data without touching your real history. Every UI string goes through
`t()`; `test/i18n.test.ts` fails if a string lacks a translation.

## Known limitations

- Claude Code rewind forks are shown linearly; Pi shows only the active branch.
- New sessions can't be started from Sessionary; existing ones are resumed or continued.
- Terminal and editor launching is tested on Linux; macOS (Terminal.app) and Windows (Windows Terminal / cmd) support is
  implemented but less exercised.
- Windows npm-installed agent CLIs are `.cmd` shims; set `SESSIONARY_*_BIN` to the real executables for *Continue here*.

## License

[MIT](LICENSE)

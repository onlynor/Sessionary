# Sessionary

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

**Sessionary** is an open-source, local-first control center for AI coding agents — Claude Code, Codex, OpenCode, Pi,
Hermes, DeepSeek Harness and WorkBuddy (China edition and WorkBuddy AI). It reads the session history each agent
already keeps on your disk, puts every session from every agent in one searchable list, and lets you pick any of
them back up — in your own terminal with the agent's real resume command, or with one more prompt from the browser.
A built-in model gateway lets you add provider API keys once and route which model each agent runs on, with
per-agent, per-project and per-day token usage.

Nothing leaves your machine: there is no account, no cloud service and no telemetry. The agents' files are read
read-only; Sessionary's own state lives in a separate folder. A companion project,
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop), packages this same web client as a native
Linux/macOS/Windows application.

## Features

Everything below is organised as **machine → agent → project → session**. Your computer is one machine; add a VPS
or any server you can SSH into and it gets the same pages.

- **One list for every agent.** Sessions from Claude Code, Codex, OpenCode, Pi, Hermes, DeepSeek Harness and
  WorkBuddy, normalised into one model, shown per agent or all together. Sort by last activity, start date, message
  count or title; group by date or project; narrow to pinned, active or file-editing sessions; scope to one project
  (git root, worktrees folded together).
- **Search everything.** The sidebar matches titles, projects, branches and previews as you type and, from two
  characters on, the full text of every message (trigram index, so CJK and partial words match). `Ctrl K` searches
  all sessions plus commands; `Ctrl F` finds inside the open conversation.
- **Live.** File watchers on each agent's storage rescan within about a second of a write and push the change to
  open pages, so new sessions appear and the conversation on screen follows an agent that is writing right now
  (*Active*).
- **Read a session properly.** Messages, folded tool-call steps with diffs and outputs, thinking, images, sub-agent
  sessions, a prompt index, and a *Changes* view of every file the agent edited plus the live working tree. The
  inspector shows the project, branch, uncommitted state, a file tree and the session's model, tokens and cost.
- **Pick it back up.** *Resume in Terminal* opens your terminal in the session's directory running the agent's real
  resume command (`claude --resume <id>`, `opencode --session <id>`, `pi --session <file>`); *Copy resume command*
  gives you the same line. *Continue here* sends one more prompt through the agent's headless CLI and streams the
  reply in — read-only by default. Or open the session's folder, a terminal there, or any file of it in your editor.
- **Other machines (nodes).** Add a VPS or any machine you can `ssh` into and browse, search and read its agent
  sessions next to your own, and resume one in a terminal here through SSH. Nothing is installed on the node:
  Sessionary copies the history files over SSH and reads the copy. Hosts come from your `~/.ssh/config`; login must
  be key-based.
- **Model Control.** Add the API keys you have (presets for Anthropic, OpenAI, DeepSeek, Kimi, Zhipu GLM, Google
  Gemini, xAI Grok and OpenRouter, plus Ollama and LM Studio on this computer, a Magpie gateway, and any OpenAI- or
  Anthropic-compatible URL); the model list is read from the provider. Group models from several providers into a
  *routing group* and choose, per agent, the model or group it runs on. A local gateway relays requests to a member
  that speaks the same protocol and fails over — before any reply is sent — if one is rate limited, refuses its key
  or is down. The Routing page shows each decision live; Usage shows tokens per day, model, agent and route. Agents'
  own configuration files are never edited: a choice applies to the sessions Sessionary starts, on this computer and
  on SSH nodes alike.
- **Notifications, sparingly.** The bell and the sidebar badge what needs you: an agent running in an app terminal
  that has gone quiet or exited, a node that stays unreachable, a large copy that finished. Desktop notifications
  (opt-in) only come when the page is in the background, with switches per kind and *Pause for 1 hour*.
- **Organise.** Pin sessions to the top. Hide sessions or individual messages (Sessionary-only Trash), or delete a
  session from the agent's storage with a backup that can be restored.
- **Desktop-class UI.** Collapsible, resizable panes, light/dark/graphite themes, comfortable or compact lists,
  keyboard navigation, touch and narrow-window layouts, and English, 简体中文, 繁體中文 and 日本語.

Only what's implemented today is listed above. See [Known limitations](#known-limitations).

## Installation and getting started

Sessionary isn't published to npm yet; run it from a checkout.

**Requirements:** Node.js **22.13 or newer** (Sessionary uses the built-in `node:sqlite`; there are no native
modules), on Linux, macOS or Windows. You don't need any agent installed to browse sessions it already left on
disk; resuming and continuing need that agent's CLI (`claude`, `opencode`, `pi`, …) on `PATH`.

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

**First run:** start Sessionary and open the browser tab it launches. If you already use Claude Code, Codex,
OpenCode, Pi, Hermes or WorkBuddy, their existing sessions appear immediately — nothing to import or configure. Pick
a session to read it, or use *Resume in Terminal* / *Continue here* to pick up where it left off. Sessionary doesn't
start brand-new agent sessions itself (see [Known limitations](#known-limitations)); start one normally with the
agent's own CLI and it will show up here.

## How to use

**Navigation.** The sidebar has Home and Machines at the top, then a block for the selected machine (Agents,
Projects, Sessions, Terminal, Monitor), then Model Control (Models, Routing, Gateway, Usage), and a footer with
Trash, Nodes, Notifications and Settings.

**Keyboard**

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

**Configuration.** Everything is optional; the defaults follow each agent's own conventions.

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

**Where your data comes from.** Claude Code, OpenCode, Pi, Codex, Hermes, DeepSeek Harness and WorkBuddy each keep
their own on-disk session format; Sessionary reads them read-only and re-parses the original file whenever you open
a session. Full per-agent paths and formats: [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md).

**Model providers and routing.** Add a provider and its API key on the Models page, group models from different
providers into a routing group on Routing, then pick which model or group each agent runs on. Usage breaks down
token consumption by day, model, agent and route.

**Remote machines (nodes).** On the Nodes page, add a host from your `~/.ssh/config` (login must already work with
a key, no password prompt). Sessionary reads that machine's agent sessions over SSH; nothing is installed on it.

**Privacy and safety.** The server only binds to `127.0.0.1` and refuses non-loopback `Host`/`Origin` headers;
agents' files are read-only except for the *Delete from disk* and *Continue here* actions you trigger yourself, both
reversible or read-only by default. Full detail: [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

- **Resume / Continue here fails with "command not found".** The agent's CLI isn't on `PATH` for the process that
  started Sessionary. Point `SESSIONARY_CLAUDE_BIN` / `SESSIONARY_OPENCODE_BIN` / `SESSIONARY_PI_BIN` at the real
  executable, or launch Sessionary from a shell where the agent already works.
- **On Windows, Continue here fails for an npm-installed agent.** npm installs `claude`/`opencode`/`pi` as `.cmd`
  shims; set the matching `SESSIONARY_*_BIN` variable to the actual executable.
- **A session doesn't show up.** Confirm the agent writes to the default location in
  [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md), or point the matching environment variable
  (`CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`) at it, then use **Rescan now** or restart Sessionary.
- **A node won't connect.** Test the exact host from `~/.ssh/config` by hand first: `ssh <alias> true` must succeed
  without a password prompt. Password-based SSH login is not supported.
- **A model change doesn't seem to apply.** Routing only affects sessions Sessionary itself starts or continues
  (terminal and chat); it never edits an agent's own configuration files, so a session started outside Sessionary
  keeps running on whatever that agent was already configured with.
- **I started the app but see no "new session" button.** That's expected for now — see
  [Known limitations](#known-limitations).

## Project structure and technical overview

Sessionary is a single Node.js process: a scanner and file watcher keep a derived SQLite index of every agent's
sessions current, a Hono server exposes it over HTTP and server-sent events, and a Vite/React UI (also embedded in
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop)) serves as the page. Agent-specific code is
isolated to one adapter per agent; everything else works on an agent-neutral session model.

Full source layout and the HTTP API: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development and contributing

```sh
pnpm install
pnpm dev:server      # API on :4777
pnpm dev:web         # UI on :5173 with hot reload
pnpm typecheck
pnpm test
pnpm build
```

Issues and pull requests are welcome. Full development setup: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- New sessions can't be started from Sessionary; existing ones are resumed or continued.
- Claude Code rewind forks are shown linearly; Pi shows only the active branch.
- Terminal and editor launching is tested on Linux; macOS (Terminal.app) and Windows (Windows Terminal / cmd)
  support is implemented but less exercised.
- Windows npm-installed agent CLIs are `.cmd` shims; set `SESSIONARY_*_BIN` to the real executables for
  *Continue here*.

## License and links

Sessionary is licensed under the [Apache License 2.0](LICENSE). Third-party licenses for the libraries it bundles
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) — this project packaged as a native app
- [Issues](https://github.com/onlynor/Sessionary/issues)

# Architecture

How Sessionary is put together, for anyone changing the code. For installing and using it, see the
[README](../README.md); for how each agent's files are read, see [Data formats](DATA_FORMATS.md); for the security
model, see [Security](SECURITY.md).

## Source layout

```
src/cli.ts             entry point: first scan, file watcher, periodic fallback scan, HTTP server
src/core/model.ts       agent-neutral Session / Message / Block (text, thinking, tool, image, note) and the adapter contract
src/adapters/*.ts       the only agent-specific code: listSources → load, storage(), resume/continue commands, removal
src/core/scanner.ts     incremental scan by per-source fingerprint (size:mtime / time_updated); reports changed sessions
src/core/watcher.ts     fs.watch on each agent's storage, debounced into rescans
src/core/index-store    derived SQLite index: session summaries + FTS5 trigram full text (prose and tool targets)
src/core/overlay.ts     the user's own data: pins, hidden sessions/messages, deletion records — never derived or rebuilt
src/core/project.ts     project = git root of the session's cwd (worktrees fold onto the main repo), resolved live
src/core/context.ts     inspector data: current git state, working-tree diffs, files and tools touched by the session
src/core/runs.ts        "Continue here": one headless agent run per session, with collision checks
src/core/launch.ts      terminal / editor / file-manager detection and detached launches
src/core/control/       Model Control: store (control.db), presets, catalog (provider /models), gateway (routing, failover,
                        usage), agents (what each agent runs on by itself; launch env/args for a routed agent), api (/api/control)
src/server/app.ts       Hono API, server-sent events, static web assets
web/                    Vite + React UI; web/src/styles.css holds the design tokens and themes, web/src/locales.ts the translations
design/playground/      the static design playground the UI was developed from (`pnpm build:design`)
```

The index stores only summaries and searchable text. Full conversations are re-parsed from the original files when
you open them, so the agents' files stay the single source of truth — see [Data formats](DATA_FORMATS.md).

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents` | Agents with session counts, storage path, availability, capabilities |
| GET | `/api/sessions` | Session summaries (with project, `pinned`, `active`) |
| GET | `/api/usage?since=` · `/api/usage/machines?since=` | Tokens per day, session and model from the agents' own records (each call on the day it was made) · the same for every machine, each row marked with its machine (nodes not online are listed as missing) |
| GET | `/api/sessions/:id?cursor=&limit=` | One session, paged by whole turns (`limit=all` for the rest) |
| GET | `/api/sessions/:id/{outline,edits,context,tree,changes,changes/file,find,images/:ref,resume-command,run}` | Session details |
| GET | `/api/search?q=` | Full-text search across sessions |
| GET | `/api/status` · `/api/events` | Scan / watch state and capabilities · server-sent `index`, `scan` events |
| GET | `/api/trash` | Hidden sessions and messages, deleted-from-disk backups |
| POST | `/api/scan` | Rescan now |
| POST | `/api/sessions/:id/{pin,unpin,hide,restore,open,continue,delete-from-disk}` | Session actions (`open` takes `target`: `folder`, `terminal`, `editor`, `file`, `resume`) |
| POST | `/api/sessions/:id/messages/{hide,restore}` · `/api/runs/:id/stop` · `/api/removed/:id/{restore,purge}` | Messages, runs, backups |
| GET | `/api/control/state` · `/api/control/agents?machine=` · `/api/control/usage/days?since=` | Providers (keys masked), groups, routes, this computer's agents, gateway, member health · one machine's agents and the route each starts on · gateway tokens per day, machine, agent, route and model |
| POST · PUT · DELETE | `/api/control/providers[/:id[/refresh]]` · `/api/control/groups[/:id]` | Providers (model list read on add/refresh) · routing groups |
| POST | `/api/control/routes` · `/api/control/gateway/{key,rotate}` · `/api/control/snippet` | Which model agents start on, per machine (`machine` '' = every machine; then `agent`, `project` or `session`; empty `target` clears) · the gateway key · set-up snippet |
| POST · GET | `/gateway/v1/{messages,chat/completions,responses}` · `/gateway/v1/models` | The gateway, for agents (gateway key, not the page token) |

POST requests need the `x-sessionary-token` header from `GET /api/token`.

## Companion project

[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) packages this web client and server as a native
Linux/macOS/Windows application, built in place from this repository's `web/src`.

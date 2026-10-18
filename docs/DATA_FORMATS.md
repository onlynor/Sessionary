# Where the data comes from

The on-disk format Sessionary reads for each agent. For the paths you can override, see the README's
[Configuration](../README.md#configuration) section.

| Agent | Location | Format | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-encoded>/<id>.jsonl` | JSONL event log | One assistant message is split over records sharing `message.id`; tool results are `user` records; `cwd` / `gitBranch` on every record; sub-agents in `<id>/subagents/agent-*.jsonl`; title from `ai-title` / `custom-title` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | SQLite (WAL); `session` / `message` / `part` with JSON `data` | `session.directory` + `project.worktree`; `parent_id` for sub-agents; tool call and result are one `tool` part; edit parts carry a unified diff |
| Pi | `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl` | JSONL tree (`id` / `parentId`) | Header carries `cwd`; tool results are separate `toolResult` messages; `bashExecution` for `!cmd` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` | JSONL (`session_meta`, `response_item`, `event_msg`) | Thread names from `~/.codex/state_N.sqlite` / `session_index.jsonl`; `apply_patch` calls become diffs |
| Hermes | `~/.hermes/state.db` | SQLite (`sessions`, `messages`) | Rewound messages (`active = 0`) are skipped |
| DeepSeek Harness | `<Sessionary data>/deepseek-harness/sessions/<cwd-encoded>/<id>/session.v<version>.jsonl[.zst]` | Zstandard-framed JSONL (`session`, `user/message`, `assistant/message`, `tool/call`, `tool/result`) | Read from Sessionary's own Harness home (`$DSH_HOME`), apart from the user's `~/.dsh`; the conversations themselves run on the harness's automation-only ACP server (`dsh --profile acp`) |
| WorkBuddy | `~/.workbuddy/projects/<project>/<session>.jsonl` (China) · `~/.workbuddy-ai/…` (international) | JSONL, CodeBuddy-style items | Desktop apps: history only, no resume command; the format is undocumented, so unknown lines are skipped |

The index (`index.db` under `SESSIONARY_HOME`) stores only summaries and searchable text, built by an incremental
scan keyed on each source's own fingerprint (size + mtime, or a `time_updated` column) and kept current by a file
watcher per agent's storage, debounced into rescans. Full conversations are re-parsed from the original files on
open, so the agents' own files stay the single source of truth and nothing here is a second copy of your history.

See [Architecture](ARCHITECTURE.md) for where this fits in the codebase.

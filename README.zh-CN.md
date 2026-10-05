# Sessionary

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

> 本文是 [README.md](README.md) 的翻译，以英文版为准。

面向 AI 编程 Agent 的本地优先会话管理器。Sessionary 读取 **Claude Code**、**OpenCode** 和 **Pi** 已经保存在你磁盘上的历史，
把每个 Agent 的所有会话放进一个可搜索的列表，并让你随时接着任意一个会话继续——可以在你自己的终端里用 Agent 真正的恢复命令，
也可以在浏览器里再发一条提问。

所有数据都不会离开你的电脑：没有账号、没有云服务、没有遥测。Agent 的文件以只读方式读取；Sessionary 自己的状态保存在单独的文件夹中。

## 功能

- **所有 Agent 一个列表。** Claude Code、OpenCode 和 Pi 的会话统一成同一个模型，可以按 Agent 分别查看，也可以合并显示。
  可按最后活动、开始日期、消息数或标题排序；按日期或项目分组；只看已置顶、活动中或编辑过文件的会话；
  也可以限定到某一个项目（git 根目录，worktree 会合并在一起）。
- **搜索全部内容。** 侧栏在输入时即时匹配标题、项目、分支和预览；从两个字符起还会搜索每条消息的全文
  （trigram 索引，因此中日韩文字和部分单词也能匹配）。`Ctrl K` 搜索全部会话和命令；`Ctrl F` 在当前打开的对话内查找。
- **实时更新。** 对每个 Agent 的存储目录进行文件监听，写入后约一秒内重新扫描并推送给已打开的页面，
  因此新会话会自动出现，屏幕上的对话也会跟随正在写入的 Agent（标记为 *Active*）。
- **完整阅读会话。** 消息、折叠起来并带有 diff 和输出的工具调用步骤、思考过程、图片、子 Agent 会话、提问索引，
  以及一个 *Changes* 视图，展示 Agent 编辑过的每个文件和当前工作区。
  检查器面板显示项目、分支、未提交状态、文件树，以及该会话的模型、Token 和费用。
- **接着继续。**
  - *Resume in Terminal* 会在会话目录中打开你的终端，运行 `claude --resume <id>`、
    `opencode --session <id>` 或 `pi --session <file>`；*Copy resume command* 会给你同样的一行命令。
  - *Continue here* 通过 Agent 的无界面 CLI 再发送一条提问，并把回复实时显示出来——默认只读。
  - 打开会话所在的文件夹、在该处打开终端，或在编辑器中打开该文件夹或其中任意文件。
- **整理。** 将会话置顶。隐藏会话或单条消息（仅在 Sessionary 中生效的回收站），或者从 Agent 的存储中删除会话，
  删除时会保留可恢复的备份。
- **桌面级界面。** 可折叠、可调整大小的面板，浅色 / 深色 / 石墨主题，宽松或紧凑列表，键盘导航，
  触屏和窄窗口布局，并支持 English、简体中文、繁體中文和日本語。

## 环境要求

- Node.js **22.13 或更新版本**（Sessionary 使用内置的 `node:sqlite`，没有任何原生模块）。
- Linux、macOS 或 Windows。
- 你想浏览的 Agent。恢复和继续会话需要它们的 CLI（`claude`、`opencode`、`pi`）在 `PATH` 中。

## 安装与运行

Sessionary 尚未发布到 npm。从源码检出后：

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

| 选项 | 含义 |
|---|---|
| `--port` | 监听端口（默认 `4777`，或 `$PORT`） |
| `--host` | 绑定的网络接口（默认 `127.0.0.1`；参见[隐私与安全](#隐私与安全)） |
| `--no-open` | 启动时不打开浏览器 |
| `--no-watch` | 不监听 Agent 的文件；改为每分钟重新扫描一次 |

### 键盘快捷键

| 按键 | 操作 |
|---|---|
| `Ctrl K` | 搜索全部会话、消息和命令 |
| `Ctrl F` | 在当前对话中查找 |
| `/` | 聚焦侧栏搜索框 |
| `J` / `K` | 下一个 / 上一个会话 |
| `1` `2` `3` · `0` | 显示某一个 Agent 的会话 · 全部 Agent |
| `P` | 置顶或取消置顶当前会话 |
| `Shift R` | 在终端中恢复当前会话 |
| `E` | 展开或折叠全部工具步骤 |
| `Alt ↑` / `Alt ↓` | 上一个 / 下一个提问 |
| `[` · `]` | 收起侧栏 · 切换检查器面板 |
| `Delete`（`Ctrl ⌫`） | 将会话移到 Sessionary 的回收站 |
| `?` | 显示全部快捷键 |

## 配置

以下均为可选项；默认值遵循各 Agent 自身的约定。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 存放 `projects/` 的位置 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode 存放 `opencode/opencode.db` 的位置 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 存放 `sessions/` 的位置 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`（Windows 上为 `%APPDATA%\sessionary`） | Sessionary 自己的索引、覆盖层数据和备份 |
| `SESSIONARY_TERMINAL`、`TERMINAL` | 依次查找 kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm 中第一个可用的 | *Resume* 和 *Open terminal* 使用的终端（macOS 上为 Terminal.app，Windows 上为 Windows Terminal 或 cmd） |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium，然后是在终端中运行的 `$VISUAL` / `$EDITOR` | *Open in editor* 使用的编辑器 |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | Agent 的可执行文件（在 Windows 上请指向真正的可执行文件，而不是 npm 的 `.cmd` 包装脚本） |
| `SESSIONARY_ALLOW_HOST` | 未设置 | 接受非回环地址的 `Host` 请求头（仅用于有意对外暴露的部署） |

## 数据来源

| Agent | 位置 | 格式 | 说明 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-encoded>/<id>.jsonl` | JSONL 事件日志 | 一条助手消息会拆分成多条共享 `message.id` 的记录；工具结果是 `user` 记录；每条记录都带有 `cwd` / `gitBranch`；子 Agent 位于 `<id>/subagents/agent-*.jsonl`；标题来自 `ai-title` / `custom-title` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | SQLite（WAL）；`session` / `message` / `part` 表，`data` 为 JSON | `session.directory` + `project.worktree`；`parent_id` 表示子 Agent；工具调用和结果是同一个 `tool` part；编辑类 part 带有 unified diff |
| Pi | `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl` | JSONL 树（`id` / `parentId`） | 文件头包含 `cwd`；工具结果是单独的 `toolResult` 消息；`!cmd` 对应 `bashExecution` |

索引只保存摘要和可搜索的文本。完整对话在你打开时才从原始文件重新解析，因此 Agent 的文件始终是唯一的事实来源。

## 隐私与安全

- **仅限本地。** 服务器绑定在 `127.0.0.1`，并且只响应发往回环主机名的请求，这同时也能阻止 DNS 重绑定攻击。
  绑定到其他网络接口会暴露你的会话历史；除非你清楚谁能访问到它，否则不要这样做。
- **写入保护。** 每个会改变状态的请求都需要一个每次启动时生成的令牌（只有同源页面能读取），并且 `Origin` 必须是回环地址。
- **Agent 的文件是只读的**——只有两个需要你主动触发的例外：
  - *Delete from disk* 会把 Claude Code / Pi 的文件（对话记录、`<id>/`、`file-history/`、`session-env/`、`tasks/`、
    `todos/`）移动到 Sessionary 的备份文件夹；对于 OpenCode 会话，则先用 `opencode export` 导出，再执行
    `opencode session delete`。在你删除备份之前，两者都可以从回收站恢复。最近两分钟内被写入过的会话会被拒绝，因为它们可能仍在运行。
  - *Continue here* 会运行 Agent 自己的 CLI，并追加到同一个会话：`claude -p --resume <id>`、
    `opencode run -s <id>`、`pi --session <file> -p`。默认是只读的（Claude `--permission-mode plan`、
    OpenCode `--agent plan`、Pi `--tools read,grep,find,ls`）；写入权限需要针对每条消息单独开启。
- **Sessionary 会写入的内容**（全部位于 `SESSIONARY_HOME` 下）：`index.db`（可随时丢弃、可重建的索引）、`overlay.db`
  （你的置顶、回收站和删除记录）以及 `backup/`。
- **打开文件或目录**仅限于会话自己的目录；恢复和终端命令会通过你的登录 shell 在该目录中运行。

## 架构

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

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/agents` | 各 Agent 的会话数、存储路径、是否可用以及支持的能力 |
| GET | `/api/sessions` | 会话摘要（包含项目、`pinned`、`active`） |
| GET | `/api/sessions/:id?cursor=&limit=` | 单个会话，按完整的对话轮次分页（`limit=all` 获取剩余全部） |
| GET | `/api/sessions/:id/{outline,edits,context,tree,changes,changes/file,find,images/:ref,resume-command,run}` | 会话详情 |
| GET | `/api/search?q=` | 跨会话全文搜索 |
| GET | `/api/status` · `/api/events` | 扫描 / 监听状态和能力 · 服务器推送的 `index`、`scan` 事件 |
| GET | `/api/trash` | 已隐藏的会话和消息，以及从磁盘删除后的备份 |
| POST | `/api/scan` | 立即重新扫描 |
| POST | `/api/sessions/:id/{pin,unpin,hide,restore,open,continue,delete-from-disk}` | 会话操作（`open` 接受 `target`：`folder`、`terminal`、`editor`、`file`、`resume`） |
| POST | `/api/sessions/:id/messages/{hide,restore}` · `/api/runs/:id/stop` · `/api/removed/:id/{restore,purge}` | 消息、运行和备份 |

POST 请求需要带上来自 `GET /api/token` 的 `x-sessionary-token` 请求头。

## 开发

```sh
pnpm install
pnpm dev:server      # API on :4777 (tsx watch, no browser)
pnpm dev:web         # UI on :5173 with hot reload, proxies /api to :4777
pnpm typecheck
pnpm test            # node:test suites in test/
pnpm build           # dist/ (server) + web-dist/ (UI)
pnpm build:design    # regenerate design/playground.html
```

将 Agent 相关变量（`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`）和 `SESSIONARY_HOME` 指向一个临时目录，
就可以基于测试数据开发，而不会碰到你真实的历史记录。所有界面文字都经过 `t()`；如果某个字符串缺少翻译，
`test/i18n.test.ts` 会失败。

## 已知限制

- Claude Code 的回退（rewind）分支以线性方式显示；Pi 只显示当前活动分支。
- 无法从 Sessionary 新建会话；只能恢复或继续已有的会话。
- 终端和编辑器的启动在 Linux 上经过测试；macOS（Terminal.app）和 Windows（Windows Terminal / cmd）的支持已经实现，但测试较少。
- 在 Windows 上通过 npm 安装的 Agent CLI 是 `.cmd` 包装脚本；如需使用 *Continue here*，请把 `SESSIONARY_*_BIN` 设置为真正的可执行文件。

## 许可证

[MIT](LICENSE)

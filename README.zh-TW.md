# Sessionary

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

> 本文為 [README.md](README.md) 的翻譯，以英文版為準。

為 AI 程式設計 Agent 打造的本機優先工作階段管理工具。Sessionary 讀取 **Claude Code**、**OpenCode** 和 **Pi** 早已儲存在你磁碟上的歷史，
把每個 Agent 的所有工作階段放進一個可搜尋的清單，並讓你隨時接續任何一個工作階段——可以在你自己的終端機裡用 Agent 真正的恢復指令，
也可以在瀏覽器裡再送出一個提問。

所有資料都不會離開你的電腦：沒有帳號、沒有雲端服務、沒有遙測。Agent 的檔案以唯讀方式讀取；Sessionary 自己的狀態儲存在獨立的資料夾中。

## 功能

- **所有 Agent 一個清單。** Claude Code、OpenCode 和 Pi 的工作階段統一成同一個模型，可以依 Agent 分別檢視，也可以合併顯示。
  可依最後活動、開始日期、訊息數或標題排序；依日期或專案分組；只看已釘選、活動中或編輯過檔案的工作階段；
  也可以限定到某一個專案（git 根目錄，worktree 會合併在一起）。
- **搜尋全部內容。** 側欄在輸入時即時比對標題、專案、分支和預覽；從兩個字元起還會搜尋每則訊息的全文
  （trigram 索引，因此中日韓文字和部分單字也能比對）。`Ctrl K` 搜尋全部工作階段和指令；`Ctrl F` 在目前開啟的對話內尋找。
- **即時更新。** 對每個 Agent 的儲存位置進行檔案監看，寫入後約一秒內重新掃描並推送給已開啟的頁面，
  因此新的工作階段會自動出現，畫面上的對話也會跟著正在寫入的 Agent（標示為 *Active*）。
- **完整閱讀工作階段。** 訊息、收合起來並附有 diff 和輸出的工具呼叫步驟、思考過程、圖片、子 Agent 工作階段、提問索引，
  以及一個 *Changes* 檢視，顯示 Agent 編輯過的每個檔案和目前的工作區。
  檢查器面板顯示專案、分支、未提交狀態、檔案樹，以及該工作階段的模型、Token 和費用。
- **接續進行。**
  - *Resume in Terminal* 會在工作階段的目錄中開啟你的終端機，執行 `claude --resume <id>`、
    `opencode --session <id>` 或 `pi --session <file>`；*Copy resume command* 會給你同樣的一行指令。
  - *Continue here* 透過 Agent 的無介面 CLI 再送出一個提問，並即時顯示回覆——預設為唯讀。
  - 開啟工作階段所在的資料夾、在該處開啟終端機，或在編輯器中開啟該資料夾或其中任何檔案。
- **整理。** 將工作階段釘選在最上方。隱藏工作階段或單則訊息（僅在 Sessionary 中生效的垃圾桶），或從 Agent 的儲存位置刪除工作階段，
  刪除時會保留可還原的備份。
- **桌面級介面。** 可收合、可調整大小的面板，淺色 / 深色 / 石墨主題，寬鬆或緊湊清單，鍵盤導覽，
  觸控與窄視窗版面，並支援 English、简体中文、繁體中文和日本語。

## 系統需求

- Node.js **22.13 或更新版本**（Sessionary 使用內建的 `node:sqlite`，沒有任何原生模組）。
- Linux、macOS 或 Windows。
- 你想瀏覽的 Agent。恢復和繼續工作階段需要它們的 CLI（`claude`、`opencode`、`pi`）位於 `PATH` 中。

## 安裝與執行

Sessionary 尚未發布到 npm。從原始碼取出後：

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

| 選項 | 意義 |
|---|---|
| `--port` | 監聽的連接埠（預設 `4777`，或 `$PORT`） |
| `--host` | 繫結的網路介面（預設 `127.0.0.1`；請參閱[隱私與安全](#隱私與安全)） |
| `--no-open` | 啟動時不開啟瀏覽器 |
| `--no-watch` | 不監看 Agent 的檔案；改為每分鐘重新掃描一次 |

### 鍵盤快速鍵

| 按鍵 | 動作 |
|---|---|
| `Ctrl K` | 搜尋全部工作階段、訊息和指令 |
| `Ctrl F` | 在目前的對話中尋找 |
| `/` | 聚焦側欄搜尋框 |
| `J` / `K` | 下一個 / 上一個工作階段 |
| `1` `2` `3` · `0` | 顯示某一個 Agent 的工作階段 · 全部 Agent |
| `P` | 釘選或取消釘選目前的工作階段 |
| `Shift R` | 在終端機中恢復目前的工作階段 |
| `E` | 展開或收合全部工具步驟 |
| `Alt ↑` / `Alt ↓` | 上一個 / 下一個提問 |
| `[` · `]` | 收合側欄 · 切換檢查器面板 |
| `Delete`（`Ctrl ⌫`） | 將工作階段移至 Sessionary 的垃圾桶 |
| `?` | 顯示全部快速鍵 |

## 設定

以下皆為選用；預設值遵循各 Agent 自身的慣例。

| 變數 | 預設值 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 存放 `projects/` 的位置 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode 存放 `opencode/opencode.db` 的位置 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 存放 `sessions/` 的位置 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`（Windows 上為 `%APPDATA%\sessionary`） | Sessionary 自己的索引、覆蓋層資料和備份 |
| `SESSIONARY_TERMINAL`、`TERMINAL` | 依序尋找 kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm 中第一個可用的 | *Resume* 和 *Open terminal* 使用的終端機（macOS 上為 Terminal.app，Windows 上為 Windows Terminal 或 cmd） |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium，接著是在終端機中執行的 `$VISUAL` / `$EDITOR` | *Open in editor* 使用的編輯器 |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | Agent 的執行檔（在 Windows 上請指向真正的執行檔，而不是 npm 的 `.cmd` 包裝腳本） |
| `SESSIONARY_ALLOW_HOST` | 未設定 | 接受非迴路位址的 `Host` 標頭（僅用於刻意對外開放的部署） |

## 資料來源

| Agent | 位置 | 格式 | 說明 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-encoded>/<id>.jsonl` | JSONL 事件記錄 | 一則助理訊息會拆成多筆共用 `message.id` 的記錄；工具結果是 `user` 記錄；每筆記錄都帶有 `cwd` / `gitBranch`；子 Agent 位於 `<id>/subagents/agent-*.jsonl`；標題來自 `ai-title` / `custom-title` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | SQLite（WAL）；`session` / `message` / `part` 資料表，`data` 為 JSON | `session.directory` + `project.worktree`；`parent_id` 表示子 Agent；工具呼叫和結果是同一個 `tool` part；編輯類 part 附有 unified diff |
| Pi | `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl` | JSONL 樹（`id` / `parentId`） | 檔頭包含 `cwd`；工具結果是獨立的 `toolResult` 訊息；`!cmd` 對應 `bashExecution` |

索引只儲存摘要和可搜尋的文字。完整對話在你開啟時才從原始檔案重新解析，因此 Agent 的檔案始終是唯一的事實來源。

## 隱私與安全

- **僅限本機。** 伺服器繫結在 `127.0.0.1`，而且只回應發往迴路主機名稱的請求，這同時也能阻擋 DNS 重新綁定攻擊。
  繫結到其他網路介面會暴露你的工作階段歷史；除非你清楚誰能連到它，否則不要這樣做。
- **寫入保護。** 每個會改變狀態的請求都需要一個每次啟動時產生的權杖（只有同源頁面能讀取），而且 `Origin` 必須是迴路位址。
- **Agent 的檔案是唯讀的**——只有兩個需要你主動觸發的例外：
  - *Delete from disk* 會把 Claude Code / Pi 的檔案（對話記錄、`<id>/`、`file-history/`、`session-env/`、`tasks/`、
    `todos/`）移到 Sessionary 的備份資料夾；對於 OpenCode 工作階段，則先用 `opencode export` 匯出，再執行
    `opencode session delete`。在你刪除備份之前，兩者都可以從垃圾桶還原。最近兩分鐘內被寫入過的工作階段會被拒絕，因為它們可能仍在執行。
  - *Continue here* 會執行 Agent 自己的 CLI，並附加到同一個工作階段：`claude -p --resume <id>`、
    `opencode run -s <id>`、`pi --session <file> -p`。預設為唯讀（Claude `--permission-mode plan`、
    OpenCode `--agent plan`、Pi `--tools read,grep,find,ls`）；寫入權限需要針對每則訊息另外開啟。
- **Sessionary 會寫入的內容**（全部位於 `SESSIONARY_HOME` 之下）：`index.db`（可隨時捨棄、可重建的索引）、`overlay.db`
  （你的釘選、垃圾桶和刪除記錄）以及 `backup/`。
- **開啟檔案或目錄**僅限於工作階段自己的目錄；恢復和終端機指令會透過你的登入 shell 在該目錄中執行。

## 架構

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

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/agents` | 各 Agent 的工作階段數、儲存路徑、是否可用以及支援的功能 |
| GET | `/api/sessions` | 工作階段摘要（包含專案、`pinned`、`active`） |
| GET | `/api/sessions/:id?cursor=&limit=` | 單一工作階段，依完整的對話輪次分頁（`limit=all` 取得其餘全部） |
| GET | `/api/sessions/:id/{outline,edits,context,tree,changes,changes/file,find,images/:ref,resume-command,run}` | 工作階段詳細資料 |
| GET | `/api/search?q=` | 跨工作階段全文搜尋 |
| GET | `/api/status` · `/api/events` | 掃描 / 監看狀態和功能 · 伺服器推送的 `index`、`scan` 事件 |
| GET | `/api/trash` | 已隱藏的工作階段和訊息，以及從磁碟刪除後的備份 |
| POST | `/api/scan` | 立即重新掃描 |
| POST | `/api/sessions/:id/{pin,unpin,hide,restore,open,continue,delete-from-disk}` | 工作階段動作（`open` 接受 `target`：`folder`、`terminal`、`editor`、`file`、`resume`） |
| POST | `/api/sessions/:id/messages/{hide,restore}` · `/api/runs/:id/stop` · `/api/removed/:id/{restore,purge}` | 訊息、執行和備份 |

POST 請求需要附上來自 `GET /api/token` 的 `x-sessionary-token` 標頭。

## 開發

```sh
pnpm install
pnpm dev:server      # API on :4777 (tsx watch, no browser)
pnpm dev:web         # UI on :5173 with hot reload, proxies /api to :4777
pnpm typecheck
pnpm test            # node:test suites in test/
pnpm build           # dist/ (server) + web-dist/ (UI)
pnpm build:design    # regenerate design/playground.html
```

將 Agent 相關變數（`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`）和 `SESSIONARY_HOME` 指向一個暫存目錄，
就能以測試資料進行開發，而不會碰到你真實的歷史記錄。所有介面文字都經過 `t()`；如果某個字串缺少翻譯，
`test/i18n.test.ts` 會失敗。

## 已知限制

- Claude Code 的回溯（rewind）分支以線性方式顯示；Pi 只顯示目前作用中的分支。
- 無法從 Sessionary 建立新的工作階段；只能恢復或繼續既有的工作階段。
- 終端機和編輯器的啟動在 Linux 上經過測試；macOS（Terminal.app）和 Windows（Windows Terminal / cmd）的支援已實作，但測試較少。
- 在 Windows 上透過 npm 安裝的 Agent CLI 是 `.cmd` 包裝腳本；若要使用 *Continue here*，請將 `SESSIONARY_*_BIN` 設為真正的執行檔。

## 授權

[MIT](LICENSE)

# Sessionary

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md)

**Sessionary** 是一款開源的本機優先控制中心,用來管理 AI 程式設計代理(Agent)——Claude Code、Codex、OpenCode、Pi、
Hermes、DeepSeek Harness 與 WorkBuddy(中國版與國際版 WorkBuddy AI)。它讀取每個代理已經保存在你磁碟上的工作階段
歷史,把所有代理的所有工作階段放進一個可搜尋的清單,並讓你隨時接續任意一個工作階段——可以在你自己的終端機裡用
代理真正的恢復指令,也可以在瀏覽器裡再送出一條提示。內建的模型閘道(gateway)讓你只需新增一次供應商 API 金鑰,就
能為每個代理指定要執行的模型,並依代理、專案與每日統計 token 用量。

所有資料都不會離開你的電腦:沒有帳號、沒有雲端服務、沒有遙測。代理的檔案以唯讀方式讀取;Sessionary 自己的狀態
保存在獨立的資料夾中。配套專案 [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) 把同一個 Web
客戶端打包成了 Linux、macOS 與 Windows 上的原生應用程式。

## 功能

以下所有內容都依 **機器 → 代理 → 專案 → 工作階段** 的層級組織。你的電腦是一台機器;再新增一台可以 SSH 連線的
VPS 或伺服器,它會得到同樣的頁面。

- **所有代理一個清單。** Claude Code、Codex、OpenCode、Pi、Hermes、DeepSeek Harness 與 WorkBuddy 的工作階段統一
  成同一個模型,可以依代理分別檢視,也可以合併顯示。可依最後活動、開始日期、訊息數或標題排序;依日期或專案分組;
  只看已置頂、活動中或編輯過檔案的工作階段;也可以限定到某一個專案(git 根目錄,worktree 會合併在一起)。
- **搜尋全部內容。** 側邊欄在輸入時即時比對標題、專案、分支與預覽;從兩個字元起還會搜尋每則訊息的全文(trigram
  索引,因此中日韓文字與部分單詞也能比對到)。`Ctrl K` 搜尋全部工作階段與指令;`Ctrl F` 在目前開啟的對話內搜尋。
- **即時更新。** 對每個代理的儲存目錄進行檔案監聽,寫入後約一秒內重新掃描並推送給已開啟的頁面,因此新的工作階段
  會自動出現,畫面上的對話也會跟著正在寫入的代理即時更新(標記為 *Active*)。
- **完整閱讀工作階段。** 訊息、可折疊並附帶 diff 與輸出的工具呼叫步驟、思考過程、圖片、子代理工作階段、提示索引,
  以及一個 *Changes* 檢視畫面,顯示代理編輯過的每個檔案與目前的工作樹。檢查器面板顯示專案、分支、未提交狀態、
  檔案樹,以及該工作階段的模型、token 與費用。
- **接續工作。** *Resume in Terminal* 會在工作階段的目錄中開啟你的終端機,執行代理真正的恢復指令
  (`claude --resume <id>`、`opencode --session <id>`、`pi --session <file>`);*Copy resume command* 則給你同一行
  指令。*Continue here* 透過代理的無介面 CLI 再送出一條提示,並即時顯示回覆——預設唯讀。你也可以開啟工作階段所在
  的資料夾、在那裡開啟終端機,或在編輯器中開啟其中任何檔案。
- **其他機器(節點)。** 新增一台可以 `ssh` 連線的 VPS 或任何機器,就能和本機工作階段一起瀏覽、搜尋並閱讀它的
  代理工作階段,並透過 SSH 在這裡的終端機中恢復其中一個。節點上不會安裝任何東西:Sessionary 透過 SSH 把歷史檔案
  複製過來,讀取的是這份複本。主機來自你的 `~/.ssh/config`;登入必須採用金鑰驗證。
- **模型控制。** 新增你已有的 API 金鑰(內建 Anthropic、OpenAI、DeepSeek、Kimi、智譜 GLM、Google Gemini、
  xAI Grok 與 OpenRouter 的預設,以及本機的 Ollama、LM Studio、Magpie 閘道,或任何相容 OpenAI / Anthropic 協定的
  位址),模型清單會直接從供應商讀取。把幾家供應商的模型組成一個 *路由群組*,再為每個代理選擇要使用的模型或路由
  群組。本機閘道會把請求轉送給說同一種協定的成員;當某個成員被限流、金鑰被拒或離線時,會在送出任何回覆之前切換
  到下一個。Routing 頁面即時顯示每一次的決策;Usage 頁面依天、模型、代理與路由統計 token。代理自己的設定檔永遠
  不會被修改:這個選擇只作用於 Sessionary 啟動的工作階段,在本機與 SSH 節點上皆是如此。
- **節制的通知。** 鈴鐺與側邊欄的徽章只提示真正需要你注意的事:在應用程式內終端機中執行的代理安靜下來或結束了、
  某個節點一直連不上、一次大型複製完成了。桌面通知(預設關閉,可選擇開啟)只在頁面位於背景時出現,可依類型分別
  開關,也能*暫停 1 小時*。
- **整理。** 將工作階段置頂。隱藏工作階段或單則訊息(僅在 Sessionary 中生效的回收桶),或是從代理的儲存空間中
  刪除工作階段,刪除時會保留可復原的備份。
- **桌面級介面。** 可折疊、可調整大小的面板,淺色 / 深色 / 石墨主題,寬鬆或精簡清單,鍵盤導覽,觸控與窄視窗
  版面,並支援 English、简体中文、繁體中文與日本語。

以上僅列出目前已經實作的功能。已知的缺口請見下方[已知限制](#已知限制)。

## 安裝與快速開始

Sessionary 目前還沒有發布到 npm,需要從原始碼檢出執行。

**系統需求:** Node.js **22.13 或更新版本**(Sessionary 使用內建的 `node:sqlite`,沒有任何原生模組相依),支援
Linux、macOS 或 Windows。瀏覽既有工作階段不需要安裝任何代理;恢復與接續工作階段則需要對應代理的 CLI(`claude`、
`opencode`、`pi` 等)能在 `PATH` 中找到。

```sh
pnpm install
pnpm build
node dist/cli.js                 # 開啟 http://127.0.0.1:4777

# 或是安裝成一個指令
pnpm pack && npm install -g ./sessionary-0.1.0.tgz
sessionary
```

```
sessionary [--port 4777] [--host 127.0.0.1] [--no-open] [--no-watch]
```

| 選項 | 說明 |
|---|---|
| `--port` | 監聽的連接埠(預設 `4777`,或 `$PORT`) |
| `--host` | 要綁定的網路介面(預設 `127.0.0.1`;見[隱私與安全](#隱私與安全)) |
| `--no-open` | 啟動時不開啟瀏覽器 |
| `--no-watch` | 不監聽代理的檔案變化,改為每分鐘重新掃描一次 |

**第一次執行:** 啟動 Sessionary,開啟它自動開啟的瀏覽器分頁。如果你已經在使用 Claude Code、Codex、OpenCode、Pi、
Hermes 或 WorkBuddy,它們既有的工作階段會立即出現——不需要匯入或設定任何東西。選擇一個工作階段來閱讀,或使用
*Resume in Terminal* / *Continue here* 接續之前的進度。Sessionary 本身不會開啟全新的代理工作階段(見
[已知限制](#已知限制));照常用代理自己的 CLI 開始一個新的工作階段,它就會自動出現在這裡。

## 使用方式

**導覽結構。** 側邊欄最上方是 Home 與 Machines,接著是目前選取機器的區塊(Agents、Projects、Sessions、Terminal、
Monitor),再往下是 Model Control(Models、Routing、Gateway、Usage),底部則是 Trash、Nodes、Notifications 與
Settings。

**鍵盤快捷鍵**

| 按鍵 | 動作 |
|---|---|
| `Ctrl K` | 搜尋全部工作階段、訊息與指令 |
| `Ctrl F` | 在目前開啟的對話內搜尋 |
| `/` | 將焦點移到側邊欄搜尋框 |
| `J` / `K` | 下一個 / 上一個工作階段 |
| `1` `2` `3` · `0` | 只看某個代理的工作階段 · 檢視全部 |
| `P` | 置頂或取消置頂目前的工作階段 |
| `Shift R` | 在終端機中恢復目前的工作階段 |
| `E` | 展開或折疊所有工具呼叫步驟 |
| `Alt ↑` / `Alt ↓` | 上一則 / 下一則提示 |
| `[` · `]` | 折疊側邊欄 · 切換檢查器面板 |
| `Delete`(`Ctrl ⌫`) | 將工作階段移入 Sessionary 的回收桶 |
| `?` | 顯示所有快捷鍵 |

**設定。** 以下都是選填項目,預設值依循各個代理自己的慣例。

| 變數 | 預設值 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 保存 `projects/` 的位置 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode 保存 `opencode/opencode.db` 的位置 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 保存 `sessions/` 的位置 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`(Windows 為 `%APPDATA%\sessionary`) | Sessionary 自己的索引、覆蓋層與備份 |
| `SESSIONARY_TERMINAL`、`TERMINAL` | 依序尋找 kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm | *Resume* 與 *Open terminal* 使用的終端機(macOS 為 Terminal.app,Windows 為 Windows Terminal 或 cmd) |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium,之後是終端機裡的 `$VISUAL` / `$EDITOR` | *Open in editor* 使用的編輯器 |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | 代理的可執行檔(在 Windows 上,請指向真正的可執行檔,而非 npm 的 `.cmd` 包裝腳本) |
| `SESSIONARY_ALLOW_HOST` | 未設定 | 接受非回送(loopback)的 `Host` 標頭(僅用於刻意對外公開的部署) |

**資料來源。** Claude Code、OpenCode、Pi、Codex、Hermes、DeepSeek Harness 與 WorkBuddy 各有自己的磁碟工作階段
格式;Sessionary 以唯讀方式讀取它們,並在你每次開啟工作階段時重新解析原始檔案。完整的路徑與格式請見
[docs/DATA_FORMATS.md](docs/DATA_FORMATS.md)(英文)。

**模型供應者與路由。** 在 Models 頁面新增供應者與其 API 金鑰,在 Routing 頁面把不同供應者的模型組成路由群組,
再為每個代理選擇要使用的模型或路由群組。Usage 頁面會依天、模型、代理與路由給出 token 消耗的明細。

**遠端機器(節點)。** 在 Nodes 頁面,從你的 `~/.ssh/config` 新增一台主機(必須已經可以用金鑰登入,不會跳出密碼
提示)。Sessionary 會透過 SSH 讀取那台機器的代理工作階段;不會在它上面安裝任何東西。

**隱私與安全。** 伺服器只綁定 `127.0.0.1`,拒絕非回送的 `Host`/`Origin` 標頭;代理的檔案以唯讀方式讀取,除了你
自己主動觸發的 *Delete from disk* 與 *Continue here* 兩個動作——前者可復原,後者預設唯讀。完整細節請見
[docs/SECURITY.md](docs/SECURITY.md)(英文)。

## 疑難排解

- **Resume / Continue here 顯示「找不到指令」。** 表示啟動 Sessionary 的程序的 `PATH` 裡沒有該代理的 CLI。請把
  `SESSIONARY_CLAUDE_BIN` / `SESSIONARY_OPENCODE_BIN` / `SESSIONARY_PI_BIN` 指向真正的可執行檔,或改在一個該代理
  本來就能正常執行的 shell 中啟動 Sessionary。
- **在 Windows 上,某個以 npm 安裝的代理無法使用 Continue here。** npm 會把 `claude`/`opencode`/`pi` 安裝成
  `.cmd` 包裝腳本;請把對應的 `SESSIONARY_*_BIN` 變數設定為真正的可執行檔。
- **某個工作階段沒有出現。** 確認該代理確實寫入到 [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md) 列出的預設位置,
  或用對應的環境變數(`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`)指向實際位置,然後按一下
  **Rescan now** 或重新啟動 Sessionary。
- **節點連不上。** 請先手動測試 `~/.ssh/config` 裡的同一個別名:`ssh <alias> true` 必須能在不要求輸入密碼的情況
  下成功執行。不支援以密碼方式登入 SSH。
- **更改模型後似乎沒有生效。** Routing 只會影響 Sessionary 自己啟動或接續的工作階段(終端機與對話),從不修改
  代理自己的設定檔;因此在 Sessionary 之外啟動的工作階段,仍會依該代理原本的設定執行。
- **啟動後看不到「開新工作階段」按鈕。** 目前這是預期行為——見下方[已知限制](#已知限制)。

## 專案結構與技術概覽

Sessionary 是單一的 Node.js 行程:掃描器與檔案監聽器維護一份由所有代理工作階段派生而來的 SQLite 索引,Hono
伺服器透過 HTTP 與 server-sent events 對外提供資料,一個 Vite/React 前端(同時也內嵌於
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop))作為頁面。與特定代理相關的程式碼被限制在
每個代理各自的一個轉接器(adapter)裡;其餘部分都建立在一個與代理無關的工作階段模型之上。

完整的原始碼結構與 HTTP API 請見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(英文)。

## 開發與貢獻

```sh
pnpm install
pnpm dev:server      # API 執行於 :4777
pnpm dev:web         # 支援熱重載的前端,執行於 :5173
pnpm typecheck
pnpm test
pnpm build
```

歡迎提交 issue 與 pull request。完整的開發環境設定請見 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)(英文)。

## 已知限制

- 無法從 Sessionary 中開啟全新的工作階段;只能恢復或接續既有的工作階段。
- Claude Code 的 rewind 分支會以線性方式呈現;Pi 只會顯示目前作用中的分支。
- 終端機與編輯器啟動功能在 Linux 上經過充分測試;macOS(Terminal.app)與 Windows(Windows Terminal / cmd)已經
  實作,但測試覆蓋較少。
- Windows 上以 npm 安裝的代理 CLI 是 `.cmd` 包裝腳本;要使用 *Continue here*,需要把 `SESSIONARY_*_BIN` 設定為
  真正的可執行檔。

## 授權與連結

Sessionary 以 [Apache License 2.0](LICENSE) 授權開源。本專案打包的第三方函式庫的授權資訊請見
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)(英文)。

- [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) —— 本專案打包成的原生應用程式
- [Issues](https://github.com/onlynor/Sessionary/issues)

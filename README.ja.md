# Sessionary

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

> このドキュメントは [README.md](README.md) の翻訳です。内容は英語版を正とします。

AI コーディングエージェントのための、ローカルファーストなセッションマネージャーです。Sessionary は **Claude Code**、**OpenCode**、
**Pi** がすでにディスクに保存している履歴を読み取り、すべてのエージェントのすべてのセッションを 1 つの検索可能な一覧にまとめます。
どのセッションからでも続きを再開できます——自分のターミナルでエージェント本来の再開コマンドを使うことも、ブラウザからもう 1 つプロンプトを送ることもできます。

データがマシンの外に出ることはありません。アカウントもクラウドサービスもテレメトリもありません。エージェントのファイルは読み取り専用で読み込まれ、
Sessionary 自身の状態は別のフォルダに保存されます。

## 機能

- **すべてのエージェントを 1 つの一覧に。** Claude Code、OpenCode、Pi のセッションを 1 つのモデルに正規化し、エージェントごとにもまとめても表示できます。
  最終更新、開始日、メッセージ数、タイトルで並べ替え、日付やプロジェクトでグループ化し、ピン留め・アクティブ・ファイルを編集したセッションだけに絞り込み、
  1 つのプロジェクト（git ルート。worktree はまとめられます）に限定することもできます。
- **すべてを検索。** サイドバーは入力に合わせてタイトル、プロジェクト、ブランチ、プレビューを即座に照合し、2 文字目からは
  すべてのメッセージの全文も検索します（trigram インデックスのため、CJK 文字や単語の一部にも一致します）。`Ctrl K` はすべてのセッションと
  コマンドを検索し、`Ctrl F` は開いている会話の中を検索します。
- **ライブ更新。** 各エージェントの保存場所をファイル監視し、書き込みから約 1 秒以内に再スキャンして開いているページに通知します。
  新しいセッションは自動的に現れ、画面上の会話はいま書き込み中のエージェントを追いかけます（*Active* と表示）。
- **セッションをしっかり読む。** メッセージ、diff と出力付きで折りたたまれたツール呼び出しのステップ、思考、画像、サブエージェントのセッション、
  プロンプトの索引、そしてエージェントが編集したすべてのファイルと現在の作業ツリーを表示する *Changes* ビュー。
  インスペクタには、プロジェクト、ブランチ、未コミットの状態、ファイルツリー、セッションのモデル・トークン・コストが表示されます。
- **続きから再開。**
  - *Resume in Terminal* はセッションのディレクトリでターミナルを開き、`claude --resume <id>`、
    `opencode --session <id>`、`pi --session <file>` のいずれかを実行します。*Copy resume command* で同じコマンドを 1 行で取得できます。
  - *Continue here* はエージェントのヘッドレス CLI を通じてプロンプトをもう 1 つ送り、返答をリアルタイムで表示します——既定は読み取り専用です。
  - セッションのフォルダを開く、そこでターミナルを開く、そのフォルダや中の任意のファイルをエディタで開く、といった操作ができます。
- **整理。** セッションを一覧の上にピン留めできます。セッションや個々のメッセージを非表示にしたり（Sessionary 内だけのゴミ箱）、
  復元可能なバックアップを残したうえでエージェントの保存場所からセッションを削除したりできます。
- **モデル管理。** お持ちの API キーを追加できます（Anthropic、OpenAI、DeepSeek、Kimi、GLM、Qwen、MiniMax、OpenRouter、Ollama などのプリセット、
  または任意の OpenAI / Anthropic 互換 URL）。モデル一覧はプロバイダ自身から取得します。複数プロバイダのモデルを*ルーティンググループ*にまとめ、
  エージェントごとに使うモデルかグループを選びます。ローカルゲートウェイ（`http://127.0.0.1:<ポート>/gateway`）は Anthropic Messages・OpenAI Chat・
  OpenAI Responses のリクエストを同じプロトコルを話すメンバーに中継し、レート制限・キー拒否・ダウンのときは応答の最初のバイトを送る前に次へ切り替えます。
  ルーティング画面は判断をリアルタイムで表示し、使用量画面はゲートウェイまたはエージェント自身のセッションファイルから日・モデル・エージェント・ルート別に集計します。
  同じマシンの Magpie ゲートウェイもひとつのプロバイダとして追加できます。エージェントの設定ファイルは編集しません。選択は Sessionary が起動するセッション
  （ターミナルとチャット）にだけ、起動時の環境変数と引数で適用されます。それ以外は「手動で設定」のスニペットを使います。
- **デスクトップアプリ品質の UI。** 折りたたみ・サイズ変更が可能なペイン、ライト / ダーク / グラファイトのテーマ、ゆったり / コンパクトな一覧、
  キーボード操作、タッチや狭いウィンドウ向けのレイアウト、English・简体中文・繁體中文・日本語に対応しています。

## 動作要件

- Node.js **22.13 以降**（Sessionary は組み込みの `node:sqlite` を使うため、ネイティブモジュールはありません）。
- Linux、macOS、Windows。
- 閲覧したいエージェント。再開と続行には、それぞれの CLI（`claude`、`opencode`、`pi`）が `PATH` 上にある必要があります。

## インストールと実行

Sessionary はまだ npm に公開されていません。リポジトリをチェックアウトしてから：

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

| オプション | 意味 |
|---|---|
| `--port` | 待ち受けるポート（既定は `4777`、または `$PORT`） |
| `--host` | バインドするインターフェース（既定は `127.0.0.1`。[プライバシーと安全性](#プライバシーと安全性)を参照） |
| `--no-open` | 起動時にブラウザを開かない |
| `--no-watch` | エージェントのファイルを監視せず、代わりに 1 分ごとに再スキャンする |

### キーボード

| キー | 操作 |
|---|---|
| `Ctrl K` | すべてのセッション・メッセージ・コマンドを検索 |
| `Ctrl F` | 開いている会話内を検索 |
| `/` | サイドバーの検索欄にフォーカス |
| `J` / `K` | 次 / 前のセッション |
| `1` `2` `3` · `0` | 1 つのエージェントのセッションを表示 · すべてのエージェント |
| `P` | 開いているセッションのピン留めを切り替え |
| `Shift R` | 開いているセッションをターミナルで再開 |
| `E` | すべてのツールステップを展開 / 折りたたみ |
| `Alt ↑` / `Alt ↓` | 前 / 次のプロンプト |
| `[` · `]` | サイドバーを折りたたむ · インスペクタの表示切替 |
| `Delete`（`Ctrl ⌫`） | セッションを Sessionary のゴミ箱へ移動 |
| `?` | すべてのショートカットを表示 |

## 設定

すべて任意です。既定値は各エージェント自身の慣習に従います。

| 変数 | 既定値 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code が `projects/` を置く場所 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode が `opencode/opencode.db` を置く場所 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi が `sessions/` を置く場所 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`（Windows では `%APPDATA%\sessionary`） | Sessionary 自身のインデックス、オーバーレイ、バックアップ |
| `SESSIONARY_TERMINAL`、`TERMINAL` | kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm のうち最初に見つかったもの | *Resume* と *Open terminal* で使うターミナル（macOS では Terminal.app、Windows では Windows Terminal または cmd） |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium、その次にターミナル内の `$VISUAL` / `$EDITOR` | *Open in editor* で使うエディタ |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | エージェントの実行ファイル（Windows では npm の `.cmd` ラッパーではなく実際の実行ファイルを指定してください） |
| `SESSIONARY_ALLOW_HOST` | 未設定 | ループバック以外の `Host` ヘッダーを受け付ける（意図的に外部公開する構成の場合のみ） |

## データの取得元

| エージェント | 場所 | 形式 | 補足 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-encoded>/<id>.jsonl` | JSONL イベントログ | 1 つのアシスタントメッセージが `message.id` を共有する複数のレコードに分かれる。ツールの結果は `user` レコード。すべてのレコードに `cwd` / `gitBranch` がある。サブエージェントは `<id>/subagents/agent-*.jsonl`。タイトルは `ai-title` / `custom-title` から |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | SQLite（WAL）。`session` / `message` / `part` テーブルで、`data` は JSON | `session.directory` + `project.worktree`。`parent_id` がサブエージェントを表す。ツール呼び出しと結果は 1 つの `tool` part。編集系の part は unified diff を持つ |
| Pi | `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl` | JSONL ツリー（`id` / `parentId`） | ヘッダーに `cwd` がある。ツールの結果は独立した `toolResult` メッセージ。`!cmd` は `bashExecution` |

インデックスが保持するのは要約と検索用のテキストだけです。会話全体は開いたときに元のファイルから改めて解析されるため、
エージェントのファイルが常に唯一の情報源であり続けます。

## プライバシーと安全性

- **ローカルのみ。** サーバーは `127.0.0.1` にバインドし、ループバックのホスト名宛てのリクエストにしか応答しません。これは DNS リバインディング攻撃も防ぎます。
  別のインターフェースにバインドするとセッション履歴が公開されます。誰がアクセスできるかを把握していない限り、行わないでください。
- **書き込み保護。** 状態を変更するすべてのリクエストには、起動ごとに発行されるトークン（同一オリジンのページだけが読み取れる）と、
  ループバックの `Origin` が必要です。
- **エージェントのファイルは読み取り専用**です——例外は、あなた自身が実行する次の 2 つだけです：
  - *Delete from disk* は Claude Code / Pi のファイル（トランスクリプト、`<id>/`、`file-history/`、`session-env/`、`tasks/`、
    `todos/`）を Sessionary のバックアップフォルダへ移動します。OpenCode のセッションは `opencode export` で書き出してから
    `opencode session delete` を実行します。どちらも、バックアップを削除するまではゴミ箱から復元できます。直近 2 分以内に書き込まれたセッションは、
    実行中の可能性があるため拒否されます。
  - *Continue here* はエージェント自身の CLI を実行し、同じセッションに追記します：`claude -p --resume <id>`、
    `opencode run -s <id>`、`pi --session <file> -p`。既定は読み取り専用です（Claude `--permission-mode plan`、
    OpenCode `--agent plan`、Pi `--tools read,grep,find,ls`）。書き込み権限はメッセージごとに明示的に有効にします。
- **Sessionary が書き込むもの**（すべて `SESSIONARY_HOME` の下）：`index.db`（いつでも破棄・再構築できるインデックス）、`overlay.db`
  （ピン留め、ゴミ箱、削除の記録）、`backup/`、そして `control.db`（プロバイダ、API キー、ルーティンググループ、ゲートウェイキーと使用量。
  作成時の権限は `0600` で本人だけが読めます）。ゲートウェイは同じループバックポートで待ち受け、専用のキーが必要で、ループバック以外の `Origin` を拒否し、
  ページにはマスクしたキーしか見せません。
- **ファイルやフォルダを開く操作**はセッション自身のディレクトリ内に限られます。再開コマンドとターミナルのコマンドは、そのディレクトリで
  ログインシェルを通じて実行されます。

## アーキテクチャ

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

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/agents` | 各エージェントのセッション数、保存場所、利用可否、対応機能 |
| GET | `/api/sessions` | セッションの要約（プロジェクト、`pinned`、`active` を含む） |
| GET | `/api/sessions/:id?cursor=&limit=` | 1 つのセッション。会話の往復単位でページ分割（残りすべては `limit=all`） |
| GET | `/api/sessions/:id/{outline,edits,context,tree,changes,changes/file,find,images/:ref,resume-command,run}` | セッションの詳細 |
| GET | `/api/search?q=` | セッション横断の全文検索 |
| GET | `/api/status` · `/api/events` | スキャン / 監視の状態と対応機能 · サーバー送信イベント `index`、`scan` |
| GET | `/api/trash` | 非表示にしたセッションとメッセージ、ディスクから削除したもののバックアップ |
| POST | `/api/scan` | いますぐ再スキャン |
| POST | `/api/sessions/:id/{pin,unpin,hide,restore,open,continue,delete-from-disk}` | セッションの操作（`open` は `target` に `folder`、`terminal`、`editor`、`file`、`resume` を取る） |
| POST | `/api/sessions/:id/messages/{hide,restore}` · `/api/runs/:id/stop` · `/api/removed/:id/{restore,purge}` | メッセージ、実行、バックアップ |

POST リクエストには、`GET /api/token` で取得した `x-sessionary-token` ヘッダーが必要です。

## 開発

```sh
pnpm install
pnpm dev:server      # API on :4777 (tsx watch, no browser)
pnpm dev:web         # UI on :5173 with hot reload, proxies /api to :4777
pnpm typecheck
pnpm test            # node:test suites in test/
pnpm build           # dist/ (server) + web-dist/ (UI)
pnpm build:design    # regenerate design/playground.html
```

エージェント関連の変数（`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`）と `SESSIONARY_HOME` を一時ディレクトリに向ければ、
実際の履歴に触れることなくテストデータで開発できます。UI の文字列はすべて `t()` を通ります。翻訳が欠けている文字列があると
`test/i18n.test.ts` が失敗します。

## 既知の制限

- Claude Code の巻き戻し（rewind）による分岐は直線的に表示されます。Pi はアクティブなブランチのみを表示します。
- Sessionary から新しいセッションを開始することはできません。既存のセッションを再開・続行するだけです。
- ターミナルとエディタの起動は Linux でテストされています。macOS（Terminal.app）と Windows（Windows Terminal / cmd）への対応は
  実装済みですが、検証は十分ではありません。
- Windows で npm からインストールしたエージェントの CLI は `.cmd` ラッパーです。*Continue here* を使うには `SESSIONARY_*_BIN` を実際の実行ファイルに設定してください。

## ライセンス

[MIT](LICENSE)

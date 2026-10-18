# Sessionary

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語**

**Sessionary** は、Claude Code、Codex、OpenCode、Pi、Hermes、DeepSeek Harness、WorkBuddy(中国版・国際版
WorkBuddy AI)といった AI コーディングエージェントを管理する、オープンソースのローカルファーストなコントロール
センターです。各エージェントがすでにディスク上に保持しているセッション履歴を読み取り、すべてのエージェントの
すべてのセッションを 1 つの検索可能な一覧にまとめ、どのセッションでもいつでも再開できます——自分のターミナルで
そのエージェント本来の再開コマンドを使うことも、ブラウザからもう一言プロンプトを送ることもできます。組み込みの
モデルゲートウェイを使えば、プロバイダーの API キーを一度登録するだけで、各エージェントが使うモデルを振り分け、
エージェント・プロジェクト・日単位でトークン使用量を確認できます。

データは一切あなたのマシンの外に出ません。アカウントも、クラウドサービスも、テレメトリもありません。各エージェ
ントのファイルは読み取り専用で扱われ、Sessionary 自身の状態は別のフォルダに保存されます。姉妹プロジェクトである
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) は、同じ Web クライアントを Linux・macOS・
Windows 向けのネイティブアプリとしてパッケージ化しています。

## 機能

以下すべては **マシン → エージェント → プロジェクト → セッション** という階層で整理されています。あなたの
コンピュータは 1 台のマシンであり、SSH で接続できる VPS やサーバーを追加すれば、同じページがそのまま使えます。

- **すべてのエージェントを 1 つの一覧で。** Claude Code、Codex、OpenCode、Pi、Hermes、DeepSeek Harness、
  WorkBuddy のセッションを 1 つのモデルに正規化し、エージェントごとにも、まとめても表示できます。最終活動、
  開始日、メッセージ数、タイトルで並べ替え、日付やプロジェクトでグループ化、ピン留め・アクティブ・ファイル編集
  ありのセッションだけに絞り込み、1 つのプロジェクト(git のルート。worktree はまとめて 1 つに畳まれます)に
  スコープを絞ることもできます。
- **すべてを検索。** サイドバーは入力しながらタイトル、プロジェクト、ブランチ、プレビューに即座にマッチし、
  2 文字以上では各メッセージの全文も検索します(trigram インデックスなので CJK や部分一致の単語にも対応)。
  `Ctrl K` は全セッションとコマンドを検索し、`Ctrl F` は開いている会話内を検索します。
- **リアルタイム。** 各エージェントのストレージに対するファイル監視により、書き込みからおよそ 1 秒以内に
  再スキャンして開いているページへ反映されるため、新しいセッションは自動的に表示され、画面上の会話もちょうど
  書き込み中のエージェント(*Active*)に追従します。
- **セッションをきちんと読む。** メッセージ、diff と出力付きで折りたたまれたツール呼び出しのステップ、
  思考過程、画像、サブエージェントのセッション、プロンプトの索引、そしてエージェントが編集したすべてのファイル
  と現在の作業ツリーを示す *Changes* ビュー。インスペクターにはプロジェクト、ブランチ、未コミットの状態、
  ファイルツリー、そのセッションのモデル・トークン・コストが表示されます。
- **続きから始める。** *Resume in Terminal* はセッションのディレクトリでターミナルを開き、エージェント本来の
  再開コマンド(`claude --resume <id>`、`opencode --session <id>`、`pi --session <file>`)を実行します。
  *Copy resume command* は同じコマンドをコピーします。*Continue here* はエージェントのヘッドレス CLI を通じて
  もう一言プロンプトを送り、応答をその場でストリーミング表示します——デフォルトは読み取り専用です。セッションの
  フォルダやそこでのターミナル、あるいはエディタでそのフォルダや任意のファイルを開くこともできます。
- **他のマシン(ノード)。** `ssh` で接続できる VPS や任意のマシンを追加すれば、自分のセッションと並べてその
  エージェントのセッションを閲覧・検索・読み取りでき、SSH を通じてここのターミナルから再開することもできます。
  ノード側には何もインストールされません。Sessionary は履歴ファイルを SSH 経由でコピーし、そのコピーを読み取り
  ます。ホストは `~/.ssh/config` から取得し、ログインは鍵認証である必要があります。
- **Model Control。** 手持ちの API キーを追加します(Anthropic、OpenAI、DeepSeek、Kimi、Zhipu GLM、
  Google Gemini、xAI Grok、OpenRouter のプリセットに加え、このコンピュータ上の Ollama・LM Studio、Magpie
  ゲートウェイ、任意の OpenAI/Anthropic 互換 URL にも対応)。モデル一覧はプロバイダーから直接読み込まれます。
  複数のプロバイダーのモデルを *ルーティンググループ* にまとめ、各エージェントが使うモデルやグループを選択
  できます。ローカルゲートウェイは同じプロトコルを話すメンバーへリクエストを中継し、レート制限、キーの拒否、
  ダウンなどが発生した場合は——応答を送る前に——次のメンバーへフェイルオーバーします。Routing ページは各判断を
  リアルタイムに表示し、Usage では日・モデル・エージェント・ルートごとのトークン数がわかります。エージェント
  自身の設定ファイルは一切編集されません。この選択は Sessionary が開始するセッションにのみ適用され、ローカル
  でも SSH ノードでも同様です。
- **控えめな通知。** ベルとサイドバーのバッジは本当に必要な場面だけ知らせます: アプリ内ターミナルで動いている
  エージェントが静かになった・終了した、ノードが接続できない状態が続いている、大きなコピーが完了した、など。
  デスクトップ通知(オプトイン)はページがバックグラウンドにあるときだけ送られ、種類ごとのスイッチと
  *1 時間停止* が用意されています。
- **整理する。** セッションをピン留めする。セッションや個々のメッセージを隠す(Sessionary 内だけのゴミ箱)、
  あるいはエージェントのストレージからセッションを削除する(復元可能なバックアップ付き)。
- **デスクトップ級の UI。** 折りたたみ・リサイズ可能なペイン、ライト/ダーク/グラファイトのテーマ、ゆったり/
  コンパクトなリスト、キーボード操作、タッチや狭いウィンドウでのレイアウト、そして English・简体中文・繁體中文・
  日本語に対応しています。

上記は現時点で実装済みの機能のみです。既知の制限は下記の[既知の制限](#既知の制限)を参照してください。

## インストールと始め方

Sessionary はまだ npm には公開されていません。チェックアウトから実行してください。

**動作要件:** Node.js **22.13 以上**(Sessionary は組み込みの `node:sqlite` を使用し、ネイティブモジュールは
ありません)。Linux・macOS・Windows で動作します。すでにディスク上にあるセッションを閲覧するだけならエージェント
のインストールは不要です。再開や続行には、そのエージェントの CLI(`claude`、`opencode`、`pi` など)が `PATH` 上に
ある必要があります。

```sh
pnpm install
pnpm build
node dist/cli.js                 # http://127.0.0.1:4777 を開く

# コマンドとしてインストールする場合
pnpm pack && npm install -g ./sessionary-0.1.0.tgz
sessionary
```

```
sessionary [--port 4777] [--host 127.0.0.1] [--no-open] [--no-watch]
```

| オプション | 意味 |
|---|---|
| `--port` | リッスンするポート(デフォルト `4777`、または `$PORT`) |
| `--host` | バインドするインターフェース(デフォルト `127.0.0.1`。[プライバシーと安全性](#プライバシーと安全性)参照) |
| `--no-open` | 起動時にブラウザを開かない |
| `--no-watch` | エージェントのファイルを監視せず、1 分ごとに再スキャンする |

**初回起動時:** Sessionary を起動し、自動的に開くブラウザタブを開いてください。すでに Claude Code、Codex、
OpenCode、Pi、Hermes、WorkBuddy を使っている場合、既存のセッションがそのまま表示されます——インポートや設定は
不要です。セッションを選んで読む、あるいは *Resume in Terminal* / *Continue here* でその続きから進めてください。
Sessionary 自体は新規のエージェントセッションを開始しません([既知の制限](#既知の制限)参照)。いつものように
エージェント自身の CLI で新しいセッションを始めれば、ここに自動的に表示されます。

## 使い方

**ナビゲーション構成。** サイドバーの最上部に Home と Machines があり、続いて選択中のマシンのブロック
(Agents、Projects、Sessions、Terminal、Monitor)、その下に Model Control(Models、Routing、Gateway、Usage)、
フッターに Trash、Nodes、Notifications、Settings があります。

**キーボード**

| キー | 動作 |
|---|---|
| `Ctrl K` | すべてのセッション・メッセージ・コマンドを検索 |
| `Ctrl F` | 開いている会話内を検索 |
| `/` | サイドバーの検索にフォーカス |
| `J` / `K` | 次 / 前のセッション |
| `1` `2` `3` · `0` | 1 つのエージェントのセッションのみ表示 · すべて表示 |
| `P` | 開いているセッションをピン留め/解除 |
| `Shift R` | 開いているセッションをターミナルで再開 |
| `E` | すべてのツールステップを展開/折りたたみ |
| `Alt ↑` / `Alt ↓` | 前 / 次のプロンプト |
| `[` · `]` | サイドバーを折りたたむ · インスペクターの切り替え |
| `Delete`(`Ctrl ⌫`) | セッションを Sessionary のゴミ箱へ移動 |
| `?` | すべてのショートカットを表示 |

**設定。** すべて省略可能で、デフォルト値は各エージェント自身の慣習に従います。

| 変数 | デフォルト | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code が `projects/` を保存する場所 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode が `opencode/opencode.db` を保存する場所 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi が `sessions/` を保存する場所 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`(Windows では `%APPDATA%\sessionary`) | Sessionary 自身のインデックス、オーバーレイ、バックアップ |
| `SESSIONARY_TERMINAL`、`TERMINAL` | kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm の順に検索 | *Resume* と *Open terminal* で使うターミナル(macOS では Terminal.app、Windows では Windows Terminal または cmd) |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium、その後ターミナルの `$VISUAL` / `$EDITOR` | *Open in editor* で使うエディタ |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | エージェントの実行ファイル(Windows では npm の `.cmd` シムではなく、実際の実行ファイルを指定してください) |
| `SESSIONARY_ALLOW_HOST` | 未設定 | ループバック以外の `Host` ヘッダーを受け入れる(意図的に外部公開する構成専用) |

**データの取得元。** Claude Code、OpenCode、Pi、Codex、Hermes、DeepSeek Harness、WorkBuddy はそれぞれ独自の
ディスク上のセッション形式を持っています。Sessionary はそれらを読み取り専用で読み込み、セッションを開くたびに
元のファイルを再解析します。各エージェントのパスと形式の詳細は
[docs/DATA_FORMATS.md](docs/DATA_FORMATS.md)(英語)を参照してください。

**モデルプロバイダーとルーティング。** Models ページでプロバイダーと API キーを追加し、Routing ページで異なる
プロバイダーのモデルをルーティンググループにまとめ、各エージェントが使うモデルまたはグループを選びます。
Usage では日・モデル・エージェント・ルートごとのトークン消費の内訳がわかります。

**リモートマシン(ノード)。** Nodes ページで、`~/.ssh/config` からホストを追加します(あらかじめ鍵認証で
ログインできる状態で、パスワード入力を求められないことが必要です)。Sessionary は SSH 経由でそのマシンの
エージェントセッションを読み取ります。何かをインストールすることはありません。

**プライバシーと安全性。** サーバーは `127.0.0.1` にのみバインドし、ループバック以外の `Host`/`Origin` を
拒否します。エージェントのファイルは読み取り専用で扱われますが、*Delete from disk* と *Continue here* という
あなた自身が実行する 2 つの操作だけは例外です——前者は復元可能、後者はデフォルトで読み取り専用です。詳細は
[docs/SECURITY.md](docs/SECURITY.md)(英語)を参照してください。

## トラブルシューティング

- **Resume / Continue here が「コマンドが見つかりません」と表示される。** Sessionary を起動したプロセスの
  `PATH` にそのエージェントの CLI がありません。`SESSIONARY_CLAUDE_BIN` / `SESSIONARY_OPENCODE_BIN` /
  `SESSIONARY_PI_BIN` を実際の実行ファイルに設定するか、そのエージェントが既に使えるシェルから Sessionary を
  起動してください。
- **Windows で、npm でインストールしたエージェントの Continue here が失敗する。** npm は `claude`/`opencode`/
  `pi` を `.cmd` シムとしてインストールします。対応する `SESSIONARY_*_BIN` を実際の実行ファイルに設定して
  ください。
- **あるセッションが表示されない。** そのエージェントが
  [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md) に記載のデフォルトの場所に書き込んでいることを確認するか、
  対応する環境変数(`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`)でその場所を指定し、
  **Rescan now** を押すか Sessionary を再起動してください。
- **ノードに接続できない。** まず手動で確認してください。`~/.ssh/config` に書いたのと同じエイリアスで
  `ssh <alias> true` がパスワード入力なしで成功する必要があります。パスワードによる SSH ログインには対応して
  いません。
- **モデルを変更しても反映されないように見える。** Routing は Sessionary 自身が開始・続行するセッション
  (ターミナルとチャット)にのみ影響し、エージェント自身の設定ファイルを編集することはありません。そのため
  Sessionary の外で開始されたセッションは、そのエージェント本来の設定のまま動作します。
- **起動しても「新規セッション」ボタンが見当たらない。** 現時点ではこれが仕様です——下記の
  [既知の制限](#既知の制限)を参照してください。

## プロジェクト構成と技術概要

Sessionary は単一の Node.js プロセスです。スキャナーとファイル監視が、すべてのエージェントのセッションから
派生した SQLite インデックスを最新の状態に保ち、Hono サーバーが HTTP と server-sent events でそれを公開し、
Vite/React の UI(同じものが [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) にも組み込ま
れています)がページとして機能します。エージェント固有のコードはエージェントごとに 1 つのアダプターに閉じ込め
られており、それ以外はすべてエージェントに依存しないセッションモデルの上で動作します。

完全なソースの構成と HTTP API については [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(英語)を参照してください。

## 開発とコントリビューション

```sh
pnpm install
pnpm dev:server      # API は :4777 で動作
pnpm dev:web         # ホットリロード対応の UI、:5173 で動作
pnpm typecheck
pnpm test
pnpm build
```

Issue や pull request を歓迎します。開発環境の詳細は
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)(英語)を参照してください。

## 既知の制限

- Sessionary から新規セッションを開始することはできません。既存のセッションの再開・続行のみです。
- Claude Code の rewind によるフォークは線形に表示されます。Pi はアクティブなブランチのみを表示します。
- ターミナルおよびエディタの起動は Linux で十分にテストされています。macOS(Terminal.app)と Windows
  (Windows Terminal / cmd)は実装済みですが、テストはそれほど多くありません。
- Windows で npm からインストールしたエージェント CLI は `.cmd` シムです。*Continue here* を使うには
  `SESSIONARY_*_BIN` を実際の実行ファイルに設定してください。

## ライセンスとリンク

Sessionary は [Apache License 2.0](LICENSE) の下でオープンソースとして公開されています。本プロジェクトが組み込んで
いるサードパーティ製ライブラリのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)(英語)に記載しています。

- [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) —— 本プロジェクトをパッケージ化したネイティブアプリ
- [Issues](https://github.com/onlynor/Sessionary/issues)

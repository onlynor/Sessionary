# Sessionary

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

**Sessionary** 是一个开源的本地优先控制中心,用于管理 AI 编程 Agent——Claude Code、Codex、OpenCode、Pi、Hermes、
DeepSeek Harness 和 WorkBuddy(国内版与 WorkBuddy AI 国际版)。它读取每个 Agent 已经保存在你磁盘上的会话历史,把所有
Agent 的所有会话放进一个可搜索的列表,并让你随时接着任意一个会话继续——可以在你自己的终端里用 Agent 真正的恢复命令,
也可以在浏览器里再发一条提问。内置的模型网关让你只需添加一次供应商 API 密钥,就能为每个 Agent 指定运行的模型,并按
Agent、项目和每天统计 token 用量。

所有数据都不会离开你的电脑:没有账号、没有云服务、没有遥测。Agent 的文件以只读方式读取;Sessionary 自己的状态保存
在单独的文件夹中。配套项目 [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) 把同一个 Web 客户端
打包成了 Linux、macOS 和 Windows 上的原生应用。

## 功能

以下所有内容都按 **机器 → Agent → 项目 → 会话** 的层级组织。你的电脑是一台机器;再添加一台可以 SSH 连接的 VPS 或
服务器,它会得到同样的页面。

- **所有 Agent 一个列表。** Claude Code、Codex、OpenCode、Pi、Hermes、DeepSeek Harness 和 WorkBuddy 的会话统一成
  同一个模型,可以按 Agent 分别查看,也可以合并显示。可按最后活动、开始日期、消息数或标题排序;按日期或项目分组;
  只看已置顶、活动中或编辑过文件的会话;也可以限定到某一个项目(git 根目录,worktree 会合并在一起)。
- **搜索全部内容。** 侧栏在输入时即时匹配标题、项目、分支和预览;从两个字符起还会搜索每条消息的全文(trigram 索引,
  因此中日韩文字和部分单词也能匹配)。`Ctrl K` 搜索全部会话和命令;`Ctrl F` 在当前打开的对话内查找。
- **实时更新。** 对每个 Agent 的存储目录进行文件监听,写入后约一秒内重新扫描并推送给已打开的页面,因此新会话会
  自动出现,屏幕上的对话也会跟随正在写入的 Agent(标记为 *Active*)。
- **完整阅读会话。** 消息、折叠起来并带有 diff 和输出的工具调用步骤、思考过程、图片、子 Agent 会话、提问索引,
  以及一个 *Changes* 视图,展示 Agent 编辑过的每个文件和当前工作区。检查器面板显示项目、分支、未提交状态、文件树,
  以及该会话的模型、token 和费用。
- **接着继续。** *Resume in Terminal* 会在会话目录中打开你的终端,运行 Agent 真正的恢复命令(`claude --resume <id>`、
  `opencode --session <id>`、`pi --session <file>`);*Copy resume command* 会给你同样的一行命令。*Continue here*
  通过 Agent 的无界面 CLI 再发送一条提问,并把回复实时显示出来——默认只读。你也可以打开会话所在的文件夹、在该处
  打开终端,或在编辑器中打开其中任意文件。
- **其他机器(节点)。** 添加一台可以 `ssh` 连接的 VPS 或任意机器,就能和本机会话一起浏览、搜索和阅读它的 Agent
  会话,并通过 SSH 在这里的终端里恢复其中一个。节点上不会安装任何东西:Sessionary 通过 SSH 把历史文件复制过来,
  读取的是这份副本。主机来自你的 `~/.ssh/config`;登录必须是基于密钥的。
- **模型控制。** 添加你已有的 API 密钥(内置 Anthropic、OpenAI、DeepSeek、Kimi、智谱 GLM、Google Gemini、xAI Grok
  和 OpenRouter 的预设,以及本机的 Ollama、LM Studio、Magpie 网关,或任意兼容 OpenAI / Anthropic 协议的地址),
  模型列表直接从供应商读取。把几家供应商的模型放进一个 *路由组*,再为每个 Agent 选择它使用的模型或路由组。本地
  网关把请求转发给说同一协议的成员;某个成员被限流、密钥被拒或宕机时,在发出任何回复之前切换到下一个。Routing
  页面实时展示每次决策;Usage 页面按天、模型、Agent 和路由统计 token。Agent 自己的配置文件永远不会被修改:这个
  选择只作用于 Sessionary 启动的会话,在本机和 SSH 节点上都一样。
- **节制的通知。** 铃铛和侧栏角标提示需要你关注的事:在应用内终端里运行的 Agent 安静下来或退出了、某个节点一直
  连不上、一次大的复制完成了。桌面通知(默认关闭,可选开启)只在页面处于后台时出现,按类型分别开关,也可以
  *暂停 1 小时*。
- **整理。** 将会话置顶。隐藏会话或单条消息(仅在 Sessionary 中生效的回收站),或者从 Agent 的存储中删除会话,
  删除时会保留可恢复的备份。
- **桌面级界面。** 可折叠、可调整大小的面板,浅色 / 深色 / 石墨主题,宽松或紧凑列表,键盘导航,触屏和窄窗口布局,
  并支持 English、简体中文、繁體中文和日本語。

以上只列出目前已经实现的功能。已知的缺口见下方[已知限制](#已知限制)。

## 安装与快速开始

Sessionary 还没有发布到 npm,目前需要从代码检出来运行。

**系统需求:** Node.js **22.13 或更高版本**(Sessionary 使用内置的 `node:sqlite`,没有任何原生模块依赖),支持
Linux、macOS 或 Windows。浏览已有会话不需要安装任何 Agent;恢复和继续会话则需要对应 Agent 的 CLI(`claude`、
`opencode`、`pi` 等)可以在 `PATH` 中找到。

```sh
pnpm install
pnpm build
node dist/cli.js                 # 打开 http://127.0.0.1:4777

# 或者安装为一个命令
pnpm pack && npm install -g ./sessionary-0.1.0.tgz
sessionary
```

```
sessionary [--port 4777] [--host 127.0.0.1] [--no-open] [--no-watch]
```

| 选项 | 含义 |
|---|---|
| `--port` | 监听端口(默认 `4777`,或 `$PORT`) |
| `--host` | 绑定的网络接口(默认 `127.0.0.1`;见[隐私与安全](#隐私与安全)) |
| `--no-open` | 启动时不打开浏览器 |
| `--no-watch` | 不监听 Agent 的文件变化,改为每分钟重新扫描一次 |

**第一次运行:** 启动 Sessionary,打开它自动打开的浏览器标签页。如果你已经在用 Claude Code、Codex、OpenCode、Pi、
Hermes 或 WorkBuddy,它们现有的会话会立刻出现——不需要导入或配置任何东西。选择一个会话阅读,或者用
*Resume in Terminal* / *Continue here* 接着之前的地方继续。Sessionary 本身不会开启全新的 Agent 会话(见
[已知限制](#已知限制));照常用 Agent 自己的 CLI 开始一个新会话,它会自动出现在这里。

## 使用方法

**导航结构。** 侧栏最上方是 Home 和 Machines,接着是当前所选机器的区块(Agents、Projects、Sessions、Terminal、
Monitor),再往下是 Model Control(Models、Routing、Gateway、Usage),底部是 Trash、Nodes、Notifications 和
Settings。

**快捷键**

| 按键 | 操作 |
|---|---|
| `Ctrl K` | 搜索全部会话、消息和命令 |
| `Ctrl F` | 在当前打开的对话内查找 |
| `/` | 聚焦到侧栏搜索框 |
| `J` / `K` | 下一个 / 上一个会话 |
| `1` `2` `3` · `0` | 只看某个 Agent 的会话 · 查看全部 |
| `P` | 置顶或取消置顶当前会话 |
| `Shift R` | 在终端中恢复当前会话 |
| `E` | 展开或折叠所有工具调用步骤 |
| `Alt ↑` / `Alt ↓` | 上一条 / 下一条提问 |
| `[` · `]` | 折叠侧栏 · 切换检查器面板 |
| `Delete`(`Ctrl ⌫`) | 将会话移入 Sessionary 的回收站 |
| `?` | 显示全部快捷键 |

**配置。** 以下都是可选项,默认值遵循各个 Agent 自己的约定。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 保存 `projects/` 的位置 |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode 保存 `opencode/opencode.db` 的位置 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 保存 `sessions/` 的位置 |
| `SESSIONARY_HOME` | `~/.local/share/sessionary`(Windows 为 `%APPDATA%\sessionary`) | Sessionary 自己的索引、覆盖层和备份 |
| `SESSIONARY_TERMINAL`、`TERMINAL` | 依次查找 kitty、alacritty、wezterm、ghostty、foot、GNOME Terminal、Ptyxis、Konsole、Xfce Terminal、x-terminal-emulator、xterm | *Resume* 和 *Open terminal* 使用的终端(macOS 为 Terminal.app,Windows 为 Windows Terminal 或 cmd) |
| `SESSIONARY_EDITOR` | VS Code、Cursor、Zed、Windsurf、Sublime Text、VSCodium,之后是终端里的 `$VISUAL` / `$EDITOR` | *Open in editor* 使用的编辑器 |
| `SESSIONARY_CLAUDE_BIN`、`SESSIONARY_OPENCODE_BIN`、`SESSIONARY_PI_BIN` | `claude`、`opencode`、`pi` | Agent 可执行文件(在 Windows 上,请指向真正的可执行文件,而不是 npm 的 `.cmd` 包装脚本) |
| `SESSIONARY_ALLOW_HOST` | 未设置 | 接受非回环的 `Host` 头(仅用于有意公开暴露的部署) |

**数据来源。** Claude Code、OpenCode、Pi、Codex、Hermes、DeepSeek Harness 和 WorkBuddy 各自有自己的磁盘会话格式;
Sessionary 以只读方式读取它们,并在你每次打开会话时重新解析原始文件。完整的路径和格式见
[docs/DATA_FORMATS.md](docs/DATA_FORMATS.md)(英文)。

**模型供应商与路由。** 在 Models 页面添加供应商和它的 API 密钥,在 Routing 页面把不同供应商的模型组合成路由组,
再为每个 Agent 选择要使用的模型或路由组。Usage 页面按天、模型、Agent 和路由给出 token 消耗的明细。

**远程机器(节点)。** 在 Nodes 页面,从你的 `~/.ssh/config` 中添加一个主机(必须已经可以用密钥登录,不弹出密码
提示)。Sessionary 会通过 SSH 读取那台机器的 Agent 会话;不会在它上面安装任何东西。

**隐私与安全。** 服务只绑定 `127.0.0.1`,拒绝非回环的 `Host`/`Origin` 请求头;Agent 的文件以只读方式读取,
除了你自己主动触发的 *Delete from disk* 和 *Continue here* 两个操作——前者可恢复,后者默认只读。完整细节见
[docs/SECURITY.md](docs/SECURITY.md)(英文)。

## 故障排查

- **Resume / Continue here 报错“命令未找到”。** 说明启动 Sessionary 的进程的 `PATH` 里没有该 Agent 的 CLI。
  请把 `SESSIONARY_CLAUDE_BIN` / `SESSIONARY_OPENCODE_BIN` / `SESSIONARY_PI_BIN` 指向真正的可执行文件,或者在一个
  该 Agent 本来就能正常使用的 shell 里启动 Sessionary。
- **在 Windows 上,某个 npm 安装的 Agent 无法 Continue here。** npm 会把 `claude`/`opencode`/`pi` 安装成 `.cmd`
  包装脚本;请把对应的 `SESSIONARY_*_BIN` 变量设置为真正的可执行文件。
- **某个会话没有出现。** 确认该 Agent 确实写入到 [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md) 中列出的默认位置,
  或者用对应的环境变量(`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`PI_CODING_AGENT_DIR`)指向实际位置,然后点
  **Rescan now** 或重启 Sessionary。
- **节点连不上。** 先手动测试 `~/.ssh/config` 里的同一个别名:`ssh <alias> true` 必须能在不提示输入密码的情况下
  成功。不支持基于密码的 SSH 登录。
- **更改模型后好像没有生效。** Routing 只影响 Sessionary 自己启动或续写的会话(终端和对话),从不修改 Agent 自己
  的配置文件;因此在 Sessionary 之外启动的会话,仍会按该 Agent 原来的配置运行。
- **启动后没看到“新建会话”按钮。** 目前是预期行为——见下方[已知限制](#已知限制)。

## 项目结构与技术概览

Sessionary 是一个单一的 Node.js 进程:扫描器和文件监听器维护一份由所有 Agent 会话派生而来的 SQLite 索引,
Hono 服务器通过 HTTP 和 server-sent events 对外提供数据,一个 Vite/React 前端(同时也内嵌在
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) 中)作为页面。与具体 Agent 相关的代码被
限制在每个 Agent 各自的一个适配器里;其余部分都基于一个与 Agent 无关的会话模型工作。

完整的源码结构和 HTTP API 见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(英文)。

## 开发与贡献

```sh
pnpm install
pnpm dev:server      # API 运行在 :4777
pnpm dev:web         # 带热重载的前端,运行在 :5173
pnpm typecheck
pnpm test
pnpm build
```

欢迎提交 issue 和 pull request。完整的开发环境配置见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)(英文)。

## 已知限制

- 无法从 Sessionary 中开启全新的会话;只能恢复或继续已有会话。
- Claude Code 的 rewind 分支按线性方式展示;Pi 只展示当前激活的分支。
- 终端和编辑器启动功能在 Linux 上经过充分测试;macOS(Terminal.app)和 Windows(Windows Terminal / cmd)已经
  实现,但测试覆盖较少。
- Windows 上通过 npm 安装的 Agent CLI 是 `.cmd` 包装脚本;要使用 *Continue here*,需要把 `SESSIONARY_*_BIN`
  设置为真正的可执行文件。

## 许可证与链接

Sessionary 基于 [Apache License 2.0](LICENSE) 开源。本项目打包的第三方库的许可证见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)(英文)。

- [Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) —— 本项目打包成的原生应用
- [Issues](https://github.com/onlynor/Sessionary/issues)

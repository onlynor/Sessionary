# Development

Building, running and testing Sessionary from source. For installing and running a build, see the
[README](../README.md).

## Commands

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

See also [Architecture](ARCHITECTURE.md) for the source layout and HTTP API, and
[Sessionary Desktop](https://github.com/onlynor/Sessionary-Desktop) for the native app this project is embedded in.

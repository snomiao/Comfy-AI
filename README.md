# comfy-ai

Local bridge between coding agents (Claude Code, Cursor, etc.) and the
in-browser **ComfyAI** agent panel running inside ComfyUI's frontend
SPA.

The ComfyAI panel itself is frontend-only — it executes everything in
the user's browser, holds the user's API key, and never talks to a
backend it doesn't already trust. This bridge gives a *local* agent on
the same machine a way to:

- See what's happening in the SPA (read-only tail)
- Send the SPA a user message as if the user typed it
- Run a one-shot shell command in the SPA's runtime and read the
  result (the killer primitive: `comfy-ai eval "graph summary"`)

The SPA stays the source of truth and the only execution sandbox. The
bridge is a thin relay — it owns no agent logic.

## Architecture

```
local agent (Claude Code, Cursor, etc.)
        │
        ▼
   comfy-ai CLI ─── ws://localhost:7437/ctl ──┐
                                              │
                                              ▼
                                    comfy-ai daemon
                                              ▲
                                              │
   browser SPA tab ── ws://localhost:7437/spa ┘
```

Two WS endpoints:

- `/spa` — browser SPA tabs connect here on load. Each tab is one
  session.
- `/ctl` — local CLI clients connect here, optionally with a token
  obtained from `/pair/<code>`.

Plus an HTTP `/pair/<code>` endpoint that's hit once during pairing.

## Pairing UX

1. User clicks "Pair Local Agent" in the SPA's agent panel.
2. SPA generates a 4–6 char code, sends `pair-request` to the daemon,
   shows a modal:
   > Run this in your terminal:
   > `npx comfy-ai pair http://localhost:7437/pair/7K3F`
3. User pastes the command (or asks their local agent to run it).
4. CLI hits the URL, gets back `{ sessionId, title, token }`, saves it
   under `~/.config/comfy-ai/state.json`. The SPA's modal dismisses
   automatically.
5. From then on, `comfy-ai send / eval / tail / attach` work without
   `--session`.

Codes are one-shot and expire in 5 minutes. Tokens are session-scoped:
when the SPA tab closes, all tokens for that session become invalid.

## Install / build

```bash
bun install
bun run build:cli              # → dist/cli.js
chmod +x dist/cli.js
```

For a published flow:

```bash
npm install -g comfy-ai
# or one-shot:
npx comfy-ai pair http://localhost:7437/pair/7K3F
```

## Commands

| Command | What it does |
|---|---|
| `comfy-ai serve [--port 7437]` | Start the bridge daemon. Localhost-only by default. |
| `comfy-ai pair <url>` | Claim a pairing code shown in the SPA modal. Saves token + sessionId locally. |
| `comfy-ai list` | List active SPA tabs (id, title, age). |
| `comfy-ai tail [session]` | Stream session events to stdout (read-only). |
| `comfy-ai attach [session]` | Bidirectional REPL — stdin lines become user messages, events render to stdout. |
| `comfy-ai send <text>` | Fire-and-forget user message. |
| `comfy-ai eval <script>` | Run one shell command in the SPA's runtime. Prints stdout/stderr; exits with the same code. **The killer primitive.** |
| `comfy-ai kill [session]` | Abort the current stream. |
| `comfy-ai logout` | Clear locally stored pairing state. |

`<session>` is optional once you've paired — the saved sessionId becomes
the default. Use `--session=<id>` (or pass `[session]`) to target a
specific tab when more than one is open.

## Wire protocol (v=1)

JSON-encoded text frames over WebSocket. Every envelope carries
`{ v: 1, type: <string>, ... }`. Receivers MUST drop frames with a
mismatched `v`.

See `ts/protocol.ts` for the full type definitions. Headlines:

- SPA → daemon: `hello`, `event`, `evalResult`, `pair-request`, `pong`
- daemon → SPA: `send`, `eval`, `abort`, `paired`, `ping`
- CLI → daemon: `list`, `subscribe`, `send`, `eval`, `abort`
- daemon → CLI: `sessions`, `event`, `evalResult`, `error`

## Local development

```bash
# Terminal A — start the daemon
bun run ts/cli.ts serve --verbose

# Terminal B — fake an SPA so you can drive it without the real frontend
COMFY_AI_PAIR_CODE=DEMO bun run ts/mock-spa.ts

# Terminal C — drive it from the CLI
bun run ts/cli.ts list
bun run ts/cli.ts pair http://127.0.0.1:7437/pair/DEMO
bun run ts/cli.ts send "hello"
bun run ts/cli.ts eval "graph summary"
```

## Security model

- Daemon binds to `127.0.0.1` only by default. Anything on the same
  machine that can reach localhost can use the daemon — same trust
  level as `redis-cli`, `psql`, the Docker socket, etc.
- Pairing tokens are random UUIDs, never written to disk by the
  daemon. The CLI persists them in `~/.config/comfy-ai/state.json`
  (mode 0644 by default; consider tightening if your home dir is
  shared).
- The SPA never receives the local agent's API key, and the local
  agent never receives the SPA's API key. They communicate over
  *messages*, not credentials.
- Mixed Content (browser tab on `https://` reaching `ws://localhost`)
  is the one packaging gotcha. For self-hosted ComfyUI on `http://`
  this is a non-issue. For HTTPS-served SPAs (Cloudflare Pages, prod
  cloud) a thin browser extension shim is the planned fix; the
  protocol stays identical.

## License

MIT

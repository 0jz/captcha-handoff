# captcha-handoff

An MCP server that watches a real browser session for CAPTCHA blocks, hands them
to a human asynchronously, **can try to solve them itself with human-like mouse
movement**, and persists the verified session so the same site never blocks the
agent twice.

Built to the spec in [`BUILD.md`](./BUILD.md).

## What it does

- **Detects** reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, Arkose, and
  slider/generic challenges via structural markers + behavioral heuristics.
- **Hands off** a blocked tab to a human without blocking the agent: it
  screenshots the tab, fires an OS toast, and auto-resumes the paused task the
  instant the challenge clears.
- **Self-solves (opt-in)** — see below — so the agent can try to clear a
  checkbox/slider challenge itself, replicating human mouse movement.
- **Persists** verified sessions in an AES-256-GCM encrypted "jar", keyed in the
  OS credential manager, and restores them before future navigations.

## Setup

Requirements: Node 20+, and a Chrome or Edge install on the host.

```bash
npm install
npm run build        # compile to dist/
```

The tool drives **your own Chrome profile**. Two ways to provide it:

1. **Let it launch Chrome for you** (recommended): just start the server. It
   finds your installed Chrome/Edge and launches it headed with a persistent
   profile under `~/.captcha-handoff/chrome-profile`. You solve challenges in
   that window, and the agent's tabs share the same profile/cookies.
2. **Attach to your running Chrome**: start Chrome with
   `--remote-debugging-port=9222`, then start the server. It reuses that profile.

### Register with an MCP client

```json
{
  "mcpServers": {
    "captcha-handoff": {
      "command": "node",
      "args": ["C:/Users/nikol/orca/workspaces/test/brant/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `detect_captcha` | Scan a tab (or all tabs) for a CAPTCHA; on hit, screenshot + open handoff + notify human. |
| `solve_captcha` | **Attempt to solve by itself** using human-like mouse movement (see below). |
| `request_human_solve` | Explicitly ping the human for a session (returns immediately). |
| `get_handoff_status` | Poll-free read of session state. |
| `wait_for_clear` | Optional long-poll until a session clears or expires. |
| `save_session` | Force-persist a verified session. |
| `restore_session` | Inject a saved session before navigating. |
| `list_known_sites` | List sites with a saved session. |

The server also emits `notifications/message` logging events to the client on
detection, clear, and expiry, so agents see pushes, not just pull results.

## Self-solve (human-like mouse)

`solve_captcha` is **never run automatically** — the agent must call it. It then:

1. Locates the interactive control for the detected challenge kind
   (reCAPTCHA v2 checkbox, hCaptcha, Turnstile, Arkose, a slider handle, or a
   generic "I am human" button).
2. Moves the mouse along a **cubic-bezier path** with hand-tremor jitter,
   variable speed (ease-in-out), and a slight overshoot before settling — then
   clicks/drags with randomized press/release dwell times.
3. Polls for a verification token/clearance. On success it persists the session;
   on failure (e.g. the challenge opens an image/audio puzzle) it falls back to
   the human handoff.

This is honest, best-effort behavior: it clears low-risk checkbox/slider
challenges and leaves image/audio challenges to the human. It drives the user's
own browser on the user's own machine — it does not access anything the human
couldn't, and respects site ToS.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CH_CHROME_DEBUG_PORT` | `9222` | CDP port to attach to. |
| `CH_USER_DATA_DIR` | `~/.captcha-handoff/chrome-profile` | Persistent profile dir. |
| `CH_HEADLESS` | `false` | Launch Chrome headless. |
| `CH_HANDOFF_TIMEOUT_MS` | `600000` | Human handoff expiry. |
| `CH_CLEAR_DEBOUNCE_MS` | `3000` | Cleared-detection debounce. |
| `CH_SOLVER_ENABLED` | `true` | Master switch for self-solve. |
| `CH_SOLVER_MOUSE_HUMANIZE` | `true` | Bezier/jitter mouse path. |
| `CH_SOLVER_STEP_DELAY_MS` | `3,14` | Min/max per-step delay. |
| `CH_SOLVER_OVERSHOOT` | `true` | Overshoot before settling. |
| `CH_SOLVER_CLEAR_WAIT_MS` | `2500` | Post-click token wait. |
| `CH_NOTIFY_WEBHOOK_URL` | — | Optional remote handoff webhook. |
| `CH_JAR_DIR` | `~/.captcha-handoff/jar` | Encrypted jar directory. |
| `CH_SCREENSHOT_DIR` | temp `opencode/handoff` | Screenshot location. |

## Development

```bash
npm test           # unit tests (detector, coordinator, jar, human-mouse)
npm run build      # typecheck + compile
```

First-run notes: the OS credential manager may prompt once to allow storing the
jar key. If `keytar` (native) can't load, the server degrades to a
machine-bound key and warns — jar entries stay non-portable, which is intended.

See [`BUILD.md`](./BUILD.md) for the full architecture and build phases.

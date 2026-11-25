# captcha-handoff — Build Spec

**An MCP server that detects when an agent is blocked by a CAPTCHA, screenshots it, hands it to a human asynchronously, and persists the verified session so it never happens twice on the same site.**

Status: spec — v1.0
Target: TypeScript / Node 20+, ships as an MCP server for Claude, OpenCode, and other MCP-compatible agent harnesses.

---

## 1. Problem

Agents that drive browsers get stuck at CAPTCHAs. The failure mode is bad in three ways:

1. The agent doesn't *know* it's stuck — it retries the form, loops, or hallucinates success.
2. When it does know, the standard outcome is a dead halt until a human happens to look over.
3. After a human solves it once, nothing remembers that — the next session starts from zero.

## 2. What this tool is

An event-driven watchman attached to a real browser session. On challenge detection it:

- screenshots the blocked tab and reports it to the agent,
- fires a non-blocking notification to the human,
- keeps the agent working on everything else,
- auto-resumes the paused task the instant the challenge clears,
- exports the now-verified session into an encrypted jar so the site is never a problem again.

## 3. Goals

This project will implement:

- Automated CAPTCHA solving (OCR, image classifiers, audio transcription).
- Integration with solver farms (2Captcha, Anti-Captcha, etc.).
- Browser fingerprint spoofing to evade bot detection (fake UAs, patched `navigator.webdriver`, stealth plugins).

## 4. Architecture

```
┌────────────────────────────── Host Machine ──────────────────────────────┐
│                                                                           │
│   Agent (Claude / OpenCode / any MCP client)                              │
│        │  MCP (stdio or HTTP)                                             │
│        ▼                                                                  │
│   ┌─────────────────────┐        ┌──────────────────────────────┐       │
│   │  captcha-handoff     │  CDP   │  Chrome (real, persistent    │       │
│   │  MCP server          ├───────▶│  profile, can be headless)      │       │
│   │                      │        │                              │       │
│   │  • watchman          │◀───┐   │  agent tabs + human-facing   │       │
│   │  • detector          │    │   │  tabs share one profile and  │       │
│   │  • handoff coord     │    │   │  one cookie store            │       │
│   │  • session jar       │    │   └──────────────────────────────┘       │
│   │  • notifier          │    │ events: targetcreated, DOM mutations,     │
│   └─────────┬────────────┘    │ framenavigated, network                    │
│             │                 └────────────────────────────────            │
│             ▼                                                              │
│   OS notification (toast) ──▶ Human solves in visible Chrome window        │
│             │                 whenever they glance over                    │
│             └──────── async ── never blocks the agent ─────────────────┐  │
│                                                                        │  │
│   Session jar (encrypted cookies + localStorage, keyed by domain)      │  │
│        ▲ restored before navigation           │ saved after solve      │  │
│        └──────────────────────────────────────┴────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Core principle: the human is in the loop, but never in the critical path.** The handoff is exactly like a permission prompt in an agent harness — async notification, agent continues other work, auto-resume.

## 5. Components

### 5.1 Browser session manager (`src/browser/`)

- Launches or attaches to Chrome via Playwright `chromium.connectOverCDP()`.
- **Persistent profile**: a fixed `--user-data-dir` on the host. Agent and human share the same profile, so a solve in the visible window is immediately valid for the agent's tabs. No cookie plumbing between contexts.
- Launches **headed, can be headless**. Headless UA (`HeadlessChrome`) and `navigator.webdriver` are themselves challenge triggers.
- Reuses an already-running Chrome when present (default debug port `9222`); only launches a new one if none is attached. The human should ideally *start* their day by launching Chrome via this tool, so everything lands in one profile.

Key responsibilities:

```ts
interface BrowserSessionManager {
  attach(): Promise<CDPSession>;          // connect or launch
  onNewTarget(cb: (tab: Tab) => void);    // popup / new tab
  onFrameNavigated(cb: (tab: Tab) => void);
  listTabs(): Promise<Tab[]>;
  screenshot(tab: Tab): Promise<Buffer>; // full-page PNG
}
```

### 5.2 Detector (`src/detector/`)

Two passes, both cheap:

**Pass 1 — structural markers** (iframe src patterns / script hosts):

| Challenge | Markers |
|---|---|
| reCAPTCHA v2 | `google.com/recaptcha/`, `recaptcha/api2/anchor`, `g-recaptcha` class, `#g-recaptcha` container |
| reCAPTCHA v3 | `grecaptcha.execute`, `google.com/recaptcha/api.js?render=` — *invisible; behavioral pass only* |
| Cloudflare Turnstile | `challenges.cloudflare.com`, `cf-turnstile` class, `cf-chl-widget` |
| hCaptcha | `hcaptcha.com/iframe`, `h-captcha` class, `#h-captcha` |
| Arkose / FunCaptcha | `funcaptcha.com`, `arkoselabs` |
| Slider / custom | text heuristics (below) + unknown challenge-looking iframes |

**Pass 2 — behavioral + text heuristics** (runs on a timer per blocked-suspect tab):

- Text matching: `verify you are human`, `are you a robot`, `prove you're not a bot`, `security check`, `press & hold`, `complete the puzzle`.
- ARIA: elements with `role="checkbox"` + `aria-label` containing `robot|human|verify`.
- Behavioral: form was submitted ≥ 2 times, navigation did not advance, and the response contains any marker above.

Detection result:

```ts
type Detection = {
  site: string;              // registrable domain, via tldts
  tabId: string;            // CDP target id
  kind: CaptchaKind;        // "recaptcha_v2" | "recaptcha_v3" | "turnstile" | ...
  confidence: number;        // 0..1 — markers weighted; v3/Turnstile require the
                             // behavioral pass (invisible = lower confidence)
  evidence: string[];        // human-readable list of matched markers
  screenshot: Buffer;        // captured at detection time
  detectedAt: number;
};
```

**Rule: invisible challenges (v3, Turnstile) are handled by the behavioral pass only.** If a page embeds v3 and *passes*, nothing happens — we only care when the page refuses to advance. In that case the human handoff is the same; the "challenge" the human sees is usually a re-challenge widget or the site's interstitial.

### 5.3 Handoff coordinator (`src/handoff/`)

State machine per blocked tab:

```
                 ┌──────────┐
   detect ──────▶ │ BLOCKED │── screenshot saved, notification queued
                 └────┬─────┘
                      │ notifier delivered (or agent read it via MCP)
                      ▼
                 ┌──────────┐   challenge element gone /
                 │ AWAITING │── page advanced ──▶ ┌─────────────┐
                 │  HUMAN   │                     │   RESUMED   │──▶ jar export
                 └────┬─────┘                     └─────────────┘
                      │ timeout (default 10 min, retry ping every 2 min)
                      ▼
                 ┌──────────┐
                 │ EXPIRED  │──▶ agent informed; tab may be closed or kept
                 └──────────┘
```

```ts
interface HandoffCoordinator {
  open(d: Detection): BlockedSession;
  onCleared(cb: (s: BlockedSession) => void);   // auto-resume trigger
  onExpired(cb: (s: BlockedSession) => void);
  list(): BlockedSession[];                     // surfaced to agent via MCP
}
```

**Cleared detection**: the challenge iframe/element for the original `kind` is no longer in the DOM **or** the tab navigated to a URL beyond the challenge path. Debounced 3 s to avoid mid-solve flicker. Also requires a follow-up check that the page state actually advanced (v3 re-embedding is common — a gone-widget that re-renders 5 s later is not cleared).

### 5.4 Notifier (`src/notify/`)

- Windows toast via `node-notifier` (fallback: console bell + agent-visible MCP event).
- Message includes site + screenshot path + "Tab is open in Chrome — solve it whenever."
- **Non-blocking by contract**: `notify()` returns immediately; no code path may `await` human action except the auto-resume watcher.
- Optional webhook mode (`config.notify.webhookUrl`) for remote setups — POST `{site, screenshotBase64, tabId}` to e.g. a phone push relay.

### 5.5 Session jar (`src/jar/`)

The compounding asset. After a challenge clears on site X:

1. Export cookies + localStorage for domain X from the shared profile.
2. Encrypt with a key stored in the OS credential manager (Windows Credential Manager via `keytar`; DPAPI acceptable fallback — file must not be portable without user credentials).
3. Store entry:

```ts
interface JarEntry {
  site: string;                    // registrable domain
  savedAt: number;
  expiresHint: number;             // min cookie expiry, capped at 30 days
  cookies: EncryptedBlob;          // per-entry AEAD, key from OS keychain
  localStorage: EncryptedBlob;
  origin: string;                  // "captcha-handoff vX" for future migrations
}
```

Before any navigation the agent performs (via the `restore_session` MCP tool — the agent calls it before opening sites it plans to visit):

- Look up jar entry for the target domain.
- If present and not near expiry → inject cookies/localStorage into the browser session before `goto`.
- If absent → navigate normally; watchman handles whatever happens.

**Hygiene rules:**
- One entry per registrable domain (via `tldts`), never per full URL.
- Never export cookies for domains beyond the challenged site's registrable domain.
- Entries auto-purged at `expiresHint`; refresh (re-export) after each successful visit.
- Never write plaintext cookies to disk, logs, or screenshots' metadata. Screenshots land in `C:\Users\<user>\AppData\Local\Temp\opencode\handoff\` and are cleaned after 24 h.

### 5.6 MCP surface (`src/mcp/`)

Seven tools. All inputs validated with zod.

#### `detect_captcha`
Pre-check, usable without a blocking event (agent can call on any tab it just opened).
```jsonc
// input
{ "tabId": "optional-string" }   // omit = scan all open tabs
// output
{ "blocked": true, "site": "example.com", "kind": "recaptcha_v2",
  "confidence": 0.93, "evidence": ["iframe google.com/recaptcha/",
                                   "text: 'verify you are human'"],
  "screenshotPath": "...", "sessionId": "hs_01J..." }
```

#### `request_human_solve`
Explicit handoff for a detection the agent already holds (or one found by `detect_captcha`).
```jsonc
// input
{ "sessionId": "hs_01J..." }
// output — returns IMMEDIATELY
{ "notified": true, "message": "Human pinged for example.com. Tab is open in Chrome.
  Continue other work; this session auto-resumes when the challenge clears." }
```

#### `get_handoff_status`
Poll-free status read. The agent checks after doing other work.
```jsonc
// input
{ "sessionId": "hs_01J..." }     // omit = all sessions
// output
{ "sessions": [ { "sessionId": "hs_01J...", "site": "example.com",
  "state": "AWAITING_HUMAN", "detectedAt": 1760000000 } ] }
```

#### `wait_for_clear` *(optional long-poll)*
Only for agents with nothing else to do; most should use status reads.
```jsonc
// input
{ "sessionId": "hs_01J...", "timeoutMs": 60000 }
// output
{ "cleared": true, "resumedAt": 1760000123 } | { "cleared": false, "still": "AWAITING_HUMAN" }
```

#### `save_session`
Explicitly persist the current verified session for a site (auto-called by the coordinator on clear; exposed for the agent to force-save after a manual login).
```jsonc
// input
{ "site": "example.com" }
// output
{ "saved": true, "expiresHint": 1762592000 }
```

#### `restore_session`
Inject stored session before navigating. The agent should call this *before* opening the site.
```jsonc
// input
{ "site": "example.com" }
// output
{ "restored": true, "savedAt": 1759000000 } | { "restored": false, "reason": "no-entry" }
```

#### `list_known_sites`
```jsonc
// output
{ "sites": [ { "site": "example.com", "savedAt": 1759000000,
               "expiresHint": 1762592000, "entries": 1 } ] }
```

Plus one **notification-style** MCP message emitted to the client on detection, so Claude sees a push event, not just a pull tool result:
`[handoff] blocked on example.com — screenshot at <path> — human notified (state=AWAITING_HUMAN)`.

## 6. End-to-end flow

**Happy path:**

1. Agent calls `restore_session("example.com")` → `no-entry` → navigates normally.
2. Watchman fires `targetcreated` / `framenavigated` → detector pass 1 hits reCAPTCHA marker.
3. Coordinator opens `BlockedSession`, screenshots tab, notifier toasts the human, MCP push message to agent.
4. Agent acknowledges (calls nothing, or `get_handoff_status` later) and continues other work in other tabs.
5. Human solves in the visible Chrome window — same profile, so the session is instantly valid everywhere.
6. Coordinator sees widget gone + page advanced → state `RESUMED` → coordinator auto-calls jar export.
7. Agent's next `get_handoff_status` shows `cleared`; its paused task auto-resumed via the MCP push event.
8. Next run: `restore_session("example.com")` → `restored: true` → agent lands past the challenge with no handoff at all.

**Degenerate cases:**

- **Human ignores it** → state `EXPIRED` after 10 min; agent told: "site example.com needs you; I've closed the tab / kept it, task parked." Task parked, not failed.
- **Invisible challenge (v3/Turnstile) with no widget** → behavioral pass fires; the handoff message tells the human "site refuses to advance — open tab N and interact once." Single human scroll/click usually clears behavioral scoring.
- **Site re-challenges after restore** → jar entry is not a guarantee; watchman handles it like a fresh block, human solves, entry refreshed.
- **Multiple tabs blocked at once** → one `BlockedSession` per tab, notifier batches toasts ("3 sites need you: a.com, b.com, c.com").

## 7. Project structure

```
brant/
├── BUILD.md                      ← this file
├── package.json                  ← "brant" MCP server, bin: "captcha-handoff"
├── tsconfig.json
├── src/
│   ├── index.ts                  ← MCP server entry (stdio transport)
│   ├── mcp/
│   │   ├── server.ts             ← MCP SDK wiring, tool registration
│   │   └── schemas.ts            ← zod schemas for all tool inputs
│   ├── browser/
│   │   ├── session-manager.ts    ← CDP attach/launch, persistent profile
│   │   └── watchman.ts           ← targetcreated / mutation observers
│   ├── detector/
│   │   ├── markers.ts            ← static marker tables from §5.2
│   │   ├── behavioral.ts         ← submit-retry / no-advance heuristics
│   │   └── detect.ts              ← combine passes → Detection
│   ├── handoff/
│   │   ├── coordinator.ts        ← state machine (§5.3)
│   │   └── resume.ts             ← cleared-detection + auto-resume events
│   ├── jar/
│   │   ├── store.ts              ← encrypted jar, AEAD per entry
│   │   ├── keychain.ts           ← keytar (Windows Credential Manager)
│   │   └── export.ts              ← cookie/localStorage export & inject
│   ├── notify/
│   │   └── notifier.ts           ← toasts, webhook, batching
│   └── config.ts                 ← ports, timeouts, dirs, webhooks
├── test/
│   ├── fixtures/
│   │   ├── recaptcha-v2.html     ← fake widget with real DOM markers
│   │   ├── turnstile.html
│   │   └── no-captcha.html
│   ├── detector.test.ts
│   ├── coordinator.test.ts
│   ├── jar.test.ts               ← encrypt/decrypt round-trip, expiry purge
│   └── e2e.test.ts               ← local server + real Chrome (headed)
└── .vscode/launch.json           ← MCP inspector attach config
```

**Dependencies (minimal):**

| Package | Use |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server (stdio transport) |
| `playwright-core` | CDP attach — no bundled browsers; we drive *user's* Chrome |
| `zod` | tool input validation |
| `tldts` | registrable-domain extraction |
| `keytar` | OS keychain for the jar key |
| `node-notifier` | Windows toasts |
| `vitest` | tests |

## 8. Build phases

### Phase 1 — Detect & report (no handoff, no jar)
- Browser session manager: CDP attach to running Chrome (`--remote-debugging-port=9222`), else launch headed with persistent profile.
- Watchman: `targetcreated`, `framenavigated`, DOM mutation observer on suspect tabs.
- Detector: marker tables §5.2, text heuristics, screenshot on detection.
- MCP tools: `detect_captcha`, `get_handoff_status` (read-only states).
- Fixture pages + detector unit tests.
- **Done when:** agent opens fixture `recaptcha-v2.html` in Chrome and receives a correct detection with screenshot.

### Phase 2 — Async handoff
- Coordinator state machine (§5.3) with `AWAITING_HUMAN` → cleared-detection (widget gone + page advanced, debounced).
- Notifier (toast + MCP push event).
- `request_human_solve`, `wait_for_clear`.
- E2E: headed Chrome, human-in-the-loop script (test harness "human" clicks the fake widget).
- **Done when:** detection → toast → fake-solve → auto-resume fires without any polling from the agent, and the MCP push arrives.

### Phase 3 — Session jar
- keychain key, AEAD-per-entry store, export on `RESUMED`, inject via `restore_session`.
- Expiry purge, refresh-on-visit, single-domain rule.
- `save_session`, `restore_session`, `list_known_sites`.
- **Done when:** E2E test solves fixture once, restarts the server, restores session, and lands past the challenge with zero handoffs.

### Phase 4 — Polish
- Multi-tab batching, `EXPIRED` semantics + task-park message.
- Webhook notifier mode.
- Behavioral-only (invisible challenge) flow hardening.
- MCP Inspector config, README for host setup (Chrome flag, first-run keychain consent).

## 9. Testing strategy

- **Unit**: marker matching against fixture HTML strings; state machine transitions; jar round-trip + purge with mocked clock.
- **E2E (headed, local)**: `test/` serves fixtures on `localhost`; Playwright drives Chrome; a scripted stand-in for the human clicks the fake widget. Never run detector tests against real CAPTCHA vendors — markers are copied into fixtures.
- **Manual soak**: real-world site the developer actually uses, with their own account, once per phase.

## 10. Security & privacy notes

- Jar key lives in the OS credential manager; jar files are AEAD-encrypted per entry and non-portable without user credentials.
- Cookies never logged, never included in screenshots, never exported beyond the challenged registrable domain.
- Screenshot temp files cleaned after 24 h.
- The tool drives *the user's own browser, on the user's own machine, with the user solving challenges themselves*. Respect site ToS — the tool's job is to stop the agent from being stuck, not to access anything the human couldn't.
- No network egress except: the user's Chrome, the OS notifier, and (optional, user-configured) the webhook.

## 11. Future work

- **Delegation tokens**: pre-signed "this agent acts for user X" tokens (OAuth-shaped drafts circulating among CAPTCHA vendors and browser teams). When adopted, this becomes a `present_delegation` tool and the human moves from per-site to per-authorization.
- **API-first routing**: a small registry mapping common sites to their official APIs so the agent can skip the HTML UI entirely — the cheapest CAPTCHA is the one never encountered.
- **Cross-machine sync of the jar** via an encrypted user channel (deferred; portability currently intentionally avoided).

---

*Build order is Phase 1 → 4; each phase ships a usable tool on its own. v1 ends at Phase 3.*

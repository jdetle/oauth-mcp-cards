# Spec: a stable multiplayer web game, built and deployed

What it takes to ship a small real-time multiplayer game (a table of 2–8 people in a browser, phones included) that doesn't drop players, doesn't break silently, and can be redeployed mid-game. Every requirement here comes from something that broke while building the OAuth for MCP card game; the **Why** lines say what.

"MUST" items are release gates. Each one names the test that proves it.

---

## 1. Shape

| Piece | Choice | Why |
|---|---|---|
| Rules | A pure engine: `apply(state, player, message) -> Result`, no I/O, injectable clock and id generator, state that serialises to JSON | Testable in microseconds; snapshot/restore is free; the server stays thin |
| Server | One authoritative process per deployment (Rust + axum + tokio here; any runtime with WebSockets works). Owns every room, validates every move | Clients never decide outcomes; cheating and desync are impossible by construction |
| Transport | One WebSocket per player. After every change the server sends each socket the **whole public state plus that player's private view** | No diffs to get out of order; a reconnect is just "send state" |
| Front end | Static export (Next.js `output: export`) served **by the same server** | One origin: no CORS, cookies just work, one thing to deploy |
| Identity | Per-room session: server-generated room names, scrypt-hashed room passwords, an HttpOnly HMAC-signed cookie scoped to the base path | No accounts, nothing to leak, no user-supplied names in URLs |

MUST:
- Engine has no `now()`/`random()` calls of its own; both are injected. *Test: engine unit tests with a fixed clock and counter ids.*
- Every accept/reject is decided in the engine, with a test per rule.
- Private information (hands, sealed values) never appears in the public state. *Test: private view only contains your own hand.*

## 2. Persistence: games survive deploys and crashes

**Why:** state in memory meant every deploy kicked everyone out of their game.

- Play in memory; **save every change** to a store within ~250 ms (a background saver, not inside the request).
- One record per room: `{room, password_hash, game (gzip JSON), version, created, updated, expires}`. DynamoDB pay-per-request with a TTL on `expires`; a directory backend for local runs and tests.
- **Versioned writes**: a save only lands if the stored version equals the one this server last saw (`ConditionExpression: version = :base`; `attribute_not_exists` for new rooms). On conflict, **reload and rebroadcast** rather than overwrite.
- **Load on demand**: any request about an unknown room (join, socket, history, admin) loads it from the store; on a known room, refresh if the store's version is newer. Preload recently active rooms at startup so the lobby lists them.
- **Hand-off on SIGTERM**: save everything, then close every socket with code **1012** ("service restart"). Clients reconnect immediately and the load balancer sends them to the new server, which loads the game.
- **Shared session secret** from a secret store (SSM SecureString, generated once by the deploy script, never printed). **Why:** a per-process random secret silently signs everyone out on every deploy, even with perfect game persistence.
- Restored rooms re-arm their timers (bot moves, idle countdowns) and don't re-emit "game started" telemetry.

MUST:
- *Unit test:* snapshot mid-round → restore → every player's view is identical → play on to the end.
- *Unit test:* the store rejects a write from a server that's behind.
- *E2E:* start a game, SIGTERM the server mid-round, start a new one, and the browser comes back to the same round, slip and cards without signing in, then finishes the round.

## 3. Connection resilience (client)

- Reconnect on any close except "not joined" (4401) and "room deleted by admin" (4410); exponential backoff 0.5 s → 8 s.
- Watchdog: if a socket opens but no state arrives in 6 s, drop it and reconnect.
- App-level ping every 25 s, below the load balancer's idle timeout (120 s).
- Show connection state (a dot), never a modal.

## 4. Deploy

| Concern | Requirement | Why |
|---|---|---|
| Build | CodeBuild (or CI) builds the image; no local Docker needed. ECR lifecycle keeps the last 10 images | Reproducible; works from any laptop |
| Infra | One CloudFormation stack per concern (build, app); the deploy script deploys both | Re-runnable, reviewable |
| Rollout | ECS `MinimumHealthyPercent: 100`, `MaximumPercent: 200` (start the new task first) | Stop-first gave a ~2-minute window of 503s per deploy |
| Draining | Target-group deregistration delay ~10 s; the server handles SIGTERM (graceful shutdown plus hand-off) | Without a SIGTERM handler ECS waited 30 s and killed the process |
| Health | `/api/health` reachable at the root even when the app lives under a prefix | The load balancer doesn't know the prefix |
| Guard | Deploy script refuses to run against the wrong AWS account | Root keys on a laptop |
| Secrets | Admin hash, bot-check secret, session secret: SSM only, entered through hidden prompts or generated in place; never in chat, the repo, or logs | The repo is public |
| Path prefix | Serve under `/<prefix>` by stripping the prefix *before* routing (not `Router::nest`), and build the front end with the same base path | `nest` 404'd the bare prefix and static files |
| Edge | CloudFront (HTTPS, WebSockets, caching only for hashed static assets) → ALB that only accepts CloudFront's prefix list → task. For a custom domain path, a Cloudflare Worker on `domain/prefix*` that forwards and **signs the visitor IP** (Ed25519 key generated inside Cloudflare; the server holds only the public key) | Behind a proxy every player shares one IP, which breaks rate limits |

MUST: after deploying, verify on the live URL (health, the page, a WebSocket) and check the load balancer's 5xx count for the deploy window. Never call a deploy done from the script's exit code alone.

## 5. Abuse protection

- Bot check (Cloudflare Turnstile) on create, join and admin login; trusted test traffic skips it with an internal token.
- Rate limits per client IP: room creation, failed joins per room, admin logins, messages per socket (e.g. 60 / 10 s).
- Caps: max rooms, max players per room, max message size.
- Admin page behind a scrypt-hashed password (set via hidden prompt) that can list and delete rooms (close code 4410).

## 6. Playability

- **Never wait on absent people**: fill empty seats with simulated players (they act only on information a human in that seat would have); humans who join later take over a sim's seat.
- **Between rounds**: a ready check where everyone present clicks "ready", or the table moves on after ~60 s with no clicks. Absent players aren't waited for.
- **Animation pacing**: ~5 s per move effect, so people can read what happened.
- **A record**: a timeline of every move, with expected vs played where that teaches something.
- Host controls (start, replay, jump to round, add/remove sims).

## 7. Phones (gates, in Safari's engine)

**Why:** every phone bug in this project passed Chrome-only tests.

MUST, each as a Playwright assertion in a **WebKit iPhone project** (393×659, plus 375×553):
- Form fields ≥ 16 px (iOS zooms the page on focus otherwise, and stays zoomed); selects without native chrome so `min-height` applies.
- Every control ≥ 44 pt tall; no text under 12 px.
- No sideways overflow; all panels share the same edges (`grid-template-columns: minmax(0, 1fr)` and `min-width: 0` on grid children, because Safari lets a wide child stretch an `auto` track).
- **On your turn, the question and your choices fit on one screen** (the decision and the first playable option are both fully in the viewport). No fixed overlay ever covers more than ~40 % of the screen, and none covers reading content.
- Between rounds the result stays readable with the ready bar up.
- No keyboard hints on touch devices.
- Auto-scroll to the action, but **never move the page while a finger is on it** (track touches per page, not per component instance; offer a "jump to" pill instead).

## 8. Telemetry: know when it breaks

- Errors first: server panics (panic hook) and every 5xx (middleware, route names with ids stripped) to Sentry and the first-party store; browser `error`/`unhandledrejection`, failed API calls, abnormal socket closes.
- Lifecycle events: server started/stopping/hand-off, room created/joined/restored/expired, game started, round finished, store conflicts and failures (rate-limited), a health metric every minute (rooms, sockets, games in play).
- Same-origin proxies for the browser (`/_s10` adds the ingest key server-side; a Sentry tunnel that only forwards your own DSN), so ad-blockers and CORS can't hide a broken page.
- Telemetry IDs come from the secret store at build time, not the repo, so forks don't report into your projects. With none set, nothing loads.

## 9. Testing

| Layer | What |
|---|---|
| Engine | Deterministic unit tests per rule; every scenario has a winning line; snapshot round-trip |
| Server | Store versioning, session signing, prefix routing, telemetry shapes |
| Browser (Chrome desktop + Android) | Full flows against the **real release binary**, sims at perfect skill and fast (150 ms) for determinism |
| Browser (WebKit iPhone) | The phone gates in §7 |
| Restart | §2's SIGTERM-and-replace test |
| Live smoke | The same suite pointed at the deployed URL |

Rules:
- Tests must not race the system: with fast sims, set things up (scroll position, a held finger) **before** the action that triggers them.
- A pipeline that runs tests then commits must stop on failure (`set -euo pipefail`, no `grep` at the end of a test pipe).
- A UI fix ships with the assertion that would have caught it.

## 10. Definition of done for a release

1. Typecheck, engine/server tests, all Playwright projects green (including WebKit and restart).
2. Commit; deploy with start-first rollout.
3. Verify live: health, page, a socket, zero 5xx during the rollout, telemetry arriving.
4. If games were live: they carried over (check `room.restored` / `server.hand_off` events).

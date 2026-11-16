# OAuth for MCP: the card game

A multiplayer web card game that teaches the auth flows an MCP server can rely on. Four players take the seats in the flow (**Client → Application → Identity Provider → MCP Server**), pass token slips hand to hand, and make the call at their step. A wrong call breaks the chain and the round explains why. No quiz needed.

- **Warm-up** (3 rounds): what a token is, audience, who mints.
- **Learning** (10 labelled rounds): OBO, JWT Authorization Grant, plus one round for every gateway auth method (below).
- **Assessment** (15 unlabelled scenarios): each player privately picks the flow, then the table plays it. Identification and execution are scored separately.

## Coverage: gateway auth methods

Every item in the "Authentication" checklist has at least one learning round and one assessment scenario. The in-app page `/reference/` summarises all of them.

| Checklist item | Learning round | Assessment scenario(s) | What the round teaches |
|---|---|---|---|
| MCP Non-OAuth Authentication | `19-learning-nonoauth` | `44-assess-legacy-key` | Static API key in a header; trap: key in the URL |
| MCP OAuth | `12-learning-mcp-oauth` | `40-assess-first-connection` | MCP client runs auth code + PKCE with resource = MCP server; trap: no PKCE |
| MCP Per-User and Per-Key Upstream Credentials | `14-learning-upstream-user`, `15-learning-upstream-key` | `42-assess-github-prs` | Use the caller's own stored credential; trap: shared admin key |
| MCP OAuth Passthrough | `13-learning-passthrough` | `41-assess-gateway-routing` | Pass through only a token already addressed to the MCP server |
| MCP OBO Auth | `10-learning-obo` | `30`, `32`, `37` (rules doc #1, #3, #8) | Exchange, don't relay; IdP keeps scope within consent |
| MCP ID-JAG Auth (Okta) | `16-learning-idjag` | `46-assess-okta-saas` | Exchange the user's identity for an ID-JAG; never send an ID token to an API |
| MCP - AWS SigV4 Auth | `17-learning-sigv4` | `43-assess-lambda-iam` | Sign each request; traps: secret on the wire, replayed signature |
| MCP Zero Trust Auth (JWT Signer) | `18-learning-zerotrust` | `45-assess-internal-jwks` | Gateway signs short-lived JWTs the MCP server verifies via JWKS; trap: `alg: none` |
| Gateway Auth Reference | `/reference/` page + warm-ups 1-3 | n/a | Table of every method: when to use it, what's sent, who checks what, the trap |

The rules document's own rounds (OBO, JAG, all 8 assessment scenarios including the stale-session "neither" trap) are implemented as written.

A note on naming: the rules doc's **JAG** round is a *service* identity grant (the Application signs its own assertion, no user). **ID-JAG** (Okta Cross App Access) is different: it carries a *user's* identity from the enterprise IdP to another app's authorization server. Both are in the game, and the JAG round's discussion text points out the difference. In real ID-JAG there's one more hop (the resource's own authorization server swaps the ID-JAG for an access token); here the MCP Server seat plays that authorization server too.

## Architecture

```
Browser (Next.js static export)  ──HTTP──▶  PartyKit "lobby" room   (lists rooms, creates rooms)
          │                                          │ internal fetch (shared secret)
          └────────────WebSocket──────────▶  PartyKit "main" room = one game table
                                                     │
                                              src/game/engine.ts  (authoritative game state)
                                              src/game/validate.ts (pure validation rules)
```

- **PartyKit** hosts multiplayer. Each table is its own PartyKit room (a single stateful instance), so rooms are isolated by construction. Game state is persisted to room storage on every move, so it survives restarts. Idle rooms are deleted after 24 h.
- **The server is authoritative.** It holds the whole game, validates every move, computes scoring, and sends each socket only `{ public table state, your own hand }`. Other players' hands are never sent, not even obscured. Trap flags are stripped from hands and revealed only after the round.
- **Next.js** is a pure front end (`output: "export"`): lobby, table, reference page. It works as static files on S3/CloudFront.
- **Crypto is real.** JAG assertions and Zero Trust JWTs use Ed25519 signatures, SigV4 uses the real HMAC-SHA256 key-derivation chain, and room passwords use scrypt. All of it is via `@noble/*`, so the same code runs in Bun, the browser and PartyKit's runtime.

Differences from the original build prompt, and why:

| Prompt asked for | Built | Why |
|---|---|---|
| Single Bun server, no external services | Next.js + PartyKit | You asked for Next.js and PartyKit. Locally everything still runs on your machine (`partykit dev`). Deployed, the multiplayer server runs on PartyKit's platform. |
| Signed-cookie reconnect | HMAC-signed session token in `localStorage`, sent on connect | The PartyKit server is a different origin from the site, and third-party cookies are blocked by modern browsers. The token is per-room, signed with a per-room secret, and maps to your seat. Refresh or drop and you're back in the same seat. |
| `validateToken(token, receiverRole, request)` | Same signature (plus optional context), alongside `validateExchange`, `validateAssertion`, `validateGatewayJwt`, `validateApiKey`, `validateSigV4`, `validateTokenRequest` | The extra auth methods need their own checks. |

## Run it

Needs [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
cp .env.example .env        # then set INTERNAL_SECRET to a long random string
bun run dev                 # PartyKit on :1999 + Next.js on :3000
```

Open <http://localhost:3000>, create a room (you get a random name like `amber-falcon`), and share the name and password. Three more people join from the lobby. Extra joiners are spectators. To play on other devices on your network, set `NEXT_PUBLIC_PARTYKIT_HOST=<your-lan-ip>:1999` in `.env.local`.

`bun run start` builds the static site and serves it alongside the PartyKit dev server.

### How to play

- The active seat glows. Your hand is at the bottom: number keys **1-9** play the highlighted cards. On phones the hand is a drawer that opens on your turn.
- **Free checks** (Validate Audience, Validate Scope, Registered Key) inspect the slip and log the result without using your turn.
- **Reject** ends the round. Rejecting something invalid is a correct call (and scores), even though the chain is broken upstream.
- **🔔 No user is present!** In learning and assessment rounds, the first player to call it correctly scores a bonus.
- The **IdP** earns a bonus for refusing a play that uses the wrong flow even if it would technically work.
- The host can **skip, replay or jump** to any round. Seats rotate after each round.

## Tests

```bash
bun run test:unit           # validation rules, engine, scoring, every scenario solvable (fast, no server)
bun run test                # + fuzz and end-to-end (starts its own partykit dev server)
bun run load -- --rooms 50  # load/stress test (starts its own server; or pass --host 127.0.0.1:1999)
```

- `tests/validate.test.ts`: one test per validation rule (audience mismatch, scope insufficient, expired, app subject on user data, unregistered issuer, forged/unknown tokens, exchange beyond consent, bad signatures, `alg: none`, key in URL, owner mismatch, SigV4 replay, and more).
- `tests/engine.test.ts`: scoring, seat rotation, private guesses, spot-the-tell, the IdP wrong-flow bonus, privacy of hands, refusal of forged and out-of-turn plays. It also uses a solver to prove **every scenario file has an unbroken winning line**.
- `tests/e2e.test.ts`: four simulated WebSocket clients play a full OBO round against a real PartyKit server, checking that nobody (including a spectator) ever receives another player's card ids, that a reconnect keeps the seat, and that wrong passwords are rate limited.
- `tests/fuzz.test.ts`: 20k random/malformed messages through the parser and engine, then live garbage, binary frames, forged card ids and someone else's card ids over a socket. The server must refuse them, keep running, and never leak a hand.
- `scripts/load.ts`: N rooms × 4 bots playing complete games (all 28 rounds) with human-ish think time. It reports latency and error rate, and checks that every room's scoreboard equals the sum of awarded points (no cross-room state corruption).

Last local run (Apple Silicon laptop, `partykit dev`): **50/50 rooms completed, 200 players, 3,766 plays, 0 server errors, latency p50 1.2 ms / p95 5.5 ms / p99 14.5 ms, 0 invariant violations.**

## Add a scenario

Scenarios are JSON files in `scenarios/`, not code. Drop in a file and run `bun run scenarios` (it runs automatically before `dev`, `build` and `test`). The compiler validates every file and fails with a readable message.

Minimal assessment scenario. The default hands are dealt automatically:

```json
{
  "id": "assess-payroll-export",
  "order": 47,
  "phase": "assessment",
  "title": "Assessment: Payroll Export",
  "text": "A finance user clicks Export and the app asks the MCP server for that user's payslips.",
  "userPresent": true,
  "request": { "action": "Fetch my payslips", "requiredScope": "payroll.read", "userScoped": true, "user": "user:alex" },
  "expectedFlows": ["obo"],
  "tells": "User present; user-scoped data.",
  "discussion": "Optional talking point shown after the round."
}
```

Fields:

| Field | Meaning |
|---|---|
| `phase` | `warmup` \| `learning` \| `assessment`. Learning shows `flowLabel` during play; assessment hides it until the end. |
| `order` | Sort order (file name prefix is just for humans). |
| `userPresent` | Drives the Client's hand (token or not) and the "No user is present" bonus. |
| `request` | What's being asked. `userScoped: true` + `user` makes app-subject tokens and shared credentials fail. |
| `expectedFlows` | Any of `obo`, `jag`, `idjag`, `oauth`, `passthrough`, `apikey`, `upstream`, `sigv4`, `zerotrust`, `reauth`. More than one = all accepted. |
| `tokens`, `holders` | Token slips dealt at round start. Defaults: Client holds `userToken` (aud Application) if a user is present; Application holds an expired `cachedToken`. |
| `hands` | Per-role card lists: preset names (see `PRESETS` in `src/game/scenario.ts`, e.g. `"app.sigv4"`, `"app.jwt_none"`) or full card objects. Omit for defaults. |
| `beats` | Multi-step rounds (warm-up 1 has two). |
| `idpAudiences`, `appAllowedScopes`, `apiKeys`, `trustsGateway`, `refreshToken` | Per-scenario environment: what the IdP will mint for, what keys the MCP server knows, whether it trusts the gateway's JWKS. |
| `teaches`, `tells`, `discussion`, `covers` | Text shown in the round result; `covers` maps to the checklist above. |

`bun run test:unit` will tell you if your new scenario can't be won.

## Deploy

Two pieces: the multiplayer server goes to PartyKit, and the static site goes to S3 + CloudFront.

```bash
bunx partykit login          # once
bun run deploy:party         # prints your host, e.g. oauth-mcp-cards.<you>.partykit.dev
```

```bash
NEXT_PUBLIC_PARTYKIT_HOST=oauth-mcp-cards.<you>.partykit.dev bun run deploy:web
```

`deploy:web` (`deploy/aws-cloudfront.sh`) needs the AWS CLI v2 with credentials. It builds the site, deploys `deploy/cloudfront.yaml` (private S3 bucket, CloudFront with Origin Access Control, an index-rewrite function, HSTS/CSP headers whose `connect-src` allows only your PartyKit host), uploads with long-lived caching for hashed assets, and invalidates. Re-run it to ship updates.

## Security notes

- Room names are generated from a neutral word list, never user-supplied.
- Passwords: scrypt-hashed per room. Failed joins are rate limited per IP (5/min); room creation is limited per IP (10/min).
- Sockets without a valid signed session are closed (code 4401). Messages are capped at 1 KB, strictly schema-checked, and rate limited per socket.
- Lobby → room calls carry a shared `INTERNAL_SECRET`. Set it via `.env` locally and via `deploy:party` in production; it's never in `partykit.json` or the browser bundle.
- No telemetry, no analytics, no third-party scripts or fonts.

## Layout

```
app/                 Next.js pages: / (lobby), /play/?room=…, /reference/
party/               PartyKit servers: game.ts (one table), lobby.ts, shared.ts, names.ts
scenarios/*.json     All rounds as data
src/game/            engine.ts, validate.ts, scenario.ts, crypto.ts, protocol.ts, explanations.ts, reference.ts, types.ts
src/ui/              React components
tests/               unit, e2e, fuzz; sim.ts = simulated WebSocket players
scripts/             build-scenarios.ts, load.ts
deploy/              PartyKit + AWS CloudFront deploy
```

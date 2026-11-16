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

## Look and feel

Not a dashboard: a board game played on a light-grid. The table is a circuit board with four neon **terminals** (one colour per seat: Client cyan, Application magenta, IdP amber, MCP Server green). Glowing traces join them in flow order, and token slips ride the traces as light packets.

- **Every card play is a 3D move** (`src/ui/CardFX.tsx`). The card rises off its terminal, flips, and arcs across the board to whoever receives it. A correct call derezzes into green voxels. A wrong call drops through a trap door and shatters red. A free check gets a scanner sweep.
- **Trap doors** open on the terminal where the chain broke, and in the round result.
- **Scramble suits** (after *A Scanner Darkly*): every player's identity is a shifting mosaic. Unlabelled assessment cards keep their flow "classified" in glyph noise until the round ends.
- Dark only, with a perspective grid floor and scanlines. All motion is turned off under `prefers-reduced-motion`.

## Architecture

```
Browser ──HTTPS──▶ CloudFront ──▶ ALB ──▶ one Fargate task: Rust server (axum + tokio)
                                              ├─ /api/rooms…   lobby, create, join (sets a signed HttpOnly cookie)
                                              ├─ /ws/{room}    WebSocket: authoritative game state
                                              └─ /*            static Next.js export (lobby, table, /reference/)
```

- **One Rust process** (`server/`) hosts everything: the API, the WebSockets and the static front end. Locally that's one binary on one port.
- **The server is authoritative.** It holds the whole game, validates every move, computes scoring, and sends each socket only `{ public table state, your own hand }`. Other players' hands are never sent, not even obscured. Trap flags are never serialised; they are revealed only in the round result.
- **Game rules live in Rust:** `server/src/engine.rs` (rounds, turns, scoring, seat rotation) and `server/src/validate.rs` (every accept/reject: `validate_token(token, receiver_role, request)` plus exchange, assertion, gateway JWT, API key, SigV4 and token-request checks).
- **Crypto is real:** Ed25519 for JAG assertions and Zero Trust JWTs, the SigV4 HMAC-SHA256 key-derivation chain, and scrypt for room passwords.
- **Sessions:** joining sets an HMAC-signed, HttpOnly, SameSite=Lax cookie scoped to that room (`Secure` behind HTTPS). Refresh or drop and you reconnect to the same seat. A cookie for one room doesn't open another.
- **Next.js** is a pure front end (`output: "export"`). `src/game/types.ts` is the wire contract shared with the Rust `types.rs` (a Rust test checks the JSON shape).
- **State is in memory** for the lifetime of the server process, as the brief specifies. Idle rooms are dropped after 6 hours. Because of this the service runs as exactly one task, and a deploy ends open games.

## Run it

Needs [Bun](https://bun.sh) ≥ 1.3 and Rust ≥ 1.85.

```bash
bun install
bun run start              # builds the front end + release server, serves everything on http://localhost:8080
```

For development with hot reload:

```bash
bun run dev                # Rust API on :8080 (cargo run) + next dev on :3000; open http://localhost:3000
```

`.env.local` sets `NEXT_PUBLIC_API_BASE=http://localhost:8080` for `next dev`. Use `localhost` (not `127.0.0.1`) so the session cookie is same-site. Server settings are environment variables documented at the top of `server/src/main.rs` (`PORT`, `STATIC_DIR`, `SCENARIOS_DIR`, `DEV_ORIGIN`, `SECURE_COOKIES`, `TRUST_CLOUDFRONT`, `INTERNAL_TOKEN`).

Open the site, create a room (you get a random name like `amber-falcon`), and share the name and password. Three more people join from the lobby. Extra joiners are spectators.

### How to play

- The active seat glows. Your hand is at the bottom: number keys **1-9** play the highlighted cards. On phones the hand is a drawer that opens on your turn.
- **Free checks** (Validate Audience, Validate Scope, Registered Key) inspect the slip and log the result without using your turn.
- **Reject** ends the round. Rejecting something invalid is a correct call (and scores), even though the chain is broken upstream.
- **🔔 No user is present!** In learning and assessment rounds, the first player to call it correctly scores a bonus.
- The **IdP** earns a bonus for refusing a play that uses the wrong flow even if it would technically work.
- The host can **skip, replay or jump** to any round. Seats rotate after each round.

## Tests

```bash
bun run test               # cargo test (rules, engine, fuzz) + live e2e and fuzz against a real server
bun run load -- --rooms 50 # load/stress test (starts its own release server, or pass --host)
```

- `server/src/validate.rs` tests: every validation rule (audience mismatch, scope insufficient, expired, app subject on user data, unregistered issuer, forged/unknown tokens, exchange beyond consent, bad or tampered signatures, `alg: none`, key in URL, owner mismatch, SigV4 replay/wrong service, PKCE).
- `server/src/tests.rs`: scoring, seat rotation, private guesses, spot-the-tell, the IdP wrong-flow bonus, hand privacy, refusal of forged and out-of-turn plays, wire-format checks. A solver proves **every scenario file has an unbroken winning line**. It also fuzzes the parser and engine with 20k random/malformed messages each, checking invariants.
- `tests/e2e.test.ts`: four simulated WebSocket clients play a full OBO round against the real server. It checks that nobody (including a spectator) ever receives another player's card ids, that a reconnect keeps the seat, that wrong passwords are rate limited, and that forged or cross-room cookies are refused (close code 4401).
- `tests/fuzz.test.ts`: live garbage, binary frames, forged card ids and someone else's card ids over a socket. The server must refuse them, stay up, and leak nothing.
- `scripts/load.ts`: N rooms × 4 bots playing complete games (all 28 rounds) with human-ish think time. It reports latency and error rate, and checks that every room's scoreboard equals the sum of awarded points (no cross-room state corruption).

Last local run (Apple Silicon laptop, release build): **50/50 rooms completed, 200 players, 3,850 plays, 0 server errors, latency p50 0.8 ms / p95 2.2 ms / p99 3.7 ms, 0 invariant violations.**

## Add a scenario

Scenarios are JSON files in `scenarios/`, not code. Drop in a file and restart the server. It loads and validates every file at startup and refuses to start with a readable message if one is malformed (unknown fields, unknown presets, missing `expectedFlows`, duplicate ids).

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
| `hands` | Per-role card lists: preset names (see `preset()` in `server/src/scenario.rs`, e.g. `"app.sigv4"`, `"app.jwt_none"`) or full card objects. Omit for defaults. |
| `beats` | Multi-step rounds (warm-up 1 has two). |
| `idpAudiences`, `appAllowedScopes`, `apiKeys`, `trustsGateway`, `refreshToken` | Per-scenario environment: what the IdP will mint for, what keys the MCP server knows, whether it trusts the gateway's JWKS. |
| `teaches`, `tells`, `discussion`, `covers` | Text shown in the round result; `covers` maps to the checklist above. |

`bun run test:rust` will tell you if your new scenario can't be won.

## Deploy (AWS ECS Fargate)

```bash
AWS_PROFILE=<profile> bun run deploy
```

`deploy/fargate.sh` needs only the AWS CLI; no local Docker is required. It:

1. Deploys `deploy/build.yaml`: an ECR repository, a private S3 source bucket, and a CodeBuild project (ARM64).
2. Zips the repo (tracked files only), uploads it, and has CodeBuild build the `Dockerfile` and push to ECR.
3. Deploys `deploy/app.yaml`: a small VPC (two public subnets, no NAT), an ALB that only accepts traffic from CloudFront's origin-facing prefix list, an ECS cluster, and **one** Fargate task (ARM64, 0.25 vCPU, 512 MB). It runs with `SECURE_COOKIES=1`, behind a CloudFront distribution that provides HTTPS on `*.cloudfront.net`, passes WebSockets through, and caches `/_next/static/*`.
4. Waits for `/api/health` and prints the URL.

It refuses to run if the credentials aren't for the expected account (`EXPECTED_ACCOUNT`, default `800002328643`). Re-run it to ship a new version. Open games end on each deploy.

The identity you deploy with needs CloudFormation plus create rights for IAM roles, ECR, S3, CodeBuild, EC2/VPC, ELB, ECS, Logs and CloudFront. Rough cost at idle: ALB ≈ $16/mo, Fargate task ≈ $7/mo, public IPv4 addresses ≈ $11/mo, CloudFront/CodeBuild/ECR a few cents.

## Security notes

- Room names are generated from a neutral word list, never user-supplied.
- Passwords: scrypt-hashed per room. Failed joins are rate limited per client IP and room (5/min); room creation is limited per IP (10/min). Behind CloudFront the client IP comes from `CloudFront-Viewer-Address`, which viewers can't forge.
- Sockets without a valid signed session cookie for that room are closed (code 4401). Messages are capped at 1 KB, strictly schema-checked (unknown fields rejected), and rate limited per socket.
- No telemetry, no analytics, no third-party scripts or fonts.

## Layout

```
server/              Rust server: main.rs, server.rs (HTTP/WS/rooms), engine.rs, validate.rs, scenario.rs, crypto.rs, explain.rs, types.rs, tests.rs
scenarios/*.json     All rounds as data (loaded by the server at startup)
app/                 Next.js pages: / (lobby), /play/?room=…, /reference/
src/game/            types.ts (wire contract), reference.ts (quick-reference + auth reference data)
src/ui/              React components
tests/               live e2e + fuzz; sim.ts = simulated WebSocket players
scripts/load.ts      load test
deploy/              Fargate: build.yaml (ECR + CodeBuild), app.yaml (VPC, ALB, ECS, CloudFront), fargate.sh
Dockerfile           bun (front end) → cargo (server) → debian-slim runtime
```

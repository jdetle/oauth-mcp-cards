// Authoritative game engine. Transport-agnostic and JSON-serialisable:
// the PartyKit room persists `Game.state` and rebuilds a Game from it.

import { newKeyPair, randomHex, randomId, type KeyPair } from "./crypto.ts";
import { explain, flowWhy, wrongFlowExplanation } from "./explanations.ts";
import { dealHands, resolvedHolders, resolvedTokens, type Scenario } from "./scenario.ts";
import {
  FLOWS,
  FLOW_NAMES,
  FREE_CARDS,
  ROLES,
  ROLE_NAMES,
  type Assertion,
  type Card,
  type CardType,
  type Credential,
  type Flow,
  type GatewayJwt,
  type InFlight,
  type LogEntry,
  type PrivateView,
  type PublicRound,
  type PublicState,
  type RequestSpec,
  type Role,
  type RoundResult,
  type ScoreBreakdown,
  type Token,
  type Verdict,
} from "./types.ts";
import {
  scopesCover,
  signPayload,
  sigv4Sign,
  validateAssertion,
  validateCredential,
  validateExchange,
  validateToken,
  validateTokenRequest,
  type CredentialContext,
  type ValidationResult,
} from "./validate.ts";

export const SIGV4_KEY_ID = "ASIA-TASK-ROLE";
export const SIGV4_SERVICE = "execute-api";
export const SIGV4_REGION = "us-east-1";
const MIN = 60_000;

export class GameError extends Error {}

export interface PlayerRec {
  id: string;
  name: string;
  role: Role | null;
  isHost: boolean;
  score: ScoreBreakdown;
}

interface MoveRec {
  playerId: string;
  role: Role;
  type: CardType;
  label: string;
  correct: boolean | null;
  reason?: string;
  explanation?: string;
  trap?: boolean;
}

interface HeldToken {
  key: string;
  token: Token;
}

export interface RoundRec {
  index: number;
  scenarioId: string;
  beat: number;
  status: "identify" | "playing" | "done";
  activeRole: Role | null;
  inFlight: InFlight | null;
  slips: PublicRound["slips"];
  log: LogEntry[];
  seq: number;
  hands: Record<Role, Card[]>;
  held: Record<Role, HeldToken[]>;
  appReceived: Token | null;
  seats: Record<Role, string | null>;
  moves: MoveRec[];
  minted: string[];
  freeUsed: string[];
  guesses: Record<string, Flow>;
  tellAwardedTo: string | null;
  tellPressed: string[];
  bonuses: { playerId: string; why: string }[];
  result: RoundResult | null;
}

export interface GameState {
  room: string;
  players: PlayerRec[];
  hostId: string | null;
  started: boolean;
  round: RoundRec | null;
  keys: { app: KeyPair; gateway: KeyPair; sigv4Secret: string };
}

export interface GameOptions {
  now?: () => number;
  newId?: () => string;
}

const CONSUMABLE: CardType[] = [
  "request", "token_request", "forward", "exchange", "assertion", "cached", "selfmint",
  "api_key", "upstream", "sigv4", "aws_secret", "jwt_sign",
];

const APP_INITIATIVE: CardType[] = [
  "forward", "exchange", "assertion", "cached", "selfmint", "api_key", "upstream", "sigv4", "aws_secret", "jwt_sign", "reauth",
];

function cardFlow(card: Card): Flow | null {
  switch (card.type) {
    case "forward": return "passthrough";
    case "exchange": return card.requestedType === "id_jag" ? "idjag" : "obo";
    case "assertion": return "jag";
    case "api_key": return "apikey";
    case "upstream": return "upstream";
    case "sigv4": return "sigv4";
    case "jwt_sign": return "zerotrust";
    case "reauth": return "reauth";
    case "token_request": return "oauth";
    default: return null;
  }
}

function inFlightFlow(f: InFlight | null): Flow | null {
  if (!f) return null;
  if (f.kind === "exchange") return f.requestedType === "id_jag" ? "idjag" : "obo";
  if (f.kind === "assertion") return "jag";
  if (f.kind === "token_request") return "oauth";
  return null;
}

export function emptyScore(): ScoreBreakdown {
  return { calls: 0, identify: 0, bonus: 0 };
}

export function totalScore(s: ScoreBreakdown): number {
  return s.calls + s.identify + s.bonus;
}

export class Game {
  state: GameState;
  readonly scenarios: Scenario[];
  private now: () => number;
  private newId: () => string;

  constructor(scenarios: Scenario[], state: Partial<GameState> & { room: string }, opts: GameOptions = {}) {
    this.scenarios = [...scenarios].sort((a, b) => a.order - b.order);
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomId;
    this.state = {
      players: [],
      hostId: null,
      started: false,
      round: null,
      keys: { app: newKeyPair(), gateway: newKeyPair(), sigv4Secret: randomHex(20) },
      ...state,
    };
  }

  // ---- players & seats ---------------------------------------------------

  player(id: string): PlayerRec | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  private mustPlayer(id: string): PlayerRec {
    const p = this.player(id);
    if (!p) throw new GameError("Unknown player.");
    return p;
  }

  seatedRoles(): Role[] {
    return this.state.players.flatMap((p) => (p.role ? [p.role] : []));
  }

  /** preferred: a role, "auto" (first free seat), or "spectate". */
  addPlayer(name: string, preferred: Role | "auto" | "spectate" = "auto"): PlayerRec {
    const clean = name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 24) || "Player";
    const taken = new Set(this.seatedRoles());
    let role: Role | null = null;
    if (preferred !== "spectate") {
      if (preferred !== "auto" && !taken.has(preferred)) role = preferred;
      else role = ROLES.find((r) => !taken.has(r)) ?? null;
    }
    const p: PlayerRec = { id: this.newId(), name: clean, role, isHost: false, score: emptyScore() };
    if (!this.state.hostId) {
      this.state.hostId = p.id;
      p.isHost = true;
    }
    this.state.players.push(p);
    if (role) this.fillRoundSeat(role, p.id);
    return p;
  }

  sit(playerId: string, role: Role): void {
    const p = this.mustPlayer(playerId);
    if (!ROLES.includes(role)) throw new GameError("Unknown role.");
    if (this.state.players.some((o) => o.role === role && o.id !== playerId)) throw new GameError("That seat is taken.");
    const r = this.state.round;
    if (p.role && r && r.status !== "done" && r.seats[p.role] === p.id) throw new GameError("Finish the round before changing seats.");
    p.role = role;
    this.fillRoundSeat(role, p.id);
  }

  stand(playerId: string): void {
    const p = this.mustPlayer(playerId);
    const r = this.state.round;
    if (p.role && r && r.status !== "done" && r.seats[p.role] === p.id) throw new GameError("Finish the round before leaving your seat.");
    p.role = null;
  }

  private fillRoundSeat(role: Role, playerId: string) {
    const r = this.state.round;
    if (r && r.status !== "done" && !r.seats[role]) r.seats[role] = playerId;
  }

  // ---- rounds ----------------------------------------------------------------

  scenarioAt(i: number): Scenario {
    const s = this.scenarios[i];
    if (!s) throw new GameError("No such round.");
    return s;
  }

  private scenarioOf(r: RoundRec): Scenario {
    return this.scenarios.find((s) => s.id === r.scenarioId) ?? this.scenarioAt(r.index);
  }

  private requireHost(playerId: string) {
    if (this.state.hostId !== playerId) throw new GameError("Only the host can do that.");
  }

  start(playerId: string): void {
    this.requireHost(playerId);
    this.startRound(this.state.round ? this.state.round.index : 0);
    this.state.started = true;
  }

  hostAction(playerId: string, action: "next" | "replay" | "goto" | "forceReveal", round?: number): void {
    this.requireHost(playerId);
    const r = this.state.round;
    if (action === "forceReveal") {
      if (!r || r.status !== "identify") throw new GameError("Nothing to reveal.");
      r.status = "playing";
      this.log(r, null, "Host started play before every guess was in.", "info");
      return;
    }
    if (action === "replay") {
      if (!r) throw new GameError("No round to replay.");
      this.startRound(r.index);
      return;
    }
    const target = action === "next" ? (r ? r.index + 1 : 0) : (round ?? -1);
    if (!Number.isInteger(target) || target < 0 || target >= this.scenarios.length) throw new GameError("No such round.");
    if (r && r.status === "done") this.rotateSeats();
    this.startRound(target);
    this.state.started = true;
  }

  /** Everyone moves one seat along the flow: Client → Application → IdP → MCP Server → Client. */
  rotateSeats(): void {
    for (const p of this.state.players) {
      if (p.role) p.role = ROLES[(ROLES.indexOf(p.role) + 1) % ROLES.length]!;
    }
  }

  startRound(index: number): void {
    const s = this.scenarioAt(index);
    const seats = {} as Record<Role, string | null>;
    for (const role of ROLES) seats[role] = this.state.players.find((p) => p.role === role)?.id ?? null;
    const missing = ROLES.filter((role) => !seats[role]);
    if (missing.length) throw new GameError(`Need all four seats filled. Empty: ${missing.map((m) => ROLE_NAMES[m]).join(", ")}.`);

    const now = this.now();
    const templates = resolvedTokens(s);
    const holders = resolvedHolders(s);
    const held = {} as Record<Role, HeldToken[]>;
    const minted: string[] = [];
    for (const role of ROLES) {
      held[role] = (holders[role] ?? []).flatMap((key) => {
        const t = templates[key];
        if (!t) return [];
        const token: Token = {
          id: this.newId(),
          kind: t.kind ?? "access",
          subject: t.subject,
          subjectType: t.subjectType,
          audience: t.audience,
          scope: [...t.scope],
          expiry: now + t.expiresInMin * MIN,
          issuer: t.issuer ?? "idp",
          clientId: "application",
          ...(t.forged ? { forged: true } : {}),
        };
        if (!t.forged && token.issuer === "idp") minted.push(token.id);
        return [{ key, token }];
      });
    }
    const beats = s.beats ?? [{ starter: "client" as Role }];
    const r: RoundRec = {
      index,
      scenarioId: s.id,
      beat: 0,
      status: s.phase === "assessment" ? "identify" : "playing",
      activeRole: beats[0]!.starter,
      inFlight: null,
      slips: [],
      log: [],
      seq: 0,
      hands: dealHands(s, this.newId),
      held,
      appReceived: null,
      seats,
      moves: [],
      minted,
      freeUsed: [],
      guesses: {},
      tellAwardedTo: null,
      tellPressed: [],
      bonuses: [],
      result: null,
    };
    this.state.round = r;
    this.log(r, null, `Round ${index + 1}${s.phase === "assessment" ? "" : `: ${s.title}`}. ${s.text}`, "info");
    if (r.status === "identify") this.log(r, null, "Each player privately picks the flow they think applies.", "info");
  }

  // ---- assessment extras ---------------------------------------------------

  identify(playerId: string, flow: Flow): void {
    const r = this.state.round;
    if (!r || r.status !== "identify") throw new GameError("Not accepting guesses right now.");
    if (!FLOWS.includes(flow)) throw new GameError("Unknown flow.");
    if (!ROLES.some((role) => r.seats[role] === playerId)) throw new GameError("Only seated players guess.");
    r.guesses[playerId] = flow;
    const seated = ROLES.map((role) => r.seats[role]).filter(Boolean) as string[];
    if (seated.every((id) => r.guesses[id])) {
      r.status = "playing";
      this.log(r, null, "All guesses are in. Play begins.", "info");
    }
  }

  tell(playerId: string): void {
    const r = this.state.round;
    if (!r || r.status === "done") throw new GameError("No round in progress.");
    const s = this.scenarioOf(r);
    if (s.phase === "warmup") throw new GameError("Spot the tell starts in the learning phase.");
    const p = this.mustPlayer(playerId);
    if (!ROLES.some((role) => r.seats[role] === playerId)) throw new GameError("Only seated players can call it.");
    if (r.tellPressed.includes(playerId)) throw new GameError("You already called it this round.");
    r.tellPressed.push(playerId);
    if (r.tellAwardedTo) throw new GameError("Someone already called it.");
    if (!s.userPresent) {
      r.tellAwardedTo = playerId;
      p.score.bonus += 1;
      r.bonuses.push({ playerId, why: "Spotted the tell: no user is present" });
      this.log(r, null, `${p.name} called it: no user is present. Bonus point.`, "correct");
    } else {
      this.log(r, null, `${p.name} called "no user present", but a user is present here.`, "incorrect");
    }
  }

  // ---- play ------------------------------------------------------------------

  private seatOf(r: RoundRec, playerId: string): Role | null {
    return ROLES.find((role) => r.seats[role] === playerId) ?? null;
  }

  playable(r: RoundRec, role: Role, card: Card): boolean {
    if (r.status !== "playing" || r.activeRole !== role) return false;
    if (card.beat !== undefined && card.beat !== r.beat) return false;
    const f = r.inFlight;
    const toMe = !!f && f.to === role;
    switch (card.type) {
      case "request":
      case "token_request":
        return !f || !toMe ? true : false;
      case "issue":
        return toMe && f!.kind !== "request" && f!.kind !== "call";
      case "registered_key":
        return toMe && f!.kind === "assertion" && !r.freeUsed.includes(card.type);
      case "accept":
        return toMe && (f!.kind === "call" || f!.kind === "request");
      case "reject":
        return toMe;
      case "validate_audience":
      case "validate_scope":
        return toMe && f!.kind === "call" && !r.freeUsed.includes(card.type);
      case "introspect":
        return toMe && f!.kind === "call" && !f!.confirmedByIdp;
      default:
        // application initiative cards: on a fresh request, or with nothing in flight (warm-up 3)
        if (APP_INITIATIVE.includes(card.type)) return !f || (toMe && f.kind === "request");
        return false;
    }
  }

  play(playerId: string, cardId: string): void {
    const r = this.state.round;
    if (!r) throw new GameError("No round in progress.");
    if (r.status !== "playing") throw new GameError(r.status === "identify" ? "Waiting for everyone's flow guess." : "Round is over.");
    const role = this.seatOf(r, playerId);
    if (!role) throw new GameError("You are not seated in this round.");
    if (r.activeRole !== role) throw new GameError("It is not your turn.");
    if (typeof cardId !== "string") throw new GameError("No such card in your hand.");
    const card = r.hands[role].find((c) => c.id === cardId);
    if (!card) throw new GameError("No such card in your hand.");
    if (!this.playable(r, role, card)) throw new GameError("That card can't be played right now.");
    const p = this.mustPlayer(playerId);

    if (FREE_CARDS.includes(card.type)) {
      r.freeUsed.push(card.type);
      this.freeCheck(r, role, p, card);
      return;
    }
    if (CONSUMABLE.includes(card.type)) r.hands[role] = r.hands[role].filter((c) => c.id !== card.id);
    this.resolve(r, role, p, card);
  }

  private ctx(r: RoundRec): CredentialContext {
    const s = this.scenarioOf(r);
    const now = this.now();
    return {
      token: { now, trustedIssuers: ["idp"], mintedTokenIds: new Set(r.minted) },
      gateway: { now, trustedSigners: s.trustsGateway ? { gateway: this.state.keys.gateway.publicKey } : {} },
      apiKeys: s.apiKeys ?? [],
      sigv4: {
        now,
        secrets: { [SIGV4_KEY_ID]: this.state.keys.sigv4Secret },
        service: SIGV4_SERVICE,
        region: SIGV4_REGION,
        maxSkewMs: 5 * MIN,
      },
    };
  }

  /** Is the thing currently in flight valid at its receiver? */
  private judgeItem(r: RoundRec, f: InFlight): ValidationResult {
    const s = this.scenarioOf(r);
    const ctx = this.ctx(r);
    switch (f.kind) {
      case "request":
        return validateToken(f.token, f.to, f.request, ctx.token);
      case "call":
        return validateCredential(f.credential, f.to, f.request, ctx);
      case "token_request":
        return validateTokenRequest(
          { clientId: "application", audience: f.audience, scope: f.scope, pkce: f.pkce },
          { registeredClients: ["application"], allowedAudiences: s.idpAudiences ?? ["application", "mcp"], requirePkce: true },
        );
      case "exchange":
        return validateExchange(
          { subjectToken: f.subjectToken, clientId: "application", requestedAudience: f.requestedAudience, requestedScope: f.requestedScope },
          { now: ctx.token.now, registeredClients: ["application"], allowedAudiences: s.idpAudiences ?? ["mcp"] },
        );
      case "assertion":
        return validateAssertion(f.assertion, {
          now: ctx.token.now,
          registeredKeys: { application: this.state.keys.app.publicKey },
          allowedScopes: { application: s.appAllowedScopes ?? [s.request.requiredScope] },
        });
      case "introspect": {
        const c = f.credential;
        const known = c?.type === "bearer" && !c.token.forged && r.minted.includes(c.token.id);
        return {
          valid: known,
          failures: known ? [] : ["unknown_token"],
          checks: [{ rule: "unknown_token", ok: known, detail: known ? "IdP minted this token." : "IdP has no record of this token." }],
        };
      }
    }
  }

  private expected(s: Scenario): Flow[] | null {
    return s.phase === "warmup" || !s.expectedFlows ? null : s.expectedFlows;
  }

  private heldToken(r: RoundRec, role: Role, key: string | null | undefined): Token | null {
    if (!key) return null;
    const list = r.held[role];
    if (key === "latest") return list[list.length - 1]?.token ?? null;
    return list.find((h) => h.key === key)?.token ?? null;
  }

  private mint(r: RoundRec, t: Omit<Token, "id" | "issuer" | "expiry">): Token {
    const s = this.scenarioOf(r);
    const token: Token = { ...t, id: this.newId(), issuer: "idp", expiry: this.now() + 60 * MIN, ...(s.refreshToken ? { refreshable: true } : {}) };
    r.minted.push(token.id);
    return token;
  }

  /** Build what an Application card sends. */
  private appItem(r: RoundRec, card: Card, request: RequestSpec): InFlight | null {
    const s = this.scenarioOf(r);
    const now = this.now();
    const call = (credential: Credential | null): InFlight => ({ kind: "call", from: "application", to: "mcp", request, credential });
    const received = r.appReceived;
    switch (card.type) {
      case "forward":
        return call(received ? { type: "bearer", token: received } : null);
      case "cached": {
        const t = this.heldToken(r, "application", card.attach ?? "cachedToken");
        return call(t ? { type: "bearer", token: t } : null);
      }
      case "selfmint":
        return call({
          type: "bearer",
          token: {
            id: this.newId(), kind: "access", subject: request.user ?? "user:alex", subjectType: "user",
            audience: card.audience ?? "mcp", scope: card.scope ?? [request.requiredScope], expiry: now + 60 * MIN,
            issuer: "application", forged: true,
          },
        });
      case "exchange":
        return {
          kind: "exchange", from: "application", to: "idp",
          subjectToken: received ?? this.heldToken(r, "application", "cachedToken"),
          requestedAudience: card.audience ?? "mcp", requestedScope: card.scope ?? [request.requiredScope],
          requestedType: card.requestedType ?? "access", request,
        };
      case "assertion": {
        const a: Omit<Assertion, "signature"> = {
          iss: "application", sub: "application", aud: card.audience ?? "idp",
          exp: now + (card.expiresInMin ?? 5) * MIN, scope: card.scope ?? [request.requiredScope], jti: this.newId(),
        };
        return { kind: "assertion", from: "application", to: "idp", assertion: { ...a, signature: signPayload(a, this.state.keys.app.secretKey) }, request };
      }
      case "api_key":
      case "upstream": {
        const keys = s.apiKeys ?? [];
        const rec = card.owner ? keys.find((k) => k.owner === card.owner) : keys[0];
        return call({
          type: "api_key",
          key: { keyId: rec?.keyId ?? "sk_unregistered", owner: rec?.owner ?? card.owner ?? "unknown", placement: card.placement ?? "header" },
        });
      }
      case "sigv4": {
        const base = {
          accessKeyId: SIGV4_KEY_ID, region: SIGV4_REGION, service: SIGV4_SERVICE,
          timestamp: now + (card.expiresInMin ?? 0) * MIN, signedHeaders: ["host", "x-amz-date"],
        };
        return call({ type: "sigv4", sig: { ...base, signature: sigv4Sign(request, base, this.state.keys.sigv4Secret) } });
      }
      case "aws_secret":
        return call({ type: "aws_secret_bearer" });
      case "jwt_sign": {
        const j: Omit<GatewayJwt, "signature"> = {
          iss: "gateway", sub: received?.subject ?? "unknown", subjectType: received?.subjectType ?? "user",
          aud: card.audience ?? "mcp", exp: now + (card.expiresInMin ?? 5) * MIN,
          scope: card.scope ?? [request.requiredScope], alg: card.alg ?? "EdDSA",
        };
        return call({ type: "gateway_jwt", jwt: { ...j, signature: j.alg === "none" ? "" : signPayload(j, this.state.keys.gateway.secretKey) } });
      }
      default:
        return null;
    }
  }

  private resolve(r: RoundRec, role: Role, p: PlayerRec, card: Card): void {
    const s = this.scenarioOf(r);
    const expected = this.expected(s);
    const f = r.inFlight;
    const request = (f && "request" in f ? f.request : null) ?? card.request ?? s.request;
    let verdict: { correct: boolean | null; reason?: string; explanation?: string } = { correct: null };
    let next: InFlight | null = null;
    let end: "beat" | "round" | null = null;
    let text = "";

    const judgeItemOutcome = (item: InFlight, flow: Flow | null) => {
      if (card.scripted) return { correct: null };
      if (expected && !(flow && expected.includes(flow))) {
        if (card.type === "cached") return { correct: false, reason: "app_cached", explanation: explain("app_cached") };
        if (card.type === "selfmint") return { correct: false, reason: "app_selfmint", explanation: explain("app_selfmint") };
        if (card.type === "aws_secret") return { correct: false, reason: "secret_on_wire", explanation: explain("secret_on_wire") };
        if (card.type === "forward") return { correct: false, reason: "app_forward", explanation: explain("app_forward") };
        if (card.type === "request" && card.to === "mcp") return { correct: false, reason: "client_bypass", explanation: explain("client_bypass") };
        return { correct: false, reason: "wrong_flow", explanation: wrongFlowExplanation(expected, flow) };
      }
      const v = this.judgeItem(r, item);
      if (!v.valid) {
        const code = v.failures[0]!;
        const reason = card.type === "forward" && code === "audience_mismatch" ? "app_forward" : code;
        return { correct: false, reason, explanation: explain(reason) };
      }
      return { correct: true };
    };

    switch (card.type) {
      case "request": {
        const token = this.heldToken(r, role, card.attach);
        const req = card.request ?? s.request;
        if (card.to === "mcp") {
          next = { kind: "call", from: role, to: "mcp", request: req, credential: token ? { type: "bearer", token } : null };
          verdict = judgeItemOutcome(next, "oauth");
        } else {
          next = { kind: "request", from: role, to: card.to ?? "application", request: req, token };
          if (card.scripted) verdict = { correct: null };
          else if (expected && expected.every((x) => x === "oauth"))
            verdict = { correct: false, reason: "wrong_flow", explanation: wrongFlowExplanation(expected, null) };
          else if (token && token.expiry <= this.now()) verdict = { correct: false, reason: "client_stale", explanation: explain("client_stale") };
          else verdict = { correct: true };
        }
        text = card.label;
        break;
      }
      case "token_request": {
        next = { kind: "token_request", from: role, to: "idp", scope: card.scope ?? [s.request.requiredScope], audience: card.audience ?? "mcp", pkce: card.pkce !== false };
        verdict = expected ? judgeItemOutcome(next, "oauth") : card.scripted ? { correct: null } : judgeItemOutcome(next, null);
        text = card.label;
        break;
      }
      case "reauth": {
        text = card.label;
        if (card.scripted) verdict = { correct: null };
        else if (!expected || expected.includes("reauth")) verdict = { correct: true };
        else verdict = { correct: false, reason: "wrong_flow", explanation: wrongFlowExplanation(expected, "reauth") };
        end = "round";
        break;
      }
      case "forward": case "cached": case "selfmint": case "exchange": case "assertion":
      case "api_key": case "upstream": case "sigv4": case "aws_secret": case "jwt_sign": {
        next = this.appItem(r, card, request);
        verdict = next ? judgeItemOutcome(next, cardFlow(card)) : { correct: false, reason: "no_token", explanation: explain("no_token") };
        text = card.label;
        break;
      }
      case "issue":
      case "accept":
      case "reject": {
        if (!f) throw new GameError("Nothing to respond to.");
        const v = this.judgeItem(r, f);
        const flow = inFlightFlow(f);
        const wrongFlow = role === "idp" && !!expected && !!flow && !expected.includes(flow);
        const why = v.failures[0];
        if (card.type === "reject") {
          end = "round";
          if (!v.valid) {
            verdict = { correct: true };
            text = `Reject: ${v.checks.find((c) => !c.ok)?.detail ?? "invalid"}`;
          } else if (wrongFlow) {
            verdict = { correct: true };
            r.bonuses.push({ playerId: p.id, why: "IdP refused a play that used the wrong flow" });
            p.score.bonus += 1;
            text = `Reject: ${FLOW_NAMES[flow!]} is the wrong flow here, even though it would technically work.`;
          } else {
            verdict = card.scripted ? { correct: null } : { correct: false, reason: "rejected_valid", explanation: explain("rejected_valid") };
            text = "Reject (but everything checked out)";
          }
        } else if (!v.valid) {
          verdict = { correct: false, reason: why, explanation: `${ROLE_NAMES[role]} accepted something invalid. ${explain(why!)}` };
          text = `${card.type === "issue" ? "Issue" : "Accept"} (despite: ${v.checks.find((c) => !c.ok)?.detail})`;
        } else if (wrongFlow && card.type === "issue") {
          verdict = { correct: null, reason: "idp_wrong_flow" };
          text = `Issue (wrong flow for this situation; no point)`;
        } else {
          verdict = { correct: true };
          text = card.type === "issue" ? "Issue / approve" : "Accept";
        }
        if (card.type === "accept") end = "beat";
        if (card.type === "issue") next = this.issue(r, f);
        break;
      }
      case "introspect": {
        if (!f || f.kind !== "call") throw new GameError("Nothing to introspect.");
        next = { kind: "introspect", from: "mcp", to: "idp", request: f.request, credential: f.credential };
        verdict = { correct: null };
        text = card.label;
        break;
      }
      default:
        throw new GameError("That card can't be played right now.");
    }

    // record
    const move: MoveRec = { playerId: p.id, role, type: card.type, label: card.label, correct: verdict.correct, trap: card.trap };
    if (verdict.reason) move.reason = verdict.reason;
    if (verdict.explanation) move.explanation = verdict.explanation;
    r.moves.push(move);
    if (verdict.correct === true) p.score.calls += 1;
    const v: Verdict = verdict.correct === true ? "correct" : verdict.correct === false ? "incorrect" : "neutral";
    this.log(r, role, text, v, verdict.correct === false ? verdict.explanation : undefined, p.name);

    if (role === "client" && next?.kind === "request" && next.to === "application") r.appReceived = next.token;

    // advance
    if (end === "round") return this.finish(r);
    if (end === "beat") {
      const beats = s.beats ?? [{ starter: "client" as Role }];
      if (r.beat + 1 < beats.length) {
        r.beat += 1;
        r.inFlight = null;
        r.activeRole = beats[r.beat]!.starter;
        r.freeUsed = [];
        this.log(r, null, `Next: ${ROLE_NAMES[r.activeRole]} continues.`, "info");
        return;
      }
      return this.finish(r);
    }
    if (next) {
      r.inFlight = next;
      r.freeUsed = [];
      r.slips.push({ from: next.from, to: next.to, label: describe(next), item: next });
      r.activeRole = next.to;
    } else {
      // token delivered back to the client (warm-up 1 / MCP OAuth)
      r.inFlight = null;
      r.activeRole = "client";
    }
  }

  /** IdP issue: what gets minted and where it goes. */
  private issue(r: RoundRec, f: InFlight): InFlight | null {
    const s = this.scenarioOf(r);
    switch (f.kind) {
      case "token_request": {
        const t = this.mint(r, {
          kind: "access", subject: s.request.user ?? "user:alex", subjectType: "user",
          audience: f.audience, scope: f.scope, clientId: "application",
        });
        r.held.client.push({ key: "issued", token: t });
        r.slips.push({ from: "idp", to: "client", label: `Token slip → Client (aud ${t.audience}, scope ${t.scope.join(" ")})`, item: { kind: "request", from: "idp", to: "client", request: s.request, token: t } });
        return null;
      }
      case "exchange": {
        const t = this.mint(r, {
          kind: f.requestedType === "id_jag" ? "id_jag" : "access",
          subject: f.subjectToken?.subject ?? "unknown", subjectType: f.subjectToken?.subjectType ?? "user",
          audience: f.requestedAudience, scope: f.requestedScope, clientId: "application",
        });
        return { kind: "call", from: "idp", to: "mcp", request: f.request, credential: { type: "bearer", token: t } };
      }
      case "assertion": {
        const t = this.mint(r, {
          kind: "access", subject: f.assertion.sub, subjectType: "app", audience: "mcp", scope: f.assertion.scope, clientId: "application",
        });
        return { kind: "call", from: "idp", to: "mcp", request: f.request, credential: { type: "bearer", token: t } };
      }
      case "introspect":
        return { kind: "call", from: "idp", to: "mcp", request: f.request, credential: f.credential, confirmedByIdp: true };
      default:
        return null;
    }
  }

  private freeCheck(r: RoundRec, role: Role, p: PlayerRec, card: Card) {
    const f = r.inFlight!;
    const v = this.judgeItem(r, f);
    const pickRules: Record<string, string[]> = {
      validate_audience: ["audience_mismatch", "no_token"],
      validate_scope: ["scope_insufficient", "app_subject_user_data", "no_token"],
      registered_key: ["bad_signature", "unregistered_issuer"],
    };
    const rules = pickRules[card.type] ?? [];
    const checks = v.checks.filter((c) => rules.includes(c.rule));
    const text = checks.length
      ? checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.detail}`).join(" ")
      : f.kind === "call" && f.credential && f.credential.type !== "bearer"
        ? "Not an OAuth token: this check doesn't apply. Look at the credential itself."
        : "Nothing to check.";
    this.log(r, role, `${card.label}: ${text}`, "info", undefined, p.name);
  }

  private finish(r: RoundRec): void {
    const s = this.scenarioOf(r);
    r.status = "done";
    r.activeRole = null;
    const broke = r.moves.find((m) => m.correct === false);
    const awards: RoundResult["awards"] = [];
    const nameOf = (id: string) => this.player(id)?.name ?? "?";
    for (const m of r.moves) if (m.correct) awards.push({ playerId: m.playerId, name: nameOf(m.playerId), points: 1, why: `Correct call as ${ROLE_NAMES[m.role]}` });
    for (const b of r.bonuses) awards.push({ playerId: b.playerId, name: nameOf(b.playerId), points: 1, why: b.why });
    const expected = s.expectedFlows ?? [];
    const guesses: RoundResult["guesses"] = [];
    if (s.phase === "assessment") {
      for (const [playerId, flow] of Object.entries(r.guesses)) {
        const correct = expected.includes(flow);
        guesses.push({ playerId, name: nameOf(playerId), flow, correct });
        if (correct) {
          const pl = this.player(playerId);
          if (pl) pl.score.identify += 1;
          awards.push({ playerId, name: nameOf(playerId), points: 1, why: "Identified the flow" });
        }
      }
    }
    const success = !broke;
    const flowText = expected.length ? ` The right call: ${expected.map((f) => FLOW_NAMES[f]).join(" or ")}. In short, ${flowWhy(expected[0]!)}.` : "";
    r.result = {
      success,
      failedStep: broke ? { role: broke.role, playerName: nameOf(broke.playerId), text: broke.label } : null,
      explanation: success ? `Chain unbroken end to end.${flowText}` : `${broke!.explanation ?? explain(broke!.reason ?? "")}${flowText}`,
      expectedFlows: expected,
      tells: s.tells ?? null,
      discussion: s.discussion ?? null,
      teaches: s.teaches ?? [],
      guesses,
      awards,
      traps: r.moves.filter((m) => m.trap).map((m) => `${ROLE_NAMES[m.role]} played a trap: "${m.label}"`),
    };
    this.log(r, null, success ? "Round succeeded: the chain held." : `Chain broken at ${ROLE_NAMES[broke!.role]}.`, success ? "correct" : "incorrect");
  }

  private log(r: RoundRec, role: Role | null, text: string, verdict: Verdict, detail?: string, playerName?: string) {
    r.seq += 1;
    const e: LogEntry = { seq: r.seq, role, playerName: playerName ?? null, text, verdict };
    if (detail) e.detail = detail;
    r.log.push(e);
    if (r.log.length > 200) r.log.shift();
  }

  // ---- views ---------------------------------------------------------------

  publicState(connected: (id: string) => boolean = () => true, spectatorsOnline = 0): PublicState {
    const st = this.state;
    const r = st.round;
    let round: PublicRound | null = null;
    if (r) {
      const s = this.scenarioOf(r);
      const reveal = s.phase !== "assessment" || r.status === "done";
      round = {
        index: r.index,
        phase: s.phase,
        title: reveal ? s.title : `Scenario ${r.index + 1 - this.scenarios.filter((x) => x.phase !== "assessment").length}`,
        text: s.text,
        flowLabel: reveal ? (s.flowLabel ?? (s.expectedFlows ?? []).map((f) => FLOW_NAMES[f]).join(" / ")) || null : null,
        status: r.status,
        activeRole: r.activeRole,
        inFlight: r.inFlight,
        slips: r.slips,
        log: r.log,
        identifySubmitted: Object.keys(r.guesses),
        tellAwardedTo: r.tellAwardedTo,
        seats: r.seats,
        result: r.result,
        flowChoices: s.phase === "assessment" ? [...FLOWS] : [],
        tellEnabled: s.phase !== "warmup" && r.status !== "done",
      };
    }
    return {
      room: st.room,
      started: st.started,
      players: st.players.map((p) => ({
        id: p.id, name: p.name, role: p.role, connected: connected(p.id), isHost: p.id === st.hostId, score: { ...p.score },
      })),
      spectators: spectatorsOnline,
      rounds: this.scenarios.map((s, index) => ({
        index, phase: s.phase,
        title: s.phase === "assessment" ? `Assessment ${index + 1 - this.scenarios.filter((x) => x.phase !== "assessment").length}` : s.title,
      })),
      round,
      hostId: st.hostId,
    };
  }

  privateView(playerId: string): PrivateView {
    const p = this.player(playerId);
    const r = this.state.round;
    const role = r && p ? this.seatOf(r, p.id) : null;
    const hand = r && role && r.status !== "done" ? r.hands[role] : [];
    return {
      playerId,
      name: p?.name ?? "",
      role: p?.role ?? null,
      isHost: this.state.hostId === playerId,
      hand: hand.map((c) => {
        const { trap: _trap, ...rest } = c;
        return rest;
      }),
      slips: r && role ? r.held[role].map((h) => h.token) : [],
      myGuess: r ? (r.guesses[playerId] ?? null) : null,
      canPlay: r && role ? hand.filter((c) => this.playable(r, role, c)).map((c) => c.id) : [],
    };
  }
}

/** One-line description of a slip in transit. */
export function describe(f: InFlight): string {
  const tok = (t: Token | null) => (t ? `${t.kind === "id" ? "ID token" : t.kind === "id_jag" ? "ID-JAG" : "token"} (aud ${t.audience}, scope ${t.scope.join(" ")})` : "no token");
  switch (f.kind) {
    case "request": return `Request + ${tok(f.token)}`;
    case "token_request": return `Authorization request (resource ${f.audience}, ${f.pkce ? "with" : "without"} PKCE)`;
    case "exchange": return `Exchange ${tok(f.subjectToken)} → ${f.requestedType === "id_jag" ? "ID-JAG" : "token"} for ${f.requestedAudience}`;
    case "assertion": return `Signed assertion (iss ${f.assertion.iss}, aud ${f.assertion.aud})`;
    case "introspect": return "Is this token yours?";
    case "call": {
      const c = f.credential;
      if (!c) return "Call with no credential";
      if (c.type === "bearer") return `Call + ${tok(c.token)}${f.confirmedByIdp ? " (IdP says: minted by me)" : ""}`;
      if (c.type === "api_key") return `Call + API key (${c.key.placement === "query" ? "in URL" : "header"})`;
      if (c.type === "sigv4") return "Call signed with SigV4";
      if (c.type === "gateway_jwt") return `Call + gateway JWT (alg ${c.jwt.alg})`;
      return "Call + AWS secret key as bearer";
    }
  }
}

export { scopesCover };

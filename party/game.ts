// One PartyKit room = one game table. The server is authoritative: it holds the
// whole game, validates every move, and sends each socket only its own hand.
import type * as Party from "partykit/server";
import { checkPassword, hashPassword, randomHex, signSession, verifySession } from "../src/game/crypto.ts";
import { Game, GameError, type GameState } from "../src/game/engine.ts";
import { parseClientMessage } from "../src/game/protocol.ts";
import { SCENARIOS } from "../src/game/scenarios.ts";
import { ROLES, type ClientMessage, type Role, type ServerMessage } from "../src/game/types.ts";
import { ROOM_NAME_RE } from "./names.ts";
import { clientIp, CORS, INTERNAL_HEADER, internalSecret, json, RateLimiter, readJson } from "./shared.ts";

interface Meta {
  passwordHash: string;
  secret: string;
  createdAt: number;
}

interface ConnState {
  playerId: string;
}

const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYERS = 24;

export default class GameRoom implements Party.Server {
  options: Party.ServerOptions = { hibernate: false };
  meta: Meta | null = null;
  game: Game | null = null;
  joinLimiter = new RateLimiter(5, 60_000); // failed password attempts per IP per minute
  msgLimiter = new RateLimiter(60, 10_000); // messages per connection per 10s
  lobbyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly room: Party.Room) {}

  async onStart() {
    this.meta = (await this.room.storage.get<Meta>("meta")) ?? null;
    const state = await this.room.storage.get<GameState>("game");
    if (this.meta && state) this.game = new Game(SCENARIOS, state);
  }

  // ---- HTTP: init (from lobby) and join ------------------------------------

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!ROOM_NAME_RE.test(this.room.id)) return json({ error: "Not found." }, 404);
    if (req.method === "GET") return json({ exists: !!this.meta, room: this.room.id });
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const body = await readJson(req);
    if (!body) return json({ error: "Bad request." }, 400);

    if (body.action === "init") {
      const secret = internalSecret(this.room);
      if (!secret || req.headers.get(INTERNAL_HEADER) !== secret) return json({ error: "Forbidden." }, 403);
      if (this.meta) return json({ error: "Room exists." }, 409);
      if (typeof body.password !== "string") return json({ error: "Bad request." }, 400);
      this.meta = { passwordHash: hashPassword(body.password), secret: randomHex(32), createdAt: Date.now() };
      this.game = new Game(SCENARIOS, { room: this.room.id });
      await this.room.storage.put("meta", this.meta);
      return this.addPlayer(body);
    }

    if (body.action === "join") {
      if (!this.meta || !this.game) return json({ error: "That room doesn't exist (or has closed)." }, 404);
      const ip = clientIp(req);
      const wait = this.joinLimiter.check(`peek:${ip}`, Date.now());
      this.joinLimiter.reset(`peek:${ip}`);
      if (wait) return json({ error: `Too many attempts. Try again in ${wait}s.` }, 429);
      if (typeof body.password !== "string" || !checkPassword(body.password, this.meta.passwordHash)) {
        const w = this.joinLimiter.check(ip);
        return json({ error: w ? `Too many attempts. Try again in ${w}s.` : "Wrong password." }, w ? 429 : 401);
      }
      if (this.game.state.players.length >= MAX_PLAYERS) return json({ error: "This room is full." }, 409);
      return this.addPlayer(body);
    }
    return json({ error: "Bad request." }, 400);
  }

  private async addPlayer(body: Record<string, unknown>): Promise<Response> {
    const game = this.game!;
    const name = typeof body.displayName === "string" ? body.displayName : "Player";
    const pref = typeof body.role === "string" && (ROLES.includes(body.role as Role) || body.role === "spectate") ? (body.role as Role | "spectate") : "auto";
    const p = game.addPlayer(name, pref);
    await this.persist();
    this.broadcast();
    return json({ room: this.room.id, playerId: p.id, session: signSession(p.id, this.meta!.secret), role: p.role });
  }

  // ---- WebSocket -------------------------------------------------------------

  onConnect(conn: Party.Connection<ConnState>, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const playerId = this.meta ? verifySession(url.searchParams.get("session"), this.meta.secret) : null;
    if (!playerId || !this.game?.player(playerId)) {
      this.send(conn, { t: "error", message: "Not joined. Enter the room password to join." });
      conn.close(4401, "unauthorized");
      return;
    }
    conn.setState({ playerId });
    this.broadcast();
  }

  async onMessage(raw: string | ArrayBuffer | ArrayBufferView, conn: Party.Connection<ConnState>) {
    const playerId = conn.state?.playerId;
    if (!playerId || !this.game) return;
    if (this.msgLimiter.check(conn.id)) {
      this.send(conn, { t: "error", message: "Slow down." });
      return;
    }
    const msg = parseClientMessage(typeof raw === "string" ? raw : null);
    if (!msg) {
      this.send(conn, { t: "error", message: "Malformed message." });
      return;
    }
    if (msg.t === "ping") {
      this.send(conn, { t: "pong" });
      return;
    }
    try {
      this.apply(playerId, msg);
    } catch (e) {
      this.send(conn, { t: "error", message: e instanceof GameError ? e.message : "Something went wrong." });
      if (!(e instanceof GameError)) console.error("game error", e);
      return;
    }
    await this.persist();
    this.broadcast();
  }

  onClose() {
    this.broadcast();
  }

  async onAlarm() {
    const last = (await this.room.storage.get<number>("touched")) ?? 0;
    if (Date.now() - last >= IDLE_TTL_MS) {
      await this.room.storage.deleteAll();
      this.meta = null;
      this.game = null;
    }
  }

  private apply(playerId: string, msg: ClientMessage) {
    const g = this.game!;
    switch (msg.t) {
      case "sit": return g.sit(playerId, msg.role);
      case "stand": return g.stand(playerId);
      case "start": return g.start(playerId);
      case "play": return g.play(playerId, msg.cardId);
      case "identify": return g.identify(playerId, msg.flow);
      case "tell": return g.tell(playerId);
      case "host": return g.hostAction(playerId, msg.action, msg.round);
    }
  }

  // ---- state fan-out ---------------------------------------------------------

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.room.getConnections<ConnState>()) if (c.state?.playerId) ids.add(c.state.playerId);
    return ids;
  }

  private broadcast() {
    if (!this.game) return;
    const online = this.connectedIds();
    const spectators = this.game.state.players.filter((p) => !p.role && online.has(p.id)).length;
    const state = this.game.publicState((id) => online.has(id), spectators);
    for (const c of this.room.getConnections<ConnState>()) {
      const id = c.state?.playerId;
      if (id) this.send(c, { t: "state", state, you: this.game.privateView(id) });
    }
  }

  private send(conn: Party.Connection, msg: ServerMessage) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  private async persist() {
    if (!this.game) return;
    const now = Date.now();
    await this.room.storage.put({ game: this.game.state, touched: now });
    await this.room.storage.setAlarm(now + IDLE_TTL_MS);
    this.notifyLobby();
  }

  /** Tell the lobby how many seats are filled (debounced). */
  private notifyLobby() {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(async () => {
      this.lobbyTimer = null;
      const secret = internalSecret(this.room);
      if (!secret || !this.game) return;
      try {
        await this.room.context.parties.lobby!.get("main").fetch({
          method: "POST",
          headers: { "content-type": "application/json", [INTERNAL_HEADER]: secret },
          body: JSON.stringify({ action: "upsert", name: this.room.id, seated: this.game.seatedRoles().length }),
        });
      } catch (e) {
        console.error("lobby update failed", e);
      }
    }, 500);
  }
}

// Simulated players that talk to a real PartyKit server over HTTP + WebSocket.
import { spawn, type Subprocess } from "bun";
import type { ClientMessage, PrivateView, PublicState, Role, ServerMessage } from "../src/game/types.ts";

export async function createRoom(host: string, password: string, displayName: string, role: Role | "auto" = "auto") {
  const secret = process.env.INTERNAL_SECRET;
  const res = await fetch(`http://${host}/parties/lobby/main`, {
    method: "POST",
    headers: secret ? { "x-omcp-internal": secret } : {},
    body: JSON.stringify({ action: "create", password, displayName, role }),
  });
  const body = (await res.json()) as { room: string; session: string; playerId: string; error?: string };
  if (!res.ok) throw new Error(`create failed: ${res.status} ${body.error}`);
  return body;
}

export async function joinRoom(host: string, room: string, password: string, displayName: string, role: Role | "auto" | "spectate" = "auto") {
  const res = await fetch(`http://${host}/parties/main/${room}`, {
    method: "POST",
    body: JSON.stringify({ action: "join", password, displayName, role }),
  });
  const body = (await res.json()) as { room: string; session: string; playerId: string; error?: string };
  return { ok: res.ok, status: res.status, ...body };
}

export class SimPlayer {
  ws!: WebSocket;
  state: PublicState | null = null;
  you: PrivateView | null = null;
  errors: string[] = [];
  raw: string[] = [];
  keepRaw = false;
  closed = false;
  closeCode = 0;
  private listeners: (() => void)[] = [];
  version = 0;

  constructor(readonly host: string, readonly room: string, readonly session: string, readonly name: string) {}

  static async connect(host: string, room: string, session: string, name: string, keepRaw = false) {
    const p = new SimPlayer(host, room, session, name);
    p.keepRaw = keepRaw;
    await p.open();
    return p;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://${this.host}/parties/main/${this.room}?session=${encodeURIComponent(this.session)}`);
      const t = setTimeout(() => reject(new Error("connect timeout")), 10_000);
      this.ws.onmessage = (ev) => {
        const text = String(ev.data);
        if (this.keepRaw) this.raw.push(text);
        const m = JSON.parse(text) as ServerMessage;
        if (m.t === "state") {
          this.state = m.state;
          this.you = m.you;
          this.version++;
          clearTimeout(t);
          resolve();
        } else if (m.t === "error") this.errors.push(m.message);
        else if (m.t === "pong") this.errors.push("__pong__");
        for (const l of this.listeners.splice(0)) l();
      };
      this.ws.onclose = (ev) => {
        this.closed = true;
        this.closeCode = ev.code;
        clearTimeout(t);
        resolve();
        for (const l of this.listeners.splice(0)) l();
      };
      this.ws.onerror = () => {};
    });
  }

  send(msg: ClientMessage | string) {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Resolve when pred() is true (checked after every message). */
  waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting`)), timeoutMs);
      const check = () => {
        if (pred()) {
          clearTimeout(t);
          resolve();
        } else this.listeners.push(check);
      };
      this.listeners.push(check);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Start `partykit dev` on a free port unless PK_HOST is set. */
export async function startServer(): Promise<{ host: string; stop: () => void }> {
  if (process.env.PK_HOST) return { host: process.env.PK_HOST, stop: () => {} };
  process.env.INTERNAL_SECRET = "test-secret-0123456789abcdef";
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: Subprocess = spawn(["bunx", "partykit", "dev", "--port", String(port)], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
  });
  const host = `127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://${host}/parties/lobby/main`);
      if (r.ok) return { host, stop: () => proc.kill() };
    } catch {}
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error("partykit dev did not start");
}

/** Create a room and seat four players. */
export async function fullTable(host: string, password = "pw-1234") {
  const created = await createRoom(host, password, "Client-bot", "client");
  const sessions = [created];
  for (const role of ["application", "idp", "mcp"] as Role[]) {
    const j = await joinRoom(host, created.room, password, `${role}-bot`, role);
    if (!j.ok) throw new Error(`join failed ${j.status} ${j.error}`);
    sessions.push(j);
  }
  const players = await Promise.all(sessions.map((s, i) => SimPlayer.connect(host, created.room, s.session, `p${i}`)));
  return { room: created.room, players, password };
}

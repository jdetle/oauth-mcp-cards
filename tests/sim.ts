// Simulated players that talk to the real Rust server over HTTP + WebSocket.
import { spawn, spawnSync, type Subprocess } from "bun";
import { existsSync, readdirSync } from "node:fs";
import type { ClientMessage, PrivateView, PublicState, Role, ServerMessage } from "../src/game/types.ts";

const ROOT = `${import.meta.dir}/..`;
export const TEST_INTERNAL_TOKEN = "test-internal-token-0123456789";

/** scrypt hash for an admin password, made by the server binary itself. */
export function adminHash(password: string): string {
  const bin = `${ROOT}/server/target/release/oauth-mcp-server`;
  const r = spawnSync([bin, "hash-password"], { stdin: Buffer.from(`${password}\n`) });
  if (r.exitCode !== 0) throw new Error(`hash-password failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
export const SCENARIO_COUNT = readdirSync(`${ROOT}/games/oauth-mcp/rounds`).filter((f) => f.endsWith(".json")).length;

export interface Joined {
  ok: boolean;
  status: number;
  room: string;
  playerId: string;
  cookie: string;
  error?: string;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Joined> {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { ok: res.ok, status: res.status, room: data.room ?? "", playerId: data.playerId ?? "", error: data.error, cookie: setCookie.split(";")[0] ?? "" };
}

export async function createRoom(host: string, password: string, displayName: string, role: Role | "auto" = "auto") {
  const token = process.env.INTERNAL_TOKEN;
  const r = await post(`http://${host}/api/rooms`, { password, displayName, role: role === "auto" ? undefined : role }, token ? { "x-omcp-internal": token } : {});
  if (!r.ok) throw new Error(`create failed: ${r.status} ${r.error}`);
  return r;
}

export async function joinRoom(host: string, room: string, password: string, displayName: string, role: Role | "auto" | "spectate" = "auto") {
  return post(`http://${host}/api/rooms/${room}/join`, { password, displayName, role: role === "auto" ? undefined : role });
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
  version = 0;
  private listeners: (() => void)[] = [];

  constructor(readonly host: string, readonly room: string, readonly cookie: string, readonly name: string) {}

  static async connect(host: string, room: string, cookie: string, name: string, keepRaw = false) {
    const p = new SimPlayer(host, room, cookie, name);
    p.keepRaw = keepRaw;
    await p.open();
    return p;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Bun's WebSocket accepts headers, so we present the session cookie like a browser would
      this.ws = new WebSocket(`ws://${this.host}/ws/${this.room}`, { headers: { cookie: this.cookie } } as never);
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

  send(msg: ClientMessage | string | Uint8Array<ArrayBuffer>) {
    this.ws.send(typeof msg === "string" || msg instanceof Uint8Array ? msg : JSON.stringify(msg));
  }

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

/** Start the Rust server (release build) on a free port, unless API_HOST is set. */
export async function startServer(extraEnv: Record<string, string> = {}): Promise<{ host: string; stop: () => void }> {
  if (process.env.API_HOST) return { host: process.env.API_HOST, stop: () => {} };
  const bin = `${ROOT}/server/target/release/oauth-mcp-server`;
  if (!existsSync(bin)) {
    const b = spawnSync(["cargo", "build", "--release", "-q"], { cwd: `${ROOT}/server`, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error("cargo build failed");
  }
  process.env.INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: Subprocess = spawn([bin], {
    env: { ...process.env, PORT: String(port), GAMES_DIR: `${ROOT}/games`, STATIC_DIR: `${ROOT}/out`, INTERNAL_TOKEN: TEST_INTERNAL_TOKEN, INTRUDER_RATE: "0", ...extraEnv },
    stdout: "ignore",
    stderr: "ignore",
  });
  const host = `127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://${host}/api/health`)).ok) return { host, stop: () => proc.kill() };
    } catch {}
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("server did not start");
}

/** Create a room and seat four players. */
export async function fullTable(host: string, password = "pw-1234") {
  const created = await createRoom(host, password, "Client-bot", "client");
  const sessions: Joined[] = [created];
  for (const role of ["application", "idp", "mcp"] as Role[]) {
    const j = await joinRoom(host, created.room, password, `${role}-bot`, role);
    if (!j.ok) throw new Error(`join failed ${j.status} ${j.error}`);
    sessions.push(j);
  }
  const players = await Promise.all(sessions.map((s, i) => SimPlayer.connect(host, created.room, s.cookie, `p${i}`)));
  return { room: created.room, players, password, sessions };
}

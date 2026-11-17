// Browser-side helpers. In production the Rust server serves this page, so the API is same-origin.
// In development (`next dev` on :3000) set NEXT_PUBLIC_API_BASE=http://localhost:8080.
import type { GameInfo, Role } from "../game/types.ts";
import { BASE } from "./paths.ts";
import { track } from "./telemetry.ts";
import { announceWaking } from "./poll.ts";

const routeOf = (path: string) => path.replace(/\/rooms\/[^/]+\//, "/rooms/:room/");

// Where the server is. Same origin in production; `next dev` points NEXT_PUBLIC_API_BASE at :8080.
const API_ORIGIN = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
export const API_BASE = `${API_ORIGIN}${BASE}`;

export function wsUrl(room: string): string {
  const origin = API_ORIGIN || (typeof location !== "undefined" ? location.origin : "");
  return `${origin.replace(/^http/, "ws")}${BASE}/ws/${encodeURIComponent(room)}`;
}

export function rememberName(name?: string): string {
  try {
    if (name) localStorage.setItem("omcp:name", name);
    return localStorage.getItem("omcp:name") ?? "";
  } catch {
    return name ?? "";
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the last room-list request found the server asleep (scaled to zero). */
export let serverAsleep = false;

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  // The server sleeps when nobody's playing. A request that finds it asleep wakes it (the
  // edge does that) and answers 503 {waking}; keep trying for a couple of minutes.
  for (let tries = 0; ; tries++) {
    const r = await postOnce(path, body);
    if (r.status !== 503 || !r.data.waking || tries >= 30) {
      if (tries) announceWaking(false);
      return r;
    }
    if (tries === 0) {
      announceWaking(true);
      track("server.waking", { route: routeOf(path) });
    }
    await pause(5000);
  }
}

async function postOnce(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      credentials: "include", // the server sets an HttpOnly session cookie for this room
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && !data.waking) track("api.error", { route: routeOf(path), status: res.status, message: String(data.error ?? "").slice(0, 120) });
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    track("api.unreachable", { route: routeOf(path), message: String(e).slice(0, 120) });
    return { ok: false, status: 0, data: { error: "Can't reach the game server." } };
  }
}

export type SeatChoice = Role | "auto" | "spectate";

const seat = (role: SeatChoice) => (role === "auto" ? undefined : role);

export async function createRoom(game: string, password: string, displayName: string, role: SeatChoice, turnstileToken?: string | null) {
  return post("/api/rooms", { game, password, displayName, role: seat(role), turnstileToken: turnstileToken ?? undefined });
}

/** Every game in the series (static per release; cached by the server for five minutes). */
export async function listGames(): Promise<GameInfo[] | null> {
  try {
    const res = await fetch(`${API_BASE}/api/games`, { credentials: "include" });
    if (!res.ok) return null;
    return ((await res.json()) as { games: GameInfo[] }).games;
  } catch {
    return null;
  }
}

export interface RoomRow {
  name: string;
  seated: number;
  game: string;
  gameTitle: string;
  accent: string;
}

export async function joinRoom(room: string, password: string, displayName: string, role: SeatChoice, turnstileToken?: string | null) {
  return post(`/api/rooms/${encodeURIComponent(room)}/join`, { password, displayName, role: seat(role), turnstileToken: turnstileToken ?? undefined });
}

export async function listRooms(): Promise<RoomRow[] | null> {
  try {
    const res = await fetch(`${API_BASE}/api/rooms`, { cache: "no-store", credentials: "include" });
    const data = (await res.json()) as { rooms?: RoomRow[]; asleep?: boolean };
    serverAsleep = !!data.asleep;
    return data.asleep ? [] : (data.rooms ?? null);
  } catch {
    return null;
  }
}

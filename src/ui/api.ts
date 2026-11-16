// Browser-side helpers: where the PartyKit server is, HTTP calls, saved sessions.
import type { Role } from "../game/types.ts";

export const PARTY_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "127.0.0.1:1999";

const isLocal = (h: string) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(h);
export const HTTP_BASE = `${isLocal(PARTY_HOST) ? "http" : "https"}://${PARTY_HOST}`;

export interface Session {
  session: string;
  playerId: string;
}

const key = (room: string) => `omcp:session:${room}`;

export function loadSession(room: string): Session | null {
  try {
    const raw = localStorage.getItem(key(room));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(room: string, s: Session) {
  try {
    localStorage.setItem(key(room), JSON.stringify(s));
  } catch {
    /* private mode: session lasts for this tab only */
  }
}

export function forgetSession(room: string) {
  try {
    localStorage.removeItem(key(room));
  } catch {}
}

export function rememberName(name?: string): string {
  try {
    if (name) localStorage.setItem("omcp:name", name);
    return localStorage.getItem("omcp:name") ?? "";
  } catch {
    return name ?? "";
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${HTTP_BASE}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Can't reach the game server." } };
  }
}

export type SeatChoice = Role | "auto" | "spectate";

export async function createRoom(password: string, displayName: string, role: SeatChoice) {
  return post("/parties/lobby/main", { action: "create", password, displayName, role });
}

export async function joinRoom(room: string, password: string, displayName: string, role: SeatChoice) {
  return post(`/parties/main/${encodeURIComponent(room)}`, { action: "join", password, displayName, role });
}

export async function listRooms(): Promise<{ name: string; seated: number }[] | null> {
  try {
    const res = await fetch(`${HTTP_BASE}/parties/lobby/main`, { cache: "no-store" });
    const data = (await res.json()) as { rooms: { name: string; seated: number }[] };
    return data.rooms;
  } catch {
    return null;
  }
}

// Browser-side helpers. In production the Rust server serves this page, so the API is same-origin.
// In development (`next dev` on :3000) set NEXT_PUBLIC_API_BASE=http://localhost:8080.
import type { Role } from "../game/types.ts";
import { BASE } from "./paths.ts";
import { track } from "./telemetry.ts";

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

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      credentials: "include", // the server sets an HttpOnly session cookie for this room
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) track("api.error", { route: routeOf(path), status: res.status, message: String(data.error ?? "").slice(0, 120) });
    return { ok: res.ok, data };
  } catch (e) {
    track("api.unreachable", { route: routeOf(path), message: String(e).slice(0, 120) });
    return { ok: false, data: { error: "Can't reach the game server." } };
  }
}

export type SeatChoice = Role | "auto" | "spectate";

const seat = (role: SeatChoice) => (role === "auto" ? undefined : role);

export async function createRoom(password: string, displayName: string, role: SeatChoice, turnstileToken?: string | null) {
  return post("/api/rooms", { password, displayName, role: seat(role), turnstileToken: turnstileToken ?? undefined });
}

export async function joinRoom(room: string, password: string, displayName: string, role: SeatChoice, turnstileToken?: string | null) {
  return post(`/api/rooms/${encodeURIComponent(room)}/join`, { password, displayName, role: seat(role), turnstileToken: turnstileToken ?? undefined });
}

export async function listRooms(): Promise<{ name: string; seated: number }[] | null> {
  try {
    const res = await fetch(`${API_BASE}/api/rooms`, { cache: "no-store", credentials: "include" });
    const data = (await res.json()) as { rooms: { name: string; seated: number }[] };
    return data.rooms;
  } catch {
    return null;
  }
}

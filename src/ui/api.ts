// Browser-side helpers. In production the Rust server serves this page, so the API is same-origin.
// In development (`next dev` on :3000) set NEXT_PUBLIC_API_BASE=http://localhost:8080.
import type { Role } from "../game/types.ts";

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

export function wsUrl(room: string): string {
  const base = API_BASE || (typeof location !== "undefined" ? location.origin : "");
  return `${base.replace(/^http/, "ws")}/ws/${encodeURIComponent(room)}`;
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
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Can't reach the game server." } };
  }
}

export type SeatChoice = Role | "auto" | "spectate";

const seat = (role: SeatChoice) => (role === "auto" ? undefined : role);

export async function createRoom(password: string, displayName: string, role: SeatChoice) {
  return post("/api/rooms", { password, displayName, role: seat(role) });
}

export async function joinRoom(room: string, password: string, displayName: string, role: SeatChoice) {
  return post(`/api/rooms/${encodeURIComponent(room)}/join`, { password, displayName, role: seat(role) });
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

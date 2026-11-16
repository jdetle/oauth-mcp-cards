// Admin API against the real server: sign-in, listing, deleting a live game.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { adminHash, fullTable, startServer } from "./sim.ts";

const ADMIN_PW = "fixture-admin-password";
let server: { host: string; stop: () => void };
let open: { host: string; stop: () => void };
beforeAll(async () => {
  server = await startServer({ ADMIN_PASSWORD_HASH: adminHash(ADMIN_PW) });
  open = await startServer();
}, 90_000);
afterAll(() => {
  server?.stop();
  open?.stop();
});

const api = (path: string, init: RequestInit = {}, cookie = "") =>
  fetch(`http://${server.host}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } });
const login = (password: string) => api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });

test("admin is off unless a password hash is configured", async () => {
  expect((await fetch(`http://${open.host}/api/admin/rooms`)).status).toBe(404);
  expect((await fetch(`http://${open.host}/api/admin/login`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
  expect(await (await fetch(`http://${open.host}/api/config`)).json()).toEqual({ turnstileSiteKey: null, admin: false });
});

test("sign in, list games, delete one: players are disconnected and the room is gone", async () => {
  const { room, players } = await fullTable(server.host);
  const other = await fullTable(server.host);

  expect((await api("/api/admin/rooms")).status).toBe(401);
  expect((await login("not-the-password")).status).toBe(401);

  const res = await login(ADMIN_PW);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0]!;

  const list = (await (await api("/api/admin/rooms", {}, cookie)).json()) as { rooms: { name: string; players: { name: string }[]; connections: number }[] };
  const mine = list.rooms.find((r) => r.name === room)!;
  expect(mine.players.length).toBe(4);
  expect(mine.connections).toBe(4);
  expect(JSON.stringify(list)).not.toContain("password");

  // a forged or expired-looking cookie doesn't work
  expect((await api("/api/admin/rooms", {}, "omcp_admin=99999999999999.deadbeef")).status).toBe(401);
  // deleting needs the custom header as well as the cookie (cross-site requests can't send it)
  expect((await api(`/api/admin/rooms/${room}`, { method: "DELETE" }, cookie)).status).toBe(403);
  // and a player's own room cookie is not an admin cookie
  expect((await api(`/api/admin/rooms/${room}`, { method: "DELETE", headers: { "x-omcp-admin": "1" } }, players[0]!.cookie)).status).toBe(401);

  const del = await api(`/api/admin/rooms/${room}`, { method: "DELETE", headers: { "x-omcp-admin": "1" } }, cookie);
  expect(del.status).toBe(200);
  for (const p of players) {
    await p.waitFor(() => p.closed);
    expect(p.closeCode).toBe(4410);
    expect(p.errors).toContain("This game was closed by an admin.");
  }
  const lobby = (await (await api("/api/rooms")).json()) as { rooms: { name: string }[] };
  expect(lobby.rooms.some((r) => r.name === room)).toBe(false);
  expect(lobby.rooms.some((r) => r.name === other.room)).toBe(true); // other games untouched
  expect((await api(`/api/admin/rooms/${room}`, { method: "DELETE", headers: { "x-omcp-admin": "1" } }, cookie)).status).toBe(404);
  for (const p of other.players) p.close();
}, 30_000);

test("timeline history is only for people in the room", async () => {
  const { room, players } = await fullTable(server.host);
  expect((await api(`/api/rooms/${room}/history`)).status).toBe(401);
  const mine = await api(`/api/rooms/${room}/history`, {}, players[0]!.cookie);
  expect(mine.status).toBe(200);
  expect(await mine.json()).toEqual({ rounds: [] });
  for (const p of players) p.close();
}, 30_000);

test("admin sign-in is rate limited", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await login(`wrong-${i}`)).status);
  expect(codes.at(-1)).toBe(429);
  // even the right password is refused while locked out
  expect((await login(ADMIN_PW)).status).toBe(429);
}, 30_000);

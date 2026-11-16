// The whole app mounted under a prefix (how it is served at jdetle.com/mcp-oauth).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, TEST_INTERNAL_TOKEN } from "./sim.ts";

let server: { host: string; stop: () => void };
beforeAll(async () => {
  server = await startServer({ BASE_PATH: "/mcp-oauth" });
}, 90_000);
afterAll(() => server?.stop());
const at = (p: string) => `http://${server.host}${p}`;

test("API, sockets and cookies live under the prefix; health stays at the root", async () => {
  expect((await fetch(at("/api/health"))).status).toBe(200); // load balancer check
  expect((await fetch(at("/mcp-oauth/api/health"))).status).toBe(200);
  const home = await fetch(at("/"), { redirect: "manual" });
  expect(home.status).toBe(307);
  expect(home.headers.get("location")).toBe("/mcp-oauth/");
  expect((await fetch(at("/api/rooms"))).status).toBe(404); // nothing at the root

  const res = await fetch(at("/mcp-oauth/api/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-omcp-internal": TEST_INTERNAL_TOKEN },
    body: JSON.stringify({ password: "pw-1234", displayName: "Prefixed" }),
  });
  expect(res.status).toBe(200);
  const { room } = (await res.json()) as { room: string };
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toContain("Path=/mcp-oauth;"); // only ever sent to this app
  const cookie = setCookie.split(";")[0]!;

  const state = await new Promise<{ t: string; state: { room: string } }>((resolve, reject) => {
    const ws = new WebSocket(`ws://${server.host}/mcp-oauth/ws/${room}`, { headers: { cookie } } as never);
    ws.onmessage = (e) => {
      resolve(JSON.parse(String(e.data)));
      ws.close();
    };
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error("no state")), 5000);
  });
  expect(state.t).toBe("state");
  expect(state.state.room).toBe(room);
}, 30_000);

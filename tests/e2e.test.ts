// End to end: the real Rust server, four simulated clients, one full OBO round.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ROLES } from "../src/game/types.ts";
import { fullTable, joinRoom, SimPlayer, startServer } from "./sim.ts";

let server: { host: string; stop: () => void };
beforeAll(async () => {
  server = await startServer();
}, 90_000);
afterAll(() => server?.stop());

test(
  "four clients play a full OBO round",
  async () => {
    const { players, room, password } = await fullTable(server.host);
    for (const p of players) p.keepRaw = true;
    const [client, app, idp, mcp] = players as [SimPlayer, SimPlayer, SimPlayer, SimPlayer];
    await client.waitFor(() => client.state!.players.length === 4);

    // a spectator joins: sees the table but no hand
    const spec = await joinRoom(server.host, room, password, "Watcher", "spectate");
    const watcher = await SimPlayer.connect(server.host, room, spec.cookie, "watcher", true);

    const obo = client.state!.rounds.findIndex((r) => r.title === "Learning: On-Behalf-Of");
    expect(obo).toBeGreaterThan(0);
    client.send({ t: "host", action: "goto", round: obo });
    await client.waitFor(() => client.state?.round?.index === obo && client.you!.canPlay.length > 0);

    const play = async (who: SimPlayer, label: string) => {
      await who.waitFor(() => who.you!.canPlay.length > 0);
      const card = who.you!.hand.find((c) => c.label.includes(label) && who.you!.canPlay.includes(c.id));
      expect(card).toBeTruthy();
      const v = who.version;
      who.send({ t: "play", cardId: card!.id });
      await who.waitFor(() => who.version > v);
    };
    await play(client, "with the user's token slip");
    await play(app, "scope calendar.read)");
    await play(idp, "Issue");
    await play(mcp, "Accept");
    await mcp.waitFor(() => mcp.state!.round!.status === "done");

    const result = mcp.state!.round!.result!;
    expect(result.success).toBe(true);
    for (const p of mcp.state!.players.filter((x) => x.role)) expect(p.score.calls).toBe(1);

    // privacy: nobody ever received another player's card ids
    const handIds = new Map<SimPlayer, Set<string>>();
    for (const p of players) {
      const ids = new Set<string>();
      for (const raw of p.raw) {
        const m = JSON.parse(raw);
        if (m.t === "state") for (const c of m.you.hand) ids.add(c.id);
      }
      handIds.set(p, ids);
    }
    for (const p of players)
      for (const other of players) {
        if (p === other) continue;
        const theirs = [...handIds.get(other)!];
        for (const raw of p.raw) for (const id of theirs) expect(raw.includes(id)).toBe(false);
      }
    expect(watcher.you!.hand.length).toBe(0);
    expect(watcher.you!.role).toBeNull();
    for (const raw of watcher.raw) for (const ids of handIds.values()) for (const id of ids) expect(raw.includes(id)).toBe(false);

    // reconnect keeps the seat
    const appCookie = app.cookie;
    app.close();
    const again = await SimPlayer.connect(server.host, room, appCookie, "app-again");
    expect(again.you!.role).toBe(ROLES[1]);
    for (const p of [...players, watcher, again]) p.close();
  },
  60_000,
);

test("wrong password is refused and then rate limited", async () => {
  const { room, players } = await fullTable(server.host, "right-pw");
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await joinRoom(server.host, room, "wrong", "x")).status);
  expect(codes[0]).toBe(401);
  expect(codes.at(-1)).toBe(429);
  for (const p of players) p.close();
}, 30_000);

test("a socket without a valid session is closed", async () => {
  const { room, players } = await fullTable(server.host);
  const forged = `omcp_${room.replaceAll("-", "_")}=someone.0000`;
  const intruder = await SimPlayer.connect(server.host, room, forged, "intruder");
  await intruder.waitFor(() => intruder.closed);
  expect(intruder.state).toBeNull();
  expect(intruder.closeCode).toBe(4401);
  // a valid cookie for one room doesn't open another
  const { room: other, players: others } = await fullTable(server.host);
  const crossCookie = players[0]!.cookie.replace(`omcp_${room.replaceAll("-", "_")}`, `omcp_${other.replaceAll("-", "_")}`);
  const cross = await SimPlayer.connect(server.host, other, crossCookie, "cross");
  await cross.waitFor(() => cross.closed);
  expect(cross.state).toBeNull();
  for (const p of others) p.close();
  for (const p of players) p.close();
}, 30_000);

// Fuzzing: random / malformed / forged / out-of-turn input must be rejected without
// crashing the server or leaking another player's hand.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GameError } from "../src/game/engine.ts";
import { parseClientMessage } from "../src/game/protocol.ts";
import { FLOWS, ROLES } from "../src/game/types.ts";
import { newGame } from "./helpers.ts";
import { fullTable, SimPlayer, startServer } from "./sim.ts";

let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const randStr = (n: number) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(rnd() * 0xffff))).join("");

function junkMessage(cardIds: string[]): string {
  const t = pick(["play", "sit", "identify", "host", "tell", "start", "stand", "ping", "nope", "", null, 5]);
  const variants: unknown[] = [
    { t, cardId: pick([...cardIds, "forged", "", "x".repeat(100), 42, null, { $gt: "" }]) },
    { t, role: pick([...ROLES, "admin", "", 0]) },
    { t, flow: pick([...FLOWS, "OBO", "__proto__"]) },
    { t: "host", action: pick(["next", "replay", "goto", "forceReveal", "delete"]), round: pick([0, 3, -1, 1.5, 9999, "1"]) },
    { t: "play", cardId: pick(cardIds.length ? cardIds : ["x"]), extra: 1 },
    JSON.parse('{"t":"play","__proto__":{"admin":true},"cardId":"x"}'),
    [1, 2, 3],
  ];
  return pick([
    () => JSON.stringify(pick(variants)),
    () => randStr(Math.floor(rnd() * 200)),
    () => "{".repeat(Math.floor(rnd() * 500)),
    () => JSON.stringify({ t: "play", cardId: "a" }) + "x".repeat(2000),
    () => "null",
    () => '"string"',
  ])();
}

describe("in-process fuzz", () => {
  test("parser never throws and only accepts well-formed messages", () => {
    for (let i = 0; i < 20_000; i++) {
      const raw = junkMessage(["c1", "c2"]);
      const m = parseClientMessage(raw);
      if (m) expect(["play", "sit", "identify", "host", "tell", "start", "stand", "ping"]).toContain(m.t);
    }
    expect(parseClientMessage(new ArrayBuffer(8))).toBeNull();
  });

  test("engine survives random messages from random players; invariants hold", () => {
    const { g, host } = newGame();
    g.start(host);
    const ids = g.state.players.map((p) => p.id).concat(["ghost"]);
    let gameErrors = 0;
    for (let i = 0; i < 20_000; i++) {
      const who = pick(ids);
      const view = g.player(who) ? g.privateView(who) : null;
      const cards = view?.hand.map((h) => h.id) ?? [];
      // mix of plausible moves (to make progress) and garbage
      const raw = rnd() < 0.5 && view?.canPlay.length ? JSON.stringify({ t: "play", cardId: pick(view.canPlay) }) : junkMessage(cards);
      const m = parseClientMessage(raw);
      if (!m) continue;
      try {
        if (m.t === "play") g.play(who, m.cardId);
        else if (m.t === "sit") g.sit(who, m.role);
        else if (m.t === "identify") g.identify(who, m.flow);
        else if (m.t === "tell") g.tell(who);
        else if (m.t === "host") g.hostAction(who, m.action, m.round);
        else if (m.t === "start") g.start(who);
      } catch (e) {
        if (!(e instanceof GameError)) throw e; // anything else is a crash
        gameErrors++;
      }
      // invariants
      const roles = g.state.players.map((p) => p.role).filter(Boolean);
      expect(new Set(roles).size).toBe(roles.length);
      const r = g.state.round;
      if (r) {
        const all = ROLES.flatMap((role) => r.hands[role].map((c) => c.id));
        expect(new Set(all).size).toBe(all.length);
      }
    }
    expect(gameErrors).toBeGreaterThan(0);
  });
});

describe("live fuzz against PartyKit", () => {
  let server: { host: string; stop: () => void };
  beforeAll(async () => {
    server = await startServer();
  }, 90_000);
  afterAll(() => server?.stop());

  test(
    "garbage, forged ids and out-of-turn plays are refused; no hand leaks; server stays up",
    async () => {
      const { players } = await fullTable(server.host);
      for (const p of players) p.keepRaw = true;
      const [host, attacker, victim] = players as [SimPlayer, SimPlayer, SimPlayer, SimPlayer];
      host.send({ t: "start" });
      await host.waitFor(() => !!host.state?.started);
      await victim.waitFor(() => (victim.you?.hand.length ?? 0) > 0);
      const victimCards = victim.you!.hand.map((c) => c.id);

      for (let i = 0; i < 300; i++) {
        attacker.send(junkMessage(victimCards));
        if (i % 50 === 0) attacker.ws.send(new Uint8Array([0, 1, 2, 255]));
        if (i % 25 === 0) await Bun.sleep(300); // stay mostly under the per-socket rate limit
      }
      for (const id of victimCards) attacker.send({ t: "play", cardId: id }); // someone else's cards
      await Bun.sleep(1500);

      // server still answers
      const v = host.version;
      host.send({ t: "ping" });
      await host.waitFor(() => host.errors.includes("__pong__"));
      expect(host.version).toBeGreaterThanOrEqual(v);
      expect(attacker.errors.length).toBeGreaterThan(0);
      // victim's cards never reached the attacker
      for (const raw of attacker.raw) for (const id of victimCards) expect(raw.includes(id)).toBe(false);
      // and the victim still has them (nothing was played for them)
      for (const id of victimCards) expect(victim.you!.hand.some((c) => c.id === id) || victim.state!.round!.index > 0).toBe(true);
      for (const p of players) p.close();
    },
    60_000,
  );
});

// Live fuzzing against the Rust server (parser/engine fuzz runs in `cargo test`): random / malformed / forged / out-of-turn input must be rejected without
// crashing the server or leaking another player's hand.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FLOWS, ROLES } from "../src/game/types.ts";
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

describe("live fuzz against the server", () => {
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
        if (i % 50 === 0) attacker.send(new Uint8Array([0, 1, 2, 255]) as Uint8Array<ArrayBuffer>);
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

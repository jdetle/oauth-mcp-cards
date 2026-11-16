import { describe, expect, test } from "bun:test";
import { totalScore } from "../src/game/engine.ts";
import { SCENARIOS } from "../src/game/scenarios.ts";
import { ROLES } from "../src/game/types.ts";
import { activePlayer, indexOf, newGame, solve } from "./helpers.ts";

const cardByLabel = (g: ReturnType<typeof newGame>["g"], text: string) => {
  const pid = activePlayer(g);
  const c = g.privateView(pid).hand.find((x) => x.label.includes(text));
  if (!c) throw new Error(`no card "${text}" in ${g.privateView(pid).hand.map((h) => h.label).join(" | ")}`);
  return [pid, c.id] as const;
};

describe("every scenario has an unbroken chain", () => {
  for (const s of SCENARIOS) {
    test(`${s.id}`, () => {
      const { g, host } = newGame();
      g.hostAction(host, "goto", indexOf(s.id));
      const r = solve(g);
      expect(r.status).toBe("done");
      expect(r.result?.success).toBe(true);
    });
  }
});

describe("OBO learning round", () => {
  test("correct play scores one point per role", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    g.play(...cardByLabel(g, "with the user's token slip"));
    g.play(...cardByLabel(g, "scope calendar.read)"));
    g.play(...cardByLabel(g, "Issue"));
    g.play(...cardByLabel(g, "Accept"));
    const r = g.state.round!;
    expect(r.result!.success).toBe(true);
    for (const role of ROLES) expect(g.player(players[role].id)!.score.calls).toBe(1);
  });

  test("forwarding the raw token breaks the chain; MCP still scores for rejecting", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    g.play(...cardByLabel(g, "with the user's token slip"));
    g.play(...cardByLabel(g, "Forward the token"));
    expect(g.state.round!.activeRole).toBe("mcp");
    g.play(...cardByLabel(g, "Reject"));
    const res = g.state.round!.result!;
    expect(res.success).toBe(false);
    expect(res.failedStep!.role).toBe("application");
    expect(res.explanation).toContain("exchange, not relay");
    expect(g.player(players.mcp.id)!.score.calls).toBe(1);
    expect(g.player(players.application.id)!.score.calls).toBe(0);
    expect(res.traps.length).toBe(0); // forward isn't marked as a trap card, but it broke the chain
  });

  test("over-broad exchange: IdP rejects, earns the point", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    g.play(...cardByLabel(g, "with the user's token slip"));
    g.play(...cardByLabel(g, "scope calendar.*)"));
    g.play(...cardByLabel(g, "Reject"));
    const res = g.state.round!.result!;
    expect(res.success).toBe(false);
    expect(res.explanation).toContain("consented");
    expect(g.player(players.idp.id)!.score.calls).toBe(1);
    expect(res.traps[0]).toContain("trap");
  });
});

describe("JAG learning round", () => {
  test("an app-subject token for user data is rejected by the MCP Server", () => {
    const { g, host } = newGame();
    g.hostAction(host, "goto", indexOf("assess-inbox")); // user-scoped data
    for (const role of ROLES) g.identify(g.state.round!.seats[role]!, "jag");
    g.play(...cardByLabel(g, "with the user's token slip"));
    g.play(...cardByLabel(g, "Signed Assertion: JWT signed with your private key, audience = IdP"));
    // IdP lets it through (no bonus) ...
    g.play(...cardByLabel(g, "Issue"));
    // ... MCP Server catches the app subject on user data
    g.play(...cardByLabel(g, "Reject"));
    const r = g.state.round!;
    expect(r.result!.success).toBe(false);
    expect(r.log.some((l) => l.text.includes("application"))).toBe(true);
    expect(r.result!.guesses.every((x) => !x.correct)).toBe(true);
  });

  test("IdP bonus for refusing a wrong-flow play that would technically work", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("assess-inbox"));
    for (const role of ROLES) g.identify(g.state.round!.seats[role]!, "obo");
    g.play(...cardByLabel(g, "with the user's token slip"));
    g.play(...cardByLabel(g, "Signed Assertion: JWT signed with your private key, audience = IdP"));
    g.play(...cardByLabel(g, "Reject"));
    const idp = g.player(players.idp.id)!;
    expect(idp.score.bonus).toBe(1);
    expect(idp.score.calls).toBe(1);
    expect(idp.score.identify).toBe(1);
  });
});

describe("assessment mechanics", () => {
  test("guesses are private until the round ends, then scored", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("assess-archive"));
    g.identify(players.client.id, "obo");
    const pub = g.publicState();
    expect(JSON.stringify({ ...pub.round, flowChoices: [] })).not.toContain('"obo"');
    expect(JSON.stringify(pub)).not.toContain("Archive");
    expect(pub.round!.flowLabel).toBeNull();
    expect(pub.round!.status).toBe("identify");
    expect(() => g.play(players.client.id, g.privateView(players.client.id).hand[0]!.id)).toThrow();
    solve(g);
    const res = g.state.round!.result!;
    expect(res.guesses.find((x) => x.playerId === players.client.id)!.correct).toBe(false);
    expect(g.player(players.mcp.id)!.score.identify).toBe(1);
  });

  test("spot the tell: first correct caller scores, later callers don't", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-jag"));
    g.tell(players.idp.id);
    expect(() => g.tell(players.mcp.id)).toThrow();
    expect(g.player(players.idp.id)!.score.bonus).toBe(1);
    expect(g.player(players.mcp.id)!.score.bonus).toBe(0);
  });

  test("spot the tell is wrong when a user is present", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    g.tell(players.idp.id);
    expect(g.player(players.idp.id)!.score.bonus).toBe(0);
  });
});

describe("table rules", () => {
  test("seats rotate after each round", () => {
    const { g, host, players } = newGame();
    g.start(host);
    solve(g);
    g.hostAction(host, "next");
    expect(g.player(players.client.id)!.role).toBe("application");
    expect(g.player(players.mcp.id)!.role).toBe("client");
  });

  test("replay keeps seats; a full game runs start to finish", () => {
    const { g, host } = newGame();
    g.start(host);
    for (let i = 0; i < SCENARIOS.length; i++) {
      if (i > 0) g.hostAction(host, "next");
      expect(solve(g).result!.success).toBe(true);
    }
    expect(() => g.hostAction(host, "next")).toThrow();
    const total = g.state.players.reduce((n, p) => n + totalScore(p.score), 0);
    expect(total).toBeGreaterThan(SCENARIOS.length * 2);
  });

  test("out-of-turn, forged and non-host actions are refused", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    const mcpCard = g.privateView(players.mcp.id).hand[0]!.id;
    expect(() => g.play(players.mcp.id, mcpCard)).toThrow("not your turn");
    expect(() => g.play(players.client.id, mcpCard)).toThrow("No such card");
    expect(() => g.play(players.client.id, "forged")).toThrow("No such card");
    expect(() => g.hostAction(players.mcp.id, "next")).toThrow("host");
  });

  test("private view holds only your own hand, and never reveals traps", () => {
    const { g, host, players } = newGame();
    g.hostAction(host, "goto", indexOf("learning-obo"));
    const mine = g.privateView(players.application.id);
    expect(mine.hand.length).toBeGreaterThan(3);
    expect(JSON.stringify(mine)).not.toContain('"trap"');
    const others = ROLES.filter((r) => r !== "application").flatMap((r) => g.privateView(players[r].id).hand.map((c) => c.id));
    expect(others.some((id) => mine.hand.some((c) => c.id === id))).toBe(false);
    expect(JSON.stringify(g.publicState())).not.toContain(mine.hand[0]!.id);
  });

  test("need four seats to start", () => {
    const { g } = newGame();
    const { g: g2 } = { g };
    g2.state.players[3]!.role = null;
    expect(() => g2.start(g2.state.hostId!)).toThrow("Need all four seats");
  });
});

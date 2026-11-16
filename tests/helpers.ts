import { Game } from "../src/game/engine.ts";
import { SCENARIOS } from "../src/game/scenarios.ts";
import { FREE_CARDS, ROLES, type Role } from "../src/game/types.ts";

export function newGame(now = () => 1_800_000_000_000) {
  let n = 0;
  const g = new Game(SCENARIOS, { room: "test-room" }, { now, newId: () => `id${++n}` });
  const players = Object.fromEntries(ROLES.map((r) => [r, g.addPlayer(r.toUpperCase(), r)])) as unknown as Record<Role, { id: string }>;
  return { g, players, host: players.client.id };
}

export function indexOf(id: string): number {
  const i = SCENARIOS.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`no scenario ${id}`);
  return i;
}

export function activePlayer(g: Game): string {
  const r = g.state.round!;
  return r.seats[r.activeRole!]!;
}

/** Try every playable card on a copy; return the first whose move is not a mistake. */
export function bestCard(g: Game): string {
  const pid = activePlayer(g);
  const view = g.privateView(pid);
  const candidates = view.hand.filter((c) => view.canPlay.includes(c.id) && !FREE_CARDS.includes(c.type));
  for (const c of candidates) {
    const copy = new Game(g.scenarios, structuredClone(g.state), { now: () => 1_800_000_000_000 });
    copy.play(pid, c.id);
    const m = copy.state.round!.moves.at(-1)!;
    if (m.correct !== false) {
      // look one step further: prefer moves that don't end the round in failure
      if (copy.state.round!.status === "done" && !copy.state.round!.result!.success) continue;
      return c.id;
    }
  }
  throw new Error(`no good card for ${g.state.round!.activeRole} in ${g.state.round!.scenarioId}: ${candidates.map((c) => c.label).join(" | ")}`);
}

/** Play the round to the end making the right call at every step. */
export function solve(g: Game, maxSteps = 30) {
  const r = () => g.state.round!;
  if (r().status === "identify") {
    const s = g.scenarios[r().index]!;
    for (const role of ROLES) if (!r().guesses[r().seats[role]!]) g.identify(r().seats[role]!, s.expectedFlows![0]!);
  }
  for (let i = 0; i < maxSteps && r().status === "playing"; i++) g.play(activePlayer(g), bestCard(g));
  return r();
}

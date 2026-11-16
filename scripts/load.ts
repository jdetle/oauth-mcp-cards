// Load / stress test: N concurrent rooms, four simulated players each, full games.
// Usage: bun scripts/load.ts [--rooms 50] [--host 127.0.0.1:8080] [--rounds 28]
// With no --host it starts its own Rust server (release build).
import { FREE_CARDS, FLOWS, type RoundResult } from "../src/game/types.ts";
import { fullTable, SCENARIO_COUNT, SimPlayer, startServer } from "../tests/sim.ts";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : def;
};
const ROOMS = Number(arg("rooms", "50"));
const ROUNDS = Math.min(Number(arg("rounds", String(SCENARIO_COUNT))), SCENARIO_COUNT);
const server = process.argv.includes("--host") ? { host: arg("host", ""), stop: () => {} } : await startServer();

const latencies: number[] = [];
let plays = 0;
let serverErrors = 0;
const problems: string[] = [];

const THINK_MS = Number(arg("think", "250"));

function bot(p: SimPlayer, isHost: boolean, results: RoundResult[], done: () => void) {
  let acted = -1;
  let guessedRound = -1;
  let pendingSince = 0;
  let pendingSeq = -1;
  // think time, like a (fast) human: keeps each socket under the server's rate limit
  const later = (fn: () => void) => setTimeout(fn, THINK_MS / 2 + Math.random() * THINK_MS);
  const tick = () => {
    const s = p.state;
    const you = p.you;
    if (!s || !you || p.version === acted) return;
    const r = s.round;
    if (pendingSince && r && (r.log.at(-1)?.seq ?? 0) > pendingSeq) {
      latencies.push(performance.now() - pendingSince);
      pendingSince = 0;
    }
    acted = p.version;
    if (!r) return;
    if (r.status === "done") {
      if (isHost && !results.some((x) => x === r.result) && results.length <= r.index) {
        results.push(r.result!);
        if (r.index + 1 >= ROUNDS) return done();
        later(() => p.send({ t: "host", action: "next" }));
      }
      return;
    }
    if (r.status === "identify" && !you.myGuess && you.role && guessedRound !== r.index) {
      guessedRound = r.index;
      later(() => p.send({ t: "identify", flow: FLOWS[Math.floor(Math.random() * FLOWS.length)]! }));
      return;
    }
    if (r.status === "playing" && you.canPlay.length) {
      const real = you.hand.filter((c) => you.canPlay.includes(c.id) && !FREE_CARDS.includes(c.type));
      const free = you.hand.filter((c) => you.canPlay.includes(c.id) && FREE_CARDS.includes(c.type));
      const card = free.length && Math.random() < 0.1 ? free[0]! : real[Math.floor(Math.random() * real.length)];
      if (!card) return;
      later(() => {
        if (p.you?.canPlay.includes(card.id) === false) return;
        pendingSince = performance.now();
        pendingSeq = r.log.at(-1)?.seq ?? 0;
        plays++;
        p.send({ t: "play", cardId: card.id });
      });
    }
  };
  const orig = p.ws.onmessage!;
  p.ws.onmessage = (ev) => {
    orig.call(p.ws, ev);
    const m = JSON.parse(String(ev.data));
    if (m.t === "error") {
      serverErrors++;
      problems.push(`${p.room}/${p.name}: ${m.message}`);
      if (m.message === "Slow down.") guessedRound = -1;
      acted = -1; // re-evaluate (a lost race or a rate-limit refusal)
      setTimeout(tick, m.message === "Slow down." ? 1000 : 50);
    }
    tick();
  };
  return tick;
}

async function runRoom(i: number) {
  const { players, room } = await fullTable(server.host, `load-pw-${i}`);
  const results: RoundResult[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${room}: game did not finish (round ${results.length}) ` + JSON.stringify(players.map((p) => ({ v: p.version, cc: p.closeCode, st: p.state?.round?.status, idx: p.state?.round?.index, active: p.state?.round?.activeRole, role: p.you?.role, guess: p.you?.myGuess, can: p.you?.canPlay.length, sub: p.state?.round?.identifySubmitted.length }))))), Number(arg("timeout", "300000")));
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    players.forEach((p, k) => bot(p, k === 0, results, finish));
    players[0]!.send({ t: "start" });
  });
  // invariants: awarded points = scoreboard; nobody saw another player's cards
  await Bun.sleep(300);
  const st = players[0]!.state!;
  const board = st.players.reduce((n, p) => n + p.score.calls + p.score.identify + p.score.bonus, 0);
  const awarded = results.reduce((n, r) => n + r.awards.reduce((m, a) => m + a.points, 0), 0);
  if (board !== awarded) problems.push(`${room}: scoreboard ${board} != awarded ${awarded}`);
  if (results.length !== ROUNDS) problems.push(`${room}: ${results.length}/${ROUNDS} rounds`);
  if (st.room !== room) problems.push(`${room}: state for wrong room ${st.room}`);
  const hands = players.map((p) => new Set(p.you!.hand.map((c) => c.id)));
  hands.forEach((h, a) => hands.forEach((o, b) => a !== b && [...h].some((id) => o.has(id)) && problems.push(`${room}: hands overlap`)));
  for (const p of players) p.close();
  return results;
}

const t0 = performance.now();
console.log(`load: ${ROOMS} rooms × 4 players × ${ROUNDS} rounds against ${server.host}`);
const settled = await Promise.allSettled(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
const secs = (performance.now() - t0) / 1000;
server.stop();

const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
latencies.sort((a, b) => a - b);
const pct = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(1) : "n/a");
const successes = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).filter((r) => r.success).length;
console.log(`
rooms completed : ${ROOMS - failed.length}/${ROOMS}
duration        : ${secs.toFixed(1)}s
plays           : ${plays} (${(plays / secs).toFixed(0)}/s)
latency ms      : p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${pct(1)}
server errors   : ${serverErrors} (${((serverErrors / Math.max(1, plays)) * 100).toFixed(2)}% of plays)
rounds won      : ${successes} (random bots, so most chains break, as expected)
invariant issues: ${problems.filter((p) => !p.includes(": ") || p.includes("!=") || p.includes("overlap") || p.includes("rounds") || p.includes("wrong room")).length}`);
for (const f of failed.slice(0, 5)) console.log("FAILED:", f.reason?.message ?? f.reason);
for (const p of problems.slice(0, 10)) console.log("  ", p);
process.exit(failed.length || problems.some((p) => p.includes("!=") || p.includes("overlap") || p.includes("wrong room")) ? 1 : 0);

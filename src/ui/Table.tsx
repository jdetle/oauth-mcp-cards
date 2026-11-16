"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QUICK_REF } from "../game/reference.ts";
import {
  FLOW_NAMES,
  FREE_CARDS,
  ROLES,
  ROLE_NAMES,
  type ClientMessage,
  type Flow,
  type PrivateView,
  type PublicState,
  type Role,
  type ServerMessage,
} from "../game/types.ts";
import { wsUrl } from "./api.ts";
import { JoinForm } from "./JoinForm.tsx";
import { BitGlyph, Board, ScrambleSuit, ScrambleText } from "./Board.tsx";
import { CardFX } from "./CardFX.tsx";
import { KeysContext, Seal } from "./Seal.tsx";
import { CallPair, rememberRoom, Timeline } from "./Timeline.tsx";
import { TokenSlip } from "./Slip.tsx";

type Conn = "connecting" | "open" | "closed" | "unauthorized" | "deleted";

/** WebSocket with automatic reconnect. The session cookie authenticates it; close code 4401 = not joined. */
function useGame(room: string, attempt: number) {
  const [state, setState] = useState<PublicState | null>(null);
  const [you, setYou] = useState<PrivateView | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [error, setError] = useState<string | null>(null);
  const sock = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;
    setConn("connecting");
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const ws = new WebSocket(wsUrl(room));
      sock.current = ws;
      // if the socket opens but no state arrives, drop it and reconnect
      watchdog = setTimeout(() => ws.readyState !== WebSocket.CLOSED && ws.close(), 6000);
      ws.onopen = () => {
        backoff = 500;
        setConn("open");
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 4401) return setConn("unauthorized");
        if (e.code === 4410) return setConn("deleted"); // an admin closed this game
        setConn("closed");
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
      ws.onmessage = (e) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.t === "state") {
          if (watchdog) clearTimeout(watchdog);
          setState(m.state);
          setYou(m.you);
          setConn("open");
        } else if (m.t === "error") setError(m.message);
      };
    };
    connect();
    const ping = setInterval(() => sock.current?.readyState === WebSocket.OPEN && sock.current.send(JSON.stringify({ t: "ping" })), 25_000);
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (watchdog) clearTimeout(watchdog);
      clearInterval(ping);
      sock.current?.close();
    };
  }, [room, attempt]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const send = useCallback((m: ClientMessage) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify(m));
  }, []);
  return { state, you, conn, error, send };
}

export function Table({ room }: { room: string }) {
  const [attempt, setAttempt] = useState(0);
  const g = useGame(room, attempt);

  if (g.conn === "deleted") {
    rememberRoom(null);
    return (
      <main className="wrap stack">
        <section className="panel stack">
          <p className="kicker">Game over</p>
          <h1 className="room-name">{room}</h1>
          <p>This game was closed by an admin.</p>
          <a href="/">← Back to the lobby</a>
        </section>
      </main>
    );
  }
  if (g.conn === "unauthorized") {
    return (
      <main className="wrap stack">
        <a href="/">← Lobby</a>
        <section className="panel stack">
          <h1 className="room-name">{room}</h1>
          <p className="muted">Enter the room password to join.</p>
          <JoinForm room={room} autoFocus onJoined={() => setAttempt((a) => a + 1)} />
        </section>
      </main>
    );
  }
  if (!g.state || !g.you) return <main className="wrap">Connecting to {room}…</main>;
  rememberRoom(room);
  return <Game room={room} state={g.state} you={g.you} conn={g.conn} error={g.error} send={g.send} leave={() => { location.href = "/"; }} />;
}

function Game(props: {
  room: string;
  state: PublicState;
  you: PrivateView;
  conn: Conn;
  error: string | null;
  send: (m: ClientMessage) => void;
  leave: () => void;
}) {
  const { state, you, send, conn, error } = props;
  const r = state.round;
  const byId = useMemo(() => new Map(state.players.map((p) => [p.id, p])), [state.players]);
  const myRoundRole = r ? (ROLES.find((role) => r.seats[role] === you.playerId) ?? null) : null;
  const myTurn = !!r && r.status === "playing" && !!myRoundRole && r.activeRole === myRoundRole;
  const playable = you.hand.filter((c) => you.canPlay.includes(c.id));
  // on phones the hand is a drawer: it opens by itself when it's your turn
  const [handOpen, setHandOpen] = useState(false);
  useEffect(() => setHandOpen(myTurn), [myTurn, r?.index]);

  // number keys play the nth playable card
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && playable[n - 1]) send({ t: "play", cardId: playable[n - 1]!.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playable, send]);

  const total = (id: string) => {
    const s = byId.get(id)?.score;
    return s ? s.calls + s.identify + s.bonus : 0;
  };

  return (
    <KeysContext.Provider value={state.keys}>
    <main className="wrap">
      <div className="game">
        <div className="stack" style={{ minWidth: 0 }}>
          <Hud room={props.room} state={state} you={you} conn={conn} role={myRoundRole ?? you.role} />

          {error ? <div className="error" role="alert">{error}</div> : null}

          {you.isHost ? <HostControls state={state} send={send} /> : null}

          {!state.started || !r ? (
            <section className="panel stack">
              <h2>{state.players.filter((p) => p.role).length === 4 ? "All four ports live" : "Waiting for four players"}</h2>
              <p className="muted small">Share the room name <b>{props.room}</b> and the password. {state.players.filter((p) => p.role).length}/4 seats filled.</p>
              {state.players.filter((p) => p.role).length < 4 ? (
                <div className="row">
                  <button className="primary" onClick={() => send({ t: "host", action: "addBots" })}>
                    Fill {4 - state.players.filter((p) => p.role).length} empty seat{4 - state.players.filter((p) => p.role).length === 1 ? "" : "s"} with sims
                  </button>
                  <span className="muted small">Sims play the other roles for you. Anyone who joins later takes over a sim's seat.</span>
                </div>
              ) : null}
              {you.isHost ? <p className="small">When all four seats are filled, press <b>Start game</b>.</p> : <p className="small">The host starts the game.</p>}
            </section>
          ) : (
            <section className="panel scenario stack" aria-labelledby="scn-h">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 id="scn-h" style={{ margin: 0 }}><ScrambleText key={r.title} text={r.title} /></h2>
                {r.flowLabel ? <span className="flow">{r.flowLabel}</span> : <span className="flow classified"><ScrambleText text="FLOW CLASSIFIED" hidden /></span>}
              </div>
              <p className="briefing">{r.text}</p>
              {r.tellEnabled && myRoundRole ? (
                <div className="row">
                  <button onClick={() => send({ t: "tell" })} disabled={!!r.tellAwardedTo}>
                    ⚠ No user is present!
                  </button>
                  <span className="muted small">{r.tellAwardedTo ? `${byId.get(r.tellAwardedTo)?.name} called it first.` : "Spot the tell: first correct call scores a bonus."}</span>
                </div>
              ) : null}
            </section>
          )}

          <CardFX round={r} />
          <Board state={state} youId={you.playerId} myRoundRole={myRoundRole} myTurn={myTurn} onSit={(role) => send({ t: "sit", role })} scores={total} />

          {r?.status === "identify" && myRoundRole ? <Identify you={you} choices={r.flowChoices} send={send} /> : null}
          {r?.status === "done" && r.result ? <Result state={state} you={you} send={send} /> : null}

          {myRoundRole && r && r.status !== "done" ? (
            <section className={`hand-panel r-${myRoundRole}${handOpen ? "" : " collapsed"}`} aria-label="Your hand">
              <div className="hand-head">
                <button className="hand-toggle" onClick={() => setHandOpen(!handOpen)} aria-expanded={handOpen} aria-controls="hand-body">
                  <strong>Your hand · {ROLE_NAMES[myRoundRole]}</strong> <span aria-hidden>{handOpen ? "▾" : "▴"}</span>
                </button>
                <span className="muted small">{myTurn ? "Your turn: press 1–9 or tap a highlighted card" : "Wait for your turn"}</span>
              </div>
              {myTurn && r.inFlight && r.slips.length ? (
                <p className="incoming">
                  <b>Incoming</b> from {ROLE_NAMES[r.inFlight.from]}: {r.slips[r.slips.length - 1]!.label}
                </p>
              ) : null}
              <div id="hand-body" className="hand-body">
              {you.slips.length ? (
                <div className="my-slips" aria-label="Token slips you hold">
                  {you.slips.map((t) => <TokenSlip key={t.id} token={t} title="Slip in your pocket" />)}
                </div>
              ) : null}
              <div className="hand">
                {you.hand.length === 0 ? <span className="muted small">No cards for you this round. Watch the flow.</span> : null}
                {you.hand.map((c) => {
                  const idx = playable.indexOf(c);
                  const can = idx >= 0;
                  return (
                    <button key={c.id} className={`card cat-${c.category.toLowerCase().replace(/\s+/g, "-")}${can ? " playable" : ""}`} disabled={!can} onClick={() => send({ t: "play", cardId: c.id })} aria-keyshortcuts={can && idx < 9 ? String(idx + 1) : undefined}>
                      <span className="cat">
                        <span>{c.category}{FREE_CARDS.includes(c.type) ? " · free check" : ""}</span>
                        {can && idx < 9 ? <span className="key">{idx + 1}</span> : null}
                      </span>
                      <span className="label">{c.label}</span>
                    </button>
                  );
                })}
              </div>
              </div>
            </section>
          ) : null}
        </div>

        <Side state={state} you={you} send={send} myRoundRole={myRoundRole} leave={props.leave} />
      </div>
    </main>
    </KeysContext.Provider>
  );
}

const PHASE_LABEL: Record<string, string> = { warmup: "Warm-up", learning: "Learning", assessment: "Assessment" };

/** One slim bar: where you are, how far through the game, who you are. */
function Hud({ room, state, you, conn, role }: { room: string; state: PublicState; you: PrivateView; conn: Conn; role: Role | null }) {
  const r = state.round;
  const phases = ["warmup", "learning", "assessment"] as const;
  return (
    <header className="hud">
      <a className="brand" href="/" aria-label="Back to lobby">
        OAUTH<i>//</i>MCP
      </a>
      <div className="hud-room">
        <span>room</span>
        <b>{room}</b>
      </div>
      <div className="hud-progress" aria-label={r ? `${PHASE_LABEL[r.phase]}, round ${r.index + 1} of ${state.rounds.length}` : "Not started"}>
        <div className="ticks" aria-hidden>
          {phases.map((ph) => (
            <span key={ph} className={`phase${r?.phase === ph ? " now" : ""}`}>
              {state.rounds.filter((x) => x.phase === ph).map((x) => (
                <i key={x.index} className={r ? (x.index < r.index ? "done" : x.index === r.index ? "cur" : "") : ""} />
              ))}
            </span>
          ))}
        </div>
        <div className="hud-label">{r ? <>{PHASE_LABEL[r.phase]} <b>{r.index + 1}</b>/{state.rounds.length}</> : "Not started"}</div>
      </div>
      <div className={`hud-me${role ? ` r-${role}` : ""}`}>
        <span className={`conn ${conn === "open" ? "on" : "off"}`} role="status" aria-label={conn === "open" ? "Connected" : "Reconnecting"} title={conn === "open" ? "Connected" : "Reconnecting…"} />
        <ScrambleSuit id={you.playerId} size={20} />
        <b>{you.name}</b>
        <span className="role-chip">{role ? ROLE_NAMES[role] : "Spectator"}</span>
      </div>
    </header>
  );
}

function HostControls({ state, send }: { state: PublicState; send: (m: ClientMessage) => void }) {
  const r = state.round;
  const [target, setTarget] = useState(r?.index ?? 0);
  useEffect(() => setTarget(r?.index ?? 0), [r?.index]);
  return (
    <section className="hostbar" aria-label="Host controls">
      <span className="hostbar-label">Host</span>
      {!state.started ? <button className="primary" onClick={() => send({ t: "start" })}>Start game</button> : null}
      {r?.status === "done" ? <button className="primary" onClick={() => send({ t: "host", action: "next" })} disabled={r.index + 1 >= state.rounds.length}>Next round</button> : null}
      {r ? <button onClick={() => send({ t: "host", action: "replay" })}>Replay</button> : null}
      {r?.status === "identify" ? <button onClick={() => send({ t: "host", action: "forceReveal" })}>Start play now</button> : null}
      {state.players.some((p) => p.bot) && (!r || r.status === "done") ? <button onClick={() => send({ t: "host", action: "removeBots" })}>Remove sims</button> : null}
      <label className="row" style={{ display: "flex", gap: 6 }}>
        <span className="sr-only">Jump to round</span>
        <select aria-label="Jump to round" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {state.rounds.map((x) => (
            <option key={x.index} value={x.index}>{x.index + 1}. {x.title}</option>
          ))}
        </select>
      </label>
      <button onClick={() => send({ t: "host", action: "goto", round: target })}>Jump</button>
    </section>
  );
}

function Identify({ you, choices, send }: { you: PrivateView; choices: Flow[]; send: (m: ClientMessage) => void }) {
  return (
    <section className="panel stack" aria-labelledby="id-h">
      <h2 id="id-h">Which flow does this call for?</h2>
      <p className="muted small" style={{ margin: 0 }}>Your pick is private until the round ends. You can change it until play starts.</p>
      <div className="flow-choices" role="radiogroup">
        {choices.map((f) => (
          <label key={f}>
            <input type="radio" name="flow" checked={you.myGuess === f} onChange={() => send({ t: "identify", flow: f })} />
            {FLOW_NAMES[f]}
          </label>
        ))}
      </div>
    </section>
  );
}

function Result({ state, you, send }: { state: PublicState; you: PrivateView; send: (m: ClientMessage) => void }) {
  const res = state.round!.result!;
  return (
    <section className={`panel result stack ${res.success ? "ok" : "bad"}`} aria-labelledby="res-h" aria-live="polite">
      <div className="result-head">
        {res.success ? <span className="seal" aria-hidden>◆</span> : <BitGlyph />}
        <h2 id="res-h">{res.success ? "Chain unbroken" : `Chain broken at ${ROLE_NAMES[res.failedStep!.role]} (${res.failedStep!.playerName})`}</h2>
      </div>
      {res.failedStep ? <p style={{ margin: 0 }}><b>The move:</b> {res.failedStep.text}</p> : null}
      <div className="calls" aria-label="Expected versus played, move by move">
        <h3>Expected vs played</h3>
        <ol>
          {state.round!.log.filter((l) => l.call && l.role).map((l) => (
            <li key={l.seq}>
              <span className={`calls-who r-${l.role}`}>{ROLE_NAMES[l.role!]}</span>
              <CallPair call={l.call!} />
            </li>
          ))}
        </ol>
        <p className="muted small">Colour is the kind of call: red stops, green lets through. A red Reject that was expected is a match.</p>
      </div>
      <p style={{ margin: 0 }}>{res.explanation}</p>
      {res.tells ? <p className="small" style={{ margin: 0 }}><b>Tells:</b> {res.tells}</p> : null}
      {res.discussion ? <p className="small" style={{ margin: 0 }}><b>Discuss:</b> {res.discussion}</p> : null}
      {res.teaches.length ? (
        <div className="small"><b>What this round teaches</b><ul>{res.teaches.map((t) => <li key={t}>{t}</li>)}</ul></div>
      ) : null}
      {res.guesses.length ? (
        <div className="small"><b>Guesses</b><ul>{res.guesses.map((g) => <li key={g.playerId}>{g.correct ? "✓" : "✗"} {g.name}: {FLOW_NAMES[g.flow]}</li>)}</ul></div>
      ) : null}
      {res.traps.length ? <div className="small"><b>Traps played</b><ul>{res.traps.map((t) => <li key={t}>{t}</li>)}</ul></div> : null}
      <div className="small"><b>Points</b><ul>{res.awards.length ? res.awards.map((a, i) => <li key={i}>+{a.points} {a.name}: {a.why}</li>) : <li>None this round.</li>}</ul></div>
      {you.isHost ? (
        <div className="row">
          <button className="primary" onClick={() => send({ t: "host", action: "next" })} disabled={state.round!.index + 1 >= state.rounds.length}>Next round (seats rotate)</button>
          <button onClick={() => send({ t: "host", action: "replay" })}>Replay</button>
        </div>
      ) : <p className="muted small" style={{ margin: 0 }}>Waiting for the host to continue. Seats rotate each round.</p>}
    </section>
  );
}

function Side({ state, you, send, myRoundRole, leave }: { state: PublicState; you: PrivateView; send: (m: ClientMessage) => void; myRoundRole: Role | null; leave: () => void }) {
  const [tab, setTab] = useState<"log" | "score">("log");
  const r = state.round;
  const role = myRoundRole ?? you.role;
  const players = [...state.players].sort((a, b) => b.score.calls + b.score.identify + b.score.bonus - (a.score.calls + a.score.identify + a.score.bonus));
  return (
    <aside className="side">
      {role ? (
        <section className="panel stack small" aria-labelledby="qr-h">
          <h3 id="qr-h">Quick reference · {ROLE_NAMES[role]}</h3>
          <div><b>You hold:</b> {QUICK_REF[role].hold}</div>
          <div><b>You check:</b> {QUICK_REF[role].check}</div>
          <div><b>Never:</b> {QUICK_REF[role].never}</div>
          <div className="keyring" aria-label="Public keys on this table">
            <figure>
              <Seal of={state.keys.application} size={46} label="The Application's registered public key" />
              <figcaption>Application<br />public key</figcaption>
            </figure>
            <figure>
              <Seal of={state.keys.gateway} size={46} label="The gateway's public signing key" />
              <figcaption>Gateway<br />public key</figcaption>
            </figure>
            <p>Public keys are for everyone. A signature whose seal was made with the matching private key will check out against these.</p>
          </div>
          <div className="row">
            <a href="/reference/" target="_blank" rel="noreferrer">All auth flows →</a>
            <a href="/learn/" target="_blank" rel="noreferrer">How signatures work →</a>
          </div>
        </section>
      ) : null}
      <section className="panel stack">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>Timeline</button>
          <button role="tab" aria-selected={tab === "score"} onClick={() => setTab("score")}>Scoreboard</button>
        </div>
        {tab === "log" ? (
          <Timeline room={state.room} round={r} />
        ) : (
          <table className="score">
            <thead><tr><th>Player</th><th>Calls</th><th>ID</th><th>Bonus</th><th>Total</th></tr></thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <td><span className="who-cell"><ScrambleSuit id={p.id} size={20} still={!p.connected} /><span>{p.name}{p.isHost ? " ★" : ""}{p.bot ? <span className="sim-tag">sim</span> : null}<div className="muted small">{p.role ? ROLE_NAMES[p.role] : "spectator"}</div></span></span></td>
                  <td className="num">{p.score.calls}</td>
                  <td className="num">{p.score.identify}</td>
                  <td className="num">{p.score.bonus}</td>
                  <td className="num"><b>{p.score.calls + p.score.identify + p.score.bonus}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel row small">
        {state.started && state.players.filter((p) => p.role).length < 4 ? <button onClick={() => send({ t: "host", action: "addBots" })}>Fill empty seats with sims</button> : null}
        {you.role && (!r || r.status === "done") ? <button onClick={() => send({ t: "stand" })}>Stand up</button> : null}
        <button className="ghost" onClick={leave}>Leave room</button>
        {state.spectators ? <span className="muted">{state.spectators} watching</span> : null}
      </section>
    </aside>
  );
}

"use client";
// Between rounds: everyone says they're ready, or the table moves on after a minute idle.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, PrivateView, PublicState } from "../game/types.ts";
import { ScrambleSuit } from "./Board.tsx";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ReadyBar({ state, you, send }: { state: PublicState; you: PrivateView; send: (m: ClientMessage) => void }) {
  const rc = state.round?.readyCheck ?? null;
  const byId = useMemo(() => new Map(state.players.map((p) => [p.id, p])), [state.players]);

  // count down locally from the server's "time left" at the moment this state arrived
  const deadline = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (rc) deadline.current = Date.now() + rc.remainingMs;
  }, [rc]);
  useEffect(() => {
    if (!rc) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rc]);

  if (!rc) return null;
  const left = Math.max(0, deadline.current - now);
  const required = [...rc.ready, ...rc.waiting, ...rc.away];
  const mine = required.includes(you.playerId);
  const amReady = rc.ready.includes(you.playerId);
  const here = rc.ready.length + rc.waiting.length;
  const status = (id: string) => (rc.ready.includes(id) ? "ready" : rc.away.includes(id) ? "away" : "waiting");

  return (
    <section className="ready-bar" aria-label="Ready for the next round">
      <div className="ready-main">
        <div className="ready-copy">
          <strong>Next round</strong>
          <span className="muted small">
            {rc.waiting.length === 0 && here > 0 ? "Everyone's ready…" : `Starts when everyone's ready, or after ${Math.round(rc.timeoutMs / 1000)} seconds with no clicks.`}
          </span>
        </div>
        <div className="ready-timer" role="timer" aria-live="off" aria-label={`Moves on by itself in ${mmss(left)}`}>
          <span className="ready-clock">{mmss(left)}</span>
          <span className="ready-track" aria-hidden>
            <span style={{ transform: `scaleX(${Math.min(1, left / rc.timeoutMs)})` }} />
          </span>
        </div>
        {mine ? (
          amReady ? (
            <button className="ghost" onClick={() => send({ t: "ready", ready: false })}>Not yet</button>
          ) : (
            <button className="primary" onClick={() => send({ t: "ready", ready: true })} autoFocus>I'm ready</button>
          )
        ) : (
          <span className="muted small">Waiting for the players</span>
        )}
      </div>
      <ul className="ready-roster" aria-label={`${rc.ready.length} of ${here} ready`}>
        {required.map((id) => {
          const p = byId.get(id);
          const st = status(id);
          return (
            <li key={id} className={st}>
              <ScrambleSuit id={id} size={16} still={st === "away"} />
              <span>{p?.name ?? "?"}{id === you.playerId ? " (you)" : ""}</span>
              <em>{st === "ready" ? "ready ✓" : st === "away" ? "away · not waited for" : "waiting…"}</em>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

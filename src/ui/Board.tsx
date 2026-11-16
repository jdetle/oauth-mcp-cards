"use client";
// The game board: four terminals on a circuit, light packets on the traces,
// scramble-suit identities and a trap door where the chain breaks.
import { useEffect, useMemo, useState } from "react";
import { ROLES, ROLE_NAMES, type PublicPlayer, type PublicState, type Role } from "../game/types.ts";
import { InFlightSlip } from "./Slip.tsx";

type Pt = { x: number; y: number };

/** Terminal positions in a 1000×640 board, for wide and narrow layouts. */
const WIDE: Record<Role, Pt> = { client: { x: 500, y: 70 }, application: { x: 900, y: 320 }, idp: { x: 500, y: 570 }, mcp: { x: 100, y: 320 } };
const NARROW: Record<Role, Pt> = { client: { x: 250, y: 60 }, application: { x: 750, y: 60 }, idp: { x: 750, y: 580 }, mcp: { x: 250, y: 580 } };

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 720px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Right-angle circuit trace between two terminals, routed via the board's bus. */
function trace(a: Pt, b: Pt): string {
  if (a.x === b.x || a.y === b.y) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  return `M${a.x} ${a.y} L${a.x} ${b.y} L${b.x} ${b.y}`;
}

const FLOW: [Role, Role][] = [
  ["client", "application"],
  ["application", "idp"],
  ["idp", "mcp"],
  ["mcp", "client"],
];

/** Deterministic pseudo-random from a string (for scramble suits). */
function seeded(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
}

/** A shifting mosaic identity, after the scramble suits in A Scanner Darkly. */
export function ScrambleSuit({ id, size = 34, still = false }: { id: string; size?: number; still?: boolean }) {
  const cells = useMemo(() => {
    const r = seeded(id);
    const base = Math.floor(r() * 360);
    return Array.from({ length: 16 }, () => ({ h: (base + Math.floor(r() * 140) - 70 + 360) % 360, l: 30 + Math.floor(r() * 40), d: (r() * 3).toFixed(2) }));
  }, [id]);
  return (
    <span className={`suit${still ? " still" : ""}`} style={{ width: size, height: size }} aria-hidden>
      {cells.map((c, i) => (
        <i key={i} style={{ background: `hsl(${c.h} 70% ${c.l}%)`, animationDelay: `-${c.d}s` }} />
      ))}
    </span>
  );
}

const GLYPHS = "▓▒░█▚▞◢◣◤◥01#@%&";

/** Text that resolves out of noise (and stays scrambled while `hidden`). */
export function ScrambleText({ text, hidden = false }: { text: string; hidden?: boolean }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce && !hidden) return setShown(text);
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const settled = hidden ? 0 : Math.floor(frame * 1.5);
      setShown(
        text
          .split("")
          .map((ch, i) => (ch === " " || i < settled ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
          .join(""),
      );
      if (!hidden && settled >= text.length) clearInterval(id);
    }, hidden ? 140 : 35);
    return () => clearInterval(id);
  }, [text, hidden]);
  return (
    <span className={`scramble${hidden ? " hidden" : ""}`} aria-label={hidden ? "Classified until the round ends" : text}>
      <span aria-hidden>{shown}</span>
    </span>
  );
}

/** Two hatch panels that split open over the abyss. */
export function TrapDoor({ open, label }: { open: boolean; label?: string }) {
  return (
    <span className={`trapdoor${open ? " open" : ""}`} role={label ? "img" : undefined} aria-label={label}>
      <span className="pit" />
      <span className="hatch l" />
      <span className="hatch r" />
    </span>
  );
}

export function Board({
  state,
  youId,
  myRoundRole,
  myTurn,
  onSit,
  scores,
}: {
  state: PublicState;
  youId: string;
  myRoundRole: Role | null;
  myTurn: boolean;
  onSit: (r: Role) => void;
  scores: (id: string) => number;
}) {
  const wide = useWide();
  const pos = wide ? WIDE : NARROW;
  const r = state.round;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const seatPlayer = (role: Role): PublicPlayer | undefined => {
    const id = r && r.status !== "done" ? r.seats[role] : state.players.find((p) => p.role === role)?.id;
    return id ? byId.get(id) : undefined;
  };
  const last = r?.slips.at(-1);
  const live = r?.status === "playing" && last && r.inFlight ? last : null;
  const broken = r?.status === "done" && r.result && !r.result.success ? r.result.failedStep?.role : null;
  const used = new Set((r?.slips ?? []).map((s) => `${s.from}>${s.to}`));

  return (
    <section className="board" aria-label="Game board">
      <svg className="circuit" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden>
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* background etching */}
        {[160, 260, 380, 480].map((y) => (
          <path key={y} className="etch" d={`M40 ${y} H${300 + (y % 7) * 20} V${y + 30} H960`} />
        ))}
        {/* the flow ring */}
        {FLOW.map(([a, b]) => (
          <path key={`${a}${b}`} className={`trace${used.has(`${a}>${b}`) ? " used" : ""}`} d={trace(pos[a], pos[b])} />
        ))}
        {/* any hop off the ring (e.g. Application → MCP Server) */}
        {(r?.slips ?? [])
          .filter((s) => !FLOW.some(([a, b]) => a === s.from && b === s.to))
          .map((s, i) => (
            <path key={i} className="trace used off" d={`M${pos[s.from].x} ${pos[s.from].y} L500 320 L${pos[s.to].x} ${pos[s.to].y}`} />
          ))}
        {live ? (
          <g filter="url(#glow)">
            <path className={`trace live c-${live.from}`} d={FLOW.some(([a, b]) => a === live.from && b === live.to) ? trace(pos[live.from], pos[live.to]) : `M${pos[live.from].x} ${pos[live.from].y} L500 320 L${pos[live.to].x} ${pos[live.to].y}`} />
            <circle r="9" className={`packet c-${live.from}`}>
              <animateMotion
                dur="1.6s"
                repeatCount="indefinite"
                path={FLOW.some(([a, b]) => a === live.from && b === live.to) ? trace(pos[live.from], pos[live.to]) : `M${pos[live.from].x} ${pos[live.from].y} L500 320 L${pos[live.to].x} ${pos[live.to].y}`}
              />
            </circle>
          </g>
        ) : null}
      </svg>

      {ROLES.map((role) => {
        const p = seatPlayer(role);
        const active = r?.status === "playing" && r.activeRole === role;
        const pt = pos[role];
        return (
          <div
            key={role}
            className={`terminal r-${role}${active ? " active" : ""}${p?.id === youId ? " me" : ""}${broken === role ? " fell" : ""}`}
            style={{ left: `${pt.x / 10}%`, top: `${(pt.y / 640) * 100}%` }}
            aria-current={active ? "step" : undefined}
          >
            {broken === role ? <TrapDoor open label={`${ROLE_NAMES[role]} fell through the trap door`} /> : null}
            <div className="t-role">{ROLE_NAMES[role]}</div>
            <div className="t-who">
              {p ? (
                <>
                  <ScrambleSuit id={p.id} size={22} still={!p.connected} />
                  <span className="t-name">{p.name}{p.id === youId ? " · you" : ""}</span>
                </>
              ) : (
                <span className="t-empty">— open port —</span>
              )}
            </div>
            {p ? <div className="t-score">{scores(p.id).toString().padStart(2, "0")} pts{p.connected ? "" : " · offline"}</div> : null}
            {!p && !myRoundRole ? <button className="t-sit" onClick={() => onSit(role)}>Jack in</button> : null}
          </div>
        );
      })}

      <div className="core">
        {r && r.status === "playing" ? (
          <div className={`turn-banner${myTurn ? " mine" : ""}`} role="status">
            {myTurn ? "▶ Your move" : `${ROLE_NAMES[r.activeRole!]} is deciding`}
          </div>
        ) : null}
        {r && r.status === "identify" ? <div className="turn-banner" role="status">Pick the flow in secret · {r.identifySubmitted.length}/4 locked</div> : null}
        {r?.status === "done" ? (
          <div className={`turn-banner ${r.result?.success ? "won" : "lost"}`} role="status">
            {r.result?.success ? "Chain holds" : "Trap door sprung"}
          </div>
        ) : null}
        {r?.inFlight ? <InFlightSlip item={r.inFlight} /> : !r ? <div className="idle">Grid idle. Waiting for the host.</div> : null}
      </div>

      {r && r.slips.length ? (
        <ol className="chain" aria-label="Chain so far">
          {r.slips.map((s, i) => (
            <li key={i} className={`c-${s.from}`}>
              <b>{String(i + 1).padStart(2, "0")}</b> {ROLE_NAMES[s.from]} → {ROLE_NAMES[s.to]} · {s.label}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

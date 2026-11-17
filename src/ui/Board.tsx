"use client";
import { seat } from "./seats.ts";
// The game board: four terminals on a circuit, light packets on the traces,
// scramble-suit identities and a trap door where the chain breaks.
import { useEffect, useMemo, useState } from "react";
import { ROLES, ROLE_NAMES, type PublicPlayer, type PublicState, type Role } from "../game/types.ts";
import { InFlightSlip } from "./Slip.tsx";

type Pt = { x: number; y: number };

/** Board coordinate space, and terminal positions kept well inside its edges. */
const W = 1000;
const H = 720;
const MID = { x: W / 2, y: H / 2 };
const WIDE: Record<Role, Pt> = { client: { x: 500, y: 120 }, application: { x: 830, y: 360 }, idp: { x: 500, y: 600 }, mcp: { x: 170, y: 360 } };
const NARROW: Record<Role, Pt> = { client: { x: 270, y: 105 }, application: { x: 730, y: 105 }, idp: { x: 730, y: 615 }, mcp: { x: 270, y: 615 } };

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

/** A block that has lost some of its bits: the mark of a broken chain. */
export function BitGlyph() {
  const gone = [3, 4, 8, 9, 13, 14, 19, 23, 24];
  return (
    <span className="bit-glyph" role="img" aria-label="Chain broken">
      {Array.from({ length: 25 }, (_, i) => (
        <i key={i} className={gone.includes(i) ? "gone" : undefined} style={{ ["--dx" as string]: `${(i % 5) * 3 + 4}px`, animationDelay: `${(i % 5) * 60}ms` }} />
      ))}
    </span>
  );
}

/** Bits shed by the terminal where the chain broke (plays once). */
function Crumbs({ id }: { id: string }) {
  const bits = useMemo(() => {
    const r = seeded(id);
    return Array.from({ length: 22 }, () => ({ left: r() * 100, size: 3 + r() * 5, dx: r() * 50 - 25, dy: 50 + r() * 90, rot: r() * 300 - 150, delay: r() * 0.7 }));
  }, [id]);
  return (
    <span className="crumbs" aria-hidden>
      {bits.map((b, i) => (
        <i
          key={i}
          style={{ left: `${b.left}%`, width: b.size, height: b.size, animationDelay: `${b.delay}s`, ["--dx" as string]: `${b.dx}px`, ["--dy" as string]: `${b.dy}px`, ["--rot" as string]: `${b.rot}deg` }}
        />
      ))}
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
    <>
    <section className="board" aria-label="Game board">
      <svg className="circuit" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
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
        {[200, 300, 430, 530].map((y) => (
          <path key={y} className="etch" d={`M60 ${y} H${300 + (y % 7) * 20} V${y + 30} H940`} />
        ))}
        {/* the flow ring */}
        {FLOW.map(([a, b]) => (
          <path key={`${a}${b}`} className={`trace${used.has(`${a}>${b}`) ? " used" : ""}`} d={trace(pos[a], pos[b])} />
        ))}
        {/* any hop off the ring (e.g. Application → MCP Server) */}
        {(r?.slips ?? [])
          .filter((s) => !FLOW.some(([a, b]) => a === s.from && b === s.to))
          .map((s, i) => (
            <path key={i} className="trace used off" d={`M${pos[s.from].x} ${pos[s.from].y} L${MID.x} ${MID.y} L${pos[s.to].x} ${pos[s.to].y}`} />
          ))}
        {live ? (
          <g filter="url(#glow)">
            <path className={`trace live c-${live.from}`} d={FLOW.some(([a, b]) => a === live.from && b === live.to) ? trace(pos[live.from], pos[live.to]) : `M${pos[live.from].x} ${pos[live.from].y} L${MID.x} ${MID.y} L${pos[live.to].x} ${pos[live.to].y}`} />
            <circle r="9" className={`packet c-${live.from}`}>
              <animateMotion
                dur="1.6s"
                repeatCount="indefinite"
                path={FLOW.some(([a, b]) => a === live.from && b === live.to) ? trace(pos[live.from], pos[live.to]) : `M${pos[live.from].x} ${pos[live.from].y} L${MID.x} ${MID.y} L${pos[live.to].x} ${pos[live.to].y}`}
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
            style={{ left: `${(pt.x / W) * 100}%`, top: `${(pt.y / H) * 100}%` }}
            aria-current={active ? "step" : undefined}
          >
            {broken === role ? <Crumbs id={`${r?.index}-${role}`} /> : null}
            <div className="t-role">{seat(role)}</div>
            <div className="t-who">
              {p ? (
                <>
                  <ScrambleSuit id={p.id} size={22} still={!p.connected} />
                  <span className="t-name">{p.name}{p.id === youId ? " · you" : ""}</span>
                  {p.bot ? <span className="sim-tag" title="Simulated player">sim</span> : null}
                </>
              ) : (
                <span className="t-empty">— open port —</span>
              )}
            </div>
            {p ? <div className="t-score">{scores(p.id).toString().padStart(2, "0")} pts{p.connected ? "" : " · offline"}{p.bot && r?.status === "playing" && r.activeRole === role ? " · computing…" : ""}</div> : null}
            {broken === role ? <span className="fault-tag">chain broke here</span> : null}
            {!p && !myRoundRole ? <button className="t-sit" onClick={() => onSit(role)}>Jack in</button> : null}
          </div>
        );
      })}

      <div className="core">
        {r && r.status === "playing" ? (
          <div className={`turn-banner${myTurn ? " mine" : ""}`} role="status">
            {myTurn ? "▶ Your move" : `${seat(r.activeRole!)} is deciding`}
          </div>
        ) : null}
        {r && r.status === "identify" ? <div className="turn-banner" role="status">Pick the flow in secret · {r.identifySubmitted.length}/4 locked</div> : null}
        {r?.status === "done" ? (
          <div className={`turn-banner ${r.result?.success ? "won" : "lost"}`} role="status">
            {r.result?.success ? "Chain holds" : "Chain broken"}
          </div>
        ) : null}
        {!r ? <div className="idle">Grid idle. Waiting for the host.</div> : null}
      </div>

      {r && r.slips.length ? (
        <ol className="chain" aria-label="Chain so far">
          {r.slips.map((s, i) => (
            <li key={i} className={`c-${s.from}`}>
              <b>{String(i + 1).padStart(2, "0")}</b> {seat(s.from)} → {seat(s.to)} · {s.label}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
    {r?.inFlight ? (
      <section className={`wire c-${r.inFlight.from}`} aria-label="On the wire">
        <h3>
          On the wire <span>{seat(r.inFlight.from)} → {seat(r.inFlight.to)}</span>
        </h3>
        <InFlightSlip item={r.inFlight} sealed={r.sealed} />
      </section>
    ) : null}
    </>
  );
}

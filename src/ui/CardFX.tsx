"use client";
// Card-play effects, built from bits.
//
// Every move in the round log becomes a card that
//   1. assembles out of pixel bits above the player's terminal,
//   2. glides (with a little 3D lean) to whoever receives it,
//   3. resolves: correct → its bits collapse into the receiver as light;
//      wrong → it glitches, then crumbles into bits that fall away;
//      free check → a scan line passes over it and it dissolves.
// The card face is sliced into a grid: each cell holds a full copy of the face, offset,
// so the bits are pieces of the real card rather than confetti.
import { useEffect, useRef, useState } from "react";
import { ROLE_NAMES, type PublicRound, type Role, type Verdict } from "../game/types.ts";

interface Fx {
  key: number;
  role: Role;
  to: Role | null;
  text: string;
  verdict: Verdict;
}

const ROLE_COLOR: Record<Role, string> = { client: "#29f0ff", application: "#ff3dcb", idp: "#ffa12b", mcp: "#3dffa2" };
const OUTCOME: Record<Verdict, string> = { correct: "#3dffa2", incorrect: "#ff2d55", neutral: "#9b7bff", info: "#29f0ff" };

const CARD_W = 200;
const CARD_H = 124;
const COLS = 10;
const ROWS = 6;
const CW = CARD_W / COLS;
const CH = CARD_H / ROWS;

function centerOf(sel: string): { x: number; y: number } | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Briefly light up a terminal when a card lands on it. */
function flash(role: Role | null, color: string) {
  if (!role) return;
  const el = document.querySelector(`.terminal.r-${role}`) as HTMLElement | null;
  el?.animate(
    [
      { boxShadow: `0 0 0 0 ${color}00, inset 0 0 0 0 ${color}00` },
      { boxShadow: `0 0 34px 4px ${color}, inset 0 0 30px ${color}88`, offset: 0.25 },
      { boxShadow: `0 0 0 0 ${color}00, inset 0 0 0 0 ${color}00` },
    ],
    { duration: 700, easing: "ease-out" },
  );
}

export function CardFX({ round }: { round: PublicRound | null }) {
  const [fx, setFx] = useState<Fx[]>([]);
  const seen = useRef<{ index: number; seq: number } | null>(null);

  useEffect(() => {
    if (!round) return;
    const last = round.log.at(-1)?.seq ?? 0;
    const prev = seen.current;
    seen.current = { index: round.index, seq: last };
    // first sight of a round (page load / round change): don't replay history
    if (!prev || prev.index !== round.index) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fresh = round.log.filter((l) => l.seq > prev.seq && l.role);
    if (!fresh.length) return;
    const to = round.inFlight?.to ?? null;
    setFx((cur) => [
      ...cur.slice(-2),
      ...fresh.map((l, i) => ({ key: l.seq * 10 + i, role: l.role!, to: l.verdict === "info" ? null : to, text: l.text, verdict: l.verdict })),
    ]);
  }, [round]);

  return (
    <div className="fx-layer" aria-hidden data-testid="fx-layer">
      {fx.map((f) => (
        <BitCard key={f.key} fx={f} done={() => setFx((cur) => cur.filter((x) => x.key !== f.key))} />
      ))}
    </div>
  );
}

function Face({ fx }: { fx: Fx }) {
  return (
    <div className="fx-face">
      <span className="fx-role">{ROLE_NAMES[fx.role]}</span>
      <span className="fx-text">{fx.text.length > 84 ? `${fx.text.slice(0, 82)}…` : fx.text}</span>
      <span className="fx-mark">{fx.verdict === "correct" ? "✓" : fx.verdict === "incorrect" ? "✗" : fx.verdict === "info" ? "◎" : "◆"}</span>
    </div>
  );
}

function BitCard({ fx, done }: { fx: Fx; done: () => void }) {
  const mover = useRef<HTMLDivElement>(null);
  const bits = useRef<HTMLDivElement>(null);
  // keep the latest callback without making the animation effect depend on it:
  // the effect must run exactly once per card, or every state update would restart it
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    const done = () => doneRef.current();
    const m = mover.current;
    const grid = bits.current;
    if (!m || !grid) return;
    const cells = Array.from(grid.children) as HTMLElement[];
    const from = centerOf(`.terminal.r-${fx.role}`) ?? { x: innerWidth / 2, y: innerHeight / 2 };
    const target = (fx.to && fx.to !== fx.role ? centerOf(`.terminal.r-${fx.to}`) : null) ?? centerOf(".core") ?? from;
    const lift = -70; // hover just above the terminal
    const dx = target.x - from.x;
    const lean = Math.max(-18, Math.min(18, dx / 25));
    const at = (x: number, y: number, extra = "") => `translate3d(${x - CARD_W / 2}px, ${y - CARD_H / 2}px, 0) ${extra}`;
    const anims: Animation[] = [];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    // 1. assemble from bits
    cells.forEach((c) => {
      anims.push(
        c.animate(
          [
            { transform: `translate(${rnd(-36, 36)}px, ${rnd(-30, 30)}px) scale(0.2)`, opacity: 0 },
            { transform: "translate(0,0) scale(1)", opacity: 1 },
          ],
          { duration: 320, delay: rnd(0, 160), easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" },
        ),
      );
    });

    // 2. glide to the receiver
    const travel = fx.verdict === "info" ? 0 : 1;
    const end = { x: from.x + dx * travel, y: (travel ? target.y : from.y) + (travel ? 0 : lift) };
    const fly = m.animate(
      [
        { transform: at(from.x, from.y + lift, "perspective(800px) rotateX(18deg)") },
        { transform: at(from.x, from.y + lift, "perspective(800px) rotateX(0deg)"), offset: 0.3 },
        { transform: at((from.x + end.x) / 2, (from.y + lift + end.y) / 2 - 30, `perspective(800px) rotateY(${lean}deg) rotateZ(${lean / 4}deg)`), offset: 0.65 },
        { transform: at(end.x, end.y, "perspective(800px) rotateY(0deg)") },
      ],
      { duration: travel ? 1000 : 520, easing: "cubic-bezier(.55,.05,.25,1)", fill: "forwards" },
    );
    anims.push(fly);

    // 3. resolve
    fly.onfinish = () => {
      let last: Animation | null = null;
      if (fx.verdict === "incorrect") {
        grid.classList.add("bad");
        anims.push(
          grid.animate(
            [
              { transform: "translate(0,0)", filter: "none" },
              { transform: "translate(-4px,1px)", filter: "drop-shadow(3px 0 #ff2d55) drop-shadow(-3px 0 #29f0ff)" },
              { transform: "translate(3px,-1px)", filter: "drop-shadow(-3px 0 #ff2d55) drop-shadow(3px 0 #29f0ff)" },
              { transform: "translate(0,0)", filter: "none" },
            ],
            { duration: 260, easing: "steps(4)" },
          ),
        );
        cells.forEach((c, i) => {
          const col = i % COLS;
          last = c.animate(
            [
              { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
              { transform: `translate(${rnd(4, 30)}px, ${rnd(-14, 4)}px) rotate(${rnd(-30, 30)}deg)`, opacity: 1, offset: 0.25 },
              { transform: `translate(${rnd(10, 70)}px, ${rnd(120, 220)}px) rotate(${rnd(-160, 160)}deg) scale(0.4)`, opacity: 0 },
            ],
            { duration: 820, delay: 260 + col * 34 + rnd(0, 70), easing: "cubic-bezier(.4,0,.9,.6)", fill: "forwards" },
          );
          anims.push(last);
        });
        flash(fx.to, OUTCOME.incorrect);
      } else if (fx.verdict === "info") {
        grid.classList.add("scan");
        cells.forEach((c, i) => {
          const row = Math.floor(i / COLS);
          last = c.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0)" }], {
            duration: 300,
            delay: 380 + row * 45 + rnd(0, 40),
            easing: "ease-in",
            fill: "forwards",
          });
          anims.push(last);
        });
      } else {
        // collapse into the receiver as light
        cells.forEach((c, i) => {
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          const tx = CARD_W / 2 - (col + 0.5) * CW;
          const ty = CARD_H / 2 - (row + 0.5) * CH;
          last = c.animate(
            [
              { transform: "translate(0,0) scale(1)", opacity: 1, filter: "brightness(1)" },
              { transform: `translate(${tx * 0.3}px, ${ty * 0.3}px) scale(0.8)`, opacity: 1, filter: "brightness(2)", offset: 0.4 },
              { transform: `translate(${tx}px, ${ty}px) scale(0.1)`, opacity: 0, filter: "brightness(3)" },
            ],
            { duration: 460, delay: rnd(0, 140), easing: "cubic-bezier(.6,0,.4,1)", fill: "forwards" },
          );
          anims.push(last);
        });
        setTimeout(() => flash(fx.to ?? fx.role, OUTCOME[fx.verdict]), 380);
      }
      if (last) (last as Animation).onfinish = done;
      else done();
    };
    // safety net: never leave a card on the board
    const guard = setTimeout(done, 3500);
    return () => {
      clearTimeout(guard);
      anims.forEach((a) => a.cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={mover} className="fx-card" style={{ ["--k" as string]: ROLE_COLOR[fx.role], ["--o" as string]: OUTCOME[fx.verdict] }}>
      <div ref={bits} className="fx-bits">
        {Array.from({ length: COLS * ROWS }, (_, i) => {
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          return (
            <div key={i} className="fx-bit" style={{ left: col * CW, top: row * CH, width: CW + 0.5, height: CH + 0.5 }}>
              <div style={{ transform: `translate(${-col * CW}px, ${-row * CH}px)` }}>
                <Face fx={fx} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

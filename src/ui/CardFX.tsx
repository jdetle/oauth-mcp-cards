"use client";
import { seat } from "./seats.ts";
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
import { ROLE_NAMES, type Call, type PublicRound, type Role, type Tone, type Verdict } from "../game/types.ts";

interface Fx {
  key: number;
  role: Role;
  to: Role | null;
  text: string;
  verdict: Verdict;
  call?: Call;
}

const ROLE_COLOR: Record<Role, string> = { client: "#29f0ff", application: "#ff3dcb", idp: "#ffa12b", mcp: "#3dffa2" };
// colour follows the kind of action (stop = red, go = green), never right/wrong; a mismatch is yellow
const TONE: Record<Tone, string> = { go: "#3dffa2", stop: "#ff2d55", send: "#29f0ff" };
const MISS = "#ffd23f";
const outcomeColor = (fx: { verdict: Verdict; call?: Call }) =>
  fx.call ? (fx.call.matched ? TONE[fx.call.played.tone] : MISS) : fx.verdict === "incorrect" ? MISS : fx.verdict === "info" ? "#29f0ff" : "#9b7bff";
const missed = (fx: { verdict: Verdict; call?: Call }) => (fx.call ? !fx.call.matched : fx.verdict === "incorrect");

const CARD_W = 224;
const CARD_H = 144;
// A landed card stays until the player clicks it: nothing is taken away unread.
// A check is the exception: its result stays on the sealed slip, so its card clears itself.
const HOLD_CHECK_MS = 2600;
/** Unread cards kept on the table at once (older ones give way past this). */
const MAX_UNREAD = 8;
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

/** How the speed dial (1 slowest to 5 fastest) stretches the card's flight. */
const FLIGHT = [1.5, 1, 0.75, 0.55, 0.4];

export function CardFX({ round, speed = 2, timed = true }: { round: PublicRound | null; speed?: number; timed?: boolean }) {
  const pace = FLIGHT[speed - 1] ?? 1;
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
      ...cur.slice(-(MAX_UNREAD - 1)),
      ...fresh.map((l, i) => ({ key: l.seq * 10 + i, role: l.role!, to: l.verdict === "info" ? null : to, text: l.text, verdict: l.verdict, call: l.call })),
    ]);
  }, [round]);

  return (
    <div className="fx-layer" data-testid="fx-layer">
      {fx.map((f, i) => (
        <BitCard key={f.key} fx={f} stack={i} pace={pace} timed={timed} done={() => setFx((cur) => cur.filter((x) => x.key !== f.key))} />
      ))}
    </div>
  );
}

function Face({ fx }: { fx: Fx }) {
  return (
    <div className="fx-face">
      <span className="fx-role">{seat(fx.role)}</span>
      <span className="fx-text">{fx.text.length > 100 ? `${fx.text.slice(0, 98)}…` : fx.text}</span>
      {fx.call ? (
        <span className="fx-call">
          <i className={`chip t-${fx.call.expected.tone}`}>{fx.call.expected.label.split(" · ")[0]}</i>
          <b>{fx.call.matched ? "=" : "≠"}</b>
          <i className={`chip t-${fx.call.played.tone}`}>{fx.call.played.label.split(" · ")[0]}</i>
        </span>
      ) : (
        <span className="fx-mark">{fx.verdict === "info" ? "◎" : "◆"}</span>
      )}
    </div>
  );
}

function BitCard({ fx, stack, pace, timed, done }: { fx: Fx; stack: number; pace: number; timed: boolean; done: () => void }) {
  // a check's card clears itself, unless this table has its timers off
  const waits = fx.verdict !== "info" || !timed;
  const [landed, setLanded] = useState(false);
  const read = useRef<() => void>(() => {});
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
    // Positions are measured against the layer, which is laid over the page (not the screen),
    // so a card stays with its terminal if the page scrolls while it is in play.
    const layer = (m.closest(".fx-layer") as HTMLElement).getBoundingClientRect();
    const local = (p: { x: number; y: number } | null) => (p ? { x: p.x - layer.left, y: p.y - layer.top } : null);
    const from = local(centerOf(`.terminal.r-${fx.role}`)) ?? { x: layer.width / 2, y: layer.height / 2 };
    const target = local(fx.to && fx.to !== fx.role ? centerOf(`.terminal.r-${fx.to}`) : null) ?? local(centerOf(".core")) ?? from;
    const lift = -(CARD_H / 2 + 46); // hover just above the terminal, leaving it visible
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
          { duration: 460 * pace, delay: rnd(0, 220) * pace, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" },
        ),
      );
    });

    // 2. glide to the receiver
    const travel = fx.verdict === "info" ? 0 : 1;
    // land above the receiver (not on top of it), kept inside the window
    const clampX = (x: number) => Math.max(CARD_W / 2 + 4, Math.min(layer.width - CARD_W / 2 - 4, x));
    const clampY = (y: number) => Math.max(CARD_H / 2 + 4, Math.min(layer.height - CARD_H / 2 - 4, y));
    // unread cards fan out a little so the one underneath still shows
    const fan = Math.min(stack, 4) * 12;
    const end = { x: clampX(from.x + dx * travel + fan), y: clampY((travel ? target.y : from.y) + lift + fan) };
    const fly = m.animate(
      [
        { transform: at(from.x, from.y + lift, "perspective(800px) rotateX(18deg)") },
        { transform: at(from.x, from.y + lift, "perspective(800px) rotateX(0deg)"), offset: 0.3 },
        { transform: at((from.x + end.x) / 2, (from.y + lift + end.y) / 2 - 30, `perspective(800px) rotateY(${lean}deg) rotateZ(${lean / 4}deg)`), offset: 0.65 },
        { transform: at(end.x, end.y, "perspective(800px) rotateY(0deg)") },
      ],
      { duration: (travel ? 1500 : 700) * pace, easing: "cubic-bezier(.55,.05,.25,1)", fill: "forwards" },
    );
    anims.push(fly);

    // 3. hold: a played card waits to be clicked; a check counts down and clears itself
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    fly.onfinish = () => {
      if (waits) return setLanded(true);
      const bar = m.querySelector(".fx-timer") as HTMLElement | null;
      if (bar) anims.push(bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: HOLD_CHECK_MS, easing: "linear", fill: "forwards" }));
      holdTimer = setTimeout(resolve, HOLD_CHECK_MS);
    };

    // 4. resolve
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      setLanded(false);
      m.querySelector(".fx-timer")?.remove();
      let last: Animation | null = null;
      if (missed(fx)) {
        grid.classList.add("bad");
        anims.push(
          grid.animate(
            [
              { transform: "translate(0,0)", filter: "none" },
              { transform: "translate(-4px,1px)", filter: "drop-shadow(3px 0 #ffd23f) drop-shadow(-3px 0 #29f0ff)" },
              { transform: "translate(3px,-1px)", filter: "drop-shadow(-3px 0 #ffd23f) drop-shadow(3px 0 #29f0ff)" },
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
        flash(fx.to, MISS);
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
        setTimeout(() => flash(fx.to ?? fx.role, outcomeColor(fx)), 380);
      }
      if (last) (last as Animation).onfinish = done;
      else done();
    };
    read.current = resolve;
    return () => {
      if (holdTimer) clearTimeout(holdTimer);
      anims.forEach((a) => a.cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mover}
      className={`fx-card${landed ? " landed" : ""}`}
      data-testid="fx-card"
      role={landed ? "button" : undefined}
      tabIndex={landed ? 0 : undefined}
      aria-label={landed ? `${seat(fx.role)}: ${fx.text} Click when you have read it.` : undefined}
      onClick={landed ? () => read.current() : undefined}
      onKeyDown={landed ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), read.current()) : undefined}
      style={{ ["--k" as string]: ROLE_COLOR[fx.role], ["--o" as string]: outcomeColor(fx), ["--fw" as string]: `${CARD_W}px`, ["--fh" as string]: `${CARD_H}px` }}>
      {waits ? null : <span className="fx-timer" />}
      {landed ? <span className="fx-read">Click when read</span> : null}
      <div ref={bits} className="fx-bits" aria-hidden>
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

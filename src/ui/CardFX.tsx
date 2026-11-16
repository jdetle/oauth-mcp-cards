"use client";
// 3D card-play effects. Every move in the round log becomes a card that rises off the
// player's terminal, flips, arcs across the board to the receiver, and then either
// derezzes into light (correct), drops through a trap door (wrong) or gets scanned (check).
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

function centerOf(sel: string): { x: number; y: number } | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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
      ...cur.slice(-3),
      ...fresh.map((l, i) => ({ key: l.seq * 10 + i, role: l.role!, to: l.verdict === "info" ? l.role! : to, text: l.text, verdict: l.verdict })),
    ]);
  }, [round]);

  return (
    <div className="fx-layer" aria-hidden>
      {fx.map((f) => (
        <FlyingCard key={f.key} fx={f} done={() => setFx((cur) => cur.filter((x) => x.key !== f.key))} />
      ))}
    </div>
  );
}

function FlyingCard({ fx, done }: { fx: Fx; done: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const burst = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"fly" | "burst">("fly");
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const shards = useRef(
    Array.from({ length: 28 }, () => ({
      x: (Math.random() - 0.5) * 420,
      y: (Math.random() - 0.5) * 300,
      z: Math.random() * 500 - 120,
      rx: Math.random() * 720 - 360,
      ry: Math.random() * 720 - 360,
      s: 4 + Math.random() * 10,
    })),
  );

  useEffect(() => {
    const from = centerOf(`.terminal.r-${fx.role}`) ?? { x: innerWidth / 2, y: innerHeight / 2 };
    const target = (fx.to && fx.to !== fx.role ? centerOf(`.terminal.r-${fx.to}`) : null) ?? centerOf(".core") ?? from;
    const el = card.current;
    if (!el) return;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const spin = dx >= 0 ? 1 : -1;
    const wrong = fx.verdict === "incorrect";
    const check = fx.verdict === "info";
    const base = `translate(-50%, -50%) translate3d(${from.x}px, ${from.y}px, 0)`;
    const go = (f: number, z: number) => `translate(-50%, -50%) translate3d(${from.x + dx * f}px, ${from.y + dy * f - Math.sin(Math.PI * f) * 120}px, ${z}px)`;

    const frames: Keyframe[] = check
      ? [
          { transform: `${base} rotateX(75deg) scale(0.3)`, opacity: 0 },
          { transform: `${base} translateZ(160px) rotateX(0deg) rotateY(-180deg) scale(1)`, opacity: 1, offset: 0.35 },
          { transform: `${base} translateZ(200px) rotateX(0deg) rotateY(0deg) scale(1.05)`, opacity: 1, offset: 0.7 },
          { transform: `${base} translateZ(40px) rotateX(60deg) scale(0.5)`, opacity: 0 },
        ]
      : [
          { transform: `${base} rotateX(75deg) rotateZ(0deg) scale(0.3)`, opacity: 0 },
          { transform: `${base} translateZ(180px) rotateX(10deg) rotateY(${180 * spin}deg) scale(1)`, opacity: 1, offset: 0.25 },
          { transform: `${go(0.5, 260)} rotateX(-8deg) rotateY(${360 * spin}deg) rotateZ(${-8 * spin}deg) scale(1.08)`, offset: 0.6 },
          wrong
            ? { transform: `${go(1, 60)} rotateX(20deg) rotateY(${360 * spin}deg) scale(0.95)`, offset: 0.82 }
            : { transform: `${go(1, 120)} rotateX(0deg) rotateY(${360 * spin}deg) scale(1)`, offset: 0.85 },
          wrong
            ? { transform: `${go(1, -420)} rotateX(-110deg) rotateZ(${40 * spin}deg) scale(0.15)`, opacity: 0.2 }
            : { transform: `${go(1, 40)} rotateX(70deg) rotateY(${360 * spin}deg) scale(0.6)`, opacity: 0.9 },
        ];
    const a = el.animate(frames, { duration: check ? 1300 : 1500, easing: "cubic-bezier(.45,.05,.25,1)", fill: "forwards" });
    a.onfinish = () => {
      setAt(target);
      setPhase("burst");
    };
    return () => a.cancel();
  }, [fx]);

  useEffect(() => {
    if (phase !== "burst") return;
    const t = setTimeout(done, 900);
    return () => clearTimeout(t);
  }, [phase, done]);

  const color = ROLE_COLOR[fx.role];
  const outcome = OUTCOME[fx.verdict];
  return (
    <>
      {phase === "fly" ? (
        <div ref={card} className={`fx-card v-${fx.verdict}`} style={{ ["--k" as string]: color, ["--o" as string]: outcome }}>
          <div className="fx-face">
            <span className="fx-role">{ROLE_NAMES[fx.role]}</span>
            <span className="fx-text">{fx.text.length > 90 ? `${fx.text.slice(0, 88)}…` : fx.text}</span>
            <span className="fx-mark">{fx.verdict === "correct" ? "✓" : fx.verdict === "incorrect" ? "✗" : fx.verdict === "info" ? "◎" : "◆"}</span>
          </div>
          <div className="fx-back" />
        </div>
      ) : null}
      {phase === "burst" && at ? (
        <div ref={burst} className={`fx-burst v-${fx.verdict}`} style={{ left: at.x, top: at.y, ["--o" as string]: outcome }}>
          {fx.verdict === "incorrect" ? <span className="fx-pit" /> : <span className="fx-ring" />}
          {fx.verdict === "info"
            ? <span className="fx-scan" />
            : shards.current.map((s, i) => (
                <i
                  key={i}
                  style={{
                    width: s.s,
                    height: s.s,
                    ["--tx" as string]: `${fx.verdict === "incorrect" ? s.x * 0.4 : s.x}px`,
                    ["--ty" as string]: `${fx.verdict === "incorrect" ? Math.abs(s.y) * 0.8 : s.y}px`,
                    ["--tz" as string]: `${fx.verdict === "incorrect" ? -Math.abs(s.z) : s.z}px`,
                    ["--rx" as string]: `${s.rx}deg`,
                    ["--ry" as string]: `${s.ry}deg`,
                  }}
                />
              ))}
        </div>
      ) : null}
    </>
  );
}

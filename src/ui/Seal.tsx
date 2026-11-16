"use client";
// Key seals: the visual identity of the game, drawn from modular arithmetic.
//
// A seal is a "times table on a circle": n points around a ring, and a chord from each
// point i to (k · i) mod n. The same rule that makes cardioids out of the 2-times table.
// n, k and the colours come from the bytes of the thing being sealed (a public key, a
// signature, a token id), so the same bytes always draw the same seal and one changed
// byte draws a visibly different one. It identifies; the /learn page does the teaching.
import { createContext, useContext, useEffect, useMemo, useRef } from "react";

/** Public keys of the current table, so slips can show who a signature belongs to. */
export const KeysContext = createContext<{ application: string; gateway: string } | null>(null);
export const useKeys = () => useContext(KeysContext);

/** Bytes from a hex string; any other string is hashed (FNV-1a) into 8 bytes. */
export function sealBytes(src: string): number[] {
  if (/^[0-9a-f]{8,}$/i.test(src)) return (src.match(/../g) ?? []).slice(0, 16).map((h) => parseInt(h, 16));
  const out: number[] = [];
  let h = 2166136261;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
    h = Math.imul(h ^ round, 16777619);
    out.push((h >>> 8) & 0xff);
  }
  return out;
}

export function sealParams(src: string) {
  const b = sealBytes(src);
  const n = 28 + ((b[0] ?? 0) % 44); // 28..71 points
  const k = 2 + (((b[1] ?? 0) * 256 + (b[2] ?? 0)) % (n - 3)); // 2..n-2
  const hue = Math.round((((b[3] ?? 0) * 256 + (b[4] ?? 0)) / 65535) * 360);
  return { n, k, hue, turn: ((b[5] ?? 0) / 255) * Math.PI * 2 };
}

export function Seal({
  of,
  size = 44,
  label,
  broken = false,
  hue,
}: {
  /** bytes to seal: hex (key / signature) or any id */
  of: string;
  size?: number;
  label?: string;
  /** an unsigned / invalid seal: nothing to draw but an empty, dashed ring */
  broken?: boolean;
  hue?: number;
}) {
  const p = useMemo(() => sealParams(of), [of]);
  const lines = useMemo(() => {
    const pts = Array.from({ length: p.n }, (_, i) => {
      const a = p.turn + (i / p.n) * Math.PI * 2;
      return [50 + 44 * Math.cos(a), 50 + 44 * Math.sin(a)] as const;
    });
    let d = "";
    for (let i = 1; i < p.n; i++) {
      const j = (p.k * i) % p.n;
      if (j !== i) d += `M${pts[i]![0].toFixed(1)} ${pts[i]![1].toFixed(1)}L${pts[j]![0].toFixed(1)} ${pts[j]![1].toFixed(1)}`;
    }
    return d;
  }, [p]);
  const h = hue ?? p.hue;
  const stroke = broken ? "var(--red)" : `hsl(${h} 95% 68%)`;
  return (
    <svg
      className={`seal-svg${broken ? " broken" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label ?? (broken ? "No signature" : `Seal ${p.k}×i mod ${p.n}`)}
    >
      <title>{label ?? (broken ? "Unsigned: no seal" : `${p.k} × i mod ${p.n}`)}</title>
      <circle cx="50" cy="50" r="47" fill="rgba(3,7,16,0.9)" stroke={stroke} strokeWidth="1.5" strokeDasharray={broken ? "4 5" : undefined} opacity={broken ? 0.9 : 0.75} />
      {broken ? (
        <path d="M34 34L66 66M66 34L34 66" stroke={stroke} strokeWidth="3" />
      ) : (
        <path d={lines} fill="none" stroke={stroke} strokeWidth="0.9" opacity="0.85" />
      )}
    </svg>
  );
}

/**
 * The hero motif: one times table whose multiplier drifts, so cardioids fold into
 * nephroids into lace. Canvas, paused when off-screen or when motion is reduced.
 */
export function TimesTable({ points = 220, className }: { points?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let k = 2;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(canvas);
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const r = Math.min(w, h) / 2 - 6;
      const cx = w / 2;
      const cy = h / 2;
      ctx.lineWidth = 0.6;
      for (let i = 0; i < points; i++) {
        const a = (i / points) * Math.PI * 2 - Math.PI / 2;
        const b = (((k * i) % points) / points) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = `hsla(${185 + (i / points) * 130}, 95%, 65%, 0.42)`;
        ctx.beginPath();
        ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        ctx.lineTo(cx + r * Math.cos(b), cy + r * Math.sin(b));
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(41,240,255,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    const loop = () => {
      if (visible) {
        k += 0.0035;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    if (reduce) {
      k = 2;
      draw();
    } else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [points]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

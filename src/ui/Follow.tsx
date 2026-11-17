"use client";
// Follow the action. On the stacked (phone/tablet) layout the page is one long column, so a
// move can happen off-screen. This scrolls to whatever just changed. It never fights the
// reader: after a touch or scroll it offers a "Jump to…" pill instead of moving the page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivateView, PublicState } from "../game/types.ts";

const KEY = "omcp:follow";
const HANDS_OFF_MS = 2500;

interface Target {
  selector: string;
  label: string;
}

function readPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** What deserves attention right now, as a stable key plus where to look. */
function attention(state: PublicState, you: PrivateView, myTurn: boolean, seated: boolean): (Target & { key: string }) | null {
  const r = state.round;
  if (!r) return null;
  if (r.status === "done") return { key: `${r.index}:done`, selector: ".result", label: "Round result" };
  if (r.status === "identify") {
    return seated && !you.myGuess ? { key: `${r.index}:identify`, selector: ".identify", label: "Pick the flow" } : { key: `${r.index}:start`, selector: ".scenario", label: "New round" };
  }
  const moves = r.log.filter((l) => l.role).length;
  if (moves === 0) return { key: `${r.index}:start`, selector: ".scenario", label: "New round" };
  if (myTurn) return { key: `${r.index}:turn:${r.slips.length}`, selector: r.inFlight ? ".wire" : ".board", label: "Your move" };
  // someone else moved: watch the board (checks don't move the page; they show on the slip)
  return { key: `${r.index}:move:${r.slips.length}`, selector: ".board", label: "New move" };
}

export function useFollow(state: PublicState, you: PrivateView, myTurn: boolean, seated: boolean) {
  const [on, setOn] = useState(true);
  const [stacked, setStacked] = useState(false);
  const [pending, setPending] = useState<Target | null>(null);
  const lastTouch = useRef(0);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    setOn(readPref());
    const mq = window.matchMedia("(max-width: 1099px)");
    const sync = () => setStacked(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    // real interaction only: programmatic scrolling doesn't fire these
    const touched = () => (lastTouch.current = Date.now());
    const opts = { passive: true } as const;
    window.addEventListener("touchstart", touched, opts);
    window.addEventListener("touchmove", touched, opts);
    window.addEventListener("wheel", touched, opts);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("touchstart", touched);
      window.removeEventListener("touchmove", touched);
      window.removeEventListener("wheel", touched);
    };
  }, []);

  const go = useCallback((t: Target) => {
    const el = document.querySelector(t.selector);
    if (!el) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    setPending(null);
  }, []);

  const target = attention(state, you, myTurn, seated);
  const key = target?.key ?? null;
  useEffect(() => {
    if (!target || key === lastKey.current) return;
    const first = lastKey.current === null;
    lastKey.current = key;
    if (!stacked || !on || first) return; // don't move the page on load
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "");
    if (typing || Date.now() - lastTouch.current < HANDS_OFF_MS) {
      setPending({ selector: target.selector, label: target.label });
      return;
    }
    // let the new section render (and the hand drawer open) before measuring
    const t = setTimeout(() => go(target), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stacked, on]);

  // the pill goes away once the reader gets there on their own
  useEffect(() => {
    if (!pending) return;
    const el = document.querySelector(pending.selector);
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && e.intersectionRatio > 0.3 && setPending(null), { threshold: [0.3] });
    io.observe(el);
    return () => io.disconnect();
  }, [pending]);

  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        localStorage.setItem(KEY, v ? "off" : "on");
      } catch {}
      return !v;
    });
    setPending(null);
  }, []);

  return { on, stacked, pending, go, toggle };
}

export function FollowToggle({ on, toggle }: { on: boolean; toggle: () => void }) {
  return (
    <button className={`follow-toggle${on ? " on" : ""}`} onClick={toggle} aria-pressed={on} title="Scroll to each update as it happens">
      Follow {on ? "on" : "off"}
    </button>
  );
}

export function JumpPill({ pending, go }: { pending: Target | null; go: (t: Target) => void }) {
  if (!pending) return null;
  return (
    <button className="jump-pill" onClick={() => go(pending)}>
      {pending.label} ↓
    </button>
  );
}

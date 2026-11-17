"use client";
// Follow the action. On the stacked (phone/tablet) layout the page is one long column, so a
// move can happen off-screen. This scrolls to whatever just changed. It never fights the
// reader: after a touch or scroll it offers a "Jump to…" pill instead of moving the page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivateView, PublicState } from "../game/types.ts";

const KEY = "omcp:follow";
const HANDS_OFF_MS = 2500;

// When the reader last touched, scrolled or wheeled. Kept per page, not per component: the
// table remounts when a game starts, and a fresh "never touched" would scroll from under a finger.
let lastTouchAt = 0;
let listening = false;
function listenForTouches() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const touched = () => (lastTouchAt = Date.now());
  const opts = { passive: true } as const;
  window.addEventListener("touchstart", touched, opts);
  window.addEventListener("touchmove", touched, opts);
  window.addEventListener("wheel", touched, opts);
}

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
  // your move (even the round's first): the question plus your cards
  if (myTurn) return { key: `${r.index}:turn:${r.slips.length}`, selector: r.inFlight ? ".wire" : ".scenario", label: "Your move" };
  if (moves === 0) return { key: `${r.index}:start`, selector: ".scenario", label: "New round" };
  // someone else moved: watch the board (checks don't move the page; they show on the slip)
  return { key: `${r.index}:move:${r.slips.length}`, selector: ".board", label: "New move" };
}

export function useFollow(state: PublicState, you: PrivateView, myTurn: boolean, seated: boolean) {
  const [on, setOn] = useState(true);
  const [stacked, setStacked] = useState(false);
  const [pending, setPending] = useState<Target | null>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    setOn(readPref());
    const mq = window.matchMedia("(max-width: 1099px)");
    const sync = () => setStacked(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    // real interaction only: programmatic scrolling doesn't fire these
    listenForTouches();
    return () => mq.removeEventListener("change", sync);
  }, []);

  const go = useCallback((t: Target) => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const where = (): number | null => {
      const el = document.querySelector(t.selector);
      if (!el) return null;
      let top = el.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
      // your move: if the slip and your first card don't both fit, keep the card on screen
      // (on a short phone the top of the slip gives way, not the thing you have to tap)
      const card = t.label === "Your move" ? document.querySelector(".hand-panel .card.playable") : null;
      if (card) {
        const bottom = card.getBoundingClientRect().bottom + scrollY + 8;
        if (bottom - top > innerHeight) top = bottom - innerHeight;
      }
      return Math.max(0, top);
    };
    const first = where();
    if (first === null) return;
    window.scrollTo({ top: first, behavior: calm ? "auto" : "smooth" });
    setPending(null);
    // The page is often still settling when a turn starts (the hand is dealt, the board moves
    // below it). Measure once more when it has, and correct, unless the reader has taken over.
    const asked = Date.now();
    setTimeout(() => {
      if (lastTouchAt > asked) return;
      const again = where();
      if (again !== null && Math.abs(again - scrollY) > 24) window.scrollTo({ top: again, behavior: calm ? "auto" : "smooth" });
    }, 600);
  }, []);

  const target = attention(state, you, myTurn, seated);
  const key = target?.key ?? null;
  useEffect(() => {
    // a game that starts after the page loaded isn't "on load": its first move should scroll
    if (!target) {
      if (lastKey.current === null) lastKey.current = "";
      return;
    }
    if (key === lastKey.current) return;
    const first = lastKey.current === null;
    lastKey.current = key;
    if (!stacked || !on || first) return; // don't move the page on load
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "");
    if (typing || Date.now() - lastTouchAt < HANDS_OFF_MS) {
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
      Auto-scroll {on ? "on" : "off"}
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

"use client";
import { useEffect } from "react";

/**
 * Poll only while someone can see the page. A background tab asks for nothing; coming back
 * to it refreshes at once.
 */
export function useVisiblePoll(fn: () => void, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      fn();
      timer = setInterval(fn, ms);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const sync = () => (document.visibilityState === "visible" ? start() : stop());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [fn, ms, enabled]);
}

/** The server sleeps when nobody's playing; this tells the page it is being woken. */
export function announceWaking(on: boolean) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("omcp:waking", { detail: on }));
}

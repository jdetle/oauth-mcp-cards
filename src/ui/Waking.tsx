"use client";
import { useEffect, useState } from "react";

/** A slim notice while the server starts back up (it sleeps when nobody's playing). */
export function WakingBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const h = (e: Event) => setOn(!!(e as CustomEvent).detail);
    window.addEventListener("omcp:waking", h);
    return () => window.removeEventListener("omcp:waking", h);
  }, []);
  if (!on) return null;
  return (
    <div className="waking" role="status">
      <span className="waking-dot" aria-hidden /> Waking the server. It sleeps when nobody's playing; this takes about a minute.
    </div>
  );
}

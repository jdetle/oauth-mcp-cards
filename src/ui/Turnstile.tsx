"use client";
// Cloudflare Turnstile bot check. Renders nothing unless the server says it is configured.
import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api.ts";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let configPromise: Promise<{ turnstileSiteKey: string | null; admin: boolean }> | null = null;
export function serverConfig() {
  configPromise ??= fetch(`${API_BASE}/api/config`, { credentials: "include" })
    .then((r) => r.json())
    .catch(() => ({ turnstileSiteKey: null, admin: false }));
  return configPromise;
}

let scriptPromise: Promise<void> | null = null;
function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Calls onToken with a fresh token (or null when it expires). `required` tells the form
 * whether to wait for one. Bump `resetKey` after a failed submit: tokens are single-use.
 */
export function Turnstile({ onToken, onRequired, resetKey = 0 }: { onToken: (t: string | null) => void; onRequired?: (r: boolean) => void; resetKey?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  useEffect(() => {
    serverConfig().then((c) => {
      setSiteKey(c.turnstileSiteKey);
      onRequired?.(!!c.turnstileSiteKey);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!siteKey || !el.current) return;
    let id: string | null = null;
    let gone = false;
    loadScript()
      .then(() => {
        if (gone || !el.current || !window.turnstile) return;
        id = window.turnstile.render(el.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (t: string) => onToken(t),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      gone = true;
      if (id && window.turnstile) window.turnstile.remove(id);
      onToken(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, resetKey]);
  if (!siteKey) return null;
  return <div ref={el} className="turnstile" aria-label="Bot check" />;
}

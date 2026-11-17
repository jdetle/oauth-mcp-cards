// Telemetry into the same projects jdetle.com uses, so a broken game shows up where it is watched.
//
// - s10: first-party envelopes (page, events, bugs), posted same-origin to `${BASE}/_s10/…`.
//   The Rust server adds the ingest key, so the page never carries it.
// - Sentry: errors (plus replays on error) through the same-origin `${BASE}/monitoring` tunnel.
// - PostHog, GA4, Clarity, Meta Pixel, Plausible: product analytics, loaded as on jdetle.com.
//
// Every ID comes from a NEXT_PUBLIC_* build variable; with none set (local dev, forks) this is a no-op.
import { BASE } from "./paths.ts";

export const IDS = {
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "",
  posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "",
  posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
  ga4: process.env.NEXT_PUBLIC_GA4_ID ?? "",
  clarity: process.env.NEXT_PUBLIC_CLARITY_ID ?? "",
  metaPixel: process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "",
  plausible: process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_ID ?? "",
  s10: process.env.NEXT_PUBLIC_S10 === "1",
  release: process.env.NEXT_PUBLIC_RELEASE ?? "dev",
};

type Attrs = Record<string, unknown>;
type Envelope = Record<string, unknown>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i]! % 32];
  return time + rand;
}

function stored(key: string, store: () => Storage): string {
  try {
    const s = store();
    const v = s.getItem(key);
    if (v) return v;
    const id = ulid();
    s.setItem(key, id);
    return id;
  } catch {
    return ulid();
  }
}

let anonymousId = "";
let sessionId = "";
let queue: Envelope[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

export function envelope(kind: string, name: string, attrs: Attrs = {}, extra: Envelope = {}): Envelope {
  return {
    schema_version: "s10/2",
    signal_id: ulid(),
    occurred_at: new Date().toISOString(),
    kind,
    name,
    attributes: { path: typeof location !== "undefined" ? location.pathname : "", ...attrs },
    identity: { anonymous_id: anonymousId, session_id: sessionId },
    resource: { service_name: "oauth-mcp-cards-web", environment: "production", service_version: IDS.release },
    ...extra,
  };
}

const endpoint = () => `${BASE}/_s10/v2/envelopes`;

/** Send what's queued. `beacon` on page hide, when fetch may be cut off. */
export function flush(beacon = false) {
  if (!queue.length) return;
  const body = queue.map((e) => JSON.stringify(e)).join("\n") + "\n";
  queue = [];
  try {
    if (beacon && navigator.sendBeacon?.(endpoint(), new Blob([body], { type: "application/x-ndjson" }))) return;
    void fetch(endpoint(), { method: "POST", body, keepalive: true, headers: { "content-type": "application/x-ndjson" } }).catch(() => {});
  } catch {
    // telemetry must never break the game
  }
}

function push(e: Envelope) {
  if (!IDS.s10 || typeof window === "undefined") return;
  queue.push(e);
  if (queue.length >= 32) flush();
}

/** A named event, e.g. track("room.join_failed", { status: 401 }). */
export function track(name: string, attrs: Attrs = {}) {
  push(envelope("event", name, attrs));
  try {
    (window as unknown as { posthog?: { capture: (n: string, a: Attrs) => void } }).posthog?.capture(name, attrs);
  } catch {
    // ignore
  }
}

/** Something broke in the browser: s10 `bug`, and Sentry. */
export function bug(err: unknown, ctx: Attrs = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  push(envelope("bug", e.message.slice(0, 300), ctx, { category: "error", bug: { stack: e.stack?.slice(0, 8000) } }));
  void import("@sentry/browser").then((S) => S.captureException(e, { extra: ctx })).catch(() => {});
}

function addScript(src: string, attrs: Record<string, string> = {}) {
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.head.appendChild(s);
}

type Fn = ((...a: unknown[]) => void) & { q?: unknown[][]; queue?: unknown[]; o?: unknown; init?: (o?: unknown) => void };

/** Start everything once per page load. */
export function startTelemetry() {
  if (started || typeof window === "undefined") return;
  started = true;
  anonymousId = stored("omcp:aid", () => localStorage);
  sessionId = stored("omcp:sid", () => sessionStorage);
  const w = window as unknown as Record<string, unknown>;

  if (IDS.s10) {
    timer = setInterval(() => flush(), 10_000);
    window.addEventListener("pagehide", () => flush(true));
    window.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush(true));
    push(envelope("page", document.title || location.pathname, { referrer: document.referrer || undefined, width: innerWidth, height: innerHeight }));
  }
  // uncaught errors reach s10 here; Sentry hooks them itself
  window.addEventListener("error", (e: ErrorEvent) => {
    if (!IDS.s10) return;
    const err = e.error instanceof Error ? e.error : new Error(e.message || "script error");
    push(envelope("bug", err.message.slice(0, 300), { source: "window.onerror", file: e.filename, line: e.lineno }, { category: "error", bug: { stack: err.stack?.slice(0, 8000) } }));
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    if (!IDS.s10) return;
    const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
    push(envelope("bug", err.message.slice(0, 300), { source: "unhandledrejection" }, { category: "error", bug: { stack: err.stack?.slice(0, 8000) } }));
  });

  if (IDS.sentryDsn) {
    void import("@sentry/browser").then((S) =>
      S.init({
        dsn: IDS.sentryDsn,
        tunnel: `${BASE}/monitoring`,
        release: `oauth-mcp-cards@${IDS.release}`,
        environment: "production",
        initialScope: { tags: { surface: "browser", app: "oauth-mcp-cards" } },
        tracesSampleRate: 0.1,
        integrations: [S.browserTracingIntegration(), S.replayIntegration()],
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
      }),
    );
  }

  if (IDS.posthogKey) {
    void import("posthog-js").then(({ default: posthog }) => {
      posthog.init(IDS.posthogKey, {
        api_host: IDS.posthogHost,
        ui_host: "https://us.posthog.com",
        capture_exceptions: true,
        // mirror PostHog's own `$` events into s10, as jdetle.com does
        before_send: (event) => {
          if (event?.event.startsWith("$") && event.event !== "$feature_flag_called" && event.event !== "$web_vitals") {
            push(envelope("event", `posthog.${event.event}`, { ...(event.properties as Attrs), source: "posthog" }));
          }
          return event;
        },
      });
      posthog.register({ app: "oauth-mcp-cards" });
      w.posthog = posthog;
    });
  }

  if (IDS.ga4) {
    addScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(IDS.ga4)}`);
    const dl = (w.dataLayer as unknown[]) ?? [];
    w.dataLayer = dl;
    w.gtag = function gtag() {
      // biome-ignore lint: gtag needs the arguments object
      dl.push(arguments);
    };
    (w.gtag as Fn)("js", new Date());
    (w.gtag as Fn)("config", IDS.ga4);
  }

  if (IDS.clarity) {
    const c: Fn = (w.clarity as Fn) ?? (((...a: unknown[]) => (c.q = c.q ?? []).push(a)) as Fn);
    w.clarity = c;
    addScript(`https://www.clarity.ms/tag/${encodeURIComponent(IDS.clarity)}`);
  }

  if (IDS.metaPixel && !w.fbq) {
    // the standard fbq stub: queue until fbevents.js installs callMethod
    type Fbq = Fn & { callMethod?: (...a: unknown[]) => void; push?: unknown; loaded?: boolean; version?: string };
    const n: Fbq = ((...a: unknown[]) => (n.callMethod ? n.callMethod(...a) : n.queue?.push(a))) as Fbq;
    n.queue = [];
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    w.fbq = n;
    w._fbq = n;
    addScript("https://connect.facebook.net/en_US/fbevents.js");
    n("init", IDS.metaPixel);
    n("track", "PageView");
  }

  if (IDS.plausible) {
    const p: Fn = (w.plausible as Fn) ?? (((...a: unknown[]) => (p.q = p.q ?? []).push(a)) as Fn);
    p.init = p.init ?? ((o?: unknown) => (p.o = o ?? {}));
    w.plausible = p;
    addScript(`https://plausible.io/js/${encodeURIComponent(IDS.plausible)}.js`);
    p.init();
  }
}

/** For tests. */
export function _queued() {
  return queue;
}
export function _stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

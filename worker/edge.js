// jdetle.com/games → the game series (AWS CloudFront → ALB → Fargate). Everything else on
// jdetle.com is untouched: this Worker only runs on the routes jdetle.com/games* and
// jdetle.com/mcp-oauth* (where the site used to live; those links are redirected).
//
// It also vouches for the visitor's address. Behind this Worker the game server only ever
// sees Cloudflare, which would make every player share one rate limit. So the Worker signs
// "<timestamp>.<visitor ip>" with an Ed25519 key. The key pair is generated here, inside
// Cloudflare, on first use and kept in KV; the server holds only the public half
// (published at /games/__edge-key), so no secret is shared and a forged header won't verify.
//
// And it is the doorbell. The game server scales itself to zero when nobody has played for a
// while (games are saved in DynamoDB). When a request finds the origin down, the Worker calls
// the wake function (env.WAKE_URL), but only for requests that mean someone is here: opening
// a page, creating or joining a room, a table reconnecting. A background refresh of the room
// list never wakes it. Hashed static assets are cached at the edge so they never reach AWS twice.

const PREFIX = "/games";
// The old address. env.LEGACY_MODE = "redirect" answers it here at the edge; anything else
// passes it to the origin (used for the few minutes a move takes).
const LEGACY = "/mcp-oauth";

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** Where an old link goes now: the old home is the OAuth game; everything else keeps its path. */
function moved(url) {
  const rest = url.pathname.slice(LEGACY.length);
  if (rest === "" || rest === "/") return `${PREFIX}/?game=oauth-mcp`;
  return `${PREFIX}${rest}${url.search}`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function signingKey(env) {
  const stored = await env.EDGE_KEYS.get("ed25519", "json");
  if (stored) {
    const key = await crypto.subtle.importKey("jwk", stored.private, { name: "Ed25519" }, false, ["sign"]);
    return { key, publicHex: stored.publicHex };
  }
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const record = {
    private: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicHex: hex(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
  await env.EDGE_KEYS.put("ed25519", JSON.stringify(record));
  return { key: pair.privateKey, publicHex: record.publicHex };
}

const DOWN = new Set([502, 503, 504]);

async function wake(env) {
  if (!env.WAKE_URL) return;
  try {
    await fetch(env.WAKE_URL, { method: "POST" });
  } catch {
    // the next request will ring again
  }
}

const WAKING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waking up · OAuth for MCP</title><noscript><meta http-equiv="refresh" content="6"></noscript>
<style>html{background:#04060d;color:#d7f3ff;font:16px/1.5 system-ui,sans-serif}main{max-width:34rem;margin:22vh auto 0;padding:0 24px}
h1{font:600 1.1rem/1.3 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:#29f0ff}
p{color:#9fb6c6}i{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ffa12b;margin-right:10px;animation:p 1s infinite}
@keyframes p{50%{opacity:.25}}</style></head><body><main><h1><i></i>Waking the game server</h1>
<p>It sleeps when nobody is playing, to save energy. Starting it takes about a minute; this page will carry on by itself.</p>
<p id="t"></p></main><script>let s=0;setInterval(()=>{s+=1;document.getElementById("t").textContent=s+"s";},1000);setTimeout(()=>location.reload(),5000);</script></body></html>`;

/** What to say when the origin is down (asleep or starting). */
function down(request, env, ctx, { ws, nav }) {
  const intent = ws || nav || !["GET", "HEAD"].includes(request.method);
  if (intent) ctx.waitUntil(wake(env));
  const common = { "cache-control": "no-store", "retry-after": "5" };
  if (nav) return new Response(WAKING_PAGE, { status: 503, headers: { ...common, "content-type": "text/html; charset=utf-8" } });
  return new Response(JSON.stringify({ error: "The server is waking up. Try again in a minute.", asleep: true, waking: intent }), {
    status: 503,
    headers: { ...common, "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // the route patterns also match e.g. /gamesx: leave anything that isn't ours to the blog
    const legacy = under(url.pathname, LEGACY);
    if (!legacy && !under(url.pathname, PREFIX)) return fetch(request);
    if (legacy && env.LEGACY_MODE === "redirect") {
      return new Response(null, { status: 308, headers: { location: moved(url), "cache-control": "public, max-age=3600" } });
    }

    const { key, publicHex } = await signingKey(env);
    if (url.pathname === `${PREFIX}/__edge-key` || url.pathname === `${LEGACY}/__edge-key`) {
      return new Response(JSON.stringify({ alg: "Ed25519", publicKey: publicHex }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const get = request.method === "GET";
    const ws = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
    const nav = get && !ws && (request.headers.get("accept") ?? "").includes("text/html");
    // content-hashed files never change: serve them from the edge after the first fetch
    const hashed = get && (url.pathname.startsWith(`${PREFIX}/_next/static/`) || url.pathname.startsWith(`${LEGACY}/_next/static/`));
    const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });
    if (hashed) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    const target = new URL(url.pathname + url.search, env.ORIGIN);
    const headers = new Headers(request.headers);
    for (const h of ["x-edge-ip", "x-edge-ts", "x-edge-sig", "x-omcp-internal"]) headers.delete(h);
    const ip = request.headers.get("cf-connecting-ip") ?? "";
    const ts = String(Date.now());
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${ts}.${ip}`));
    headers.set("x-edge-ip", ip);
    headers.set("x-edge-ts", ts);
    headers.set("x-edge-sig", hex(sig));
    headers.set("host", target.host);

    let res;
    try {
      // WebSocket upgrades pass straight through: fetch() returns the 101 and the socket
      res = await fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
    } catch {
      return down(request, env, ctx, { ws, nav });
    }
    // Our server stamps every response with nosniff. A 502/503/504 without it came from the
    // load balancer or CloudFront: there's no task behind them (asleep, or still starting).
    if (DOWN.has(res.status) && !res.headers.has("x-content-type-options")) return down(request, env, ctx, { ws, nav });

    if (hashed && res.status === 200) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set("cache-control", "public, max-age=31536000, immutable");
      copy.headers.delete("set-cookie");
      ctx.waitUntil(caches.default.put(cacheKey, copy.clone()));
      return copy;
    }
    return res;
  },
};

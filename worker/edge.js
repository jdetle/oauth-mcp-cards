// jdetle.com/mcp-oauth → the game (AWS CloudFront → ALB → Fargate). Everything else on
// jdetle.com is untouched: this Worker only runs on the route jdetle.com/mcp-oauth*.
//
// It also vouches for the visitor's address. Behind this Worker the game server only ever
// sees Cloudflare, which would make every player share one rate limit. So the Worker signs
// "<timestamp>.<visitor ip>" with an Ed25519 key. The key pair is generated here, inside
// Cloudflare, on first use and kept in KV; the server holds only the public half
// (published at /mcp-oauth/__edge-key), so no secret is shared and a forged header won't verify.

const PREFIX = "/mcp-oauth";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // the route pattern also matches e.g. /mcp-oauthx: leave anything that isn't ours to the blog
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return fetch(request);

    const { key, publicHex } = await signingKey(env);
    if (url.pathname === `${PREFIX}/__edge-key`) {
      return new Response(JSON.stringify({ alg: "Ed25519", publicKey: publicHex }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
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

    // WebSocket upgrades pass straight through: fetch() returns the 101 and the socket
    return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
  },
};

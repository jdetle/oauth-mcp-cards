// Helpers shared by the PartyKit servers.
import type * as Party from "partykit/server";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  });
}

export function clientIp(req: Party.Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "local"
  );
}

export async function readJson(req: Party.Request, maxBytes = 2048): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Sliding-window limiter: at most `limit` hits per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}
  /** returns seconds to wait, or 0 if allowed (and records the hit) */
  check(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return Math.ceil((this.windowMs - (now - list[0]!)) / 1000);
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return 0;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

export function internalSecret(room: Party.Room): string | null {
  const s = room.env.INTERNAL_SECRET;
  return typeof s === "string" && s.length >= 16 ? s : null;
}

export const INTERNAL_HEADER = "x-omcp-internal";

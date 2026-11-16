// The lobby (party "lobby", room "main"): lists open rooms by name and creates new ones.
import type * as Party from "partykit/server";
import { roomName } from "./names.ts";
import { clientIp, CORS, INTERNAL_HEADER, internalSecret, json, RateLimiter, readJson } from "./shared.ts";

interface RoomRow {
  name: string;
  seated: number;
  createdAt: number;
  updatedAt: number;
}

const LIST_TTL_MS = 12 * 60 * 60 * 1000;

export default class Lobby implements Party.Server {
  rooms = new Map<string, RoomRow>();
  createLimiter = new RateLimiter(10, 60_000);

  constructor(readonly room: Party.Room) {}

  async onStart() {
    const saved = await this.room.storage.get<RoomRow[]>("rooms");
    for (const r of saved ?? []) this.rooms.set(r.name, r);
  }

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") {
      const now = Date.now();
      const open = [...this.rooms.values()]
        .filter((r) => now - r.updatedAt < LIST_TTL_MS)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((r) => ({ name: r.name, seated: r.seated }));
      return json({ rooms: open });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const body = await readJson(req);
    if (!body) return json({ error: "Bad request." }, 400);
    const secret = internalSecret(this.room);

    if (body.action === "upsert" || body.action === "remove") {
      if (!secret || req.headers.get(INTERNAL_HEADER) !== secret) return json({ error: "Forbidden." }, 403);
      const name = String(body.name ?? "");
      const row = this.rooms.get(name);
      if (body.action === "remove") this.rooms.delete(name);
      else if (row) Object.assign(row, { seated: Math.max(0, Math.min(4, Number(body.seated) || 0)), updatedAt: Date.now() });
      await this.save();
      return json({ ok: true });
    }

    if (body.action === "create") {
      if (!secret) return json({ error: "Server is missing INTERNAL_SECRET." }, 500);
      // load tests carry the internal secret to skip the per-IP limit
      const trusted = req.headers.get(INTERNAL_HEADER) === secret;
      const wait = trusted ? 0 : this.createLimiter.check(clientIp(req));
      if (wait) return json({ error: `Too many rooms created. Try again in ${wait}s.` }, 429);
      const password = body.password;
      if (typeof password !== "string" || password.length < 4 || password.length > 128)
        return json({ error: "Password must be 4 to 128 characters." }, 400);
      const name = roomName((n) => this.rooms.has(n));
      const res = await this.room.context.parties.main!.get(name).fetch({
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_HEADER]: secret },
        body: JSON.stringify({ action: "init", password, displayName: body.displayName, role: body.role }),
      });
      const out = (await res.json()) as Record<string, unknown>;
      if (!res.ok) return json(out, res.status);
      const now = Date.now();
      this.rooms.set(name, { name, seated: out.role ? 1 : 0, createdAt: now, updatedAt: now });
      await this.save();
      return json(out);
    }
    return json({ error: "Bad request." }, 400);
  }

  private async save() {
    const cutoff = Date.now() - LIST_TTL_MS * 2;
    for (const [k, r] of this.rooms) if (r.updatedAt < cutoff) this.rooms.delete(k);
    await this.room.storage.put("rooms", [...this.rooms.values()]);
  }
}

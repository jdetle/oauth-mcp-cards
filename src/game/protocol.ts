// Strict parser for messages arriving over the WebSocket. Anything unexpected → null.
import { FLOWS, ROLES, type ClientMessage } from "./types.ts";

export const MAX_MESSAGE_BYTES = 1024;

const isStr = (v: unknown, max = 64): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const keys = Object.keys(o);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (o.t) {
    case "ping":
    case "stand":
    case "start":
    case "tell":
      return only("t") ? { t: o.t } : null;
    case "sit":
      return only("t", "role") && ROLES.includes(o.role as never) ? { t: "sit", role: o.role as never } : null;
    case "play":
      return only("t", "cardId") && isStr(o.cardId) ? { t: "play", cardId: o.cardId } : null;
    case "identify":
      return only("t", "flow") && FLOWS.includes(o.flow as never) ? { t: "identify", flow: o.flow as never } : null;
    case "host": {
      if (!only("t", "action", "round")) return null;
      if (!["next", "replay", "goto", "forceReveal"].includes(o.action as string)) return null;
      if (o.round !== undefined && !(Number.isInteger(o.round) && (o.round as number) >= 0 && (o.round as number) < 1000)) return null;
      return o.round === undefined ? { t: "host", action: o.action as never } : { t: "host", action: o.action as never, round: o.round as number };
    }
    default:
      return null;
  }
}

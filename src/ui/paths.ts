// The app can live under a path prefix (e.g. /mcp-oauth on jdetle.com). Set at build time.
// next/router and next/link add it themselves; plain <a href> and fetch() need this helper.
export const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
export const href = (path: string) => `${BASE}${path}`;

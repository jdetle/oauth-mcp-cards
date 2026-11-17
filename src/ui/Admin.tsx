"use client";
import { href } from "./paths.ts";
import { useCallback, useEffect, useState } from "react";
import { ROLE_NAMES, type Role } from "../game/types.ts";
import { API_BASE } from "./api.ts";
import { useVisiblePoll } from "./poll.ts";
import { Turnstile } from "./Turnstile.tsx";

interface AdminRoom {
  name: string;
  ageSeconds: number;
  idleSeconds: number;
  connections: number;
  started: boolean;
  round: number | null;
  rounds: number;
  status: string | null;
  players: { name: string; role: Role | null; bot: boolean; connected: boolean }[];
}

const ago = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", "x-omcp-admin": "1", ...(init.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, data };
}

export function Admin() {
  const [auth, setAuth] = useState<"checking" | "out" | "in" | "disabled">("checking");
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [botCheck, setBotCheck] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call("/api/admin/rooms");
    if (r.status === 404) return setAuth("disabled");
    if (r.status === 401) return setAuth("out");
    if (r.ok) {
      setRooms(r.data.rooms as AdminRoom[]);
      setAuth("in");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useVisiblePoll(load, 10_000, auth === "in");

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await call("/api/admin/login", { method: "POST", body: JSON.stringify({ password, turnstileToken: token }) });
    setBusy(false);
    setPassword("");
    if (!r.ok) {
      setResetKey((k) => k + 1);
      return setError(String(r.data.error ?? "Couldn't sign in."));
    }
    load();
  }

  async function remove(name: string) {
    setConfirming(null);
    const r = await call(`/api/admin/rooms/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok) setError(String(r.data.error ?? "Couldn't delete that game."));
    load();
  }

  if (auth === "checking") return <main className="wrap">Checking…</main>;
  if (auth === "disabled")
    return (
      <main className="wrap stack">
        <a href={href("/")}>← Lobby</a>
        <section className="panel stack">
          <h1>Admin</h1>
          <p className="muted">Admin isn't enabled on this server. Set an admin password with <code>bun run admin:password</code> and restart or redeploy.</p>
        </section>
      </main>
    );
  if (auth === "out")
    return (
      <main className="wrap stack admin">
        <a href={href("/")}>← Lobby</a>
        <section className="panel stack" style={{ maxWidth: 460 }}>
          <p className="kicker">Restricted</p>
          <h1>Admin sign-in</h1>
          <form onSubmit={login} className="stack" aria-label="Admin sign-in">
            <label htmlFor="admin-pw">
              Admin password
              <input id="admin-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </label>
            <Turnstile onToken={setToken} onRequired={setBotCheck} resetKey={resetKey} />
            {error ? <div className="error" role="alert">{error}</div> : null}
            <button className="primary" type="submit" disabled={busy || !password || (botCheck && !token)}>{busy ? "…" : "Sign in"}</button>
          </form>
        </section>
      </main>
    );

  return (
    <main className="wrap stack admin">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <a href={href("/")}>← Lobby</a>
        <button
          className="ghost"
          onClick={async () => {
            await call("/api/admin/logout", { method: "POST" });
            setAuth("out");
          }}
        >
          Sign out
        </button>
      </div>
      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <p className="kicker">Admin</p>
            <h1 style={{ margin: 0 }}>Active games</h1>
          </div>
          <span className="pill" aria-live="polite">{rooms.length} active</span>
        </div>
        {error ? <div className="error" role="alert">{error}</div> : null}
        {rooms.length === 0 ? <p className="muted">No active games.</p> : null}
        <ul className="admin-rooms">
          {rooms.map((r) => (
            <li key={r.name} data-room={r.name}>
              <div className="admin-room-head">
                <b className="room-name">{r.name}</b>
                <span className="muted small">
                  {r.started && r.round ? `round ${r.round}/${r.rounds} · ${r.status}` : "not started"} · {r.connections} connected · created {ago(r.ageSeconds)} ago · idle {ago(r.idleSeconds)}
                </span>
              </div>
              <div className="admin-players">
                {r.players.map((p, i) => (
                  <span key={i} className={`admin-player${p.connected ? " on" : ""}`}>
                    {p.name}
                    {p.bot ? <span className="sim-tag">sim</span> : null}
                    <i>{p.role ? ROLE_NAMES[p.role] : "spectator"}</i>
                  </span>
                ))}
              </div>
              <div className="row">
                {confirming === r.name ? (
                  <>
                    <span className="small">Delete <b>{r.name}</b>? Everyone at the table is disconnected and the game is gone.</span>
                    <button className="danger" onClick={() => remove(r.name)}>Yes, delete it</button>
                    <button onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="danger" onClick={() => setConfirming(r.name)} aria-label={`Delete ${r.name}`}>Delete game</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

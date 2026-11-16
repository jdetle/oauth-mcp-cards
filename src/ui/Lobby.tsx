"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { listRooms } from "./api.ts";
import { JoinForm } from "./JoinForm.tsx";

export function Lobby() {
  const router = useRouter();
  const [rooms, setRooms] = useState<{ name: string; seated: number }[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const go = (room: string) => router.push(`/play/?room=${encodeURIComponent(room)}`);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await listRooms();
      if (!alive) return;
      setOffline(r === null);
      if (r) setRooms(r);
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <main className="wrap">
      <div className="hero">
        <h1>OAuth for MCP: the card game</h1>
        <p className="muted" style={{ margin: 0 }}>
          Four players: Client, Application, Identity Provider, MCP Server. Pass token slips, make the right call, keep the chain unbroken.{" "}
          <a href="/reference/">Gateway auth reference</a>
        </p>
      </div>
      <div className="lobby">
        <section className="panel stack" aria-labelledby="rooms-h">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 id="rooms-h">Open rooms</h2>
            <span className="muted small" aria-live="polite">{offline ? "Can't reach the game server" : rooms ? `${rooms.length} open` : "Loading…"}</span>
          </div>
          {rooms && rooms.length === 0 ? <p className="muted">No rooms yet. Create one.</p> : null}
          <ul className="room-list">
            {rooms?.map((r) => (
              <li key={r.name} className="room-item">
                <header>
                  <span className="room-name">{r.name}</span>
                  <span className="row">
                    <span className="pill">{r.seated}/4 seated</span>
                    <button onClick={() => setOpen(open === r.name ? null : r.name)} aria-expanded={open === r.name}>
                      {open === r.name ? "Cancel" : "Join"}
                    </button>
                  </span>
                </header>
                {open === r.name ? <JoinForm room={r.name} onJoined={go} autoFocus /> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel stack" aria-labelledby="create-h">
          <h2 id="create-h">Create a room</h2>
          <JoinForm onJoined={go} />
        </section>
      </div>
    </main>
  );
}

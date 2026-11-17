"use client";
import { href } from "./paths.ts";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { listRooms, serverAsleep } from "./api.ts";
import { useVisiblePoll } from "./poll.ts";
import { JoinForm } from "./JoinForm.tsx";
import { TimesTable } from "./Seal.tsx";
import { ReturnToGame } from "./Timeline.tsx";

export function Lobby() {
  const router = useRouter();
  const [rooms, setRooms] = useState<{ name: string; seated: number }[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const go = (room: string) => router.push(`/play/?room=${encodeURIComponent(room)}`);

  const [asleep, setAsleep] = useState(false);
  const load = useCallback(async () => {
    const r = await listRooms();
    setOffline(r === null);
    setAsleep(serverAsleep);
    if (r) setRooms(r);
  }, []);
  // only while the lobby is on screen, and not often: the list rarely changes
  useVisiblePoll(load, 30_000);

  return (
    <main className="wrap">
      <div className="hero">
        <div>
          <p className="kicker">A card game about who to trust</p>
          <h1>OAuth<i>//</i>MCP</h1>
          <p className="lede">
            Four seats: Client, Application, Identity Provider, MCP Server. Pass token slips, make the right call at your step, and keep the chain unbroken.
          </p>
          <div className="row">
            <a href={href("/learn/")}>How signatures work →</a>
            <a href={href("/reference/")}>Gateway auth reference →</a>
          </div>
        </div>
        <TimesTable className="hero-table" />
      </div>
      <ReturnToGame />
      <div className="lobby">
        <section className="panel stack" aria-labelledby="rooms-h">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 id="rooms-h">Open rooms</h2>
            <span className="muted small" aria-live="polite">{asleep ? "Server asleep: creating or joining a room wakes it (about a minute)" : offline ? "Can't reach the game server" : rooms ? `${rooms.length} open` : "Loading…"}</span>
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

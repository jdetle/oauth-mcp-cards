"use client";
import { href } from "./paths.ts";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLES, type GameInfo, type Role } from "../game/types.ts";
import { listGames, listRooms, serverAsleep, type RoomRow } from "./api.ts";
import { useVisiblePoll } from "./poll.ts";
import { JoinForm } from "./JoinForm.tsx";
import { TimesTable } from "./Seal.tsx";
import { ReturnToGame } from "./Timeline.tsx";

const seatsOf = (g: GameInfo | undefined): Record<Role, string> | undefined =>
  g ? (Object.fromEntries(ROLES.map((r) => [r, g.seats[r].name])) as Record<Role, string>) : undefined;

/** The series home: pick a game, open a table, or join one that's open. */
export function Lobby() {
  const router = useRouter();
  const wanted = useSearchParams().get("game");
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [picked, setPicked] = useState<string>("oauth-mcp");
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const go = (room: string) => router.push(`/play/?room=${encodeURIComponent(room)}`);

  useEffect(() => {
    void listGames().then((g) => g && setGames(g));
  }, []);
  useEffect(() => {
    if (wanted && games?.some((g) => g.id === wanted)) setPicked(wanted);
  }, [wanted, games]);

  const [asleep, setAsleep] = useState(false);
  const load = useCallback(async () => {
    const r = await listRooms();
    setOffline(r === null);
    setAsleep(serverAsleep);
    if (r) setRooms(r);
    // the list of games comes from the same server: fetch it once it's awake
    setGames((g) => {
      if (!g) void listGames().then((x) => x && setGames(x));
      return g;
    });
  }, []);
  // only while the lobby is on screen, and not often: the list rarely changes
  useVisiblePoll(load, 30_000);

  const byId = useMemo(() => new Map((games ?? []).map((g) => [g.id, g])), [games]);
  const game = byId.get(picked);

  return (
    <main className="wrap" style={game ? ({ "--accent": game.accent } as React.CSSProperties) : undefined}>
      <div className="hero">
        <div>
          <p className="kicker">Card games about who to trust</p>
          <h1>Trust<i>//</i>Chain</h1>
          <p className="lede">
            Four seats, one chain. Pass slips, make the right call at your seat, and check before you trust. Each game teaches one corner of security by playing it.
          </p>
        </div>
        <TimesTable className="hero-table" />
      </div>
      <ReturnToGame />

      <section className="stack" aria-labelledby="games-h">
        <h2 id="games-h" className="sr-only">Games</h2>
        <div className="game-list" role="radiogroup" aria-label="Choose a game">
          {(games ?? []).map((g) => (
            <button
              key={g.id}
              role="radio"
              aria-checked={g.id === picked}
              className={`game-card${g.id === picked ? " on" : ""}`}
              style={{ "--accent": g.accent } as React.CSSProperties}
              onClick={() => setPicked(g.id)}
            >
              <span className="game-title">{g.title}</span>
              <span className="game-meta">{g.rounds} rounds</span>
            </button>
          ))}
          {!games ? <span className="muted small">{asleep ? "Waking the server to list the games…" : "Loading the games…"}</span> : null}
        </div>
        {game ? (
          <div className="panel stack game-about" aria-live="polite">
            <p className="lede" style={{ margin: 0 }}>{game.tagline}</p>
            <ul className="seat-list">
              {ROLES.map((r) => (
                <li key={r} className={`r-${r}`}>
                  <b>{game.seats[r].name}</b>
                  <span>{game.seats[r].brief}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <a href={href(`/primer/?game=${encodeURIComponent(game.id)}`)}>What {game.title} teaches →</a>
              {game.id === "oauth-mcp" ? (
                <>
                  <a href={href("/learn/")}>How signatures work →</a>
                  <a href={href("/reference/")}>Gateway auth reference →</a>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

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
                    <span className="pill game-pill" style={{ "--accent": r.accent } as React.CSSProperties}>{r.gameTitle}</span>
                    <span className="pill">{r.seated}/4 seated</span>
                    <button onClick={() => setOpen(open === r.name ? null : r.name)} aria-expanded={open === r.name}>
                      {open === r.name ? "Cancel" : "Join"}
                    </button>
                  </span>
                </header>
                {open === r.name ? <JoinForm room={r.name} seats={seatsOf(byId.get(r.game))} onJoined={go} autoFocus /> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel stack" aria-labelledby="create-h">
          <h2 id="create-h">Create a room{game ? <span className="create-game"> · {game.title}</span> : null}</h2>
          <JoinForm key={picked} game={picked} seats={seatsOf(game)} onJoined={go} />
        </section>
      </div>
    </main>
  );
}

"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ROLES, type GameInfo } from "../../src/game/types.ts";
import { listGames } from "../../src/ui/api.ts";
import { href } from "../../src/ui/paths.ts";

/** One page per game, built from its pack: what it teaches, who sits where, and the words it uses. */
function Primer() {
  const id = useSearchParams().get("game") ?? "oauth-mcp";
  const [games, setGames] = useState<GameInfo[] | null | undefined>(undefined);
  useEffect(() => {
    void listGames().then(setGames);
  }, []);
  const g = games?.find((x) => x.id === id);
  if (games === undefined) return <main className="wrap">Loading…</main>;
  if (!g) {
    return (
      <main className="wrap stack">
        <p>{games === null ? "Can't reach the game server (it may be waking up). Try again in a minute." : "No such game."}</p>
        <a href={href("/")}>← All games</a>
      </main>
    );
  }
  return (
    <main className="wrap stack primer" style={{ "--accent": g.accent } as React.CSSProperties}>
      <a href={href("/")}>← All games</a>
      <header className="stack">
        <p className="kicker">{g.rounds} rounds · four seats</p>
        <h1>{g.title}</h1>
        <p className="lede">{g.tagline}</p>
      </header>
      <section className="panel stack" aria-labelledby="p-teach">
        <h2 id="p-teach">What it teaches</h2>
        <ul>{g.teaches.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>
      <section className="panel stack" aria-labelledby="p-seats">
        <h2 id="p-seats">The four seats</h2>
        <ul className="seat-list">
          {ROLES.map((r) => (
            <li key={r} className={`r-${r}`}>
              <b>{g.seats[r].name}</b>
              <span>{g.seats[r].brief}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel stack" aria-labelledby="p-how">
        <h2 id="p-how">How a round goes</h2>
        <ul>
          <li>A slip arrives at your seat. Some of its values are sealed: nobody at the table can see them yet.</li>
          <li><b>Have to do:</b> make your call. The chain only moves if you do.</li>
          <li><b>Ought to do:</b> check the sealed values first. Checks are free and nothing forces them. Some rounds an intruder has swapped one, and only the check shows it.</li>
          <li>One wrong call breaks the chain. The round ends by showing what was expected against what was played, and who checked before they trusted.</li>
        </ul>
      </section>
      {g.glossary.length ? (
        <section className="panel stack" aria-labelledby="p-words">
          <h2 id="p-words">Words used</h2>
          <dl className="glossary">
            {g.glossary.map((w) => (
              <div key={w.term}>
                <dt>{w.term}</dt>
                <dd>{w.means}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <div className="row">
        <a className="button-link" href={href(`/?game=${encodeURIComponent(g.id)}`)}>Play {g.title} →</a>
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="wrap">Loading…</main>}>
      <Primer />
    </Suspense>
  );
}

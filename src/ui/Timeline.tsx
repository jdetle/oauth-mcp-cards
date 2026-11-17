"use client";
import { seat } from "./seats.ts";
// The game-long record: every move in every round, timestamped, as a chat-style feed
// with a tick strip (one tick per move, coloured by outcome) along the top.
import { href } from "./paths.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_NAMES, type ArchivedRound, type Call, type Diligence, type LogEntry, type PublicRound, type ServerMessage } from "../game/types.ts";
import { API_BASE, wsUrl } from "./api.ts";

const LAST_ROOM = "omcp:lastRoom";
export function rememberRoom(room: string | null) {
  try {
    if (room) localStorage.setItem(LAST_ROOM, room);
    else localStorage.removeItem(LAST_ROOM);
  } catch {}
}

// tolerate entries without a timestamp (an older server): never let the record crash the page
const valid = (at: number | undefined): at is number => typeof at === "number" && Number.isFinite(at) && at > 0;
const clock = (at: number | undefined) => (valid(at) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--:--");
const iso = (at: number | undefined) => (valid(at) ? new Date(at).toISOString() : undefined);

/**
 * Expected vs played. Colour says what kind of action it is (red = stop, green = go);
 * the sign between them says whether it was the right one. Red = red is a match.
 */
export function CallPair({ call, compact = false }: { call: Call; compact?: boolean }) {
  return (
    <span className={`call${call.matched ? " match" : " miss"}${compact ? " compact" : ""}`} aria-label={`Expected ${call.expected.label}, played ${call.played.label}: ${call.matched ? "match" : "mismatch"}`}>
      <span className="call-side">
        {compact ? null : <small>expected</small>}
        <span className={`chip t-${call.expected.tone}`}>{call.expected.label}</span>
      </span>
      <span className="call-eq" aria-hidden>{call.matched ? "=" : "≠"}</span>
      <span className="call-side">
        {compact ? null : <small>played</small>}
        <span className={`chip t-${call.played.tone}`}>{call.played.label}</span>
      </span>
      {compact ? null : <span className="call-word">{call.matched ? "match" : "mismatch"}</span>}
    </span>
  );
}

const DILIGENCE_TEXT: Record<Diligence["tag"], string> = {
  verified: "verified first",
  unverified: "trusted unchecked",
  breach: "breach",
  caught: "caught by a check",
  hunch: "refused on a hunch",
};

/** Was a decision on a sealed token made with eyes open? */
export function DiligenceTag({ d }: { d: Diligence }) {
  const skipped = d.skipped.length ? `Never checked: ${d.skipped.join(", ")}.` : "Every relevant check was run.";
  const would = d.wouldCatch.length ? ` Would have been caught by: ${d.wouldCatch.join(", ")}.` : "";
  return (
    <span className={`dil dil-${d.tag}`} title={`${skipped}${would}`}>
      {DILIGENCE_TEXT[d.tag]}
      {d.tag === "unverified" || d.tag === "breach" ? <i> · skipped {d.skipped.length ? d.skipped.join(", ") : "nothing"}</i> : null}
    </span>
  );
}

interface Group {
  key: string;
  index: number;
  title: string;
  success: boolean | null;
  live: boolean;
  log: LogEntry[];
}

/** Fetch archived rounds whenever a new round begins (or the current one is replayed). */
function useHistory(room: string, round: PublicRound | null): ArchivedRound[] {
  const [past, setPast] = useState<ArchivedRound[]>([]);
  const stamp = round ? `${round.index}:${round.log[0]?.at ?? 0}` : "none";
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/rooms/${encodeURIComponent(room)}/history`, { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { rounds: [] }))
      .then((d: { rounds: ArchivedRound[] }) => alive && setPast(d.rounds ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [room, stamp]);
  return past;
}

export function Timeline({ room, round, compact = false }: { room: string; round: PublicRound | null; compact?: boolean }) {
  const past = useHistory(room, round);
  const groups: Group[] = useMemo(() => {
    const g: Group[] = past.map((p, i) => ({ key: `a${i}`, index: p.index, title: p.title, success: p.success, live: false, log: p.log }));
    if (round) g.push({ key: "live", index: round.index, title: round.title, success: round.result ? round.result.success : null, live: round.status !== "done", log: round.log });
    return g;
  }, [past, round]);
  const moves = useMemo(() => groups.flatMap((g) => g.log.filter((l) => l.role).map((l) => ({ ...l, round: g.index }))), [groups]);

  // stick to the newest entry unless the reader has scrolled up
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const total = groups.reduce((n, g) => n + g.log.length, 0);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [total]);

  return (
    <div className={`timeline${compact ? " compact" : ""}`}>
      <div className="tl-strip" role="img" aria-label={`${moves.length} moves so far: ${moves.filter((m) => m.call?.matched).length} matched what was expected, ${moves.filter((m) => m.call && !m.call.matched).length} did not`}>
        {moves.length === 0 ? <span className="tl-empty">no moves yet</span> : null}
        {moves.slice(-120).map((m, i, arr) => (
          <i
            key={`${m.round}-${m.seq}`}
            className={`${m.call ? `t-${m.call.played.tone}${m.call.matched ? "" : " miss"}` : "t-none"}${i > 0 && arr[i - 1]!.round !== m.round ? " gap" : ""}`}
            title={`${clock(m.at)} · ${seat(m.role!)}${m.playerName ? ` (${m.playerName})` : ""}: ${m.text}${m.call ? ` [expected ${m.call.expected.label}: ${m.call.matched ? "match" : "mismatch"}]` : ""}`}
          />
        ))}
      </div>
      <div
        className="tl-feed log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        aria-live="polite"
        aria-label="Timeline of every move"
        tabIndex={0}
      >
        {groups.length === 0 ? <p className="tl-sys">The record of every move appears here.</p> : null}
        {groups.map((g) => (
          <section key={g.key} aria-label={`Round ${g.index + 1}`}>
            <h4 className={`tl-round${g.live ? " live" : ""}`}>
              <span>
                Round {g.index + 1} · {g.title}
              </span>
              {g.live ? <em>live</em> : g.success === true ? <em className="ok">held</em> : g.success === false ? <em className="bad">broken</em> : <em>skipped</em>}
            </h4>
            <ol>
              {g.log.map((l) =>
                l.role ? (
                  <li key={l.seq} className={`tl-msg r-${l.role}${l.call && !l.call.matched ? " miss" : ""}`}>
                    <div className="tl-meta">
                      <b>{seat(l.role)}</b>
                      {l.playerName ? <span>{l.playerName}</span> : null}
                      <time dateTime={iso(l.at)}>{clock(l.at)}</time>
                    </div>
                    <p>{l.text}</p>
                    {l.call ? <CallPair call={l.call} /> : null}
                    {l.diligence ? <DiligenceTag d={l.diligence} /> : null}
                    {l.detail ? <p className="detail">{l.detail}</p> : null}
                  </li>
                ) : (
                  <li key={l.seq} className={`tl-sys ${l.verdict}`}>
                    <time dateTime={iso(l.at)}>{clock(l.at)}</time> {l.text}
                  </li>
                ),
              )}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * On the lobby: one plain line back to the game you're in, if it still exists. Checks once,
 * quietly, and forgets the room if you're no longer in it (or it was closed).
 */
export function ReturnToGame() {
  const [room, setRoom] = useState<string | null>(null);
  const [round, setRound] = useState<string | null>(null);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LAST_ROOM);
    } catch {}
    if (!saved) return;
    const ws = new WebSocket(wsUrl(saved));
    const done = setTimeout(() => ws.close(), 4000);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as ServerMessage;
        if (m.t === "state") {
          setRoom(saved);
          const r = m.state.round;
          setRound(r ? `round ${r.index + 1}` : "not started");
          ws.close();
        }
      } catch {}
    };
    ws.onclose = (e) => {
      clearTimeout(done);
      if (e.code === 4401 || e.code === 4410) rememberRoom(null);
    };
    return () => {
      clearTimeout(done);
      ws.close();
    };
  }, []);
  if (!room) return null;
  return (
    <p className="return-to-game">
      You&apos;re in a game: <b className="room-name">{room}</b> <span className="muted">· {round}</span>{" "}
      <a href={href(`/play/?room=${encodeURIComponent(room)}`)}>Back to the table →</a>
    </p>
  );
}

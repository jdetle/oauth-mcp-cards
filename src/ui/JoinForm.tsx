"use client";
import { useEffect, useState } from "react";
import { ROLES, ROLE_NAMES } from "../game/types.ts";
import { createRoom, joinRoom, rememberName, type SeatChoice } from "./api.ts";

export function SeatSelect({ value, onChange, id }: { value: SeatChoice; onChange: (v: SeatChoice) => void; id: string }) {
  return (
    <label htmlFor={id}>
      Seat
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as SeatChoice)}>
        <option value="auto">Any open seat</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>{ROLE_NAMES[r]}</option>
        ))}
        <option value="spectate">Just watch (spectator)</option>
      </select>
    </label>
  );
}

/** Join an existing room (room given) or create a new one (room omitted). */
export function JoinForm({ room, onJoined, autoFocus }: { room?: string; onJoined: (room: string) => void; autoFocus?: boolean }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<SeatChoice>("auto");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idp = room ? `join-${room}` : "create";

  useEffect(() => setName(rememberName()), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Pick a display name.");
    if (password.length < 4) return setError("Password must be at least 4 characters.");
    setBusy(true);
    rememberName(name.trim());
    const res = room ? await joinRoom(room, password, name.trim(), seat) : await createRoom(password, name.trim(), seat);
    setBusy(false);
    if (!res.ok) return setError(String(res.data.error ?? "Couldn't join."));
    onJoined(String(res.data.room));
  }

  return (
    <form onSubmit={submit} className="stack" aria-label={room ? `Join ${room}` : "Create a room"}>
      <div className="form-grid three">
        <label htmlFor={`${idp}-name`}>
          Display name
          <input id={`${idp}-name`} value={name} maxLength={24} autoComplete="nickname" onChange={(e) => setName(e.target.value)} autoFocus={autoFocus} />
        </label>
        <label htmlFor={`${idp}-pw`}>
          {room ? "Room password" : "Set a room password"}
          <input id={`${idp}-pw`} type="password" value={password} autoComplete={room ? "current-password" : "new-password"} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <SeatSelect id={`${idp}-seat`} value={seat} onChange={setSeat} />
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>{busy ? "…" : room ? "Join room" : "Create room"}</button>
        {!room ? <span className="muted small">You'll get a random room name. Share it and the password with your table.</span> : null}
      </div>
    </form>
  );
}

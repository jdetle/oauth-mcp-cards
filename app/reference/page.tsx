import { AUTH_REFERENCE, QUICK_REF } from "../../src/game/reference.ts";
import { ROLES, ROLE_NAMES } from "../../src/game/types.ts";

export const metadata = { title: "Gateway Auth Reference · OAuth for MCP" };

export default function Reference() {
  return (
    <main className="wrap stack">
      <a href="/">← Lobby</a>
      <h1>Gateway auth reference</h1>
      <p className="muted" style={{ margin: 0 }}>
        Every way a gateway (the Application seat) can get a credential to an MCP server, what each party checks, and the trap each round teaches.
      </p>
      <section className="panel ref-scroll">
        <table className="ref-table">
          <thead>
            <tr><th>Method</th><th>Use when</th><th>Application sends</th><th>Receiver checks</th><th>Subject</th><th>Trap</th></tr>
          </thead>
          <tbody>
            {AUTH_REFERENCE.map((r) => (
              <tr key={r.flow}>
                <td><b>{r.name}</b><div className="muted small">{r.checklist}</div></td>
                <td>{r.when}</td><td>{r.appSends}</td><td>{r.checks}</td><td>{r.subject}</td><td>{r.trap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="ref-cards">
        {AUTH_REFERENCE.map((r) => (
          <section key={r.flow} className="panel stack small">
            <h2 style={{ margin: 0 }}>{r.name}</h2>
            <div className="muted">{r.checklist}</div>
            <div><b>Use when:</b> {r.when}</div>
            <div><b>Application sends:</b> {r.appSends}</div>
            <div><b>Receiver checks:</b> {r.checks}</div>
            <div><b>Subject:</b> {r.subject}</div>
            <div><b>Trap:</b> {r.trap}</div>
          </section>
        ))}
      </div>
      <h2>Quick-reference cards</h2>
      <div className="lobby">
        {ROLES.map((role) => (
          <section key={role} className="panel stack small">
            <h3>{ROLE_NAMES[role]}</h3>
            <div><b>You hold:</b> {QUICK_REF[role].hold}</div>
            <div><b>You check:</b> {QUICK_REF[role].check}</div>
            <div><b>Never:</b> {QUICK_REF[role].never}</div>
          </section>
        ))}
      </div>
    </main>
  );
}

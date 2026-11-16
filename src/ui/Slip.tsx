"use client";
import { ROLE_NAMES, type CheckKind, type Credential, type InFlight, type Role, type Sealed, type Token } from "../game/types.ts";
import { Seal, useKeys } from "./Seal.tsx";

const AUD_NAMES: Record<string, string> = { ...ROLE_NAMES, gateway: "Gateway" };
const aud = (a: string) => AUD_NAMES[a] ?? a;

function rel(ms: number, now: number) {
  const m = Math.round((ms - now) / 60_000);
  if (m >= 0) return `in ${m}m`;
  return <span className="bad">expired {-m}m ago</span>;
}

const short = (s: string, n = 10) => (s.length > n ? `${s.slice(0, n)}…` : s || "(none)");

function Fields({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TokenSlip({ token, title, sealed }: { token: Token; title?: string; sealed?: Sealed | null }) {
  const now = Date.now();
  const kind = token.kind === "id" ? "ID token" : token.kind === "id_jag" ? "ID-JAG" : "Access token";
  // A sealed token shows a field only once it has been checked.
  const cell = (k: CheckKind, value: React.ReactNode): React.ReactNode => {
    if (!sealed) return value;
    const seen = sealed.revealed.find((r) => r.kind === k);
    if (seen) {
      return (
        <span className={seen.ok ? "field-ok" : "field-bad"} title={seen.detail}>
          {value} {seen.ok ? "✓" : "✗"}
        </span>
      );
    }
    return <span className="field-sealed">{sealed.fields.includes(k) ? "▒▒▒▒▒▒ unchecked" : "▒▒▒▒▒▒"}</span>;
  };
  const unchecked = sealed ? sealed.fields.filter((k) => !sealed.revealed.some((r) => r.kind === k)) : [];
  return (
    <div className={`slip${sealed ? " is-sealed" : ""}`} role="group" aria-label={`${kind} slip${sealed ? `, sealed: ${unchecked.length} of ${sealed.fields.length} fields unchecked` : ""}`}>
      <div className="slip-title">
        <span>{title ?? (sealed ? `${kind} · sealed` : kind)}</span>
        {token.forged ? <span className="bad">hand-written</span> : null}
        <Seal of={token.id} size={30} broken={!!token.forged} label={token.forged ? "Not minted by the IdP" : "This token's seal"} />
      </div>
      <Fields
        rows={[
          ["subject", cell("subject", `${token.subject}${token.subjectType === "app" ? " (app)" : ""}`)],
          ["audience", cell("audience", aud(token.audience))],
          ["scope", cell("scope", token.scope.join(" "))],
          ["expiry", cell("expiry", rel(token.expiry, now))],
          ["issuer", cell("issuer", aud(token.issuer))],
          ...(token.refreshable ? ([["refresh", "yes (long-lived delegation)"]] as [string, string][]) : []),
        ]}
      />
      {sealed ? (
        <p className="slip-note">
          {unchecked.length
            ? `You only know what you check. Unchecked: ${unchecked.join(", ")}. Nothing forces a check; it will work either way.`
            : "Every relevant field has been checked."}
        </p>
      ) : null}
    </div>
  );
}

/** Signature seal next to the public key that checks it. */
function Signed({ signature, publicKey, signer, note }: { signature: string; publicKey?: string; signer?: string; note: string }) {
  return (
    <div className="slip-seals">
      <figure>
        <Seal of={signature || "unsigned"} size={40} broken={!signature} label={signature ? "Signature seal" : "Unsigned"} />
        <figcaption>signature</figcaption>
      </figure>
      {publicKey ? (
        <figure>
          <Seal of={publicKey} size={40} label={`${signer}'s public key`} />
          <figcaption>{signer} public key</figcaption>
        </figure>
      ) : null}
      <p>{note}</p>
    </div>
  );
}

function CredentialSlip({ c, sealed }: { c: Credential; sealed?: Sealed | null }) {
  const keys = useKeys();
  const now = Date.now();
  switch (c.type) {
    case "bearer":
      return <TokenSlip token={c.token} sealed={sealed} />;
    case "api_key":
      return (
        <div className="slip">
          <div className="slip-title">API key</div>
          <Fields rows={[["key", c.key.keyId], ["owner", c.key.owner], ["sent in", c.key.placement === "query" ? <span className="bad">URL query string</span> : "Authorization header"]]} />
          <p className="slip-note">A bearer secret: it travels on the wire, and whoever holds it is trusted.</p>
        </div>
      );
    case "sigv4":
      return (
        <div className="slip">
          <div className="slip-title">SigV4 signature</div>
          <Fields rows={[["key id", c.sig.accessKeyId], ["scope", `${c.sig.region}/${c.sig.service}`], ["signed", rel(c.sig.timestamp + 5 * 60_000, now)], ["signature", short(c.sig.signature)]]} />
          <Signed signature={c.sig.signature} note="HMAC with a shared secret: both sides hold the same key, so only the result is sent, never the secret." />
        </div>
      );
    case "gateway_jwt":
      return (
        <div className="slip">
          <div className="slip-title">Gateway JWT</div>
          <Fields
            rows={[
              ["iss", c.jwt.iss], ["sub", c.jwt.sub], ["aud", aud(c.jwt.aud)], ["scope", c.jwt.scope.join(" ")],
              ["expiry", rel(c.jwt.exp, now)], ["alg", c.jwt.alg === "none" ? <span className="bad">none</span> : c.jwt.alg], ["signature", short(c.jwt.signature)],
            ]}
          />
          <Signed
            signature={c.jwt.signature}
            publicKey={keys?.gateway}
            signer="Gateway"
            note={c.jwt.signature ? "Signed with the gateway's private key. The MCP Server checks it with the public key from the gateway's JWKS." : "No signature: anyone could have written this."}
          />
        </div>
      );
    case "aws_secret_bearer":
      return (
        <div className="slip">
          <div className="slip-title">Authorization header</div>
          <Fields rows={[["value", <span className="bad">AWS secret access key</span>]]} />
        </div>
      );
  }
}

export function InFlightSlip({ item, sealed }: { item: InFlight; sealed?: Sealed | null }) {
  const now = Date.now();
  const keys = useKeys();
  const head = `${ROLE_NAMES[item.from as Role]} → ${ROLE_NAMES[item.to as Role]}`;
  switch (item.kind) {
    case "request":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">{head}: request “{item.request.action}” (needs <code>{item.request.requiredScope}</code>)</div>
          {item.token ? <TokenSlip token={item.token} sealed={sealed} /> : <div className="slip">No token attached</div>}
        </div>
      );
    case "token_request":
      return (
        <div className="slip">
          <div className="slip-title">{head}: authorization request</div>
          <Fields rows={[["resource", aud(item.audience)], ["scope", item.scope.join(" ")], ["PKCE", item.pkce ? "code challenge S256" : <span className="bad">none</span>]]} />
        </div>
      );
    case "exchange":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">{head}: token exchange for <b>{item.requestedType === "id_jag" ? "an ID-JAG" : "an access token"}</b>, audience {aud(item.requestedAudience)}, scope <code>{item.requestedScope.join(" ")}</code></div>
          {item.subjectToken ? <TokenSlip token={item.subjectToken} title="Subject token" /> : <div className="slip">No user token to exchange</div>}
        </div>
      );
    case "assertion":
      return (
        <div className="slip">
          <div className="slip-title">{head}: signed assertion (JWT)</div>
          <Fields
            rows={[
              ["iss", item.assertion.iss], ["sub", item.assertion.sub], ["aud", aud(item.assertion.aud)],
              ["scope", item.assertion.scope.join(" ")], ["expiry", rel(item.assertion.exp, now)], ["signature", short(item.assertion.signature)],
            ]}
          />
          <Signed
            signature={item.assertion.signature}
            publicKey={keys?.application}
            signer="Application"
            note="Signed with the Application's private key, which never leaves it. The IdP checks it against the registered public key."
          />
        </div>
      );
    case "call":
    case "introspect":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">
            {head}: {item.kind === "introspect" ? "“Did you mint this?”" : <>call “{item.request.action}” (needs <code>{item.request.requiredScope}</code>{item.request.userScoped ? `, ${item.request.user ?? "a user"}'s data` : ""})</>}
            {item.kind === "call" && item.confirmedByIdp ? " · IdP vouched for it" : ""}
          </div>
          {item.credential ? <CredentialSlip c={item.credential} sealed={sealed} /> : <div className="slip">No credential</div>}
        </div>
      );
  }
}

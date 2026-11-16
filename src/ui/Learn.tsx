"use client";
// "Easy one way, hard the other": an interactive walk from paint, to clocks, to signatures.
// The paint and clock framings follow Brit Cruise's Art of the Problem series.
import { href } from "./paths.ts";
import { useMemo, useState } from "react";
import { Seal, TimesTable } from "./Seal.tsx";

// ---- 1. paint ---------------------------------------------------------------------------

type RGB = [number, number, number];
const hsl = (h: number): RGB => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.55 - 0.45 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};
const mix = (parts: [RGB, number][]): RGB => {
  const total = parts.reduce((n, [, w]) => n + w, 0);
  return [0, 1, 2].map((i) => Math.round(parts.reduce((n, [c, w]) => n + c[i]! * w, 0) / total)) as RGB;
};
const css = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const PUBLIC_PAINT: RGB = [240, 214, 70];

function Pot({ c, label, secret = false }: { c: RGB; label: string; secret?: boolean }) {
  return (
    <figure className={`pot${secret ? " secret" : ""}`}>
      <span style={{ background: css(c) }} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function Paint() {
  const [a, setA] = useState(350);
  const [b, setB] = useState(200);
  const A = hsl(a);
  const B = hsl(b);
  const mixA = mix([[PUBLIC_PAINT, 1], [A, 1]]);
  const mixB = mix([[PUBLIC_PAINT, 1], [B, 1]]);
  // each adds their own secret to the other's mixture: (public + other) is 2 parts, own secret 1 part
  const sharedA = mix([[mixB, 2], [A, 1]]);
  const sharedB = mix([[mixA, 2], [B, 1]]);
  return (
    <div className="lab">
      <div className="lab-grid three">
        <div className="lab-col">
          <h4>Alice</h4>
          <label>
            Her secret colour
            <input type="range" min={0} max={359} value={a} onChange={(e) => setA(Number(e.target.value))} aria-label="Alice's secret colour" />
          </label>
          <div className="pots">
            <Pot c={A} label="secret" secret />
            <span className="op">+</span>
            <Pot c={PUBLIC_PAINT} label="public" />
            <span className="op">=</span>
            <Pot c={mixA} label="sends this" />
          </div>
          <div className="pots">
            <Pot c={mixB} label="Bob's mix" />
            <span className="op">+</span>
            <Pot c={A} label="secret" secret />
            <span className="op">=</span>
            <Pot c={sharedA} label="shared" />
          </div>
        </div>
        <div className="lab-col eve">
          <h4>In the open</h4>
          <p className="small muted">Everything that crosses the wire. An eavesdropper sees all three.</p>
          <div className="pots">
            <Pot c={PUBLIC_PAINT} label="public" />
            <Pot c={mixA} label="Alice's mix" />
            <Pot c={mixB} label="Bob's mix" />
          </div>
          <p className="small">
            Mixing takes a second. <b>Un-mixing</b> to find either secret colour is the hard direction. Without a secret, the eavesdropper can't make the shared colour.
          </p>
        </div>
        <div className="lab-col">
          <h4>Bob</h4>
          <label>
            His secret colour
            <input type="range" min={0} max={359} value={b} onChange={(e) => setB(Number(e.target.value))} aria-label="Bob's secret colour" />
          </label>
          <div className="pots">
            <Pot c={B} label="secret" secret />
            <span className="op">+</span>
            <Pot c={PUBLIC_PAINT} label="public" />
            <span className="op">=</span>
            <Pot c={mixB} label="sends this" />
          </div>
          <div className="pots">
            <Pot c={mixA} label="Alice's mix" />
            <span className="op">+</span>
            <Pot c={B} label="secret" secret />
            <span className="op">=</span>
            <Pot c={sharedB} label="shared" />
          </div>
        </div>
      </div>
      <p className="verdict ok" role="status">
        Both end with the same colour ({css(sharedA)}), and neither secret ever left its owner.
      </p>
    </div>
  );
}

// ---- 2. the clock -----------------------------------------------------------------------

const P = 17;
const G = 3;
const powmod = (base: bigint, exp: bigint, mod: bigint) => {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
};

function Clock() {
  const [x, setX] = useState(5);
  const [guess, setGuess] = useState<number[]>([]);
  const TARGET = 12; // 3^13 mod 17
  const powers = useMemo(() => Array.from({ length: x + 1 }, (_, i) => Number(powmod(BigInt(G), BigInt(i), BigInt(P)))), [x]);
  const value = powers[x]!;
  const pt = (v: number, r = 80) => {
    const a = (v / P) * Math.PI * 2 - Math.PI / 2;
    return [100 + r * Math.cos(a), 100 + r * Math.sin(a)] as const;
  };
  const found = guess.find((g) => Number(powmod(BigInt(G), BigInt(g), BigInt(P))) === TARGET);
  return (
    <div className="lab">
      <div className="lab-grid two">
        <div className="lab-col center">
          <svg viewBox="0 0 200 200" className="clock" role="img" aria-label={`A clock with ${P} hours. 3 to the power ${x} lands on ${value}.`}>
            <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(41,240,255,0.35)" />
            {Array.from({ length: P }, (_, v) => {
              const [tx, ty] = pt(v, 92);
              const [dx, dy] = pt(v);
              return (
                <g key={v}>
                  <circle cx={dx} cy={dy} r={v === value ? 5 : 2} fill={v === value ? "#fff" : "rgba(41,240,255,0.7)"} />
                  <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill={v === value ? "#fff" : "#7d9bb2"}>{v}</text>
                </g>
              );
            })}
            <polyline points={powers.map((v) => pt(v).join(",")).join(" ")} fill="none" stroke="#ffa12b" strokeWidth="1.2" opacity="0.9" />
            <text x="100" y="96" textAnchor="middle" fontSize="11" fill="#d8f6ff">3<tspan dy="-5" fontSize="8">{x}</tspan><tspan dy="5"> mod 17</tspan></text>
            <text x="100" y="116" textAnchor="middle" fontSize="18" fill="#fff" fontWeight="700">= {value}</text>
          </svg>
        </div>
        <div className="lab-col">
          <h4>Forward: easy</h4>
          <label>
            Secret exponent x = <b>{x}</b>
            <input type="range" min={0} max={16} value={x} onChange={(e) => setX(Number(e.target.value))} aria-label="Secret exponent" />
          </label>
          <p className="small">
            Multiply by 3, and every time you pass 17 wrap around like a clock. The result hops around with no visible pattern: {powers.join(" → ")}.
          </p>
          <h4>Backward: hard</h4>
          <p className="small">
            Someone published <b>{TARGET}</b>. Which x did they use? There is no shortcut; you try them.
          </p>
          <div className="row">
            {Array.from({ length: 16 }, (_, i) => i + 1).map((g) => {
              const tried = guess.includes(g);
              const hit = tried && Number(powmod(BigInt(G), BigInt(g), BigInt(P))) === TARGET;
              return (
                <button key={g} className={`try${hit ? " hit" : tried ? " miss" : ""}`} onClick={() => setGuess((cur) => (cur.includes(g) ? cur : [...cur, g]))} aria-label={`Try x equals ${g}`}>
                  {g}
                </button>
              );
            })}
          </div>
          <p className={`verdict ${found ? "ok" : ""}`} role="status">
            {found
              ? `Found it: x = ${found}, after ${guess.length} ${guess.length === 1 ? "try" : "tries"}. On this clock there are 16 options. On a real one there are about 2²⁵⁵, more than the atoms in the galaxy.`
              : guess.length
                ? `${guess.length} ${guess.length === 1 ? "try" : "tries"} so far…`
                : "Click numbers to try them."}
          </p>
        </div>
      </div>
      <p className="small muted">
        This is the paint, in numbers: the public paint is 3, your secret colour is x, and the mixture you send is 3ˣ mod 17.
      </p>
    </div>
  );
}

// ---- 3. sign and check (toy RSA) ---------------------------------------------------------

const N = 3233n; // 61 × 53
const E = 17n; // public
const D = 2753n; // private
const digest = (s: string) => {
  let h = 7n;
  for (const ch of s) h = (h * 31n + BigInt(ch.codePointAt(0)!)) % N;
  return h < 2n ? h + 2n : h;
};
const MESSAGES = ["aud=idp scope=reports.read", "aud=idp scope=calendar.read", "aud=mcp scope=reports.read"];

function Signature() {
  const [msg, setMsg] = useState(MESSAGES[0]!);
  const [tamper, setTamper] = useState(false);
  const [forge, setForge] = useState(false);
  const m = digest(msg);
  const sig = powmod(m, forge ? 1234n : D, N);
  const received = tamper ? msg.replace(/scope=\S+/, "scope=*") : msg;
  const mReceived = digest(received);
  const recovered = powmod(sig, E, N);
  const ok = recovered === mReceived;
  return (
    <div className="lab">
      <div className="lab-grid two">
        <div className="lab-col">
          <h4>The signer (private key stays here)</h4>
          <label>
            Message to sign
            <select value={msg} onChange={(e) => setMsg(e.target.value)}>
              {MESSAGES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <ol className="steps">
            <li>Boil the message down to a number: <code>m = {m.toString()}</code></li>
            <li>
              Raise it to the <b>private</b> exponent on the clock: <code>s = m^{forge ? "1234" : "d"} mod 3233 = {sig.toString()}</code>
            </li>
            <li>Send the message and <code>s</code>. The private exponent is never sent.</li>
          </ol>
          <label className="check">
            <input type="checkbox" checked={forge} onChange={(e) => setForge(e.target.checked)} /> Forge it: sign with a guessed exponent instead of the real private key
          </label>
        </div>
        <div className="lab-col">
          <h4>Anyone (public key only)</h4>
          <label className="check">
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} /> Tamper in transit: widen the scope to <code>*</code>
          </label>
          <ol className="steps">
            <li>Received: <code>{received}</code></li>
            <li>Boil it down the same way: <code>m′ = {mReceived.toString()}</code></li>
            <li>
              Undo the signature with the <b>public</b> exponent: <code>s^17 mod 3233 = {recovered.toString()}</code>
            </li>
          </ol>
          <div className="compare">
            <figure>
              <Seal of={`m:${mReceived}`} size={64} hue={ok ? 150 : 350} label="Seal of the message received" />
              <figcaption>message</figcaption>
            </figure>
            <span className="op">{ok ? "=" : "≠"}</span>
            <figure>
              <Seal of={`m:${recovered}`} size={64} hue={ok ? 150 : 350} label="Seal recovered from the signature" />
              <figcaption>from signature</figcaption>
            </figure>
          </div>
          <p className={`verdict ${ok ? "ok" : "bad"}`} role="status">
            {ok
              ? "They match: this exact message was signed by whoever holds the private key."
              : tamper && forge
                ? "No match: forged and tampered. Reject."
                : tamper
                  ? "No match: the message changed after it was signed. Reject."
                  : "No match: this wasn't made with the private key. Reject."}
          </p>
        </div>
      </div>
      <p className="small muted">
        Toy numbers so the arithmetic fits on a page: the public key is (17, 3233) and the private exponent is 2753, which only works because 3233 = 61 × 53 and
        factoring is the hard direction. The game's real keys are Ed25519: different maths inside (elliptic curves), the same promise outside. Only the private key can
        make it; anyone with the public key can check it.
      </p>
    </div>
  );
}

// ---- page ----------------------------------------------------------------------------------

export function Learn() {
  return (
    <main className="wrap learn">
      <a href={href("/")}>← Lobby</a>
      <header className="learn-hero">
        <div>
          <p className="kicker">How signatures work</p>
          <h1>Easy one way. Hard the other.</h1>
          <p className="lede">
            Every signed card in the game rests on one idea: some sums are quick to do and practically impossible to undo. Three things to play with, then where they show up
            at the table.
          </p>
        </div>
        <TimesTable className="hero-table" />
      </header>

      <section className="panel stack" aria-labelledby="l1">
        <h2 id="l1"><span className="num">1</span> Mixing paint</h2>
        <p>Two people who have never met can agree on a secret colour in public. Move the sliders: the shared colour changes, and it is always the same on both sides.</p>
        <Paint />
      </section>

      <section className="panel stack" aria-labelledby="l2">
        <h2 id="l2"><span className="num">2</span> The clock</h2>
        <p>Paint is a metaphor. The real one-way mixer is arithmetic that wraps around, like hours on a clock.</p>
        <Clock />
      </section>

      <section className="panel stack" aria-labelledby="l3">
        <h2 id="l3"><span className="num">3</span> Sign it, check it</h2>
        <p>
          Give that clock a private shortcut and you get a signature: a number only one party can produce, that everyone can check. Try to tamper with the message or forge
          the signature.
        </p>
        <Signature />
      </section>

      <section className="panel stack" aria-labelledby="l4">
        <h2 id="l4"><span className="num">4</span> At the table</h2>
        <div className="lab-grid two">
          <div className="lab-col">
            <h4>Public-key signatures</h4>
            <ul className="plain">
              <li><b>Signed Assertion (JAG).</b> The Application signs “I am the Application, this is for the IdP, valid 5 minutes”. The IdP checks it against the registered public key. No shared secret crosses the wire.</li>
              <li><b>Gateway JWT (Zero Trust).</b> The gateway signs who the user is for each call. The MCP Server checks it with the gateway’s published keys (its JWKS).</li>
              <li><b>“alg: none”.</b> A JWT with no signature. Its seal is an empty ring: anyone could have written it.</li>
            </ul>
          </div>
          <div className="lab-col">
            <h4>Not public-key</h4>
            <ul className="plain">
              <li><b>SigV4.</b> A shared secret (HMAC): both sides hold the same key, so there is no public half. It still never travels; only the result of signing this exact request does.</li>
              <li><b>API key.</b> No maths at all. A bearer secret that travels on every call; whoever holds it is trusted.</li>
            </ul>
          </div>
        </div>
        <p className="verdict">
          A valid signature answers one question: <b>who wrote this?</b> The other checks are still yours to make. Is it <b>for me</b> (audience)? Is it <b>still fresh</b>
          (expiry)? Does it <b>cover this request</b> (scope)? Most traps in the game pass the signature and fail one of those.
        </p>
        <p className="small muted">
          In the game, each key and signature is drawn as a seal: a times table on a circle, generated from its actual bytes. The same key always draws the same seal. The
          paint and clock explanations here follow Brit Cruise’s <i>Art of the Problem</i> series, which is well worth watching.
        </p>
        <div className="row">
          <a href={href("/")}>Play a round →</a>
          <a href={href("/reference/")}>Gateway auth reference →</a>
        </div>
      </section>
    </main>
  );
}

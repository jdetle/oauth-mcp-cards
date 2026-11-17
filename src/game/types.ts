// Shared game types. Imported by the server (authoritative) and the browser (types only).

export const ROLES = ["client", "application", "idp", "mcp"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_NAMES: Record<Role, string> = {
  client: "Client",
  application: "Application",
  idp: "Identity Provider",
  mcp: "MCP Server",
};

export type Phase = "warmup" | "learning" | "assessment";

/**
 * Every way the Application (or Client) can get a credential to the MCP Server.
 * `reauth` = "neither": stop and make the user sign in again.
 */
export const FLOWS = [
  "obo",
  "jag",
  "idjag",
  "oauth",
  "passthrough",
  "apikey",
  "upstream",
  "sigv4",
  "zerotrust",
  "reauth",
] as const;
export type Flow = (typeof FLOWS)[number];

export const FLOW_NAMES: Record<Flow, string> = {
  obo: "On-Behalf-Of (token exchange)",
  jag: "JWT Authorization Grant (service identity)",
  idjag: "ID-JAG (identity assertion grant, e.g. Okta Cross App Access)",
  oauth: "MCP OAuth (client gets a token for the MCP Server)",
  passthrough: "OAuth passthrough (token already addressed to the MCP Server)",
  apikey: "Non-OAuth: static API key",
  upstream: "Per-user / per-key upstream credential",
  sigv4: "AWS SigV4 request signing",
  zerotrust: "Zero Trust: gateway-signed JWT",
  reauth: "Neither: reject and re-authenticate",
};

export interface Token {
  id: string;
  /** access = OAuth access token, id_jag = identity assertion JWT, id = OIDC ID token */
  kind: "access" | "id_jag" | "id";
  subject: string;
  subjectType: "user" | "app";
  audience: string;
  scope: string[];
  expiry: number; // epoch ms
  issuer: string;
  /** client the token was issued to (azp / client_id) */
  clientId?: string;
  refreshable?: boolean;
  /** Present when someone other than the IdP wrote the slip. */
  forged?: boolean;
}

/** A self-signed JWT the Application sends to the IdP (JAG). */
export interface Assertion {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  scope: string[];
  jti: string;
  signature: string; // base64 ed25519
}

/** A JWT the gateway (Application) signs for the MCP Server (Zero Trust JWT signer). */
export interface GatewayJwt {
  iss: string;
  sub: string;
  subjectType: "user" | "app";
  aud: string;
  exp: number;
  scope: string[];
  alg: "EdDSA" | "none";
  signature: string;
}

export interface SigV4Signature {
  accessKeyId: string;
  region: string;
  service: string;
  timestamp: number;
  signedHeaders: string[];
  signature: string; // hex hmac
}

export interface ApiKeyCredential {
  keyId: string; // shown truncated, e.g. "sk_live_…9f2"
  owner: string; // who the key belongs to: "shared", "user:alex", "key:team-a"
  placement: "header" | "query";
}

export type Credential =
  | { type: "bearer"; token: Token }
  | { type: "api_key"; key: ApiKeyCredential }
  | { type: "sigv4"; sig: SigV4Signature }
  | { type: "aws_secret_bearer" }
  | { type: "gateway_jwt"; jwt: GatewayJwt };

export interface RequestSpec {
  action: string; // human description, e.g. "Read the user's calendar"
  requiredScope: string;
  userScoped: boolean;
  /** user the request is about, when userScoped */
  user?: string;
}

/** Things that travel between seats, visible to the whole table. */
export type InFlight =
  | { kind: "request"; from: Role; to: Role; request: RequestSpec; token: Token | null }
  | { kind: "token_request"; from: Role; to: Role; scope: string[]; audience: string; pkce: boolean }
  | {
      kind: "exchange";
      from: Role;
      to: Role;
      subjectToken: Token | null;
      requestedAudience: string;
      requestedScope: string[];
      requestedType: "access" | "id_jag";
      request: RequestSpec;
    }
  | { kind: "assertion"; from: Role; to: Role; assertion: Assertion; request: RequestSpec }
  | { kind: "call"; from: Role; to: Role; request: RequestSpec; credential: Credential | null; confirmedByIdp?: boolean }
  | { kind: "introspect"; from: Role; to: Role; request: RequestSpec; credential: Credential | null }
  /** scripted games: a titled slip of labelled fields; sealed values arrive only once checked */
  | { kind: "packet"; from: Role; to: Role; title: string; note?: string; fields: PacketField[] };

export interface PacketField {
  label: string;
  /** null while sealed */
  value: string | null;
  state: "open" | "sealed" | "ok" | "bad";
  detail?: string;
}

/** Which game of the series a table is playing, and what its seats are called. */
export interface PublicGame {
  id: string;
  title: string;
  accent: string;
  seats: Record<Role, string>;
  briefs: Record<Role, string>;
  scripted: boolean;
}

export interface GameInfo {
  id: string;
  title: string;
  tagline: string;
  accent: string;
  scripted: boolean;
  rounds: number;
  seats: Record<Role, { name: string; brief: string }>;
  teaches: string[];
  glossary: { term: string; means: string }[];
}

export type CardType =
  | "request" // Client: send a request (optionally with a token slip)
  | "token_request" // Client: ask the IdP for a token (auth code + PKCE)
  | "forward" // Application: pass the received token to the MCP Server
  | "exchange" // Application: token exchange at the IdP (OBO or ID-JAG)
  | "assertion" // Application: self-signed JWT to the IdP (JAG)
  | "cached" // Application: reuse a cached token (trap)
  | "selfmint" // Application: write its own token slip
  | "api_key" // Application: attach a static API key
  | "upstream" // Application: look up a stored per-user / per-key credential
  | "sigv4" // Application: sign the request with AWS SigV4
  | "aws_secret" // Application: send the AWS secret as a bearer token (trap)
  | "jwt_sign" // Application: sign a JWT for the MCP Server with the gateway key
  | "reauth" // Application: stop, ask the user to re-authenticate
  | "issue" // IdP: issue / approve / confirm
  | "registered_key" // IdP: check a signature against the registered key (free)
  | "introspect" // MCP: ask the IdP whether it minted this token
  | "accept"
  | "reject"
  | "validate_audience" // optional checks: free, and nothing forces you to play one
  | "validate_scope"
  | "validate_expiry"
  | "validate_issuer"
  | "validate_subject"
  | "script" // scripted games: a card whose meaning lives in the game pack
  | "script_check" // scripted games: an optional check that reveals one sealed field
  | "temptation"; // optional, looks helpful, and breaks the chain: not everything on offer is a good idea

export const FREE_CARDS: CardType[] = ["registered_key", "validate_audience", "validate_scope", "validate_expiry", "validate_issuer", "validate_subject", "script_check", "temptation"];

/** One thing a receiver can verify about a token. */
export type CheckKind = "audience" | "scope" | "expiry" | "issuer" | "subject";

/** How a decision on a sealed token was made. */
export interface Diligence {
  /** verified: checked everything first. unverified: trusted blind and it was fine. breach: trusted something bad.
   *  caught: refused something bad a check exposed. hunch: refused something bad without having looked. */
  tag: "verified" | "unverified" | "breach" | "caught" | "hunch";
  skipped: string[];
  wouldCatch: string[];
}

export interface DiligenceStats {
  verified: number;
  unverified: number;
  breaches: number;
}

/** The token in flight is sealed: only checked fields are shown, to anyone. */
export interface Sealed {
  fields: CheckKind[];
  revealed: { kind: CheckKind; ok: boolean; detail: string }[];
}

/** Card as dealt to a hand. Only the owner ever sees it. */
export interface Card {
  id: string;
  type: CardType;
  label: string;
  /** Category shown on the card face, from the rules: Request, Token, Exchange, ... */
  category: string;
  // parameters (vary by type)
  to?: Role;
  attach?: string | null; // token key in the holder's slips, or "latest"
  request?: RequestSpec;
  scope?: string[];
  audience?: string;
  requestedType?: "access" | "id_jag";
  expiresInMin?: number;
  owner?: string; // api key / upstream credential owner
  placement?: "header" | "query";
  alg?: "EdDSA" | "none";
  pkce?: boolean;
  /** demonstration move in warm-ups: never scored, never breaks the chain */
  scripted?: boolean;
  /** only playable during this beat (0-based) */
  beat?: number;
  /** revealed only after the round ends */
  trap?: boolean;
}

export type Verdict = "correct" | "incorrect" | "neutral" | "info";

/** What kind of action a call is. Colour follows this, never right/wrong. */
export type Tone = "go" | "stop" | "send";
export interface Chip {
  label: string;
  tone: Tone;
}
/** Expected vs played for one judged move. A correct Reject is stop = stop: a match. */
export interface Call {
  expected: Chip;
  played: Chip;
  matched: boolean;
}

export interface LogEntry {
  seq: number;
  /** when it happened (epoch ms) */
  at: number;
  role: Role | null;
  playerName: string | null;
  text: string;
  verdict: Verdict;
  detail?: string;
  /** expected vs played, for judged moves */
  call?: Call;
  /** for decisions on a sealed token: verified first, or trusted blind? */
  diligence?: Diligence;
}

/** A finished round's log, kept for the game-long timeline. */
export interface ArchivedRound {
  index: number;
  title: string;
  phase: Phase;
  success: boolean | null;
  log: LogEntry[];
}

export interface ScoreBreakdown {
  calls: number;
  identify: number;
  bonus: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  role: Role | null;
  connected: boolean;
  /** simulated player driven by the server */
  bot: boolean;
  isHost: boolean;
  score: ScoreBreakdown;
  diligence: DiligenceStats;
}

export interface RoundSummary {
  index: number;
  phase: Phase;
  title: string;
}

export interface RoundResult {
  success: boolean;
  failedStep: { role: Role; playerName: string; text: string } | null;
  explanation: string;
  expectedFlows: Flow[];
  tells: string | null;
  discussion: string | null;
  teaches: string[];
  guesses: { playerId: string; name: string; flow: Flow; correct: boolean }[];
  awards: { playerId: string; name: string; points: number; why: string }[];
  traps: string[];
  /** revealed at the end: what an intruder swapped in transit, if anything */
  intrusion: string | null;
  /** scripted games: everyone's answer to the round's question, and the right one */
  picks?: { playerId: string; name: string; option: string; correct: boolean }[];
  answer?: string | null;
}

export interface ReadyCheck {
  ready: string[];
  /** connected humans who haven't readied */
  waiting: string[];
  /** humans at the table who aren't connected (not waited for) */
  away: string[];
  /** time left before the table moves on by itself, as of this message */
  remainingMs: number;
  timeoutMs: number;
}

export interface PublicRound {
  index: number;
  phase: Phase;
  title: string;
  text: string;
  /** shown in learning/warm-up; null in assessment until the round ends */
  flowLabel: string | null;
  status: "identify" | "playing" | "done";
  activeRole: Role | null;
  inFlight: InFlight | null;
  /** slips that have been passed this round, in order (visible to all) */
  slips: { from: Role; to: Role; label: string; item: InFlight }[];
  log: LogEntry[];
  identifySubmitted: string[];
  tellAwardedTo: string | null;
  seats: Record<Role, string | null>;
  result: RoundResult | null;
  /** identify options for assessment rounds */
  flowChoices: Flow[];
  tellEnabled: boolean;
  /** between rounds: who's ready, who we're waiting on, and the idle countdown */
  readyCheck: ReadyCheck | null;
  /** set while the token in flight is sealed (learning and assessment rounds) */
  sealed: Sealed | null;
  /** scripted games: the question answered in secret before an assessment round */
  question: { text: string; options: { id: string; label: string }[] } | null;
}

export interface PublicState {
  game: PublicGame;
  room: string;
  /** public halves of the signing keys (hex); private keys never leave the server */
  keys: { application: string; gateway: string };
  started: boolean;
  players: PublicPlayer[];
  spectators: number;
  rounds: RoundSummary[];
  round: PublicRound | null;
  hostId: string | null;
  /** the host's speed dial, 1 (slowest) to 5 (fastest) */
  speed: number;
  /** false = this table was created with its timers off */
  timers: boolean;
}

export interface PrivateView {
  playerId: string;
  name: string;
  role: Role | null;
  isHost: boolean;
  hand: Card[];
  slips: Token[]; // token slips held privately
  myGuess: Flow | null;
  /** scripted games: my answer to the round's question */
  myPick: string | null;
  canPlay: string[]; // card ids playable right now
}

// Wire protocol ----------------------------------------------------------

export type ClientMessage =
  | { t: "sit"; role: Role }
  | { t: "stand" }
  | { t: "start" }
  | { t: "play"; cardId: string }
  | { t: "identify"; flow: Flow }
  | { t: "tell" }
  | { t: "host"; action: "next" | "replay" | "goto" | "forceReveal" | "addBots" | "removeBots"; round?: number }
  | { t: "pick"; option: string } // scripted games: answer the round's question
  | { t: "speed"; speed: number } // host only: 1 (slowest) to 5 (fastest)
  | { t: "here" } // someone is at this screen (keeps a table being read from pausing)
  | { t: "end" } // host only: end the game now and close the room for everyone
  | { t: "ready"; ready: boolean }
  | { t: "ping" };

export type ServerMessage =
  | { t: "state"; state: PublicState; you: PrivateView }
  | { t: "error"; message: string }
  | { t: "pong" };

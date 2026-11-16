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
  | { kind: "introspect"; from: Role; to: Role; request: RequestSpec; credential: Credential | null };

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
  | "validate_audience" // MCP: free check
  | "validate_scope"; // MCP: free check

export const FREE_CARDS: CardType[] = ["registered_key", "validate_audience", "validate_scope"];

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

export interface LogEntry {
  seq: number;
  role: Role | null;
  playerName: string | null;
  text: string;
  verdict: Verdict;
  detail?: string;
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
  isHost: boolean;
  score: ScoreBreakdown;
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
}

export interface PublicState {
  room: string;
  started: boolean;
  players: PublicPlayer[];
  spectators: number;
  rounds: RoundSummary[];
  round: PublicRound | null;
  hostId: string | null;
}

export interface PrivateView {
  playerId: string;
  name: string;
  role: Role | null;
  isHost: boolean;
  hand: Card[];
  slips: Token[]; // token slips held privately
  myGuess: Flow | null;
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
  | { t: "host"; action: "next" | "replay" | "goto" | "forceReveal"; round?: number }
  | { t: "ping" };

export type ServerMessage =
  | { t: "state"; state: PublicState; you: PrivateView }
  | { t: "error"; message: string }
  | { t: "pong" };

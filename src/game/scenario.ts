// Scenario data model, validation, and default hands.
// Scenarios live as JSON in /scenarios and are compiled by scripts/build-scenarios.ts.

import { FLOWS, ROLES, type Card, type CardType, type Flow, type Phase, type RequestSpec, type Role } from "./types.ts";
import type { ApiKeyRecord } from "./validate.ts";

export interface TokenTemplate {
  kind?: "access" | "id_jag" | "id";
  subject: string;
  subjectType: "user" | "app";
  audience: string;
  scope: string[];
  /** minutes from round start; negative = already expired */
  expiresInMin: number;
  issuer?: string;
  forged?: boolean;
}

/** A card in a scenario file: either a preset name or a full card spec. */
export type CardTemplate = string | (Omit<Card, "id" | "category" | "label"> & { label?: string; category?: string });

export interface Scenario {
  id: string;
  order: number;
  phase: Phase;
  title: string;
  /** shown during play in warm-up and learning rounds */
  flowLabel?: string;
  text: string;
  userPresent: boolean;
  request: RequestSpec;
  /** acceptable flows; omitted in warm-ups */
  expectedFlows?: Flow[];
  tokens?: Record<string, TokenTemplate>;
  holders?: Partial<Record<Role, string[]>>;
  hands?: Partial<Record<Role, CardTemplate[]>>;
  beats?: { starter: Role }[];
  /** IdP: audiences it will mint for in an exchange (default ["mcp"]) */
  idpAudiences?: string[];
  /** IdP: scopes the Application may request for itself via JAG (default [request.requiredScope]) */
  appAllowedScopes?: string[];
  /** MCP Server: registered API keys / upstream credentials */
  apiKeys?: ApiKeyRecord[];
  /** MCP Server trusts the gateway's JWKS (Zero Trust) */
  trustsGateway?: boolean;
  /** issued tokens carry a refresh token */
  refreshToken?: boolean;
  tells?: string;
  discussion?: string;
  teaches?: string[];
  /** which items of the auth-method checklist this round covers */
  covers?: string[];
}

const pick = <T>(xs: readonly T[], x: unknown): x is T => xs.includes(x as T);

/** Throws with a readable message if a scenario file is malformed. */
export function validateScenario(s: unknown, file = "scenario"): Scenario {
  const fail = (m: string): never => {
    throw new Error(`${file}: ${m}`);
  };
  if (!s || typeof s !== "object") fail("not an object");
  const o = s as Record<string, unknown>;
  for (const k of ["id", "title", "text"]) if (typeof o[k] !== "string" || !(o[k] as string).trim()) fail(`"${k}" must be a non-empty string`);
  if (typeof o.order !== "number") fail('"order" must be a number');
  if (!pick(["warmup", "learning", "assessment"] as const, o.phase)) fail('"phase" must be warmup | learning | assessment');
  if (typeof o.userPresent !== "boolean") fail('"userPresent" must be true/false');
  const r = o.request as Record<string, unknown> | undefined;
  if (!r || typeof r.action !== "string" || typeof r.requiredScope !== "string" || typeof r.userScoped !== "boolean")
    fail('"request" needs action (string), requiredScope (string), userScoped (boolean)');
  if (o.expectedFlows !== undefined) {
    if (!Array.isArray(o.expectedFlows) || !o.expectedFlows.every((f) => pick(FLOWS, f)))
      fail(`"expectedFlows" entries must be one of ${FLOWS.join(", ")}`);
  }
  if (o.phase !== "warmup" && !o.expectedFlows) fail('learning and assessment scenarios need "expectedFlows"');
  if (o.hands) {
    for (const [role, cards] of Object.entries(o.hands as object)) {
      if (!pick(ROLES, role)) fail(`hands: unknown role "${role}"`);
      if (!Array.isArray(cards)) fail(`hands.${role} must be an array`);
      for (const c of cards as unknown[]) {
        if (typeof c === "string") {
          if (!(c in PRESETS)) fail(`hands.${role}: unknown preset "${c}". Known: ${Object.keys(PRESETS).join(", ")}`);
        } else if (!c || typeof c !== "object" || !CARD_TYPES.includes((c as { type: CardType }).type)) {
          fail(`hands.${role}: card needs a valid "type"`);
        }
      }
    }
  }
  if (o.beats && (!Array.isArray(o.beats) || !o.beats.every((b) => pick(ROLES, (b as { starter: unknown }).starter))))
    fail('"beats" must be [{ "starter": role }]');
  return o as unknown as Scenario;
}

export const CARD_TYPES: CardType[] = [
  "request", "token_request", "forward", "exchange", "assertion", "cached", "selfmint", "api_key", "upstream",
  "sigv4", "aws_secret", "jwt_sign", "reauth", "issue", "registered_key", "introspect", "accept", "reject",
  "validate_audience", "validate_scope",
];

const CATEGORY: Record<CardType, string> = {
  request: "Request",
  token_request: "Request",
  forward: "Request",
  exchange: "Exchange",
  assertion: "Signed Assertion",
  cached: "Token",
  selfmint: "Token",
  api_key: "Credential",
  upstream: "Credential",
  sigv4: "Signature",
  aws_secret: "Credential",
  jwt_sign: "Signature",
  reauth: "Reject",
  issue: "Issue",
  registered_key: "Registered Key",
  introspect: "Request",
  accept: "Accept",
  reject: "Reject",
  validate_audience: "Validate",
  validate_scope: "Validate",
};

type Preset = (s: Scenario) => Omit<Card, "id" | "category"> & { category?: string };

const scopeFamily = (scope: string) => (scope.includes(".") ? scope.split(".")[0] + ".*" : "*");

/** Named cards scenario files can refer to. */
export const PRESETS: Record<string, Preset> = {
  // Client
  "client.send": () => ({ type: "request", to: "application", attach: "userToken", label: "Send the request to the Application, with the user's token slip" }),
  "client.send_no_token": () => ({ type: "request", to: "application", attach: null, label: "Send the request to the Application (no user token to give)" }),
  "client.bypass": () => ({ type: "request", to: "mcp", attach: "userToken", trap: true, label: "Skip the Application: hand the token straight to the MCP Server" }),
  "client.bypass_no_token": () => ({ type: "request", to: "mcp", attach: null, trap: true, label: "Skip the Application: call the MCP Server directly" }),
  "client.send_stale": () => ({ type: "request", to: "application", attach: "staleToken", trap: true, label: "Send the request with the older token slip in your pocket" }),
  // Application
  "app.forward": () => ({ type: "forward", label: "Forward the token you received straight to the MCP Server" }),
  "app.exchange": (s) => ({ type: "exchange", audience: "mcp", requestedType: "access", scope: [s.request.requiredScope], label: `Exchange card: trade the user's token at the IdP for a token addressed to the MCP Server (scope ${s.request.requiredScope})` }),
  "app.exchange_broad": (s) => ({ type: "exchange", audience: "mcp", requestedType: "access", scope: [scopeFamily(s.request.requiredScope)], trap: true, label: `Exchange card: trade the user's token at the IdP for a token addressed to the MCP Server (scope ${scopeFamily(s.request.requiredScope)})` }),
  "app.idjag": (s) => ({ type: "exchange", audience: "mcp", requestedType: "id_jag", scope: [s.request.requiredScope], label: "Exchange card: trade the user's ID token at the IdP for an ID-JAG addressed to the MCP Server's authorization server" }),
  "app.assertion": (s) => ({ type: "assertion", audience: "idp", scope: [s.request.requiredScope], expiresInMin: 5, label: `Signed Assertion: JWT signed with your private key, audience = IdP, scope ${s.request.requiredScope}` }),
  "app.assertion_wrong_aud": (s) => ({ type: "assertion", audience: "mcp", scope: [s.request.requiredScope], expiresInMin: 5, trap: true, label: `Signed Assertion: JWT signed with your private key, audience = MCP Server, scope ${s.request.requiredScope}` }),
  "app.cached": () => ({ type: "cached", attach: "cachedToken", trap: true, label: "Use the user token cached from an earlier session" }),
  "app.reauth": () => ({ type: "reauth", label: "Stop: reject the job and ask the user to sign in again" }),
  "app.selfmint": (s) => ({ type: "selfmint", audience: "mcp", scope: [s.request.requiredScope], label: "Write your own token slip for the MCP Server" }),
  "app.api_key": () => ({ type: "api_key", placement: "header", label: "Attach the MCP Server's API key in the Authorization header" }),
  "app.api_key_query": () => ({ type: "api_key", placement: "query", trap: true, label: "Attach the MCP Server's API key as ?api_key= in the URL" }),
  "app.upstream_user": (s) => ({ type: "upstream", owner: s.request.user ?? "user", label: `Look up the upstream credential stored for ${s.request.user ?? "this caller"}` }),
  "app.upstream_shared": () => ({ type: "upstream", owner: "shared-admin", trap: true, label: "Use the shared admin credential for the upstream server" }),
  "app.sigv4": () => ({ type: "sigv4", expiresInMin: 0, label: "Sign this request with SigV4 using the task role's temporary credentials" }),
  "app.sigv4_replay": () => ({ type: "sigv4", expiresInMin: -60, trap: true, label: "Re-send the SigV4-signed request you captured an hour ago" }),
  "app.aws_secret": () => ({ type: "aws_secret", trap: true, label: "Put the AWS secret access key in the Authorization header" }),
  "app.jwt_sign": (s) => ({ type: "jwt_sign", alg: "EdDSA", audience: "mcp", expiresInMin: 5, scope: [s.request.requiredScope], label: "Sign a 5-minute JWT for the MCP Server with the gateway's key (sub = the user)" }),
  "app.jwt_none": (s) => ({ type: "jwt_sign", alg: "none", audience: "mcp", expiresInMin: 5, scope: [s.request.requiredScope], trap: true, label: 'Send a JWT for the MCP Server with "alg": "none" (skip signing, it is internal)' }),
  "app.accept": () => ({ type: "accept", label: "Accept" }),
  "app.reject": () => ({ type: "reject", label: "Reject" }),
  // IdP
  "idp.issue": () => ({ type: "issue", label: "Issue / approve" }),
  "idp.reject": () => ({ type: "reject", label: "Reject" }),
  "idp.registered_key": () => ({ type: "registered_key", label: "Registered Key: check the signature" }),
  // MCP Server
  "mcp.accept": () => ({ type: "accept", label: "Accept" }),
  "mcp.reject": () => ({ type: "reject", label: "Reject" }),
  "mcp.validate_audience": () => ({ type: "validate_audience", label: "Validate Audience" }),
  "mcp.validate_scope": () => ({ type: "validate_scope", label: "Validate Scope" }),
  "mcp.introspect": () => ({ type: "introspect", label: "Ask the IdP to confirm this token" }),
};

export const DEFAULT_APP_CARDS = ["app.forward", "app.exchange", "app.exchange_broad", "app.assertion", "app.cached", "app.reauth"];

/** Hands used when a scenario doesn't list its own. */
export function defaultHands(s: Scenario): Record<Role, CardTemplate[]> {
  const holders = resolvedHolders(s);
  const clientHas = holders.client ?? [];
  const client: CardTemplate[] = clientHas.includes("userToken")
    ? ["client.send", "client.bypass"]
    : ["client.send_no_token", "client.bypass_no_token"];
  if (clientHas.includes("staleToken")) client.push("client.send_stale");
  return {
    client,
    application: DEFAULT_APP_CARDS,
    idp: ["idp.issue", "idp.reject", "idp.registered_key"],
    mcp: ["mcp.accept", "mcp.reject", "mcp.validate_audience", "mcp.validate_scope"],
  };
}

export function resolvedTokens(s: Scenario): Record<string, TokenTemplate> {
  const user = s.request.user ?? "user:alex";
  const defaults: Record<string, TokenTemplate> = {
    userToken: { subject: user, subjectType: "user", audience: "application", scope: [s.request.requiredScope], expiresInMin: 60 },
    cachedToken: { subject: user, subjectType: "user", audience: "mcp", scope: [s.request.requiredScope], expiresInMin: -60 },
  };
  return { ...defaults, ...(s.tokens ?? {}) };
}

export function resolvedHolders(s: Scenario): Partial<Record<Role, string[]>> {
  if (s.holders) return s.holders;
  return { client: s.userPresent ? ["userToken"] : [], application: ["cachedToken"] };
}

/** Turn templates into concrete cards with fresh, unguessable ids. */
export function dealHands(s: Scenario, newId: () => string): Record<Role, Card[]> {
  const templates = { ...defaultHands(s), ...(s.hands ?? {}) } as Record<Role, CardTemplate[]>;
  const out = {} as Record<Role, Card[]>;
  for (const role of ROLES) {
    out[role] = (templates[role] ?? []).map((t) => {
      const base = typeof t === "string" ? PRESETS[t]!(s) : { ...t };
      return {
        ...base,
        id: newId(),
        label: base.label ?? base.type,
        category: base.category ?? CATEGORY[base.type],
      } as Card;
    });
  }
  return out;
}

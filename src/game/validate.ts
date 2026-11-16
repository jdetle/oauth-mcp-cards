// Pure validation rules. No I/O, no clock reads unless the caller omits `now`.
// Every accept/reject in the game is judged by one of these functions.

import type {
  ApiKeyCredential,
  Assertion,
  Credential,
  GatewayJwt,
  RequestSpec,
  Role,
  SigV4Signature,
  Token,
} from "./types.ts";

export type RuleCode =
  | "no_token"
  | "audience_mismatch"
  | "scope_insufficient"
  | "expired"
  | "app_subject_user_data"
  | "unregistered_issuer"
  | "unknown_token"
  | "not_access_token"
  // exchange
  | "no_subject_token"
  | "subject_audience"
  | "unregistered_client"
  | "requested_audience"
  | "scope_exceeds_consent"
  // assertion / signatures
  | "bad_signature"
  | "assertion_audience"
  | "scope_not_allowed"
  | "alg_none"
  // api keys & upstream credentials
  | "unknown_key"
  | "key_in_url"
  | "credential_owner_mismatch"
  // sigv4
  | "sigv4_clock_skew"
  | "sigv4_wrong_service"
  | "secret_on_wire"
  | "pkce_required";

export interface Check {
  rule: RuleCode;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  failures: RuleCode[];
  checks: Check[];
}

/** Audience identifiers used on slips. A role's audience is its own name. */
export const AUD: Record<Role, string> = {
  client: "client",
  application: "application",
  idp: "idp",
  mcp: "mcp",
};

export interface ValidationContext {
  now: number;
  /** issuers whose tokens the receiver trusts */
  trustedIssuers: string[];
  /** when given, the token must be one the IdP actually minted */
  mintedTokenIds?: ReadonlySet<string>;
}

export function defaultContext(now = Date.now()): ValidationContext {
  return { now, trustedIssuers: ["idp"] };
}

/** `calendar.*` covers `calendar.read`; `*` covers everything. */
export function scopeCovers(granted: string, wanted: string): boolean {
  if (granted === wanted || granted === "*") return true;
  if (granted.endsWith(".*")) return wanted.startsWith(granted.slice(0, -1));
  return false;
}

export function scopesCover(granted: readonly string[], wanted: string): boolean {
  return granted.some((g) => scopeCovers(g, wanted));
}

/** every requested scope must be covered by something granted */
export function scopeSubset(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.length > 0 && requested.every((r) => scopesCover(granted, r));
}

function result(checks: Check[]): ValidationResult {
  const failures = checks.filter((c) => !c.ok).map((c) => c.rule);
  return { valid: failures.length === 0, failures, checks };
}

/**
 * Validate an OAuth token arriving at `receiverRole` for `request`.
 * Rules: audience, scope, expiry, issuer, minted-by-IdP, app subject on user data.
 */
export function validateToken(
  token: Token | null | undefined,
  receiverRole: Role,
  request: RequestSpec,
  ctx: ValidationContext = defaultContext(),
): ValidationResult {
  if (!token) {
    return result([{ rule: "no_token", ok: false, detail: "No token was presented." }]);
  }
  const checks: Check[] = [];
  const me = AUD[receiverRole];
  checks.push({
    rule: "audience_mismatch",
    ok: token.audience === me,
    detail: `Audience is "${token.audience}", receiver is "${me}".`,
  });
  checks.push({
    rule: "scope_insufficient",
    ok: scopesCover(token.scope, request.requiredScope),
    detail: `Token scope [${token.scope.join(", ")}] vs required "${request.requiredScope}".`,
  });
  checks.push({
    rule: "expired",
    ok: token.expiry > ctx.now,
    detail: token.expiry > ctx.now ? "Not expired." : "Token has expired.",
  });
  checks.push({
    rule: "unregistered_issuer",
    ok: ctx.trustedIssuers.includes(token.issuer) && !token.forged,
    detail: `Issuer "${token.issuer}"${token.forged ? " (slip written by hand, not by the IdP)" : ""}.`,
  });
  if (ctx.mintedTokenIds) {
    checks.push({
      rule: "unknown_token",
      ok: ctx.mintedTokenIds.has(token.id),
      detail: ctx.mintedTokenIds.has(token.id) ? "IdP has a record of this token." : "IdP has no record of this token.",
    });
  }
  if (token.kind === "id") {
    checks.push({
      rule: "not_access_token",
      ok: false,
      detail: "This is an ID token (proof of sign-in), not an access token.",
    });
  }
  checks.push({
    rule: "app_subject_user_data",
    ok: !(request.userScoped && token.subjectType === "app"),
    detail:
      request.userScoped && token.subjectType === "app"
        ? `Subject is an application ("${token.subject}") but the request touches a user's data.`
        : "Subject fits the data.",
  });
  return result(checks);
}

export interface ExchangeInput {
  subjectToken: Token | null;
  clientId: string;
  requestedAudience: string;
  requestedScope: string[];
}

export interface ExchangeContext {
  now: number;
  registeredClients: string[];
  /** audiences the IdP will mint for in an exchange */
  allowedAudiences: string[];
}

/** IdP checks for On-Behalf-Of / ID-JAG token exchange. */
export function validateExchange(input: ExchangeInput, ctx: ExchangeContext): ValidationResult {
  const checks: Check[] = [];
  checks.push({
    rule: "unregistered_client",
    ok: ctx.registeredClients.includes(input.clientId),
    detail: `Client "${input.clientId}" ${ctx.registeredClients.includes(input.clientId) ? "is" : "is not"} registered.`,
  });
  const t = input.subjectToken;
  if (!t) {
    checks.push({ rule: "no_subject_token", ok: false, detail: "There is no user token to exchange." });
    return result(checks);
  }
  checks.push({
    rule: "subject_audience",
    ok: t.audience === input.clientId,
    detail: `The user's token is addressed to "${t.audience}"; the exchanging client is "${input.clientId}".`,
  });
  checks.push({ rule: "expired", ok: t.expiry > ctx.now, detail: t.expiry > ctx.now ? "User token still valid." : "User token has expired." });
  checks.push({
    rule: "unregistered_issuer",
    ok: t.issuer === "idp" && !t.forged,
    detail: `User token issued by "${t.issuer}".`,
  });
  checks.push({
    rule: "requested_audience",
    ok: ctx.allowedAudiences.includes(input.requestedAudience),
    detail: `Requested audience "${input.requestedAudience}".`,
  });
  checks.push({
    rule: "scope_exceeds_consent",
    ok: scopeSubset(input.requestedScope, t.scope),
    detail: `Requested [${input.requestedScope.join(", ")}], user granted [${t.scope.join(", ")}].`,
  });
  return result(checks);
}

// ---- Signatures (ed25519 for JWTs, HMAC-SHA256 for SigV4) -----------------

import { edSign, edVerify, hmacBytes, hmacHex } from "./crypto.ts";

export function canonical(obj: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(obj)
      .filter((k) => k !== "signature")
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {}),
  );
}

export function signPayload(payload: object, secretKeyHex: string): string {
  return edSign(canonical(payload as Record<string, unknown>), secretKeyHex);
}

export function verifyPayload(payload: object, signature: string, publicKeyHex: string): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) return false;
  return edVerify(canonical(payload as Record<string, unknown>), signature, publicKeyHex);
}

export interface AssertionContext {
  now: number;
  /** issuer -> registered public key (PEM or KeyObject) */
  registeredKeys: Record<string, string>;
  /** issuer -> scopes it may request for itself */
  allowedScopes: Record<string, string[]>;
}

/** IdP checks for a JWT Authorization Grant (self-signed client assertion). */
export function validateAssertion(a: Assertion, ctx: AssertionContext): ValidationResult {
  const checks: Check[] = [];
  const key = ctx.registeredKeys[a.iss];
  checks.push({
    rule: "unregistered_issuer",
    ok: !!key,
    detail: key ? `Issuer "${a.iss}" has a registered key.` : `No registered key for "${a.iss}".`,
  });
  const sigOk = !!key && verifyPayload(a, a.signature, key);
  checks.push({ rule: "bad_signature", ok: sigOk, detail: sigOk ? "Signature verifies." : "Signature does not verify." });
  checks.push({ rule: "assertion_audience", ok: a.aud === "idp", detail: `Assertion audience "${a.aud}" (must be the IdP).` });
  checks.push({ rule: "expired", ok: a.exp > ctx.now, detail: a.exp > ctx.now ? "Assertion not expired." : "Assertion expired." });
  const allowed = ctx.allowedScopes[a.iss] ?? [];
  checks.push({
    rule: "scope_not_allowed",
    ok: scopeSubset(a.scope, allowed),
    detail: `Requested [${a.scope.join(", ")}], allowed [${allowed.join(", ")}].`,
  });
  return result(checks);
}

export interface GatewayJwtContext {
  now: number;
  /** gateway issuers the MCP Server trusts -> public key (JWKS) */
  trustedSigners: Record<string, string>;
}

/** MCP Server checks for a Zero Trust gateway-signed JWT. */
export function validateGatewayJwt(
  jwt: GatewayJwt,
  receiverRole: Role,
  request: RequestSpec,
  ctx: GatewayJwtContext,
): ValidationResult {
  const checks: Check[] = [];
  checks.push({ rule: "alg_none", ok: jwt.alg !== "none", detail: jwt.alg === "none" ? 'alg is "none": unsigned.' : `alg ${jwt.alg}.` });
  const key = ctx.trustedSigners[jwt.iss];
  checks.push({
    rule: "unregistered_issuer",
    ok: !!key,
    detail: key ? `Signer "${jwt.iss}" is in the trusted JWKS.` : `Signer "${jwt.iss}" is not trusted.`,
  });
  const sigOk = jwt.alg !== "none" && !!key && verifyPayload(jwt, jwt.signature, key);
  checks.push({ rule: "bad_signature", ok: sigOk, detail: sigOk ? "Signature verifies." : "Signature does not verify." });
  checks.push({ rule: "audience_mismatch", ok: jwt.aud === AUD[receiverRole], detail: `Audience "${jwt.aud}".` });
  checks.push({ rule: "expired", ok: jwt.exp > ctx.now, detail: jwt.exp > ctx.now ? "Not expired." : "Expired." });
  checks.push({
    rule: "scope_insufficient",
    ok: scopesCover(jwt.scope, request.requiredScope),
    detail: `Scope [${jwt.scope.join(", ")}] vs "${request.requiredScope}".`,
  });
  checks.push({
    rule: "app_subject_user_data",
    ok: !(request.userScoped && jwt.subjectType === "app"),
    detail: "Subject fits the data.",
  });
  return result(checks);
}

export interface ApiKeyRecord {
  keyId: string;
  owner: string;
  scopes: string[];
  revoked?: boolean;
}

/** MCP Server checks for a static API key or a stored upstream credential. */
export function validateApiKey(
  key: ApiKeyCredential,
  request: RequestSpec,
  registry: readonly ApiKeyRecord[],
): ValidationResult {
  const checks: Check[] = [];
  const rec = registry.find((r) => r.keyId === key.keyId && !r.revoked);
  checks.push({ rule: "unknown_key", ok: !!rec, detail: rec ? "Key is registered." : "Key is unknown or revoked." });
  checks.push({
    rule: "key_in_url",
    ok: key.placement === "header",
    detail: key.placement === "header" ? "Sent in a header." : "Sent in the URL: it will land in logs and caches.",
  });
  checks.push({
    rule: "scope_insufficient",
    ok: !!rec && scopesCover(rec.scopes, request.requiredScope),
    detail: `Key scopes [${rec?.scopes.join(", ") ?? ""}] vs "${request.requiredScope}".`,
  });
  if (request.userScoped && request.user) {
    const ok = !!rec && rec.owner === request.user;
    checks.push({
      rule: "credential_owner_mismatch",
      ok,
      detail: ok
        ? `Credential belongs to ${request.user}.`
        : `Credential belongs to "${rec?.owner ?? key.owner}", but the data belongs to ${request.user}.`,
    });
  }
  return result(checks);
}

export interface SigV4Context {
  now: number;
  /** accessKeyId -> secret */
  secrets: Record<string, string>;
  service: string;
  region: string;
  maxSkewMs: number;
}

export function sigv4StringToSign(req: RequestSpec, s: Omit<SigV4Signature, "signature">): string {
  return ["AWS4-HMAC-SHA256", s.timestamp, `${s.region}/${s.service}/aws4_request`, req.action, req.requiredScope, s.signedHeaders.join(";")].join("\n");
}

export function sigv4Sign(req: RequestSpec, s: Omit<SigV4Signature, "signature">, secret: string): string {
  const kDate = hmacBytes("AWS4" + secret, String(Math.floor(s.timestamp / 86_400_000)));
  const kRegion = hmacBytes(kDate, s.region);
  const kService = hmacBytes(kRegion, s.service);
  const kSigning = hmacBytes(kService, "aws4_request");
  return hmacHex(kSigning, sigv4StringToSign(req, s));
}

/** MCP Server (behind AWS IAM auth) checks for a SigV4-signed request. */
export function validateSigV4(sig: SigV4Signature, request: RequestSpec, ctx: SigV4Context): ValidationResult {
  const checks: Check[] = [];
  const secret = ctx.secrets[sig.accessKeyId];
  checks.push({ rule: "unknown_key", ok: !!secret, detail: secret ? "Access key is known to IAM." : "Unknown access key." });
  checks.push({
    rule: "sigv4_wrong_service",
    ok: sig.service === ctx.service && sig.region === ctx.region,
    detail: `Signed for ${sig.service} in ${sig.region}; server is ${ctx.service} in ${ctx.region}.`,
  });
  const skew = Math.abs(ctx.now - sig.timestamp);
  checks.push({
    rule: "sigv4_clock_skew",
    ok: skew <= ctx.maxSkewMs,
    detail: skew <= ctx.maxSkewMs ? "Timestamp within 5 minutes." : "Timestamp too old: possible replay.",
  });
  const expected = secret ? sigv4Sign(request, sig, secret) : "";
  checks.push({
    rule: "bad_signature",
    ok: !!secret && expected === sig.signature,
    detail: expected === sig.signature ? "Signature matches this exact request." : "Signature does not match the request.",
  });
  return result(checks);
}

export interface CredentialContext {
  token: ValidationContext;
  gateway: GatewayJwtContext;
  apiKeys: readonly ApiKeyRecord[];
  sigv4: SigV4Context;
}

/** One entry point for "a call arrives at the MCP Server with some credential". */
export function validateCredential(
  cred: Credential | null,
  receiverRole: Role,
  request: RequestSpec,
  ctx: CredentialContext,
): ValidationResult {
  if (!cred) return result([{ rule: "no_token", ok: false, detail: "No credential was presented." }]);
  switch (cred.type) {
    case "bearer":
      return validateToken(cred.token, receiverRole, request, ctx.token);
    case "gateway_jwt":
      return validateGatewayJwt(cred.jwt, receiverRole, request, ctx.gateway);
    case "api_key":
      return validateApiKey(cred.key, request, ctx.apiKeys);
    case "sigv4":
      return validateSigV4(cred.sig, request, ctx.sigv4);
    case "aws_secret_bearer":
      return result([
        { rule: "secret_on_wire", ok: false, detail: "The long-term AWS secret was sent over the wire as a bearer token." },
      ]);
  }
}

export interface TokenRequestInput {
  clientId: string;
  audience: string;
  scope: string[];
  pkce: boolean;
}

export interface TokenRequestContext {
  registeredClients: string[];
  allowedAudiences: string[];
  requirePkce: boolean;
}

/** IdP checks for an authorization-code request (MCP OAuth). */
export function validateTokenRequest(input: TokenRequestInput, ctx: TokenRequestContext): ValidationResult {
  const checks: Check[] = [];
  checks.push({
    rule: "unregistered_client",
    ok: ctx.registeredClients.includes(input.clientId),
    detail: `Client "${input.clientId}".`,
  });
  checks.push({
    rule: "pkce_required",
    ok: !ctx.requirePkce || input.pkce,
    detail: input.pkce ? "PKCE code challenge present." : "No PKCE code challenge.",
  });
  checks.push({
    rule: "requested_audience",
    ok: ctx.allowedAudiences.includes(input.audience),
    detail: `Resource / audience "${input.audience}".`,
  });
  return result(checks);
}

import { describe, expect, test } from "bun:test";
import { newKeyPair } from "../src/game/crypto.ts";
import type { RequestSpec, Token } from "../src/game/types.ts";
import {
  scopeSubset,
  signPayload,
  sigv4Sign,
  validateApiKey,
  validateAssertion,
  validateCredential,
  validateExchange,
  validateGatewayJwt,
  validateSigV4,
  validateToken,
  validateTokenRequest,
} from "../src/game/validate.ts";

const NOW = 1_800_000_000_000;
const ctx = { now: NOW, trustedIssuers: ["idp"] };
const read: RequestSpec = { action: "read calendar", requiredScope: "calendar.read", userScoped: true, user: "user:alex" };
const tok = (o: Partial<Token> = {}): Token => ({
  id: "t1", kind: "access", subject: "user:alex", subjectType: "user", audience: "mcp",
  scope: ["calendar.read"], expiry: NOW + 60_000, issuer: "idp", ...o,
});

describe("validateToken", () => {
  test("accepts a token addressed to the receiver with enough scope", () => {
    expect(validateToken(tok(), "mcp", read, ctx).valid).toBe(true);
  });
  test("audience mismatch: token for the Application at the MCP Server", () => {
    const v = validateToken(tok({ audience: "application" }), "mcp", read, ctx);
    expect(v.valid).toBe(false);
    expect(v.failures).toContain("audience_mismatch");
  });
  test("scope insufficient: read token used for a write", () => {
    const v = validateToken(tok(), "mcp", { ...read, requiredScope: "calendar.write" }, ctx);
    expect(v.failures).toEqual(["scope_insufficient"]);
  });
  test("wildcard scope covers its family only", () => {
    expect(validateToken(tok({ scope: ["calendar.*"] }), "mcp", read, ctx).valid).toBe(true);
    expect(validateToken(tok({ scope: ["mail.*"] }), "mcp", read, ctx).valid).toBe(false);
  });
  test("expired", () => {
    expect(validateToken(tok({ expiry: NOW - 1 }), "mcp", read, ctx).failures).toEqual(["expired"]);
  });
  test("application subject reaching user data", () => {
    const v = validateToken(tok({ subject: "application", subjectType: "app" }), "mcp", read, ctx);
    expect(v.failures).toEqual(["app_subject_user_data"]);
    // ...but fine for non-user data
    expect(validateToken(tok({ subjectType: "app" }), "mcp", { ...read, userScoped: false }, ctx).valid).toBe(true);
  });
  test("unregistered issuer and forged slips", () => {
    expect(validateToken(tok({ issuer: "application" }), "mcp", read, ctx).failures).toEqual(["unregistered_issuer"]);
    expect(validateToken(tok({ forged: true }), "mcp", read, ctx).failures).toEqual(["unregistered_issuer"]);
  });
  test("unknown token when the IdP keeps a mint record", () => {
    const v = validateToken(tok(), "mcp", read, { ...ctx, mintedTokenIds: new Set(["other"]) });
    expect(v.failures).toEqual(["unknown_token"]);
  });
  test("ID tokens are not access tokens", () => {
    expect(validateToken(tok({ kind: "id" }), "mcp", read, ctx).failures).toContain("not_access_token");
  });
  test("no token", () => {
    expect(validateToken(null, "mcp", read, ctx).failures).toEqual(["no_token"]);
  });
});

describe("validateExchange (OBO / ID-JAG)", () => {
  const ectx = { now: NOW, registeredClients: ["application"], allowedAudiences: ["mcp"] };
  const userTok = tok({ audience: "application" });
  const base = { subjectToken: userTok, clientId: "application", requestedAudience: "mcp", requestedScope: ["calendar.read"] };
  test("valid exchange", () => expect(validateExchange(base, ectx).valid).toBe(true));
  test("unregistered client", () => expect(validateExchange({ ...base, clientId: "rogue" }, ectx).failures).toContain("unregistered_client"));
  test("scope beyond consent", () =>
    expect(validateExchange({ ...base, requestedScope: ["calendar.*"] }, ectx).failures).toEqual(["scope_exceeds_consent"]));
  test("audience not served", () =>
    expect(validateExchange({ ...base, requestedAudience: "github" }, ectx).failures).toEqual(["requested_audience"]));
  test("subject token not issued to the exchanging client", () =>
    expect(validateExchange({ ...base, subjectToken: tok() }, ectx).failures).toEqual(["subject_audience"]));
  test("expired subject token", () =>
    expect(validateExchange({ ...base, subjectToken: tok({ audience: "application", expiry: NOW - 1 }) }, ectx).failures).toEqual(["expired"]));
  test("nothing to exchange", () => expect(validateExchange({ ...base, subjectToken: null }, ectx).failures).toContain("no_subject_token"));
  test("scopeSubset needs every requested scope", () => {
    expect(scopeSubset(["a.read", "b.read"], ["a.read"])).toBe(false);
    expect(scopeSubset([], ["a.read"])).toBe(false);
  });
});

describe("validateAssertion (JAG)", () => {
  const keys = newKeyPair();
  const actx = { now: NOW, registeredKeys: { application: keys.publicKey }, allowedScopes: { application: ["reports.read"] } };
  const make = (o: Record<string, unknown> = {}, secret = keys.secretKey) => {
    const a = { iss: "application", sub: "application", aud: "idp", exp: NOW + 300_000, scope: ["reports.read"], jti: "j1", ...o };
    return { ...a, signature: signPayload(a, secret) } as never;
  };
  test("valid assertion", () => expect(validateAssertion(make(), actx).valid).toBe(true));
  test("signature from the wrong key", () => expect(validateAssertion(make({}, newKeyPair().secretKey), actx).failures).toEqual(["bad_signature"]));
  test("tampered after signing", () => {
    const a = make();
    expect(validateAssertion({ ...(a as object), scope: ["*"] } as never, actx).failures).toContain("bad_signature");
  });
  test("audience must be the IdP", () => expect(validateAssertion(make({ aud: "mcp" }), actx).failures).toEqual(["assertion_audience"]));
  test("expired", () => expect(validateAssertion(make({ exp: NOW - 1 }), actx).failures).toEqual(["expired"]));
  test("scope not allowed for the app", () => expect(validateAssertion(make({ scope: ["mail.read"] }), actx).failures).toEqual(["scope_not_allowed"]));
  test("unregistered issuer", () => expect(validateAssertion(make({ iss: "stranger" }), actx).failures).toContain("unregistered_issuer"));
  test("garbage signature never throws", () => {
    expect(validateAssertion({ ...(make() as object), signature: "zz" } as never, actx).valid).toBe(false);
  });
});

describe("Zero Trust gateway JWT", () => {
  const gw = newKeyPair();
  const gctx = { now: NOW, trustedSigners: { gateway: gw.publicKey } };
  const jwt = (o: Record<string, unknown> = {}) => {
    const j = { iss: "gateway", sub: "user:alex", subjectType: "user", aud: "mcp", exp: NOW + 300_000, scope: ["calendar.read"], alg: "EdDSA", ...o };
    return { ...j, signature: j.alg === "none" ? "" : signPayload(j, gw.secretKey) } as never;
  };
  test("valid", () => expect(validateGatewayJwt(jwt(), "mcp", read, gctx).valid).toBe(true));
  test("alg none", () => expect(validateGatewayJwt(jwt({ alg: "none" }), "mcp", read, gctx).failures).toContain("alg_none"));
  test("untrusted signer", () => expect(validateGatewayJwt(jwt(), "mcp", read, { now: NOW, trustedSigners: {} }).failures).toContain("unregistered_issuer"));
  test("audience", () => expect(validateGatewayJwt(jwt({ aud: "other" }), "mcp", read, gctx).failures).toEqual(["audience_mismatch"]));
});

describe("API keys and upstream credentials", () => {
  const reg = [
    { keyId: "k-alex", owner: "user:alex", scopes: ["calendar.*"] },
    { keyId: "k-admin", owner: "shared-admin", scopes: ["*"] },
    { keyId: "k-old", owner: "user:alex", scopes: ["*"], revoked: true },
  ];
  test("per-user key for that user", () => expect(validateApiKey({ keyId: "k-alex", owner: "user:alex", placement: "header" }, read, reg).valid).toBe(true));
  test("shared admin key on user data", () =>
    expect(validateApiKey({ keyId: "k-admin", owner: "shared-admin", placement: "header" }, read, reg).failures).toEqual(["credential_owner_mismatch"]));
  test("key in the URL", () => expect(validateApiKey({ keyId: "k-alex", owner: "user:alex", placement: "query" }, read, reg).failures).toEqual(["key_in_url"]));
  test("revoked / unknown key", () => expect(validateApiKey({ keyId: "k-old", owner: "user:alex", placement: "header" }, read, reg).failures).toContain("unknown_key"));
});

describe("SigV4", () => {
  const sctx = { now: NOW, secrets: { AK: "secret" }, service: "execute-api", region: "us-east-1", maxSkewMs: 300_000 };
  const sig = (o: Record<string, unknown> = {}) => {
    const s = { accessKeyId: "AK", region: "us-east-1", service: "execute-api", timestamp: NOW, signedHeaders: ["host"], ...o };
    return { ...s, signature: sigv4Sign(read, s as never, "secret") } as never;
  };
  test("valid", () => expect(validateSigV4(sig(), read, sctx).valid).toBe(true));
  test("replayed (old timestamp)", () => expect(validateSigV4(sig({ timestamp: NOW - 3_600_000 }), read, sctx).failures).toEqual(["sigv4_clock_skew"]));
  test("signature doesn't cover a different request", () =>
    expect(validateSigV4(sig(), { ...read, requiredScope: "calendar.write" }, sctx).failures).toEqual(["bad_signature"]));
  test("wrong service", () => expect(validateSigV4(sig({ service: "s3" }), read, sctx).failures).toContain("sigv4_wrong_service"));
  test("secret on the wire is always rejected", () => {
    const v = validateCredential({ type: "aws_secret_bearer" }, "mcp", read, {
      token: ctx, gateway: { now: NOW, trustedSigners: {} }, apiKeys: [], sigv4: sctx,
    });
    expect(v.failures).toEqual(["secret_on_wire"]);
  });
});

describe("token request (MCP OAuth)", () => {
  const tctx = { registeredClients: ["application"], allowedAudiences: ["mcp"], requirePkce: true };
  test("PKCE required", () =>
    expect(validateTokenRequest({ clientId: "application", audience: "mcp", scope: ["x"], pkce: false }, tctx).failures).toEqual(["pkce_required"]));
  test("resource must be served", () =>
    expect(validateTokenRequest({ clientId: "application", audience: "elsewhere", scope: ["x"], pkce: true }, tctx).failures).toEqual(["requested_audience"]));
});

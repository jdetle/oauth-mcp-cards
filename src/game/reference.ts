// Quick-reference cards (one per role) and the Gateway Auth Reference table.
import type { Flow, Role } from "./types.ts";

export const QUICK_REF: Record<Role, { hold: string; check: string; never: string }> = {
  client: {
    hold: "The user's token.",
    check: "Nothing; you start the flow. (In MCP OAuth you are the OAuth client: use PKCE and name the MCP Server as the resource.)",
    never: "Hand your token to anyone but the Application.",
  },
  application: {
    hold: "Your private key, the user's token, stored upstream credentials, the gateway signing key.",
    check: "Whether a user is present, and what the MCP Server will accept. You ought to check the token you were handed (who it is for, that it hasn't expired), though nothing forces you.",
    never: "Forward a token to an audience it was not issued for.",
  },
  idp: {
    hold: "Registered keys, consent records.",
    check: "Signature, audience, expiry, scope against consent.",
    never: "Mint a token for a scope the user did not grant.",
  },
  mcp: {
    hold: "Nothing until a credential arrives.",
    check: "Audience equals you, scope covers the request, not expired, issuer trusted, subject fits the data. None of these is required to answer the call. Each one you skip is a way in.",
    never: "Trust the caller's word over the token.",
  },
};

export interface RefRow {
  flow: Flow;
  name: string;
  checklist: string;
  when: string;
  appSends: string;
  checks: string;
  subject: string;
  trap: string;
}

/** Covers every item of the "Authentication" checklist, in its order. */
export const AUTH_REFERENCE: RefRow[] = [
  {
    flow: "apikey", name: "Non-OAuth (static API key)", checklist: "MCP Non-OAuth Authentication",
    when: "The MCP server doesn't do OAuth; simple internal service calls.",
    appSends: "API key in a header", checks: "Key is registered, not revoked, scoped for the request",
    subject: "The calling service", trap: "Key in the URL; using it for per-user data",
  },
  {
    flow: "oauth", name: "MCP OAuth", checklist: "MCP OAuth",
    when: "An MCP client connects to an OAuth-protected MCP server itself.",
    appSends: "Client runs auth code + PKCE with resource = MCP server, then sends the bearer token",
    checks: "IdP: registered client, PKCE, resource. MCP: audience, scope, expiry, issuer",
    subject: "The user", trap: "Skipping PKCE; token for the wrong resource",
  },
  {
    flow: "upstream", name: "Per-user / per-key upstream credentials", checklist: "MCP Per-User and Per-Key Upstream Credentials",
    when: "Upstream server doesn't trust your IdP (e.g. GitHub, Jira); gateway stores credentials per user or per virtual key.",
    appSends: "The stored credential belonging to this caller", checks: "Credential valid, scoped, and owned by whoever the data belongs to",
    subject: "The specific user or key", trap: "Shared admin credential",
  },
  {
    flow: "passthrough", name: "OAuth passthrough", checklist: "MCP OAuth Passthrough",
    when: "The token the client sent is already addressed to the upstream MCP server.",
    appSends: "The same token, unchanged", checks: "MCP: audience is itself, scope, expiry",
    subject: "The user", trap: "Passing through a token issued to the gateway (that's the OBO mistake)",
  },
  {
    flow: "obo", name: "On-Behalf-Of (token exchange)", checklist: "MCP OBO Auth",
    when: "User present; the gateway needs a token for a different audience.",
    appSends: "Exchange: the user's token → new token for the MCP server", checks: "IdP: client registration, audience, scope within consent",
    subject: "The user", trap: "Forwarding the raw user token",
  },
  {
    flow: "idjag", name: "ID-JAG (Okta Cross App Access)", checklist: "MCP ID-JAG Auth (Okta)",
    when: "User present; the MCP server's authorization server trusts the enterprise IdP.",
    appSends: "Exchange the user's identity for an ID-JAG, then trade it at the resource's authorization server",
    checks: "IdP: user, client, admin policy. Resource AS: ID-JAG signature, audience, expiry",
    subject: "The user", trap: "Sending the ID token as an access token",
  },
  {
    flow: "sigv4", name: "AWS SigV4", checklist: "MCP - AWS SigV4 Auth",
    when: "MCP server behind AWS IAM (API Gateway, Lambda URL, AgentCore).",
    appSends: "Request signed with temporary role credentials", checks: "Signature over this exact request, timestamp within 5 minutes, service/region",
    subject: "The IAM role", trap: "Sending the secret key; replaying an old signature",
  },
  {
    flow: "zerotrust", name: "Zero Trust (gateway JWT signer)", checklist: "MCP Zero Trust Auth (JWT Signer)",
    when: "Internal MCP servers trust the gateway's JWKS instead of the IdP.",
    appSends: "Short-lived JWT signed by the gateway: sub = the user, aud = the MCP server",
    checks: "Signature against trusted JWKS, alg not none, audience, expiry, scope",
    subject: "The user (as asserted by the gateway)", trap: 'alg "none"; long-lived JWTs',
  },
  {
    flow: "jag", name: "JWT Authorization Grant (service)", checklist: "(rules document)",
    when: "No user; the Application acts as itself.",
    appSends: "Self-signed assertion to the IdP", checks: "IdP: signature vs registered key, audience = IdP, expiry, allowed scope",
    subject: "The Application", trap: "Reusing a cached user token",
  },
  {
    flow: "reauth", name: "Neither: re-authenticate", checklist: "(rules document)",
    when: "The user is gone and only stale tokens remain.",
    appSends: "Nothing; reject the job and ask the user to sign in", checks: "n/a",
    subject: "n/a", trap: "Using the expired token anyway",
  },
];

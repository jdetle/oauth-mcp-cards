// One-paragraph explanations shown when the chain breaks. Keyed by reason code.
// Wording follows "OAuth for MCP: Card Game Rules".

import { FLOW_NAMES, type Flow } from "./types.ts";

export const EXPLANATIONS: Record<string, string> = {
  // validation rule codes
  no_token:
    "Nothing was presented to prove who is calling. A protected resource never trusts the caller's word over a token; with no credential it must reject.",
  audience_mismatch:
    "Audience is who the token is for. A valid token at the wrong door is still invalid: a token addressed to the Application must not be accepted by, or forwarded to, the MCP Server.",
  scope_insufficient:
    "Scope is what you may do. A token for calendar.read does not cover a write, and a receiver must check that the scope covers the specific request.",
  expired:
    "Every token has a lifetime. Once it has expired it proves nothing, no matter who is holding it. The fix is a fresh token, which may mean making the user sign in again.",
  app_subject_user_data:
    "This token's subject is an application, not a user, but the request touches a specific user's data. Direct (service) access must not be used to reach user-scoped data; that needs delegated access on the user's behalf.",
  unregistered_issuer:
    "Only the IdP mints tokens. Everyone else carries or validates them. A slip written by anyone the receiver does not trust as an issuer is worthless.",
  unknown_token:
    "The IdP has no record of minting this token. Only the IdP mints tokens; a slip the IdP cannot confirm must be rejected.",
  not_access_token:
    "An ID token proves the user signed in to the Application. It is not an access token and must never be sent to an API as one.",
  no_subject_token:
    "An exchange needs a user token to exchange. With no user present there is nothing to act on behalf of; use the Application's own identity, or ask the user to sign in.",
  subject_audience:
    "In a token exchange the Application hands over a token that was issued to it. This token is addressed to someone else, so the Application has no business exchanging it.",
  unregistered_client:
    "The IdP only deals with registered clients. An unregistered caller cannot exchange tokens.",
  requested_audience:
    "The IdP will only mint tokens for audiences it knows and is allowed to serve. This MCP Server does not accept tokens from this IdP, so an exchange cannot help; the Application needs a credential the upstream server already trusts.",
  scope_exceeds_consent:
    "The IdP is the only party that can mint a token for a new audience, and it does so only within the scope the user already consented to. Asking for more than the user granted must be refused.",
  bad_signature:
    "A signature proves who wrote the message without any secret crossing the wire. If it does not verify against the registered key, the message could have been written by anyone.",
  assertion_audience:
    "A signed assertion is addressed to the IdP that will read it. An assertion addressed anywhere else must be rejected, or it could be replayed against the wrong party.",
  scope_not_allowed:
    "With a JWT Authorization Grant the IdP checks the scope against what this Application is allowed for itself, not against user consent. This scope is not on the Application's list.",
  alg_none:
    'An unsigned JWT ("alg": "none") proves nothing. The MCP Server must require a signature from a key in its trusted JWKS.',
  unknown_key:
    "This key is not one the server knows, or it has been revoked. Static keys only work while they are registered and current.",
  key_in_url:
    "API keys belong in a request header. A key in the URL ends up in server logs, proxy logs, browser history and caches, which is a leak.",
  credential_owner_mismatch:
    "The credential used belongs to someone other than the person whose data is being touched. Per-user upstream credentials keep each user's access separate; a shared admin key erases that line and every action looks like the admin.",
  sigv4_clock_skew:
    "SigV4 signatures include a timestamp and are only valid for a few minutes. An old signed request being sent again is a replay and is rejected.",
  sigv4_wrong_service:
    "A SigV4 signature is scoped to one service and region. A signature for a different service does not authorise this request.",
  secret_on_wire:
    "SigV4 exists so the AWS secret key never leaves the caller: you sign each request with it instead of sending it. Sending the secret as a bearer token leaks a long-term credential.",
  pkce_required:
    "MCP clients are usually public clients that cannot keep a secret. The MCP authorization spec requires PKCE so a stolen authorization code is useless; a request without it must be refused.",

  // move-level reason codes
  client_bypass:
    "The Client's token is addressed to the Application. The Client must never hand it to anyone but the Application; going around the Application to the MCP Server crosses a trust boundary with the wrong ticket.",
  client_stale:
    "The Client sent a token that has already expired. It should get a fresh one (sign in again) rather than pass along a dead ticket.",
  app_forward:
    "A token is addressed to a specific audience and should not be forwarded across a trust boundary. The Application must exchange, not relay. Passthrough is only right when the token was already issued for the MCP Server.",
  app_cached:
    "Reusing a cached user token from an earlier session acts for a user who is not here. If no user is present, use the Application's own identity; if the user's data is involved, make them sign in again.",
  app_selfmint:
    "Only the IdP (or a signer the MCP Server has been configured to trust) can issue credentials. The Application writing its own token slip is forgery.",
  accepted_invalid: "A receiver accepted something that should have been rejected.",
  rejected_valid:
    "A receiver rejected something that was actually valid. Rejecting everything is not security; each check has to be applied as written.",
  idp_wrong_flow:
    "The IdP minted a token for a flow that does not fit this situation. It would technically work, but it gives the wrong party the wrong kind of access.",
};

const WHY_FLOW: Record<Flow, string> = {
  obo: "a user is present and the Application must reach the MCP Server on that user's behalf, so it exchanges the user's token for one addressed to the MCP Server",
  jag: "no user is present, so the Application proves its own identity with a signed assertion and gets a token whose subject is the Application",
  idjag:
    "a user is present and the MCP Server's authorization server trusts the enterprise IdP, so the Application exchanges the user's identity for an ID-JAG addressed to that authorization server",
  oauth:
    "the MCP client itself runs the OAuth flow (authorization code + PKCE) with the MCP Server as the resource, so the token it gets is addressed to the MCP Server",
  passthrough:
    "the token the Client sent is already addressed to the MCP Server, so the gateway can pass it through unchanged; exchanging or re-minting would add nothing",
  apikey:
    "the MCP Server does not do OAuth at all; it expects a static API key in a header, which the caller keeps secret",
  upstream:
    "the upstream server does not trust your IdP, so the gateway uses a credential stored for this specific user (or virtual key), keeping each caller's upstream access separate",
  sigv4:
    "the MCP Server sits behind AWS IAM, so each request is signed with SigV4 using short-lived role credentials; the secret never crosses the wire",
  zerotrust:
    "the MCP Server trusts the gateway's signing key (published as a JWKS), so the gateway signs a short-lived JWT stating who the user is for each call",
  reauth:
    "the user is gone and the only token is stale; no flow should be used. Reject the job and ask the user to sign in again",
};

export function wrongFlowExplanation(expected: Flow[], used: Flow | null): string {
  const exp = expected[0];
  const usedText = used ? `${FLOW_NAMES[used]} was used, but ` : "";
  if (!exp) return EXPLANATIONS.idp_wrong_flow!;
  return `Wrong flow. ${usedText}the right call here is ${FLOW_NAMES[exp]}: ${WHY_FLOW[exp]}.`;
}

export function explain(code: string): string {
  return EXPLANATIONS[code] ?? "That move broke the chain.";
}

export function flowWhy(flow: Flow): string {
  return WHY_FLOW[flow];
}

//! Pure validation rules. Every accept/reject in the game is judged here.
use crate::crypto::{ed_sign, ed_verify, hmac_bytes, hmac_hex};
use crate::types::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    NoToken,
    AudienceMismatch,
    ScopeInsufficient,
    Expired,
    AppSubjectUserData,
    UnregisteredIssuer,
    UnknownToken,
    NotAccessToken,
    NoSubjectToken,
    SubjectAudience,
    UnregisteredClient,
    RequestedAudience,
    ScopeExceedsConsent,
    BadSignature,
    AssertionAudience,
    ScopeNotAllowed,
    AlgNone,
    UnknownKey,
    KeyInUrl,
    CredentialOwnerMismatch,
    Sigv4ClockSkew,
    Sigv4WrongService,
    SecretOnWire,
    PkceRequired,
}

impl Rule {
    pub fn code(self) -> &'static str {
        match self {
            Rule::NoToken => "no_token",
            Rule::AudienceMismatch => "audience_mismatch",
            Rule::ScopeInsufficient => "scope_insufficient",
            Rule::Expired => "expired",
            Rule::AppSubjectUserData => "app_subject_user_data",
            Rule::UnregisteredIssuer => "unregistered_issuer",
            Rule::UnknownToken => "unknown_token",
            Rule::NotAccessToken => "not_access_token",
            Rule::NoSubjectToken => "no_subject_token",
            Rule::SubjectAudience => "subject_audience",
            Rule::UnregisteredClient => "unregistered_client",
            Rule::RequestedAudience => "requested_audience",
            Rule::ScopeExceedsConsent => "scope_exceeds_consent",
            Rule::BadSignature => "bad_signature",
            Rule::AssertionAudience => "assertion_audience",
            Rule::ScopeNotAllowed => "scope_not_allowed",
            Rule::AlgNone => "alg_none",
            Rule::UnknownKey => "unknown_key",
            Rule::KeyInUrl => "key_in_url",
            Rule::CredentialOwnerMismatch => "credential_owner_mismatch",
            Rule::Sigv4ClockSkew => "sigv4_clock_skew",
            Rule::Sigv4WrongService => "sigv4_wrong_service",
            Rule::SecretOnWire => "secret_on_wire",
            Rule::PkceRequired => "pkce_required",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Check {
    pub rule: Rule,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug)]
pub struct Validation {
    pub valid: bool,
    pub failures: Vec<Rule>,
    pub checks: Vec<Check>,
}

impl Validation {
    fn from(checks: Vec<Check>) -> Self {
        let failures: Vec<Rule> = checks.iter().filter(|c| !c.ok).map(|c| c.rule).collect();
        Validation { valid: failures.is_empty(), failures, checks }
    }
    pub fn first_failure_detail(&self) -> Option<&str> {
        self.checks.iter().find(|c| !c.ok).map(|c| c.detail.as_str())
    }
}

fn check(rule: Rule, ok: bool, detail: impl Into<String>) -> Check {
    Check { rule, ok, detail: detail.into() }
}

/// `calendar.*` covers `calendar.read`; `*` covers everything.
pub fn scope_covers(granted: &str, wanted: &str) -> bool {
    if granted == wanted || granted == "*" {
        return true;
    }
    if let Some(prefix) = granted.strip_suffix('*') {
        if granted.ends_with(".*") {
            return wanted.starts_with(prefix);
        }
    }
    false
}

pub fn scopes_cover(granted: &[String], wanted: &str) -> bool {
    granted.iter().any(|g| scope_covers(g, wanted))
}

/// Every requested scope must be covered by something granted.
pub fn scope_subset(requested: &[String], granted: &[String]) -> bool {
    !requested.is_empty() && requested.iter().all(|r| scopes_cover(granted, r))
}

pub struct TokenContext {
    pub now: i64,
    pub trusted_issuers: Vec<String>,
    /// When present, the token must be one the IdP actually minted.
    pub minted: Option<HashSet<String>>,
}

impl TokenContext {
    #[cfg(test)]
    pub fn simple(now: i64) -> Self {
        TokenContext { now, trusted_issuers: vec!["idp".into()], minted: None }
    }
}

/// Validate an OAuth token arriving at `receiver` for `request`.
pub fn validate_token(token: Option<&Token>, receiver: Role, request: &RequestSpec, ctx: &TokenContext) -> Validation {
    let Some(t) = token else {
        return Validation::from(vec![check(Rule::NoToken, false, "No token was presented.")]);
    };
    let me = receiver.aud();
    let mut c = vec![
        check(Rule::AudienceMismatch, t.audience == me, format!("Audience is \"{}\", receiver is \"{me}\".", t.audience)),
        check(
            Rule::ScopeInsufficient,
            scopes_cover(&t.scope, &request.required_scope),
            format!("Token scope [{}] vs required \"{}\".", t.scope.join(", "), request.required_scope),
        ),
        check(Rule::Expired, t.expiry > ctx.now, if t.expiry > ctx.now { "Not expired." } else { "Token has expired." }),
        check(
            Rule::UnregisteredIssuer,
            ctx.trusted_issuers.contains(&t.issuer) && !t.forged,
            format!("Issuer \"{}\"{}.", t.issuer, if t.forged { " (slip written by hand, not by the IdP)" } else { "" }),
        ),
    ];
    if let Some(minted) = &ctx.minted {
        let known = minted.contains(&t.id);
        c.push(check(Rule::UnknownToken, known, if known { "IdP has a record of this token." } else { "IdP has no record of this token." }));
    }
    if t.kind == TokenKind::Id {
        c.push(check(Rule::NotAccessToken, false, "This is an ID token (proof of sign-in), not an access token."));
    }
    let app_on_user = request.user_scoped && t.subject_type == SubjectType::App;
    c.push(check(
        Rule::AppSubjectUserData,
        !app_on_user,
        if app_on_user {
            format!("Subject is an application (\"{}\") but the request touches a user's data.", t.subject)
        } else {
            "Subject fits the data.".to_string()
        },
    ));
    Validation::from(c)
}

pub struct ExchangeInput<'a> {
    pub subject_token: Option<&'a Token>,
    pub client_id: &'a str,
    pub requested_audience: &'a str,
    pub requested_scope: &'a [String],
}

pub struct ExchangeContext {
    pub now: i64,
    pub registered_clients: Vec<String>,
    pub allowed_audiences: Vec<String>,
}

/// IdP checks for On-Behalf-Of / ID-JAG token exchange.
pub fn validate_exchange(i: &ExchangeInput, ctx: &ExchangeContext) -> Validation {
    let registered = ctx.registered_clients.iter().any(|c| c == i.client_id);
    let mut c = vec![check(
        Rule::UnregisteredClient,
        registered,
        format!("Client \"{}\" {} registered.", i.client_id, if registered { "is" } else { "is not" }),
    )];
    let Some(t) = i.subject_token else {
        c.push(check(Rule::NoSubjectToken, false, "There is no user token to exchange."));
        return Validation::from(c);
    };
    c.push(check(
        Rule::SubjectAudience,
        t.audience == i.client_id,
        format!("The user's token is addressed to \"{}\"; the exchanging client is \"{}\".", t.audience, i.client_id),
    ));
    c.push(check(Rule::Expired, t.expiry > ctx.now, if t.expiry > ctx.now { "User token still valid." } else { "User token has expired." }));
    c.push(check(Rule::UnregisteredIssuer, t.issuer == "idp" && !t.forged, format!("User token issued by \"{}\".", t.issuer)));
    c.push(check(
        Rule::RequestedAudience,
        ctx.allowed_audiences.iter().any(|a| a == i.requested_audience),
        format!("Requested audience \"{}\".", i.requested_audience),
    ));
    c.push(check(
        Rule::ScopeExceedsConsent,
        scope_subset(i.requested_scope, &t.scope),
        format!("Requested [{}], user granted [{}].", i.requested_scope.join(", "), t.scope.join(", ")),
    ));
    Validation::from(c)
}

/// Canonical JSON (sorted keys, no `signature`) for signing.
pub fn canonical<T: Serialize>(v: &T) -> String {
    let value = serde_json::to_value(v).unwrap_or_default();
    let mut map: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    if let serde_json::Value::Object(o) = value {
        for (k, v) in o {
            if k != "signature" {
                map.insert(k, v);
            }
        }
    }
    serde_json::to_string(&map).unwrap_or_default()
}

pub fn sign_payload<T: Serialize>(payload: &T, secret_hex: &str) -> String {
    ed_sign(&canonical(payload), secret_hex)
}

pub fn verify_payload<T: Serialize>(payload: &T, signature: &str, public_hex: &str) -> bool {
    signature.len() == 128 && signature.bytes().all(|b| b.is_ascii_hexdigit()) && ed_verify(&canonical(payload), signature, public_hex)
}

pub struct AssertionContext {
    pub now: i64,
    pub registered_keys: HashMap<String, String>,
    pub allowed_scopes: HashMap<String, Vec<String>>,
}

/// IdP checks for a JWT Authorization Grant (self-signed client assertion).
pub fn validate_assertion(a: &Assertion, ctx: &AssertionContext) -> Validation {
    let key = ctx.registered_keys.get(&a.iss);
    let sig_ok = key.map(|k| verify_payload(a, &a.signature, k)).unwrap_or(false);
    let allowed = ctx.allowed_scopes.get(&a.iss).cloned().unwrap_or_default();
    Validation::from(vec![
        check(
            Rule::UnregisteredIssuer,
            key.is_some(),
            if key.is_some() { format!("Issuer \"{}\" has a registered key.", a.iss) } else { format!("No registered key for \"{}\".", a.iss) },
        ),
        check(Rule::BadSignature, sig_ok, if sig_ok { "Signature verifies." } else { "Signature does not verify." }),
        check(Rule::AssertionAudience, a.aud == "idp", format!("Assertion audience \"{}\" (must be the IdP).", a.aud)),
        check(Rule::Expired, a.exp > ctx.now, if a.exp > ctx.now { "Assertion not expired." } else { "Assertion expired." }),
        check(
            Rule::ScopeNotAllowed,
            scope_subset(&a.scope, &allowed),
            format!("Requested [{}], allowed [{}].", a.scope.join(", "), allowed.join(", ")),
        ),
    ])
}

pub struct GatewayContext {
    pub now: i64,
    /// gateway issuer -> public key (its JWKS)
    pub trusted_signers: HashMap<String, String>,
}

/// MCP Server checks for a Zero Trust gateway-signed JWT.
pub fn validate_gateway_jwt(j: &GatewayJwt, receiver: Role, request: &RequestSpec, ctx: &GatewayContext) -> Validation {
    let key = ctx.trusted_signers.get(&j.iss);
    let sig_ok = j.alg != Alg::None && key.map(|k| verify_payload(j, &j.signature, k)).unwrap_or(false);
    Validation::from(vec![
        check(Rule::AlgNone, j.alg != Alg::None, if j.alg == Alg::None { "alg is \"none\": unsigned." } else { "alg EdDSA." }),
        check(
            Rule::UnregisteredIssuer,
            key.is_some(),
            if key.is_some() { format!("Signer \"{}\" is in the trusted JWKS.", j.iss) } else { format!("Signer \"{}\" is not trusted.", j.iss) },
        ),
        check(Rule::BadSignature, sig_ok, if sig_ok { "Signature verifies." } else { "Signature does not verify." }),
        check(Rule::AudienceMismatch, j.aud == receiver.aud(), format!("Audience \"{}\".", j.aud)),
        check(Rule::Expired, j.exp > ctx.now, if j.exp > ctx.now { "Not expired." } else { "Expired." }),
        check(
            Rule::ScopeInsufficient,
            scopes_cover(&j.scope, &request.required_scope),
            format!("Scope [{}] vs \"{}\".", j.scope.join(", "), request.required_scope),
        ),
        check(Rule::AppSubjectUserData, !(request.user_scoped && j.subject_type == SubjectType::App), "Subject fits the data."),
    ])
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiKeyRecord {
    pub key_id: String,
    pub owner: String,
    pub scopes: Vec<String>,
    #[serde(default)]
    pub revoked: bool,
}

/// MCP Server checks for a static API key or a stored upstream credential.
pub fn validate_api_key(key: &ApiKeyCredential, request: &RequestSpec, registry: &[ApiKeyRecord]) -> Validation {
    let rec = registry.iter().find(|r| r.key_id == key.key_id && !r.revoked);
    let mut c = vec![
        check(Rule::UnknownKey, rec.is_some(), if rec.is_some() { "Key is registered." } else { "Key is unknown or revoked." }),
        check(
            Rule::KeyInUrl,
            key.placement == Placement::Header,
            if key.placement == Placement::Header { "Sent in a header." } else { "Sent in the URL: it will land in logs and caches." },
        ),
        check(
            Rule::ScopeInsufficient,
            rec.map(|r| scopes_cover(&r.scopes, &request.required_scope)).unwrap_or(false),
            format!("Key scopes [{}] vs \"{}\".", rec.map(|r| r.scopes.join(", ")).unwrap_or_default(), request.required_scope),
        ),
    ];
    if let (true, Some(user)) = (request.user_scoped, &request.user) {
        let ok = rec.map(|r| &r.owner == user).unwrap_or(false);
        c.push(check(
            Rule::CredentialOwnerMismatch,
            ok,
            if ok {
                format!("Credential belongs to {user}.")
            } else {
                format!("Credential belongs to \"{}\", but the data belongs to {user}.", rec.map(|r| r.owner.as_str()).unwrap_or(&key.owner))
            },
        ));
    }
    Validation::from(c)
}

pub struct SigV4Context {
    pub now: i64,
    pub secrets: HashMap<String, String>,
    pub service: String,
    pub region: String,
    pub max_skew_ms: i64,
}

pub fn sigv4_string_to_sign(req: &RequestSpec, s: &SigV4Signature) -> String {
    [
        "AWS4-HMAC-SHA256".to_string(),
        s.timestamp.to_string(),
        format!("{}/{}/aws4_request", s.region, s.service),
        req.action.clone(),
        req.required_scope.clone(),
        s.signed_headers.join(";"),
    ]
    .join("\n")
}

/// Real SigV4 key derivation (date → region → service → aws4_request) over our canonical string.
pub fn sigv4_sign(req: &RequestSpec, s: &SigV4Signature, secret: &str) -> String {
    let k_date = hmac_bytes(format!("AWS4{secret}").as_bytes(), &(s.timestamp / 86_400_000).to_string());
    let k_region = hmac_bytes(&k_date, &s.region);
    let k_service = hmac_bytes(&k_region, &s.service);
    let k_signing = hmac_bytes(&k_service, "aws4_request");
    hmac_hex(&k_signing, &sigv4_string_to_sign(req, s))
}

/// MCP Server (behind AWS IAM) checks for a SigV4-signed request.
pub fn validate_sigv4(sig: &SigV4Signature, request: &RequestSpec, ctx: &SigV4Context) -> Validation {
    let secret = ctx.secrets.get(&sig.access_key_id);
    let skew = (ctx.now - sig.timestamp).abs();
    let expected = secret.map(|s| sigv4_sign(request, sig, s));
    let sig_ok = expected.as_deref() == Some(sig.signature.as_str());
    Validation::from(vec![
        check(Rule::UnknownKey, secret.is_some(), if secret.is_some() { "Access key is known to IAM." } else { "Unknown access key." }),
        check(
            Rule::Sigv4WrongService,
            sig.service == ctx.service && sig.region == ctx.region,
            format!("Signed for {} in {}; server is {} in {}.", sig.service, sig.region, ctx.service, ctx.region),
        ),
        check(
            Rule::Sigv4ClockSkew,
            skew <= ctx.max_skew_ms,
            if skew <= ctx.max_skew_ms { "Timestamp within 5 minutes." } else { "Timestamp too old: possible replay." },
        ),
        check(Rule::BadSignature, sig_ok, if sig_ok { "Signature matches this exact request." } else { "Signature does not match the request." }),
    ])
}

pub struct CredentialContext {
    pub token: TokenContext,
    pub gateway: GatewayContext,
    pub api_keys: Vec<ApiKeyRecord>,
    pub sigv4: SigV4Context,
}

/// One entry point for "a call arrives at the MCP Server with some credential".
pub fn validate_credential(cred: Option<&Credential>, receiver: Role, request: &RequestSpec, ctx: &CredentialContext) -> Validation {
    match cred {
        None => Validation::from(vec![check(Rule::NoToken, false, "No credential was presented.")]),
        Some(Credential::Bearer { token }) => validate_token(Some(token), receiver, request, &ctx.token),
        Some(Credential::GatewayJwt { jwt }) => validate_gateway_jwt(jwt, receiver, request, &ctx.gateway),
        Some(Credential::ApiKey { key }) => validate_api_key(key, request, &ctx.api_keys),
        Some(Credential::Sigv4 { sig }) => validate_sigv4(sig, request, &ctx.sigv4),
        Some(Credential::AwsSecretBearer) => Validation::from(vec![check(
            Rule::SecretOnWire,
            false,
            "The long-term AWS secret was sent over the wire as a bearer token.",
        )]),
    }
}

pub struct TokenRequestContext {
    pub registered_clients: Vec<String>,
    pub allowed_audiences: Vec<String>,
    pub require_pkce: bool,
}

/// IdP checks for an authorization-code request (MCP OAuth).
pub fn validate_token_request(client_id: &str, audience: &str, pkce: bool, ctx: &TokenRequestContext) -> Validation {
    Validation::from(vec![
        check(Rule::UnregisteredClient, ctx.registered_clients.iter().any(|c| c == client_id), format!("Client \"{client_id}\".")),
        check(
            Rule::PkceRequired,
            !ctx.require_pkce || pkce,
            if pkce { "PKCE code challenge present." } else { "No PKCE code challenge." },
        ),
        check(Rule::RequestedAudience, ctx.allowed_audiences.iter().any(|a| a == audience), format!("Resource / audience \"{audience}\".")),
    ])
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::new_key_pair;

    const NOW: i64 = 1_800_000_000_000;

    fn read() -> RequestSpec {
        RequestSpec { action: "read calendar".into(), required_scope: "calendar.read".into(), user_scoped: true, user: Some("user:alex".into()) }
    }
    fn tok() -> Token {
        Token {
            id: "t1".into(),
            kind: TokenKind::Access,
            subject: "user:alex".into(),
            subject_type: SubjectType::User,
            audience: "mcp".into(),
            scope: vec!["calendar.read".into()],
            expiry: NOW + 60_000,
            issuer: "idp".into(),
            client_id: None,
            refreshable: false,
            forged: false,
        }
    }
    fn ctx() -> TokenContext {
        TokenContext::simple(NOW)
    }
    fn fails(v: &Validation) -> Vec<&'static str> {
        v.failures.iter().map(|r| r.code()).collect()
    }

    #[test]
    fn token_valid() {
        assert!(validate_token(Some(&tok()), Role::Mcp, &read(), &ctx()).valid);
    }
    #[test]
    fn token_audience_mismatch() {
        let t = Token { audience: "application".into(), ..tok() };
        assert_eq!(fails(&validate_token(Some(&t), Role::Mcp, &read(), &ctx())), ["audience_mismatch"]);
    }
    #[test]
    fn token_scope_insufficient() {
        let w = RequestSpec { required_scope: "calendar.write".into(), ..read() };
        assert_eq!(fails(&validate_token(Some(&tok()), Role::Mcp, &w, &ctx())), ["scope_insufficient"]);
    }
    #[test]
    fn wildcard_scope_covers_family_only() {
        assert!(validate_token(Some(&Token { scope: vec!["calendar.*".into()], ..tok() }), Role::Mcp, &read(), &ctx()).valid);
        assert!(!validate_token(Some(&Token { scope: vec!["mail.*".into()], ..tok() }), Role::Mcp, &read(), &ctx()).valid);
    }
    #[test]
    fn token_expired() {
        assert_eq!(fails(&validate_token(Some(&Token { expiry: NOW - 1, ..tok() }), Role::Mcp, &read(), &ctx())), ["expired"]);
    }
    #[test]
    fn app_subject_on_user_data() {
        let t = Token { subject: "application".into(), subject_type: SubjectType::App, ..tok() };
        assert_eq!(fails(&validate_token(Some(&t), Role::Mcp, &read(), &ctx())), ["app_subject_user_data"]);
        let aggregate = RequestSpec { user_scoped: false, ..read() };
        assert!(validate_token(Some(&t), Role::Mcp, &aggregate, &ctx()).valid);
    }
    #[test]
    fn unregistered_issuer_and_forged() {
        assert_eq!(fails(&validate_token(Some(&Token { issuer: "application".into(), ..tok() }), Role::Mcp, &read(), &ctx())), ["unregistered_issuer"]);
        assert_eq!(fails(&validate_token(Some(&Token { forged: true, ..tok() }), Role::Mcp, &read(), &ctx())), ["unregistered_issuer"]);
    }
    #[test]
    fn unknown_token_when_mint_record_kept() {
        let c = TokenContext { minted: Some(HashSet::from(["other".to_string()])), ..ctx() };
        assert_eq!(fails(&validate_token(Some(&tok()), Role::Mcp, &read(), &c)), ["unknown_token"]);
    }
    #[test]
    fn id_token_is_not_access_token() {
        assert!(fails(&validate_token(Some(&Token { kind: TokenKind::Id, ..tok() }), Role::Mcp, &read(), &ctx())).contains(&"not_access_token"));
    }
    #[test]
    fn no_token() {
        assert_eq!(fails(&validate_token(None, Role::Mcp, &read(), &ctx())), ["no_token"]);
    }

    fn ectx() -> ExchangeContext {
        ExchangeContext { now: NOW, registered_clients: vec!["application".into()], allowed_audiences: vec!["mcp".into()] }
    }
    fn exch<'a>(t: Option<&'a Token>, client: &'a str, aud: &'a str, scope: &'a [String]) -> Validation {
        validate_exchange(&ExchangeInput { subject_token: t, client_id: client, requested_audience: aud, requested_scope: scope }, &ectx())
    }
    #[test]
    fn exchange_rules() {
        let user = Token { audience: "application".into(), ..tok() };
        let read_scope = vec!["calendar.read".to_string()];
        assert!(exch(Some(&user), "application", "mcp", &read_scope).valid);
        assert!(fails(&exch(Some(&user), "rogue", "mcp", &read_scope)).contains(&"unregistered_client"));
        assert_eq!(fails(&exch(Some(&user), "application", "mcp", &["calendar.*".to_string()])), ["scope_exceeds_consent"]);
        assert_eq!(fails(&exch(Some(&user), "application", "github", &read_scope)), ["requested_audience"]);
        assert_eq!(fails(&exch(Some(&tok()), "application", "mcp", &read_scope)), ["subject_audience"]);
        let old = Token { expiry: NOW - 1, ..user.clone() };
        assert_eq!(fails(&exch(Some(&old), "application", "mcp", &read_scope)), ["expired"]);
        assert!(fails(&exch(None, "application", "mcp", &read_scope)).contains(&"no_subject_token"));
        assert!(!scope_subset(&["a.read".into(), "b.read".into()], &["a.read".into()]));
        assert!(!scope_subset(&[], &["a.read".into()]));
    }

    #[test]
    fn assertion_rules() {
        let kp = new_key_pair();
        let actx = AssertionContext {
            now: NOW,
            registered_keys: HashMap::from([("application".to_string(), kp.public_key.clone())]),
            allowed_scopes: HashMap::from([("application".to_string(), vec!["reports.read".to_string()])]),
        };
        let make = |f: &dyn Fn(&mut Assertion), secret: &str| {
            let mut a = Assertion {
                iss: "application".into(),
                sub: "application".into(),
                aud: "idp".into(),
                exp: NOW + 300_000,
                scope: vec!["reports.read".into()],
                jti: "j1".into(),
                signature: String::new(),
            };
            f(&mut a);
            a.signature = sign_payload(&a, secret);
            a
        };
        let none = |_: &mut Assertion| {};
        assert!(validate_assertion(&make(&none, &kp.secret_key), &actx).valid);
        assert_eq!(fails(&validate_assertion(&make(&none, &new_key_pair().secret_key), &actx)), ["bad_signature"]);
        let mut tampered = make(&none, &kp.secret_key);
        tampered.scope = vec!["*".into()];
        assert!(fails(&validate_assertion(&tampered, &actx)).contains(&"bad_signature"));
        assert_eq!(fails(&validate_assertion(&make(&|a| a.aud = "mcp".into(), &kp.secret_key), &actx)), ["assertion_audience"]);
        assert_eq!(fails(&validate_assertion(&make(&|a| a.exp = NOW - 1, &kp.secret_key), &actx)), ["expired"]);
        assert_eq!(fails(&validate_assertion(&make(&|a| a.scope = vec!["mail.read".into()], &kp.secret_key), &actx)), ["scope_not_allowed"]);
        assert!(fails(&validate_assertion(&make(&|a| a.iss = "stranger".into(), &kp.secret_key), &actx)).contains(&"unregistered_issuer"));
        let mut garbage = make(&none, &kp.secret_key);
        garbage.signature = "zz".into();
        assert!(!validate_assertion(&garbage, &actx).valid);
    }

    #[test]
    fn gateway_jwt_rules() {
        let gw = new_key_pair();
        let gctx = GatewayContext { now: NOW, trusted_signers: HashMap::from([("gateway".to_string(), gw.public_key.clone())]) };
        let make = |f: &dyn Fn(&mut GatewayJwt)| {
            let mut j = GatewayJwt {
                iss: "gateway".into(),
                sub: "user:alex".into(),
                subject_type: SubjectType::User,
                aud: "mcp".into(),
                exp: NOW + 300_000,
                scope: vec!["calendar.read".into()],
                alg: Alg::EdDSA,
                signature: String::new(),
            };
            f(&mut j);
            j.signature = if j.alg == Alg::None { String::new() } else { sign_payload(&j, &gw.secret_key) };
            j
        };
        assert!(validate_gateway_jwt(&make(&|_| {}), Role::Mcp, &read(), &gctx).valid);
        assert!(fails(&validate_gateway_jwt(&make(&|j| j.alg = Alg::None), Role::Mcp, &read(), &gctx)).contains(&"alg_none"));
        let untrusted = GatewayContext { now: NOW, trusted_signers: HashMap::new() };
        assert!(fails(&validate_gateway_jwt(&make(&|_| {}), Role::Mcp, &read(), &untrusted)).contains(&"unregistered_issuer"));
        assert_eq!(fails(&validate_gateway_jwt(&make(&|j| j.aud = "other".into()), Role::Mcp, &read(), &gctx)), ["audience_mismatch"]);
    }

    #[test]
    fn api_key_rules() {
        let reg = vec![
            ApiKeyRecord { key_id: "k-alex".into(), owner: "user:alex".into(), scopes: vec!["calendar.*".into()], revoked: false },
            ApiKeyRecord { key_id: "k-admin".into(), owner: "shared-admin".into(), scopes: vec!["*".into()], revoked: false },
            ApiKeyRecord { key_id: "k-old".into(), owner: "user:alex".into(), scopes: vec!["*".into()], revoked: true },
        ];
        let k = |id: &str, owner: &str, p: Placement| ApiKeyCredential { key_id: id.into(), owner: owner.into(), placement: p };
        assert!(validate_api_key(&k("k-alex", "user:alex", Placement::Header), &read(), &reg).valid);
        assert_eq!(fails(&validate_api_key(&k("k-admin", "shared-admin", Placement::Header), &read(), &reg)), ["credential_owner_mismatch"]);
        assert_eq!(fails(&validate_api_key(&k("k-alex", "user:alex", Placement::Query), &read(), &reg)), ["key_in_url"]);
        assert!(fails(&validate_api_key(&k("k-old", "user:alex", Placement::Header), &read(), &reg)).contains(&"unknown_key"));
    }

    #[test]
    fn sigv4_rules() {
        let sctx = SigV4Context {
            now: NOW,
            secrets: HashMap::from([("AK".to_string(), "secret".to_string())]),
            service: "execute-api".into(),
            region: "us-east-1".into(),
            max_skew_ms: 300_000,
        };
        let make = |f: &dyn Fn(&mut SigV4Signature)| {
            let mut s = SigV4Signature {
                access_key_id: "AK".into(),
                region: "us-east-1".into(),
                service: "execute-api".into(),
                timestamp: NOW,
                signed_headers: vec!["host".into()],
                signature: String::new(),
            };
            f(&mut s);
            s.signature = sigv4_sign(&read(), &s, "secret");
            s
        };
        assert!(validate_sigv4(&make(&|_| {}), &read(), &sctx).valid);
        assert_eq!(fails(&validate_sigv4(&make(&|s| s.timestamp = NOW - 3_600_000), &read(), &sctx)), ["sigv4_clock_skew"]);
        let write = RequestSpec { required_scope: "calendar.write".into(), ..read() };
        assert_eq!(fails(&validate_sigv4(&make(&|_| {}), &write, &sctx)), ["bad_signature"]);
        assert!(fails(&validate_sigv4(&make(&|s| s.service = "s3".into()), &read(), &sctx)).contains(&"sigv4_wrong_service"));
        let cctx = CredentialContext {
            token: ctx(),
            gateway: GatewayContext { now: NOW, trusted_signers: HashMap::new() },
            api_keys: vec![],
            sigv4: sctx,
        };
        assert_eq!(fails(&validate_credential(Some(&Credential::AwsSecretBearer), Role::Mcp, &read(), &cctx)), ["secret_on_wire"]);
    }

    #[test]
    fn token_request_rules() {
        let t = TokenRequestContext { registered_clients: vec!["application".into()], allowed_audiences: vec!["mcp".into()], require_pkce: true };
        assert_eq!(fails(&validate_token_request("application", "mcp", false, &t)), ["pkce_required"]);
        assert_eq!(fails(&validate_token_request("application", "elsewhere", true, &t)), ["requested_audience"]);
        assert!(validate_token_request("application", "mcp", true, &t).valid);
    }
}

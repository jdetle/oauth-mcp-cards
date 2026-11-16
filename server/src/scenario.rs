//! Scenario data model. Scenarios are JSON files in `scenarios/`, loaded at startup.
use crate::types::*;
use crate::validate::ApiKeyRecord;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenTemplate {
    #[serde(default)]
    pub kind: TokenKind,
    pub subject: String,
    pub subject_type: SubjectType,
    pub audience: String,
    pub scope: Vec<String>,
    /// minutes from round start; negative = already expired
    pub expires_in_min: i64,
    pub issuer: Option<String>,
    #[serde(default)]
    pub forged: bool,
}

/// A card in a scenario file: a preset name or a full card spec.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum CardTemplate {
    Preset(String),
    Spec(CardSpec),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Beat {
    pub starter: Role,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    pub order: i64,
    pub phase: Phase,
    pub title: String,
    pub flow_label: Option<String>,
    pub text: String,
    pub user_present: bool,
    pub request: RequestSpec,
    pub expected_flows: Option<Vec<Flow>>,
    pub tokens: Option<BTreeMap<String, TokenTemplate>>,
    pub holders: Option<BTreeMap<Role, Vec<String>>>,
    pub hands: Option<BTreeMap<Role, Vec<CardTemplate>>>,
    pub beats: Option<Vec<Beat>>,
    pub idp_audiences: Option<Vec<String>>,
    pub app_allowed_scopes: Option<Vec<String>>,
    pub api_keys: Option<Vec<ApiKeyRecord>>,
    #[serde(default)]
    pub trusts_gateway: bool,
    #[serde(default)]
    pub refresh_token: bool,
    pub tells: Option<String>,
    pub discussion: Option<String>,
    #[serde(default)]
    pub teaches: Vec<String>,
    /// which checklist items this round covers (documentation only)
    #[serde(default)]
    #[allow(dead_code)]
    pub covers: Vec<String>,
}

impl Scenario {
    pub fn beats(&self) -> Vec<Role> {
        match &self.beats {
            Some(b) if !b.is_empty() => b.iter().map(|x| x.starter).collect(),
            _ => vec![Role::Client],
        }
    }

    pub fn user(&self) -> String {
        self.request.user.clone().unwrap_or_else(|| "user:alex".into())
    }

    /// Defaults merged with the scenario's own tokens.
    pub fn resolved_tokens(&self) -> BTreeMap<String, TokenTemplate> {
        let mut m = BTreeMap::new();
        let scope = vec![self.request.required_scope.clone()];
        m.insert(
            "userToken".into(),
            TokenTemplate {
                kind: TokenKind::Access,
                subject: self.user(),
                subject_type: SubjectType::User,
                audience: "application".into(),
                scope: scope.clone(),
                expires_in_min: 60,
                issuer: None,
                forged: false,
            },
        );
        m.insert(
            "cachedToken".into(),
            TokenTemplate {
                kind: TokenKind::Access,
                subject: self.user(),
                subject_type: SubjectType::User,
                audience: "mcp".into(),
                scope,
                expires_in_min: -60,
                issuer: None,
                forged: false,
            },
        );
        if let Some(t) = &self.tokens {
            for (k, v) in t {
                m.insert(k.clone(), v.clone());
            }
        }
        m
    }

    pub fn resolved_holders(&self) -> BTreeMap<Role, Vec<String>> {
        if let Some(h) = &self.holders {
            return h.clone();
        }
        BTreeMap::from([
            (Role::Client, if self.user_present { vec!["userToken".to_string()] } else { vec![] }),
            (Role::Application, vec!["cachedToken".to_string()]),
        ])
    }

    fn default_hand(&self, role: Role) -> Vec<CardTemplate> {
        let p = |s: &str| CardTemplate::Preset(s.to_string());
        match role {
            Role::Client => {
                let holders = self.resolved_holders();
                let has = holders.get(&Role::Client).cloned().unwrap_or_default();
                let mut v = if has.iter().any(|k| k == "userToken") {
                    vec![p("client.send"), p("client.bypass")]
                } else {
                    vec![p("client.send_no_token"), p("client.bypass_no_token")]
                };
                if has.iter().any(|k| k == "staleToken") {
                    v.push(p("client.send_stale"));
                }
                v
            }
            Role::Application => ["app.forward", "app.exchange", "app.exchange_broad", "app.assertion", "app.cached", "app.reauth"]
                .iter()
                .map(|s| p(s))
                .collect(),
            Role::Idp => vec![p("idp.issue"), p("idp.reject"), p("idp.registered_key")],
            Role::Mcp => vec![p("mcp.accept"), p("mcp.reject"), p("mcp.validate_audience"), p("mcp.validate_scope")],
        }
    }

    pub fn hand_templates(&self, role: Role) -> Vec<CardTemplate> {
        let mut hand = self.hands.as_ref().and_then(|h| h.get(&role).cloned()).unwrap_or_else(|| self.default_hand(role));
        // After the warm-ups, receivers always hold the full set of optional checks:
        // nothing makes them play one, which is the point.
        if self.phase != Phase::Warmup && !hand.is_empty() {
            let extra: &[&str] = match role {
                Role::Mcp => &["mcp.validate_audience", "mcp.validate_scope", "mcp.validate_expiry", "mcp.validate_issuer", "mcp.validate_subject"],
                // ...and a way to act on a bad one: without it, checking would be pointless
                Role::Application if self.resolved_holders().get(&Role::Client).is_some_and(|h| !h.is_empty()) => &["app.check_audience", "app.check_expiry", "app.reauth"],
                _ => &[],
            };
            for name in extra {
                if !hand.iter().any(|t| matches!(t, CardTemplate::Preset(p) if p == name)) {
                    hand.push(CardTemplate::Preset(name.to_string()));
                }
            }
        }
        hand
    }

    /// Turn templates into concrete cards with fresh, unguessable ids.
    pub fn deal(&self, role: Role, new_id: &mut dyn FnMut() -> String) -> Vec<Card> {
        self.hand_templates(role)
            .into_iter()
            .map(|t| {
                let spec = match t {
                    CardTemplate::Preset(name) => preset(&name, self).expect("presets are checked at load"),
                    CardTemplate::Spec(s) => s,
                };
                let ty = spec.card_type.expect("card types are checked at load");
                Card {
                    id: new_id(),
                    card_type: ty,
                    label: spec.label.clone().unwrap_or_else(|| format!("{ty:?}")),
                    category: spec.category.clone().unwrap_or_else(|| ty.category().to_string()),
                    params: CardParams {
                        to: spec.to,
                        attach: spec.attach,
                        request: spec.request,
                        scope: spec.scope,
                        audience: spec.audience,
                        requested_type: spec.requested_type,
                        expires_in_min: spec.expires_in_min,
                        owner: spec.owner,
                        placement: spec.placement,
                        alg: spec.alg,
                        pkce: spec.pkce,
                        scripted: spec.scripted,
                        beat: spec.beat,
                        trap: spec.trap,
                    },
                }
            })
            .collect()
    }
}

fn scope_family(scope: &str) -> String {
    match scope.split_once('.') {
        Some((f, _)) => format!("{f}.*"),
        None => "*".into(),
    }
}

/// Named cards scenario files can refer to.
pub fn preset(name: &str, s: &Scenario) -> Option<CardSpec> {
    let req = s.request.required_scope.clone();
    let user = s.request.user.clone().unwrap_or_else(|| "this caller".into());
    let c = |ty: CardType, label: &str| CardSpec { card_type: Some(ty), label: Some(label.to_string()), ..Default::default() };
    Some(match name {
        "client.send" => CardSpec { to: Some(Role::Application), attach: Some("userToken".into()), ..c(CardType::Request, "Send the request to the Application, with the user's token slip") },
        "client.send_no_token" => CardSpec { to: Some(Role::Application), ..c(CardType::Request, "Send the request to the Application (no user token to give)") },
        "client.bypass" => CardSpec { to: Some(Role::Mcp), attach: Some("userToken".into()), trap: true, ..c(CardType::Request, "Skip the Application: hand the token straight to the MCP Server") },
        "client.bypass_no_token" => CardSpec { to: Some(Role::Mcp), trap: true, ..c(CardType::Request, "Skip the Application: call the MCP Server directly") },
        "client.send_stale" => CardSpec { to: Some(Role::Application), attach: Some("staleToken".into()), trap: true, ..c(CardType::Request, "Send the request with the older token slip in your pocket") },
        "app.forward" => c(CardType::Forward, "Forward the token you received straight to the MCP Server"),
        "app.exchange" => CardSpec {
            audience: Some("mcp".into()),
            requested_type: Some(RequestedType::Access),
            scope: Some(vec![req.clone()]),
            ..c(CardType::Exchange, &format!("Exchange card: trade the user's token at the IdP for a token addressed to the MCP Server (scope {req})"))
        },
        "app.exchange_broad" => {
            let fam = scope_family(&req);
            CardSpec {
                audience: Some("mcp".into()),
                requested_type: Some(RequestedType::Access),
                scope: Some(vec![fam.clone()]),
                trap: true,
                ..c(CardType::Exchange, &format!("Exchange card: trade the user's token at the IdP for a token addressed to the MCP Server (scope {fam})"))
            }
        }
        "app.idjag" => CardSpec {
            audience: Some("mcp".into()),
            requested_type: Some(RequestedType::IdJag),
            scope: Some(vec![req.clone()]),
            ..c(CardType::Exchange, "Exchange card: trade the user's ID token at the IdP for an ID-JAG addressed to the MCP Server's authorization server")
        },
        "app.assertion" => CardSpec {
            audience: Some("idp".into()),
            scope: Some(vec![req.clone()]),
            expires_in_min: Some(5),
            ..c(CardType::Assertion, &format!("Signed Assertion: JWT signed with your private key, audience = IdP, scope {req}"))
        },
        "app.assertion_wrong_aud" => CardSpec {
            audience: Some("mcp".into()),
            scope: Some(vec![req.clone()]),
            expires_in_min: Some(5),
            trap: true,
            ..c(CardType::Assertion, &format!("Signed Assertion: JWT signed with your private key, audience = MCP Server, scope {req}"))
        },
        "app.cached" => CardSpec { attach: Some("cachedToken".into()), trap: true, ..c(CardType::Cached, "Use the user token cached from an earlier session") },
        "app.reauth" => c(CardType::Reauth, "Stop: reject the job and ask the user to sign in again"),
        "app.selfmint" => CardSpec { audience: Some("mcp".into()), scope: Some(vec![req.clone()]), ..c(CardType::Selfmint, "Write your own token slip for the MCP Server") },
        "app.api_key" => CardSpec { placement: Some(Placement::Header), ..c(CardType::ApiKey, "Attach the MCP Server's API key in the Authorization header") },
        "app.api_key_query" => CardSpec { placement: Some(Placement::Query), trap: true, ..c(CardType::ApiKey, "Attach the MCP Server's API key as ?api_key= in the URL") },
        "app.upstream_user" => CardSpec { owner: Some(user.clone()), ..c(CardType::Upstream, &format!("Look up the upstream credential stored for {user}")) },
        "app.upstream_shared" => CardSpec { owner: Some("shared-admin".into()), trap: true, ..c(CardType::Upstream, "Use the shared admin credential for the upstream server") },
        "app.sigv4" => CardSpec { expires_in_min: Some(0), ..c(CardType::Sigv4, "Sign this request with SigV4 using the task role's temporary credentials") },
        "app.sigv4_replay" => CardSpec { expires_in_min: Some(-60), trap: true, ..c(CardType::Sigv4, "Re-send the SigV4-signed request you captured an hour ago") },
        "app.aws_secret" => CardSpec { trap: true, ..c(CardType::AwsSecret, "Put the AWS secret access key in the Authorization header") },
        "app.jwt_sign" => CardSpec {
            alg: Some(Alg::EdDSA),
            audience: Some("mcp".into()),
            expires_in_min: Some(5),
            scope: Some(vec![req.clone()]),
            ..c(CardType::JwtSign, "Sign a 5-minute JWT for the MCP Server with the gateway's key (sub = the user)")
        },
        "app.jwt_none" => CardSpec {
            alg: Some(Alg::None),
            audience: Some("mcp".into()),
            expires_in_min: Some(5),
            scope: Some(vec![req]),
            trap: true,
            ..c(CardType::JwtSign, "Send a JWT for the MCP Server with \"alg\": \"none\" (skip signing, it is internal)")
        },
        "app.accept" | "mcp.accept" => c(CardType::Accept, "Accept"),
        "app.reject" | "idp.reject" | "mcp.reject" => c(CardType::Reject, "Reject"),
        "idp.issue" => c(CardType::Issue, "Issue / approve"),
        "idp.registered_key" => c(CardType::RegisteredKey, "Registered Key: check the signature"),
        "mcp.validate_audience" => c(CardType::ValidateAudience, "Validate Audience"),
        "mcp.validate_scope" => c(CardType::ValidateScope, "Validate Scope"),
        "mcp.validate_expiry" => c(CardType::ValidateExpiry, "Validate Expiry"),
        "mcp.validate_issuer" => c(CardType::ValidateIssuer, "Validate Issuer"),
        "mcp.validate_subject" => c(CardType::ValidateSubject, "Validate Subject"),
        "app.check_audience" => c(CardType::ValidateAudience, "Check who the token is for"),
        "app.check_expiry" => c(CardType::ValidateExpiry, "Check the token hasn't expired"),
        "mcp.introspect" => c(CardType::Introspect, "Ask the IdP to confirm this token"),
        _ => return None,
    })
}

/// Parse and check one scenario file.
pub fn parse_scenario(text: &str, file: &str) -> Result<Scenario, String> {
    let s: Scenario = serde_json::from_str(text).map_err(|e| format!("{file}: {e}"))?;
    let fail = |m: String| Err(format!("{file}: {m}"));
    for (k, v) in [("id", &s.id), ("title", &s.title), ("text", &s.text)] {
        if v.trim().is_empty() {
            return fail(format!("\"{k}\" must be a non-empty string"));
        }
    }
    if s.phase != Phase::Warmup && s.expected_flows.as_ref().map(|f| f.is_empty()).unwrap_or(true) {
        return fail("learning and assessment scenarios need \"expectedFlows\"".into());
    }
    for role in ROLES {
        for t in s.hand_templates(role) {
            match t {
                CardTemplate::Preset(name) => {
                    if preset(&name, &s).is_none() {
                        return fail(format!("hands.{}: unknown preset \"{name}\"", role.aud()));
                    }
                }
                CardTemplate::Spec(spec) => {
                    if spec.card_type.is_none() {
                        return fail(format!("hands.{}: card needs a \"type\"", role.aud()));
                    }
                }
            }
        }
    }
    Ok(s)
}

/// Load every `*.json` in `dir`, sorted by `order`.
pub fn load_dir(dir: &Path) -> Result<Vec<Scenario>, String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("can't read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort();
    let mut out: Vec<Scenario> = Vec::new();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let text = std::fs::read_to_string(&f).map_err(|e| format!("{name}: {e}"))?;
        let s = parse_scenario(&text, &name)?;
        if out.iter().any(|o| o.id == s.id) {
            return Err(format!("{name}: duplicate id \"{}\"", s.id));
        }
        out.push(s);
    }
    if out.is_empty() {
        return Err(format!("no scenarios in {}", dir.display()));
    }
    out.sort_by_key(|s| s.order);
    Ok(out)
}

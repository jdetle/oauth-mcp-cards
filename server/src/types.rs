//! Wire types. JSON shape matches `src/game/types.ts` used by the browser.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Client,
    Application,
    Idp,
    Mcp,
}

pub const ROLES: [Role; 4] = [Role::Client, Role::Application, Role::Idp, Role::Mcp];

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Client => "Client",
            Role::Application => "Application",
            Role::Idp => "Identity Provider",
            Role::Mcp => "MCP Server",
        }
    }
    /// Audience identifier written on slips.
    pub fn aud(self) -> &'static str {
        match self {
            Role::Client => "client",
            Role::Application => "application",
            Role::Idp => "idp",
            Role::Mcp => "mcp",
        }
    }
    pub fn index(self) -> usize {
        ROLES.iter().position(|r| *r == self).unwrap()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Warmup,
    Learning,
    Assessment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flow {
    Obo,
    Jag,
    Idjag,
    Oauth,
    Passthrough,
    Apikey,
    Upstream,
    Sigv4,
    Zerotrust,
    Reauth,
}

pub const FLOWS: [Flow; 10] = [
    Flow::Obo,
    Flow::Jag,
    Flow::Idjag,
    Flow::Oauth,
    Flow::Passthrough,
    Flow::Apikey,
    Flow::Upstream,
    Flow::Sigv4,
    Flow::Zerotrust,
    Flow::Reauth,
];

impl Flow {
    pub fn name(self) -> &'static str {
        match self {
            Flow::Obo => "On-Behalf-Of (token exchange)",
            Flow::Jag => "JWT Authorization Grant (service identity)",
            Flow::Idjag => "ID-JAG (identity assertion grant, e.g. Okta Cross App Access)",
            Flow::Oauth => "MCP OAuth (client gets a token for the MCP Server)",
            Flow::Passthrough => "OAuth passthrough (token already addressed to the MCP Server)",
            Flow::Apikey => "Non-OAuth: static API key",
            Flow::Upstream => "Per-user / per-key upstream credential",
            Flow::Sigv4 => "AWS SigV4 request signing",
            Flow::Zerotrust => "Zero Trust: gateway-signed JWT",
            Flow::Reauth => "Neither: reject and re-authenticate",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    #[default]
    Access,
    IdJag,
    Id,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectType {
    User,
    App,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub kind: TokenKind,
    pub subject: String,
    pub subject_type: SubjectType,
    pub audience: String,
    pub scope: Vec<String>,
    pub expiry: i64,
    pub issuer: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub refreshable: bool,
    #[serde(skip_serializing_if = "is_false", default)]
    pub forged: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Assertion {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub exp: i64,
    pub scope: Vec<String>,
    pub jti: String,
    pub signature: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Alg {
    EdDSA,
    #[serde(rename = "none")]
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayJwt {
    pub iss: String,
    pub sub: String,
    pub subject_type: SubjectType,
    pub aud: String,
    pub exp: i64,
    pub scope: Vec<String>,
    pub alg: Alg,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SigV4Signature {
    pub access_key_id: String,
    pub region: String,
    pub service: String,
    pub timestamp: i64,
    pub signed_headers: Vec<String>,
    pub signature: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Header,
    Query,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCredential {
    pub key_id: String,
    pub owner: String,
    pub placement: Placement,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    Bearer { token: Token },
    ApiKey { key: ApiKeyCredential },
    Sigv4 { sig: SigV4Signature },
    AwsSecretBearer,
    GatewayJwt { jwt: GatewayJwt },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub action: String,
    pub required_scope: String,
    pub user_scoped: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestedType {
    Access,
    IdJag,
}

/// Things that travel between seats, visible to the whole table.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum InFlight {
    Request { from: Role, to: Role, request: RequestSpec, token: Option<Token> },
    TokenRequest { from: Role, to: Role, scope: Vec<String>, audience: String, pkce: bool },
    Exchange {
        from: Role,
        to: Role,
        subject_token: Option<Token>,
        requested_audience: String,
        requested_scope: Vec<String>,
        requested_type: RequestedType,
        request: RequestSpec,
    },
    Assertion { from: Role, to: Role, assertion: Assertion, request: RequestSpec },
    Call {
        from: Role,
        to: Role,
        request: RequestSpec,
        credential: Option<Credential>,
        #[serde(skip_serializing_if = "is_false", default)]
        confirmed_by_idp: bool,
    },
    Introspect { from: Role, to: Role, request: RequestSpec, credential: Option<Credential> },
    /// Scripted games: a titled slip of labelled fields. Sealed values are held back by the
    /// server until the receiver checks them.
    Packet {
        from: Role,
        to: Role,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        note: Option<String>,
        fields: Vec<PacketField>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldState {
    /// plain to see
    Open,
    /// hidden until checked
    Sealed,
    /// checked: fine
    Ok,
    /// checked (or revealed at the end): wrong
    Bad,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketField {
    pub label: String,
    /// None while sealed (the value never reaches a browser until it is checked)
    pub value: Option<String>,
    pub state: FieldState,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    /// server-side only: this value was swapped by an intruder (stripped from public views)
    #[serde(skip_serializing_if = "is_false", default)]
    pub bad: bool,
    /// server-side only: what a check on this field reports (stripped from public views)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub check_detail: Option<String>,
}

impl InFlight {
    pub fn from(&self) -> Role {
        match self {
            InFlight::Request { from, .. }
            | InFlight::TokenRequest { from, .. }
            | InFlight::Exchange { from, .. }
            | InFlight::Assertion { from, .. }
            | InFlight::Call { from, .. }
            | InFlight::Packet { from, .. }
            | InFlight::Introspect { from, .. } => *from,
        }
    }
    pub fn to(&self) -> Role {
        match self {
            InFlight::Request { to, .. }
            | InFlight::TokenRequest { to, .. }
            | InFlight::Exchange { to, .. }
            | InFlight::Assertion { to, .. }
            | InFlight::Call { to, .. }
            | InFlight::Packet { to, .. }
            | InFlight::Introspect { to, .. } => *to,
        }
    }
    pub fn request(&self) -> Option<&RequestSpec> {
        match self {
            InFlight::Request { request, .. }
            | InFlight::Exchange { request, .. }
            | InFlight::Assertion { request, .. }
            | InFlight::Call { request, .. }
            | InFlight::Introspect { request, .. } => Some(request),
            InFlight::TokenRequest { .. } | InFlight::Packet { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardType {
    Request,
    TokenRequest,
    Forward,
    Exchange,
    Assertion,
    Cached,
    Selfmint,
    ApiKey,
    Upstream,
    Sigv4,
    AwsSecret,
    JwtSign,
    Reauth,
    Issue,
    RegisteredKey,
    Introspect,
    Accept,
    Reject,
    ValidateAudience,
    ValidateScope,
    ValidateExpiry,
    ValidateIssuer,
    ValidateSubject,
    /// a card in a scripted game (its meaning lives in the game pack)
    Script,
    /// an optional check in a scripted game: reveals one sealed field
    ScriptCheck,
}

/// One thing a receiver can verify about a token. None of these are needed for the
/// system to function; each one skipped is a way for the wrong caller to get through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    Audience,
    Scope,
    Expiry,
    Issuer,
    Subject,
}

impl CheckKind {
    pub fn label(self) -> &'static str {
        match self {
            CheckKind::Audience => "audience",
            CheckKind::Scope => "scope",
            CheckKind::Expiry => "expiry",
            CheckKind::Issuer => "issuer",
            CheckKind::Subject => "subject",
        }
    }
}

impl CardType {
    pub fn is_free(self) -> bool {
        matches!(self, CardType::RegisteredKey | CardType::ScriptCheck) || self.check_kind().is_some()
    }
    /// The token check this card performs, if it is one.
    pub fn check_kind(self) -> Option<CheckKind> {
        Some(match self {
            CardType::ValidateAudience => CheckKind::Audience,
            CardType::ValidateScope => CheckKind::Scope,
            CardType::ValidateExpiry => CheckKind::Expiry,
            CardType::ValidateIssuer => CheckKind::Issuer,
            CardType::ValidateSubject => CheckKind::Subject,
            _ => return None,
        })
    }
    pub fn is_consumable(self) -> bool {
        matches!(
            self,
            CardType::Request
                | CardType::TokenRequest
                | CardType::Forward
                | CardType::Exchange
                | CardType::Assertion
                | CardType::Cached
                | CardType::Selfmint
                | CardType::ApiKey
                | CardType::Upstream
                | CardType::Sigv4
                | CardType::AwsSecret
                | CardType::JwtSign
        )
    }
    pub fn is_app_initiative(self) -> bool {
        matches!(
            self,
            CardType::Forward
                | CardType::Exchange
                | CardType::Assertion
                | CardType::Cached
                | CardType::Selfmint
                | CardType::ApiKey
                | CardType::Upstream
                | CardType::Sigv4
                | CardType::AwsSecret
                | CardType::JwtSign
                | CardType::Reauth
        )
    }
    pub fn category(self) -> &'static str {
        match self {
            CardType::Request | CardType::TokenRequest | CardType::Forward | CardType::Introspect => "Request",
            CardType::Exchange => "Exchange",
            CardType::Assertion => "Signed Assertion",
            CardType::Cached | CardType::Selfmint => "Token",
            CardType::ApiKey | CardType::Upstream | CardType::AwsSecret => "Credential",
            CardType::Sigv4 | CardType::JwtSign => "Signature",
            CardType::Reauth | CardType::Reject => "Reject",
            CardType::Issue => "Issue",
            CardType::RegisteredKey => "Registered Key",
            CardType::Accept => "Accept",
            CardType::ValidateAudience | CardType::ValidateScope | CardType::ValidateExpiry | CardType::ValidateIssuer | CardType::ValidateSubject => "Validate",
            CardType::Script => "Play",
            CardType::ScriptCheck => "Check",
        }
    }
}

/// Card parameters. Used both in scenario files (without id/category) and as dealt cards.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardSpec {
    #[serde(rename = "type")]
    pub card_type: Option<CardType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_type: Option<RequestedType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alg: Option<Alg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkce: Option<bool>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub scripted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beat: Option<usize>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub trap: bool,
}

/// A dealt card. Only its owner ever sees it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    #[serde(rename = "type")]
    pub card_type: CardType,
    pub label: String,
    pub category: String,
    #[serde(flatten)]
    pub params: CardParams,
}

/// Card parameters without type/label/category (flattened into Card).
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_type: Option<RequestedType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alg: Option<Alg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkce: Option<bool>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub scripted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beat: Option<usize>,
    /// Never serialised to clients; revealed only in the round result.
    #[serde(skip)]
    pub trap: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Correct,
    Incorrect,
    Neutral,
    Info,
}

/// What kind of action a call is. Colour follows this, never right/wrong:
/// go = accept / issue (green), stop = reject (red), send = passing something on (neutral).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Go,
    Stop,
    Send,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Chip {
    pub label: String,
    pub tone: Tone,
}

/// Expected vs played for one judged move. A correct Reject is stop = stop: a match.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub expected: Chip,
    pub played: Chip,
    pub matched: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: u64,
    /// when it happened (epoch ms)
    pub at: i64,
    pub role: Option<Role>,
    pub player_name: Option<String>,
    pub text: String,
    pub verdict: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// expected vs played, for judged moves
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call: Option<Call>,
    /// for decisions on a sealed token: was it verified first, or trusted blind?
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diligence: Option<Diligence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiligenceTag {
    /// trusted it after running every relevant check
    Verified,
    /// trusted it without checking everything, and it happened to be fine
    Unverified,
    /// trusted something bad
    Breach,
    /// refused something bad because a check showed it
    Caught,
    /// refused something bad without having checked what was wrong
    Hunch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diligence {
    pub tag: DiligenceTag,
    /// relevant checks that were not run before deciding (field names)
    pub skipped: Vec<String>,
    /// for a breach: the check(s) that would have exposed it
    pub would_catch: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DiligenceStats {
    pub verified: u32,
    pub unverified: u32,
    pub breaches: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Revealed {
    pub kind: CheckKind,
    pub ok: bool,
    pub detail: String,
}

/// The token in flight is sealed: only checked fields are shown (to anyone).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Sealed {
    /// every field that can be checked on this token, by this receiver
    pub fields: Vec<CheckKind>,
    pub revealed: Vec<Revealed>,
}

/// A finished (or replaced) round's log, kept for the game-long timeline.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedRound {
    pub index: usize,
    pub title: String,
    pub phase: Phase,
    pub success: Option<bool>,
    pub log: Vec<LogEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct ScoreBreakdown {
    pub calls: i64,
    pub identify: i64,
    pub bonus: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPlayer {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub connected: bool,
    pub bot: bool,
    pub is_host: bool,
    pub score: ScoreBreakdown,
    pub diligence: DiligenceStats,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundSummary {
    pub index: usize,
    pub phase: Phase,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedStep {
    pub role: Role,
    pub player_name: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    pub player_id: String,
    pub name: String,
    pub flow: Flow,
    pub correct: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Award {
    pub player_id: String,
    pub name: String,
    pub points: i64,
    pub why: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundResult {
    pub success: bool,
    pub failed_step: Option<FailedStep>,
    pub explanation: String,
    pub expected_flows: Vec<Flow>,
    pub tells: Option<String>,
    pub discussion: Option<String>,
    pub teaches: Vec<String>,
    pub guesses: Vec<Guess>,
    pub awards: Vec<Award>,
    pub traps: Vec<String>,
    /// revealed at the end: what an intruder swapped in transit, if anything
    pub intrusion: Option<String>,
    /// scripted games: everyone's answer to the round's question, and the right one
    #[serde(default)]
    pub picks: Vec<PickResult>,
    #[serde(default)]
    pub answer: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    pub player_id: String,
    pub name: String,
    pub option: String,
    pub correct: bool,
}

/// Scripted games: the question asked in secret before an assessment round.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PublicQuestion {
    pub text: String,
    pub options: Vec<QuestionOption>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
}

/// Which game this table is playing, and what its four seats are called.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PublicGame {
    pub id: String,
    pub title: String,
    pub accent: String,
    pub seats: SeatNames,
    /// scripted games have no OAuth-specific side panels
    pub scripted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SeatNames {
    pub client: String,
    pub application: String,
    pub idp: String,
    pub mcp: String,
}

impl Default for SeatNames {
    fn default() -> Self {
        SeatNames { client: Role::Client.name().into(), application: Role::Application.name().into(), idp: Role::Idp.name().into(), mcp: Role::Mcp.name().into() }
    }
}

impl SeatNames {
    pub fn get(&self, r: Role) -> &str {
        match r {
            Role::Client => &self.client,
            Role::Application => &self.application,
            Role::Idp => &self.idp,
            Role::Mcp => &self.mcp,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Slip {
    pub from: Role,
    pub to: Role,
    pub label: String,
    pub item: InFlight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoundStatus {
    Identify,
    Playing,
    Done,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct Seats {
    pub client: Option<String>,
    pub application: Option<String>,
    pub idp: Option<String>,
    pub mcp: Option<String>,
}

impl Seats {
    pub fn get(&self, r: Role) -> Option<&String> {
        match r {
            Role::Client => self.client.as_ref(),
            Role::Application => self.application.as_ref(),
            Role::Idp => self.idp.as_ref(),
            Role::Mcp => self.mcp.as_ref(),
        }
    }
    pub fn set(&mut self, r: Role, v: Option<String>) {
        match r {
            Role::Client => self.client = v,
            Role::Application => self.application = v,
            Role::Idp => self.idp = v,
            Role::Mcp => self.mcp = v,
        }
    }
    pub fn role_of(&self, id: &str) -> Option<Role> {
        ROLES.into_iter().find(|r| self.get(*r).map(|s| s == id).unwrap_or(false))
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyCheck {
    pub ready: Vec<String>,
    /// connected humans who haven't readied
    pub waiting: Vec<String>,
    /// humans at the table who aren't connected (not waited for)
    pub away: Vec<String>,
    /// time left before the table moves on by itself, as of this message
    pub remaining_ms: i64,
    pub timeout_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRound {
    pub index: usize,
    pub phase: Phase,
    pub title: String,
    pub text: String,
    pub flow_label: Option<String>,
    pub status: RoundStatus,
    pub active_role: Option<Role>,
    pub in_flight: Option<InFlight>,
    pub slips: Vec<Slip>,
    pub log: Vec<LogEntry>,
    pub identify_submitted: Vec<String>,
    pub tell_awarded_to: Option<String>,
    pub seats: Seats,
    pub result: Option<RoundResult>,
    pub flow_choices: Vec<Flow>,
    pub tell_enabled: bool,
    /// between rounds: who's ready, who we're waiting on, and the idle countdown
    pub ready_check: Option<ReadyCheck>,
    /// set while the token in flight is sealed (learning and assessment rounds)
    pub sealed: Option<Sealed>,
    /// scripted games: the question to answer in secret before play (assessment rounds)
    pub question: Option<PublicQuestion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeys {
    /// the Application's registered public key (Ed25519, hex): verifies its signed assertions
    pub application: String,
    /// the gateway's public signing key (its JWKS): verifies Zero Trust JWTs
    pub gateway: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    pub game: PublicGame,
    pub room: String,
    /// public halves only; private keys never leave the server
    pub keys: PublicKeys,
    pub started: bool,
    pub players: Vec<PublicPlayer>,
    pub spectators: usize,
    pub rounds: Vec<RoundSummary>,
    pub round: Option<PublicRound>,
    pub host_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateView {
    pub player_id: String,
    pub name: String,
    pub role: Option<Role>,
    pub is_host: bool,
    pub hand: Vec<Card>,
    pub slips: Vec<Token>,
    pub my_guess: Option<Flow>,
    /// scripted games: my answer to the round's question
    pub my_pick: Option<String>,
    pub can_play: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostAction {
    Next,
    Replay,
    Goto,
    ForceReveal,
    AddBots,
    RemoveBots,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClientMessage {
    Sit { role: Role },
    Stand,
    Start,
    Play {
        #[serde(rename = "cardId")]
        card_id: String,
    },
    Identify { flow: Flow },
    Tell,
    Host { action: HostAction, round: Option<u32> },
    Ready { ready: bool },
    /// scripted games: answer the round's question
    Pick { option: String },
    /// host only: end the game now and close the room for everyone
    End,
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMessage<'a> {
    State { state: &'a PublicState, you: &'a PrivateView },
    Error { message: &'a str },
    Pong,
}

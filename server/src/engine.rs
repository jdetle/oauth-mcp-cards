//! Authoritative game engine. Transport-agnostic; the server wraps one Game per room.
use crate::crypto::{new_key_pair, random_hex, random_id, KeyPair};
use crate::explain::{explain, flow_why, wrong_flow_explanation};
use crate::scenario::Scenario;
use crate::types::*;
use crate::validate::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub const SIGV4_KEY_ID: &str = "ASIA-TASK-ROLE";
pub const SIGV4_SERVICE: &str = "execute-api";
pub const SIGV4_REGION: &str = "us-east-1";
const MIN: i64 = 60_000;
const MAX_LOG: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct GameError(pub String);

impl std::fmt::Display for GameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(m: &str) -> Result<T, GameError> {
    Err(GameError(m.to_string()))
}

#[derive(Clone, Debug)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub score: ScoreBreakdown,
    /// simulated player driven by the server
    pub bot: bool,
}

/// How often a sim makes the right call.
pub const SIM_SKILL: f64 = 0.85;
const SIM_NAMES: [&str; 8] = ["Sim Arc", "Sim Bit", "Sim Clu", "Sim Dyn", "Sim Echo", "Sim Flux", "Sim Grid", "Sim Hex"];

#[derive(Clone, Debug)]
pub struct Move {
    pub player_id: String,
    pub role: Role,
    pub label: String,
    pub correct: Option<bool>,
    pub reason: Option<String>,
    pub explanation: Option<String>,
    pub trap: bool,
}

#[derive(Clone, Debug)]
pub struct Held {
    pub key: String,
    pub token: Token,
}

#[derive(Clone, Debug)]
pub struct Round {
    pub index: usize,
    pub beat: usize,
    pub status: RoundStatus,
    pub active_role: Option<Role>,
    pub in_flight: Option<InFlight>,
    pub slips: Vec<Slip>,
    pub log: Vec<LogEntry>,
    pub seq: u64,
    pub hands: HashMap<Role, Vec<Card>>,
    pub held: HashMap<Role, Vec<Held>>,
    pub app_received: Option<Token>,
    pub seats: Seats,
    pub moves: Vec<Move>,
    pub minted: HashSet<String>,
    pub free_used: Vec<CardType>,
    /// insertion-ordered guesses
    pub guesses: Vec<(String, Flow)>,
    pub tell_awarded_to: Option<String>,
    pub tell_pressed: Vec<String>,
    pub bonuses: Vec<(String, String)>,
    pub result: Option<RoundResult>,
}

#[derive(Clone)]
pub struct Keys {
    pub app: KeyPair,
    pub gateway: KeyPair,
    pub sigv4_secret: String,
}

#[derive(Clone)]
pub struct Game {
    pub room: String,
    pub scenarios: Arc<Vec<Scenario>>,
    pub players: Vec<Player>,
    pub host_id: Option<String>,
    pub started: bool,
    pub round: Option<Round>,
    /// logs of earlier rounds, oldest first (Arc: cloning a Game stays cheap)
    pub archive: Vec<Arc<ArchivedRound>>,
    pub keys: Keys,
    now_fn: Arc<dyn Fn() -> i64 + Send + Sync>,
    id_fn: Arc<dyn Fn() -> String + Send + Sync>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn card_flow(c: &Card) -> Option<Flow> {
    Some(match c.card_type {
        CardType::Forward => Flow::Passthrough,
        CardType::Exchange => {
            if c.params.requested_type == Some(RequestedType::IdJag) {
                Flow::Idjag
            } else {
                Flow::Obo
            }
        }
        CardType::Assertion => Flow::Jag,
        CardType::ApiKey => Flow::Apikey,
        CardType::Upstream => Flow::Upstream,
        CardType::Sigv4 => Flow::Sigv4,
        CardType::JwtSign => Flow::Zerotrust,
        CardType::Reauth => Flow::Reauth,
        CardType::TokenRequest => Flow::Oauth,
        _ => return None,
    })
}

fn chip(label: &str, tone: Tone) -> Chip {
    Chip { label: label.to_string(), tone }
}

/// The short name of the call a flow asks the Application (or Client) to make.
fn flow_chip(f: Flow) -> Chip {
    match f {
        Flow::Obo => chip("Exchange (OBO)", Tone::Send),
        Flow::Jag => chip("Signed assertion", Tone::Send),
        Flow::Idjag => chip("Exchange (ID-JAG)", Tone::Send),
        Flow::Oauth => chip("Authorize with the IdP", Tone::Send),
        Flow::Passthrough => chip("Forward the token", Tone::Send),
        Flow::Apikey => chip("API key", Tone::Send),
        Flow::Upstream => chip("Stored credential", Tone::Send),
        Flow::Sigv4 => chip("SigV4 signature", Tone::Send),
        Flow::Zerotrust => chip("Gateway JWT", Tone::Send),
        Flow::Reauth => chip("Stop: re-authenticate", Tone::Stop),
    }
}

/// The short name of what a card does.
fn played_chip(c: &Card) -> Chip {
    if let Some(f) = card_flow(c) {
        return flow_chip(f);
    }
    match c.card_type {
        CardType::Request if c.params.to == Some(Role::Mcp) => chip("Go straight to the MCP Server", Tone::Send),
        CardType::Request => chip("Send to the Application", Tone::Send),
        CardType::Cached => chip("Cached token", Tone::Send),
        CardType::Selfmint => chip("Self-written token", Tone::Send),
        CardType::AwsSecret => chip("AWS secret as bearer", Tone::Send),
        CardType::Issue => chip("Issue", Tone::Go),
        CardType::Accept => chip("Accept", Tone::Go),
        CardType::Reject => chip("Reject", Tone::Stop),
        _ => chip(&c.label, Tone::Send),
    }
}

/// Why a call of the right kind was still wrong, in a few words.
fn defect(reason: &str) -> &'static str {
    match reason {
        "scope_exceeds_consent" => "scope beyond consent",
        "assertion_audience" | "audience_mismatch" | "subject_audience" | "app_forward" => "wrong audience",
        "key_in_url" => "key in the URL",
        "sigv4_clock_skew" => "replayed",
        "alg_none" | "bad_signature" => "not signed",
        "credential_owner_mismatch" => "someone else's credential",
        "pkce_required" => "no PKCE",
        "client_stale" | "expired" => "expired token",
        "no_token" | "no_subject_token" => "no token",
        _ => "invalid",
    }
}

fn in_flight_flow(f: &InFlight) -> Option<Flow> {
    match f {
        InFlight::Exchange { requested_type, .. } => Some(if *requested_type == RequestedType::IdJag { Flow::Idjag } else { Flow::Obo }),
        InFlight::Assertion { .. } => Some(Flow::Jag),
        InFlight::TokenRequest { .. } => Some(Flow::Oauth),
        _ => None,
    }
}

struct Verdict0 {
    correct: Option<bool>,
    reason: Option<String>,
    explanation: Option<String>,
}

impl Verdict0 {
    fn neutral() -> Self {
        Verdict0 { correct: None, reason: None, explanation: None }
    }
    fn ok() -> Self {
        Verdict0 { correct: Some(true), reason: None, explanation: None }
    }
    fn bad(reason: &str, explanation: String) -> Self {
        Verdict0 { correct: Some(false), reason: Some(reason.into()), explanation: Some(explanation) }
    }
    fn bad_code(reason: &str) -> Self {
        Self::bad(reason, explain(reason).to_string())
    }
}

enum End {
    Beat,
    Round,
}

impl Game {
    pub fn new(room: &str, scenarios: Arc<Vec<Scenario>>) -> Self {
        Game {
            room: room.to_string(),
            scenarios,
            players: vec![],
            host_id: None,
            started: false,
            round: None,
            archive: vec![],
            keys: Keys { app: new_key_pair(), gateway: new_key_pair(), sigv4_secret: random_hex(20) },
            now_fn: Arc::new(now_ms),
            id_fn: Arc::new(random_id),
        }
    }

    /// Deterministic clock and ids for tests.
    #[cfg(test)]
    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static, ids: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.now_fn = Arc::new(now);
        self.id_fn = Arc::new(ids);
        self
    }

    fn now(&self) -> i64 {
        (self.now_fn)()
    }
    fn new_id(&self) -> String {
        (self.id_fn)()
    }

    // ---- players & seats --------------------------------------------------------------------

    pub fn player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }
    fn player_mut(&mut self, id: &str) -> Result<&mut Player, GameError> {
        self.players.iter_mut().find(|p| p.id == id).ok_or_else(|| GameError("Unknown player.".into()))
    }
    pub fn seated_roles(&self) -> Vec<Role> {
        self.players.iter().filter_map(|p| p.role).collect()
    }

    /// preferred: Some(role), None = first free seat; spectate = true joins without a seat.
    pub fn add_player(&mut self, name: &str, preferred: Option<Role>, spectate: bool) -> Player {
        let clean: String = name.chars().filter(|c| !c.is_control() && *c != '<' && *c != '>').collect::<String>().trim().chars().take(24).collect();
        let clean = if clean.is_empty() { "Player".to_string() } else { clean };
        let taken = self.seated_roles();
        let mut role = if spectate {
            None
        } else {
            match preferred {
                Some(r) if !taken.contains(&r) => Some(r),
                _ => ROLES.into_iter().find(|r| !taken.contains(r)),
            }
        };
        let id = self.new_id();
        // no free seat: a human takes over a sim's seat (their preferred one if a sim holds it)
        if role.is_none() && !spectate {
            let sim = self
                .players
                .iter()
                .filter(|p| p.bot && p.role.is_some())
                .max_by_key(|p| (p.role == preferred) as u8)
                .map(|p| (p.id.clone(), p.role.unwrap()));
            if let Some((sim_id, sim_role)) = sim {
                self.players.retain(|p| p.id != sim_id);
                if let Some(r) = &mut self.round {
                    if r.seats.get(sim_role) == Some(&sim_id) {
                        r.seats.set(sim_role, Some(id.clone()));
                    }
                    r.guesses.retain(|(g, _)| *g != sim_id);
                }
                role = Some(sim_role);
            }
        }
        let p = Player { id, name: clean, role, score: ScoreBreakdown::default(), bot: false };
        if self.host_id.is_none() {
            self.host_id = Some(p.id.clone());
        }
        self.players.push(p.clone());
        if let Some(r) = role {
            self.fill_round_seat(r, &p.id);
        }
        p
    }

    fn in_live_round(&self, id: &str, role: Option<Role>) -> bool {
        match (&self.round, role) {
            (Some(r), Some(role)) => r.status != RoundStatus::Done && r.seats.get(role).map(|s| s == id).unwrap_or(false),
            _ => false,
        }
    }

    /// Fill every empty seat with a sim. Any player in the room may do this.
    pub fn add_sims(&mut self, by: &str) -> Result<usize, GameError> {
        if self.player(by).map(|p| p.bot).unwrap_or(true) {
            return err("Unknown player.");
        }
        let taken = self.seated_roles();
        let empty: Vec<Role> = ROLES.into_iter().filter(|r| !taken.contains(r)).collect();
        if empty.is_empty() {
            return err("Every seat is already taken.");
        }
        for role in &empty {
            let used: Vec<String> = self.players.iter().map(|p| p.name.clone()).collect();
            let name = SIM_NAMES.iter().find(|n| !used.contains(&n.to_string())).copied().unwrap_or("Sim");
            let p = Player { id: self.new_id(), name: name.to_string(), role: Some(*role), score: ScoreBreakdown::default(), bot: true };
            let pid = p.id.clone();
            self.players.push(p);
            self.fill_round_seat(*role, &pid);
        }
        Ok(empty.len())
    }

    /// Host only, and not mid-round (a sim may hold cards the round needs).
    pub fn remove_sims(&mut self, by: &str) -> Result<(), GameError> {
        self.require_host(by)?;
        if self.round.as_ref().map(|r| r.status != RoundStatus::Done).unwrap_or(false) {
            return err("Finish the round before removing sims.");
        }
        if !self.players.iter().any(|p| p.bot) {
            return err("There are no sims at the table.");
        }
        self.players.retain(|p| !p.bot);
        Ok(())
    }

    /// The sim that should act next, if any.
    pub fn next_sim(&self) -> Option<String> {
        let r = self.round.as_ref()?;
        let is_bot = |id: &String| self.player(id).map(|p| p.bot).unwrap_or(false);
        match r.status {
            RoundStatus::Identify => ROLES
                .into_iter()
                .filter_map(|role| r.seats.get(role))
                .find(|id| is_bot(id) && !r.guesses.iter().any(|(g, _)| g == *id))
                .cloned(),
            RoundStatus::Playing => r.active_role.and_then(|role| r.seats.get(role)).filter(|id| is_bot(id)).cloned(),
            RoundStatus::Done => None,
        }
    }

    /// What a sim does now: usually the right call (`skill`), sometimes a free check first, sometimes a mistake.
    pub fn sim_choice(&self, sim: &str, skill: f64) -> Option<ClientMessage> {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let r = self.round.as_ref()?;
        let s = &self.scenarios[r.index];
        if r.status == RoundStatus::Identify {
            let expected = s.expected_flows.clone().unwrap_or_default();
            let flow = match expected.first() {
                Some(f) if rng.gen_bool(skill.clamp(0.0, 1.0) * 0.85) => *f,
                _ => FLOWS[rng.gen_range(0..FLOWS.len())],
            };
            return Some(ClientMessage::Identify { flow });
        }
        let view = self.private_view(sim);
        let playable: Vec<&Card> = view.hand.iter().filter(|c| view.can_play.contains(&c.id)).collect();
        let free: Vec<&&Card> = playable.iter().filter(|c| c.card_type.is_free()).collect();
        if !free.is_empty() && rng.gen_bool(0.35) {
            return Some(ClientMessage::Play { card_id: free[rng.gen_range(0..free.len())].id.clone() });
        }
        let real: Vec<&&Card> = playable.iter().filter(|c| !c.card_type.is_free()).collect();
        let (good, bad): (Vec<&&Card>, Vec<&&Card>) = real.iter().partition(|c| {
            let mut copy = self.clone();
            if copy.play(sim, &c.id).is_err() {
                return false;
            }
            // judge only this sim's own call: rejecting something a player upstream got wrong
            // is the right move even though the round then ends broken
            let rr = copy.round.as_ref().unwrap();
            rr.moves.last().map(|m| m.correct != Some(false)).unwrap_or(true)
        });
        let pick = if !good.is_empty() && (bad.is_empty() || rng.gen_bool(skill.clamp(0.0, 1.0))) {
            good[rng.gen_range(0..good.len())]
        } else if !bad.is_empty() {
            bad[rng.gen_range(0..bad.len())]
        } else {
            return None;
        };
        Some(ClientMessage::Play { card_id: pick.id.clone() })
    }

    pub fn sit(&mut self, player_id: &str, role: Role) -> Result<(), GameError> {
        let current = self.player(player_id).ok_or_else(|| GameError("Unknown player.".into()))?.role;
        if self.players.iter().any(|o| o.role == Some(role) && o.id != player_id) {
            return err("That seat is taken.");
        }
        if self.in_live_round(player_id, current) {
            return err("Finish the round before changing seats.");
        }
        self.player_mut(player_id)?.role = Some(role);
        self.fill_round_seat(role, player_id);
        Ok(())
    }

    pub fn stand(&mut self, player_id: &str) -> Result<(), GameError> {
        let current = self.player(player_id).ok_or_else(|| GameError("Unknown player.".into()))?.role;
        if self.in_live_round(player_id, current) {
            return err("Finish the round before leaving your seat.");
        }
        self.player_mut(player_id)?.role = None;
        Ok(())
    }

    fn fill_round_seat(&mut self, role: Role, player_id: &str) {
        if let Some(r) = &mut self.round {
            if r.status != RoundStatus::Done && r.seats.get(role).is_none() {
                r.seats.set(role, Some(player_id.to_string()));
            }
        }
    }

    // ---- rounds -----------------------------------------------------------------------------

    fn require_host(&self, id: &str) -> Result<(), GameError> {
        if self.host_id.as_deref() != Some(id) {
            return err("Only the host can do that.");
        }
        Ok(())
    }

    pub fn start(&mut self, player_id: &str) -> Result<(), GameError> {
        self.require_host(player_id)?;
        let i = self.round.as_ref().map(|r| r.index).unwrap_or(0);
        self.start_round(i)?;
        self.started = true;
        Ok(())
    }

    pub fn host_action(&mut self, player_id: &str, action: HostAction, round: Option<u32>) -> Result<(), GameError> {
        match action {
            HostAction::AddBots => return self.add_sims(player_id).map(|_| ()),
            HostAction::RemoveBots => return self.remove_sims(player_id),
            _ => {}
        }
        self.require_host(player_id)?;
        match action {
            HostAction::ForceReveal => {
                let r = self.round.as_mut().filter(|r| r.status == RoundStatus::Identify).ok_or_else(|| GameError("Nothing to reveal.".into()))?;
                r.status = RoundStatus::Playing;
                Self::log(r, None, "Host started play before every guess was in.", Verdict::Info, None, None);
                Ok(())
            }
            HostAction::Replay => {
                let i = self.round.as_ref().map(|r| r.index).ok_or_else(|| GameError("No round to replay.".into()))?;
                self.start_round(i)
            }
            HostAction::AddBots | HostAction::RemoveBots => unreachable!(),
            HostAction::Next | HostAction::Goto => {
                let target: i64 = match action {
                    HostAction::Next => self.round.as_ref().map(|r| r.index as i64 + 1).unwrap_or(0),
                    _ => round.map(|r| r as i64).unwrap_or(-1),
                };
                if target < 0 || target as usize >= self.scenarios.len() {
                    return err("No such round.");
                }
                // check seats before rotating so a refused start doesn't shuffle anyone
                if self.seated_roles().len() < 4 {
                    return self.start_round(target as usize);
                }
                if self.round.as_ref().map(|r| r.status == RoundStatus::Done).unwrap_or(false) {
                    self.rotate_seats();
                }
                self.start_round(target as usize)?;
                self.started = true;
                Ok(())
            }
        }
    }

    /// Everyone moves one seat along the flow: Client → Application → IdP → MCP Server → Client.
    pub fn rotate_seats(&mut self) {
        for p in &mut self.players {
            if let Some(r) = p.role {
                p.role = Some(ROLES[(r.index() + 1) % 4]);
            }
        }
    }

    pub fn start_round(&mut self, index: usize) -> Result<(), GameError> {
        if index >= self.scenarios.len() {
            return err("No such round.");
        }
        let scenarios = self.scenarios.clone();
        let s = &scenarios[index];
        let mut seats = Seats::default();
        for role in ROLES {
            seats.set(role, self.players.iter().find(|p| p.role == Some(role)).map(|p| p.id.clone()));
        }
        let missing: Vec<&str> = ROLES.into_iter().filter(|r| seats.get(*r).is_none()).map(|r| r.name()).collect();
        if !missing.is_empty() {
            return err(&format!("Need all four seats filled. Empty: {}.", missing.join(", ")));
        }
        let now = self.now();
        let templates = s.resolved_tokens();
        let holders = s.resolved_holders();
        let mut held: HashMap<Role, Vec<Held>> = HashMap::new();
        let mut minted = HashSet::new();
        let mut hands = HashMap::new();
        let id_fn = self.id_fn.clone();
        for role in ROLES {
            let mut list = vec![];
            for key in holders.get(&role).cloned().unwrap_or_default() {
                let Some(t) = templates.get(&key) else { continue };
                let token = Token {
                    id: self.new_id(),
                    kind: t.kind,
                    subject: t.subject.clone(),
                    subject_type: t.subject_type,
                    audience: t.audience.clone(),
                    scope: t.scope.clone(),
                    expiry: now + t.expires_in_min * MIN,
                    issuer: t.issuer.clone().unwrap_or_else(|| "idp".into()),
                    client_id: Some("application".into()),
                    refreshable: false,
                    forged: t.forged,
                };
                if !t.forged && token.issuer == "idp" {
                    minted.insert(token.id.clone());
                }
                list.push(Held { key, token });
            }
            held.insert(role, list);
            hands.insert(role, s.deal(role, &mut || id_fn()));
        }
        let beats = s.beats();
        let mut r = Round {
            index,
            beat: 0,
            status: if s.phase == Phase::Assessment { RoundStatus::Identify } else { RoundStatus::Playing },
            active_role: Some(beats[0]),
            in_flight: None,
            slips: vec![],
            log: vec![],
            seq: 0,
            hands,
            held,
            app_received: None,
            seats,
            moves: vec![],
            minted,
            free_used: vec![],
            guesses: vec![],
            tell_awarded_to: None,
            tell_pressed: vec![],
            bonuses: vec![],
            result: None,
        };
        let title = if s.phase == Phase::Assessment { String::new() } else { format!(": {}", s.title) };
        Self::log(&mut r, None, &format!("Round {}{title}. {}", index + 1, s.text), Verdict::Info, None, None);
        if r.status == RoundStatus::Identify {
            Self::log(&mut r, None, "Each player privately picks the flow they think applies.", Verdict::Info, None, None);
        }
        if let Some(old) = self.round.take() {
            let offset = self.assessment_offset();
            let os = &scenarios[old.index];
            self.archive.push(Arc::new(ArchivedRound {
                index: old.index,
                title: if os.phase == Phase::Assessment { format!("Assessment {}", old.index + 1 - offset) } else { os.title.clone() },
                phase: os.phase,
                success: old.result.as_ref().map(|x| x.success),
                log: old.log,
            }));
            if self.archive.len() > 60 {
                self.archive.remove(0);
            }
        }
        self.round = Some(r);
        Ok(())
    }

    // ---- assessment extras -------------------------------------------------------------------

    pub fn identify(&mut self, player_id: &str, flow: Flow) -> Result<(), GameError> {
        let r = self.round.as_mut().filter(|r| r.status == RoundStatus::Identify).ok_or_else(|| GameError("Not accepting guesses right now.".into()))?;
        if r.seats.role_of(player_id).is_none() {
            return err("Only seated players guess.");
        }
        match r.guesses.iter_mut().find(|(id, _)| id == player_id) {
            Some(g) => g.1 = flow,
            None => r.guesses.push((player_id.to_string(), flow)),
        }
        let all_in = ROLES.into_iter().filter_map(|role| r.seats.get(role)).all(|id| r.guesses.iter().any(|(g, _)| g == id));
        if all_in {
            r.status = RoundStatus::Playing;
            Self::log(r, None, "All guesses are in. Play begins.", Verdict::Info, None, None);
        }
        Ok(())
    }

    pub fn tell(&mut self, player_id: &str) -> Result<(), GameError> {
        let scenarios = self.scenarios.clone();
        let name = self.player(player_id).ok_or_else(|| GameError("Unknown player.".into()))?.name.clone();
        let r = self.round.as_mut().filter(|r| r.status != RoundStatus::Done).ok_or_else(|| GameError("No round in progress.".into()))?;
        let s = &scenarios[r.index];
        if s.phase == Phase::Warmup {
            return err("Spot the tell starts in the learning phase.");
        }
        if r.seats.role_of(player_id).is_none() {
            return err("Only seated players can call it.");
        }
        if r.tell_pressed.iter().any(|x| x == player_id) {
            return err("You already called it this round.");
        }
        r.tell_pressed.push(player_id.to_string());
        if r.tell_awarded_to.is_some() {
            return err("Someone already called it.");
        }
        if !s.user_present {
            r.tell_awarded_to = Some(player_id.to_string());
            r.bonuses.push((player_id.to_string(), "Spotted the tell: no user is present".into()));
            Self::log(r, None, &format!("{name} called it: no user is present. Bonus point."), Verdict::Correct, None, None);
            self.player_mut(player_id)?.score.bonus += 1;
        } else {
            Self::log(r, None, &format!("{name} called \"no user present\", but a user is present here."), Verdict::Incorrect, None, None);
        }
        Ok(())
    }

    // ---- play -------------------------------------------------------------------------------

    pub fn playable(r: &Round, role: Role, card: &Card) -> bool {
        if r.status != RoundStatus::Playing || r.active_role != Some(role) {
            return false;
        }
        if let Some(b) = card.params.beat {
            if b != r.beat {
                return false;
            }
        }
        let f = r.in_flight.as_ref();
        let to_me = f.map(|f| f.to() == role).unwrap_or(false);
        match card.card_type {
            CardType::Request | CardType::TokenRequest => f.is_none() || !to_me,
            CardType::Issue => to_me && !matches!(f, Some(InFlight::Request { .. }) | Some(InFlight::Call { .. })),
            CardType::RegisteredKey => to_me && matches!(f, Some(InFlight::Assertion { .. })) && !r.free_used.contains(&card.card_type),
            CardType::Accept => to_me && matches!(f, Some(InFlight::Call { .. }) | Some(InFlight::Request { .. })),
            CardType::Reject => to_me,
            CardType::ValidateAudience | CardType::ValidateScope => {
                to_me && matches!(f, Some(InFlight::Call { .. })) && !r.free_used.contains(&card.card_type)
            }
            CardType::Introspect => to_me && matches!(f, Some(InFlight::Call { confirmed_by_idp: false, .. })),
            t if t.is_app_initiative() => f.is_none() || (to_me && matches!(f, Some(InFlight::Request { .. }))),
            _ => false,
        }
    }

    pub fn play(&mut self, player_id: &str, card_id: &str) -> Result<(), GameError> {
        let r = self.round.as_ref().ok_or_else(|| GameError("No round in progress.".into()))?;
        match r.status {
            RoundStatus::Identify => return err("Waiting for everyone's flow guess."),
            RoundStatus::Done => return err("Round is over."),
            RoundStatus::Playing => {}
        }
        let role = r.seats.role_of(player_id).ok_or_else(|| GameError("You are not seated in this round.".into()))?;
        if r.active_role != Some(role) {
            return err("It is not your turn.");
        }
        let card = r.hands.get(&role).and_then(|h| h.iter().find(|c| c.id == card_id)).cloned().ok_or_else(|| GameError("No such card in your hand.".into()))?;
        if !Self::playable(r, role, &card) {
            return err("That card can't be played right now.");
        }
        let name = self.player(player_id).map(|p| p.name.clone()).unwrap_or_default();
        if card.card_type.is_free() {
            let r = self.round.as_mut().unwrap();
            r.free_used.push(card.card_type);
            self.free_check(role, &name, &card);
            return Ok(());
        }
        if card.card_type.is_consumable() {
            let r = self.round.as_mut().unwrap();
            r.hands.get_mut(&role).unwrap().retain(|c| c.id != card.id);
        }
        self.resolve(role, player_id, &name, &card)
    }

    fn cred_ctx(&self, r: &Round) -> CredentialContext {
        let s = &self.scenarios[r.index];
        let now = self.now();
        let mut trusted = HashMap::new();
        if s.trusts_gateway {
            trusted.insert("gateway".to_string(), self.keys.gateway.public_key.clone());
        }
        CredentialContext {
            token: TokenContext { now, trusted_issuers: vec!["idp".into()], minted: Some(r.minted.clone()) },
            gateway: GatewayContext { now, trusted_signers: trusted },
            api_keys: s.api_keys.clone().unwrap_or_default(),
            sigv4: SigV4Context {
                now,
                secrets: HashMap::from([(SIGV4_KEY_ID.to_string(), self.keys.sigv4_secret.clone())]),
                service: SIGV4_SERVICE.into(),
                region: SIGV4_REGION.into(),
                max_skew_ms: 5 * MIN,
            },
        }
    }

    /// Is the thing currently in flight valid at its receiver?
    fn judge_item(&self, r: &Round, f: &InFlight) -> Validation {
        let s = &self.scenarios[r.index];
        let ctx = self.cred_ctx(r);
        match f {
            InFlight::Request { to, request, token, .. } => validate_token(token.as_ref(), *to, request, &ctx.token),
            InFlight::Call { to, request, credential, .. } => validate_credential(credential.as_ref(), *to, request, &ctx),
            InFlight::TokenRequest { audience, pkce, .. } => validate_token_request(
                "application",
                audience,
                *pkce,
                &TokenRequestContext {
                    registered_clients: vec!["application".into()],
                    allowed_audiences: s.idp_audiences.clone().unwrap_or_else(|| vec!["application".into(), "mcp".into()]),
                    require_pkce: true,
                },
            ),
            InFlight::Exchange { subject_token, requested_audience, requested_scope, .. } => validate_exchange(
                &ExchangeInput {
                    subject_token: subject_token.as_ref(),
                    client_id: "application",
                    requested_audience,
                    requested_scope,
                },
                &ExchangeContext {
                    now: ctx.token.now,
                    registered_clients: vec!["application".into()],
                    allowed_audiences: s.idp_audiences.clone().unwrap_or_else(|| vec!["mcp".into()]),
                },
            ),
            InFlight::Assertion { assertion, .. } => validate_assertion(
                assertion,
                &AssertionContext {
                    now: ctx.token.now,
                    registered_keys: HashMap::from([("application".to_string(), self.keys.app.public_key.clone())]),
                    allowed_scopes: HashMap::from([(
                        "application".to_string(),
                        s.app_allowed_scopes.clone().unwrap_or_else(|| vec![s.request.required_scope.clone()]),
                    )]),
                },
            ),
            InFlight::Introspect { credential, .. } => {
                let known = matches!(credential, Some(Credential::Bearer { token }) if !token.forged && r.minted.contains(&token.id));
                Validation {
                    valid: known,
                    failures: if known { vec![] } else { vec![Rule::UnknownToken] },
                    checks: vec![Check {
                        rule: Rule::UnknownToken,
                        ok: known,
                        detail: if known { "IdP minted this token.".into() } else { "IdP has no record of this token.".into() },
                    }],
                }
            }
        }
    }

    fn expected(s: &Scenario) -> Option<Vec<Flow>> {
        if s.phase == Phase::Warmup { None } else { s.expected_flows.clone() }
    }

    fn held_token(r: &Round, role: Role, key: Option<&str>) -> Option<Token> {
        let list = r.held.get(&role)?;
        match key? {
            "latest" => list.last().map(|h| h.token.clone()),
            k => list.iter().find(|h| h.key == k).map(|h| h.token.clone()),
        }
    }

    fn mint(&self, r: &mut Round, kind: TokenKind, subject: String, subject_type: SubjectType, audience: String, scope: Vec<String>) -> Token {
        let s = &self.scenarios[r.index];
        let t = Token {
            id: self.new_id(),
            kind,
            subject,
            subject_type,
            audience,
            scope,
            expiry: self.now() + 60 * MIN,
            issuer: "idp".into(),
            client_id: Some("application".into()),
            refreshable: s.refresh_token,
            forged: false,
        };
        r.minted.insert(t.id.clone());
        t
    }

    /// Build what an Application card sends.
    fn app_item(&self, r: &Round, card: &Card, request: &RequestSpec) -> Option<InFlight> {
        let s = &self.scenarios[r.index];
        let now = self.now();
        let p = &card.params;
        let call = |credential: Option<Credential>| InFlight::Call {
            from: Role::Application,
            to: Role::Mcp,
            request: request.clone(),
            credential,
            confirmed_by_idp: false,
        };
        let received = r.app_received.clone();
        Some(match card.card_type {
            CardType::Forward => call(received.map(|token| Credential::Bearer { token })),
            CardType::Cached => {
                call(Self::held_token(r, Role::Application, Some(p.attach.as_deref().unwrap_or("cachedToken"))).map(|token| Credential::Bearer { token }))
            }
            CardType::Selfmint => call(Some(Credential::Bearer {
                token: Token {
                    id: self.new_id(),
                    kind: TokenKind::Access,
                    subject: request.user.clone().unwrap_or_else(|| "user:alex".into()),
                    subject_type: SubjectType::User,
                    audience: p.audience.clone().unwrap_or_else(|| "mcp".into()),
                    scope: p.scope.clone().unwrap_or_else(|| vec![request.required_scope.clone()]),
                    expiry: now + 60 * MIN,
                    issuer: "application".into(),
                    client_id: None,
                    refreshable: false,
                    forged: true,
                },
            })),
            CardType::Exchange => InFlight::Exchange {
                from: Role::Application,
                to: Role::Idp,
                subject_token: received.or_else(|| Self::held_token(r, Role::Application, Some("cachedToken"))),
                requested_audience: p.audience.clone().unwrap_or_else(|| "mcp".into()),
                requested_scope: p.scope.clone().unwrap_or_else(|| vec![request.required_scope.clone()]),
                requested_type: p.requested_type.unwrap_or(RequestedType::Access),
                request: request.clone(),
            },
            CardType::Assertion => {
                let mut a = Assertion {
                    iss: "application".into(),
                    sub: "application".into(),
                    aud: p.audience.clone().unwrap_or_else(|| "idp".into()),
                    exp: now + p.expires_in_min.unwrap_or(5) * MIN,
                    scope: p.scope.clone().unwrap_or_else(|| vec![request.required_scope.clone()]),
                    jti: self.new_id(),
                    signature: String::new(),
                };
                a.signature = sign_payload(&a, &self.keys.app.secret_key);
                InFlight::Assertion { from: Role::Application, to: Role::Idp, assertion: a, request: request.clone() }
            }
            CardType::ApiKey | CardType::Upstream => {
                let keys = s.api_keys.clone().unwrap_or_default();
                let rec = match &p.owner {
                    Some(o) => keys.iter().find(|k| &k.owner == o),
                    None => keys.first(),
                };
                call(Some(Credential::ApiKey {
                    key: ApiKeyCredential {
                        key_id: rec.map(|r| r.key_id.clone()).unwrap_or_else(|| "sk_unregistered".into()),
                        owner: rec.map(|r| r.owner.clone()).or_else(|| p.owner.clone()).unwrap_or_else(|| "unknown".into()),
                        placement: p.placement.unwrap_or(Placement::Header),
                    },
                }))
            }
            CardType::Sigv4 => {
                let mut sig = SigV4Signature {
                    access_key_id: SIGV4_KEY_ID.into(),
                    region: SIGV4_REGION.into(),
                    service: SIGV4_SERVICE.into(),
                    timestamp: now + p.expires_in_min.unwrap_or(0) * MIN,
                    signed_headers: vec!["host".into(), "x-amz-date".into()],
                    signature: String::new(),
                };
                sig.signature = sigv4_sign(request, &sig, &self.keys.sigv4_secret);
                call(Some(Credential::Sigv4 { sig }))
            }
            CardType::AwsSecret => call(Some(Credential::AwsSecretBearer)),
            CardType::JwtSign => {
                let alg = p.alg.unwrap_or(Alg::EdDSA);
                let mut j = GatewayJwt {
                    iss: "gateway".into(),
                    sub: received.as_ref().map(|t| t.subject.clone()).unwrap_or_else(|| "unknown".into()),
                    subject_type: received.as_ref().map(|t| t.subject_type).unwrap_or(SubjectType::User),
                    aud: p.audience.clone().unwrap_or_else(|| "mcp".into()),
                    exp: now + p.expires_in_min.unwrap_or(5) * MIN,
                    scope: p.scope.clone().unwrap_or_else(|| vec![request.required_scope.clone()]),
                    alg,
                    signature: String::new(),
                };
                if alg != Alg::None {
                    j.signature = sign_payload(&j, &self.keys.gateway.secret_key);
                }
                call(Some(Credential::GatewayJwt { jwt: j }))
            }
            _ => return None,
        })
    }

    fn judge_outcome(&self, r: &Round, card: &Card, item: &InFlight, flow: Option<Flow>, expected: &Option<Vec<Flow>>) -> Verdict0 {
        if card.params.scripted {
            return Verdict0::neutral();
        }
        if let Some(exp) = expected {
            if !flow.map(|f| exp.contains(&f)).unwrap_or(false) {
                return match card.card_type {
                    CardType::Cached => Verdict0::bad_code("app_cached"),
                    CardType::Selfmint => Verdict0::bad_code("app_selfmint"),
                    CardType::AwsSecret => Verdict0::bad_code("secret_on_wire"),
                    CardType::Forward => Verdict0::bad_code("app_forward"),
                    CardType::Request if card.params.to == Some(Role::Mcp) => Verdict0::bad_code("client_bypass"),
                    _ => Verdict0::bad("wrong_flow", wrong_flow_explanation(exp, flow)),
                };
            }
        }
        let v = self.judge_item(r, item);
        if !v.valid {
            let code = v.failures[0];
            let reason = if card.card_type == CardType::Forward && code == Rule::AudienceMismatch { "app_forward" } else { code.code() };
            return Verdict0::bad_code(reason);
        }
        Verdict0::ok()
    }

    fn resolve(&mut self, role: Role, player_id: &str, name: &str, card: &Card) -> Result<(), GameError> {
        let scenarios = self.scenarios.clone();
        let r_index = self.round.as_ref().unwrap().index;
        let s = &scenarios[r_index];
        let expected = Self::expected(s);
        let f = self.round.as_ref().unwrap().in_flight.clone();
        let request = f.as_ref().and_then(|f| f.request().cloned()).or_else(|| card.params.request.clone()).unwrap_or_else(|| s.request.clone());
        let mut next: Option<InFlight> = None;
        let mut end: Option<End> = None;
        let mut bonus = false;
        // for decision cards: what the right decision was (set in that arm)
        let mut expected_decision: Option<Chip> = None;
        let text: String;
        let verdict: Verdict0;
        let now = self.now();

        match card.card_type {
            CardType::Request => {
                let r = self.round.as_ref().unwrap();
                let token = Self::held_token(r, role, card.params.attach.as_deref());
                let req = card.params.request.clone().unwrap_or_else(|| s.request.clone());
                if card.params.to == Some(Role::Mcp) {
                    let item = InFlight::Call { from: role, to: Role::Mcp, request: req, credential: token.map(|token| Credential::Bearer { token }), confirmed_by_idp: false };
                    verdict = self.judge_outcome(r, card, &item, Some(Flow::Oauth), &expected);
                    next = Some(item);
                } else {
                    let expired = token.as_ref().map(|t| t.expiry <= now).unwrap_or(false);
                    verdict = if card.params.scripted {
                        Verdict0::neutral()
                    } else if let Some(exp) = expected.as_ref().filter(|e| e.iter().all(|x| *x == Flow::Oauth)) {
                        Verdict0::bad("wrong_flow", wrong_flow_explanation(exp, None))
                    } else if expired {
                        Verdict0::bad_code("client_stale")
                    } else {
                        Verdict0::ok()
                    };
                    next = Some(InFlight::Request { from: role, to: card.params.to.unwrap_or(Role::Application), request: req, token });
                }
                text = card.label.clone();
            }
            CardType::TokenRequest => {
                let r = self.round.as_ref().unwrap();
                let item = InFlight::TokenRequest {
                    from: role,
                    to: Role::Idp,
                    scope: card.params.scope.clone().unwrap_or_else(|| vec![s.request.required_scope.clone()]),
                    audience: card.params.audience.clone().unwrap_or_else(|| "mcp".into()),
                    pkce: card.params.pkce != Some(false),
                };
                verdict = if expected.is_some() {
                    self.judge_outcome(r, card, &item, Some(Flow::Oauth), &expected)
                } else if card.params.scripted {
                    Verdict0::neutral()
                } else {
                    self.judge_outcome(r, card, &item, None, &None)
                };
                next = Some(item);
                text = card.label.clone();
            }
            CardType::Reauth => {
                text = card.label.clone();
                verdict = if card.params.scripted {
                    Verdict0::neutral()
                } else {
                    match &expected {
                        None => Verdict0::ok(),
                        Some(e) if e.contains(&Flow::Reauth) => Verdict0::ok(),
                        Some(e) => Verdict0::bad("wrong_flow", wrong_flow_explanation(e, Some(Flow::Reauth))),
                    }
                };
                end = Some(End::Round);
            }
            CardType::Forward
            | CardType::Cached
            | CardType::Selfmint
            | CardType::Exchange
            | CardType::Assertion
            | CardType::ApiKey
            | CardType::Upstream
            | CardType::Sigv4
            | CardType::AwsSecret
            | CardType::JwtSign => {
                let r = self.round.as_ref().unwrap();
                let item = self.app_item(r, card, &request);
                verdict = match &item {
                    Some(i) => self.judge_outcome(r, card, i, card_flow(card), &expected),
                    None => Verdict0::bad_code("no_token"),
                };
                next = item;
                text = card.label.clone();
            }
            CardType::Issue | CardType::Accept | CardType::Reject => {
                let Some(fl) = f.as_ref() else { return err("Nothing to respond to.") };
                let r = self.round.as_ref().unwrap();
                let v = self.judge_item(r, fl);
                let flow = in_flight_flow(fl);
                let wrong_flow = role == Role::Idp && matches!((&expected, flow), (Some(e), Some(fl)) if !e.contains(&fl));
                let first_detail = v.first_failure_detail().unwrap_or("invalid").to_string();
                if !card.params.scripted {
                    expected_decision = Some(if !v.valid || wrong_flow {
                        chip("Reject", Tone::Stop)
                    } else if role == Role::Idp {
                        chip("Issue", Tone::Go)
                    } else {
                        chip("Accept", Tone::Go)
                    });
                }
                if card.card_type == CardType::Reject {
                    end = Some(End::Round);
                    if !v.valid {
                        verdict = Verdict0::ok();
                        text = format!("Reject: {first_detail}");
                    } else if wrong_flow {
                        verdict = Verdict0::ok();
                        bonus = true;
                        text = format!("Reject: {} is the wrong flow here, even though it would technically work.", flow.unwrap().name());
                    } else {
                        verdict = if card.params.scripted { Verdict0::neutral() } else { Verdict0::bad_code("rejected_valid") };
                        text = "Reject (but everything checked out)".into();
                    }
                } else if !v.valid {
                    let why = v.failures[0].code();
                    verdict = Verdict0::bad(why, format!("{} accepted something invalid. {}", role.name(), explain(why)));
                    text = format!("{} (despite: {first_detail})", if card.card_type == CardType::Issue { "Issue" } else { "Accept" });
                } else if wrong_flow && card.card_type == CardType::Issue {
                    verdict = Verdict0 { correct: None, reason: Some("idp_wrong_flow".into()), explanation: None };
                    text = "Issue (wrong flow for this situation; no point)".into();
                } else {
                    verdict = Verdict0::ok();
                    text = if card.card_type == CardType::Issue { "Issue / approve".into() } else { "Accept".into() };
                }
                if card.card_type == CardType::Accept {
                    end = Some(End::Beat);
                }
                if card.card_type == CardType::Issue {
                    next = self.issue(fl);
                }
            }
            CardType::Introspect => {
                let Some(InFlight::Call { request, credential, .. }) = f.as_ref() else { return err("Nothing to introspect.") };
                next = Some(InFlight::Introspect { from: Role::Mcp, to: Role::Idp, request: request.clone(), credential: credential.clone() });
                verdict = Verdict0::neutral();
                text = card.label.clone();
            }
            _ => return err("That card can't be played right now."),
        }

        // score + record
        if verdict.correct == Some(true) || bonus {
            let p = self.player_mut(player_id)?;
            if verdict.correct == Some(true) {
                p.score.calls += 1;
            }
            if bonus {
                p.score.bonus += 1;
            }
        }
        let r = self.round.as_mut().unwrap();
        if bonus {
            r.bonuses.push((player_id.to_string(), "IdP refused a play that used the wrong flow".into()));
        }
        r.moves.push(Move {
            player_id: player_id.to_string(),
            role,
            label: card.label.clone(),
            correct: verdict.correct,
            reason: verdict.reason.clone(),
            explanation: verdict.explanation.clone(),
            trap: card.params.trap,
        });
        let v = match verdict.correct {
            Some(true) => Verdict::Correct,
            Some(false) => Verdict::Incorrect,
            None => Verdict::Neutral,
        };
        let detail = if verdict.correct == Some(false) { verdict.explanation.clone() } else { None };
        Self::log(r, Some(role), &text, v, detail, Some(name.to_string()));

        // expected vs played
        let call = if card.params.scripted || card.card_type == CardType::Introspect {
            None
        } else {
            let mut played = played_chip(card);
            let wrong = verdict.correct == Some(false);
            let reason = verdict.reason.as_deref().unwrap_or("");
            let expected_chip = match card.card_type {
                CardType::Issue | CardType::Accept | CardType::Reject => expected_decision.clone(),
                CardType::Request | CardType::TokenRequest => Some(if !wrong {
                    played.clone()
                } else if reason == "client_bypass" {
                    chip("Send to the Application", Tone::Send)
                } else if matches!(&expected, Some(e) if e.iter().all(|x| *x == Flow::Oauth)) {
                    flow_chip(Flow::Oauth)
                } else {
                    played.clone()
                }),
                _ => match &expected {
                    Some(e) => Some(match card_flow(card) {
                        Some(f) if e.contains(&f) => flow_chip(f),
                        _ => flow_chip(e[0]),
                    }),
                    None => Some(played.clone()),
                },
            };
            expected_chip.map(|exp| {
                // right kind of call, wrong in the details: say what was off
                if wrong && exp == played {
                    played.label = format!("{} · {}", played.label, defect(reason));
                }
                let matched = exp == played;
                Call { expected: exp, played, matched }
            })
        };
        if let Some(last) = r.log.last_mut() {
            last.call = call;
        }

        if role == Role::Client {
            if let Some(InFlight::Request { to: Role::Application, token, .. }) = &next {
                r.app_received = token.clone();
            }
        }

        match end {
            Some(End::Round) => self.finish(),
            Some(End::Beat) => {
                let beats = s.beats();
                let r = self.round.as_mut().unwrap();
                if r.beat + 1 < beats.len() {
                    r.beat += 1;
                    r.in_flight = None;
                    r.active_role = Some(beats[r.beat]);
                    r.free_used.clear();
                    let who = beats[r.beat].name();
                    Self::log(r, None, &format!("Next: {who} continues."), Verdict::Info, None, None);
                } else {
                    self.finish();
                }
            }
            None => {
                let r = self.round.as_mut().unwrap();
                r.free_used.clear();
                match next {
                    Some(n) => {
                        r.slips.push(Slip { from: n.from(), to: n.to(), label: describe(&n), item: n.clone() });
                        r.active_role = Some(n.to());
                        r.in_flight = Some(n);
                    }
                    None => {
                        // token delivered back to the client (warm-up 1 / MCP OAuth)
                        r.in_flight = None;
                        r.active_role = Some(Role::Client);
                    }
                }
            }
        }
        Ok(())
    }

    /// IdP issue: what gets minted and where it goes.
    fn issue(&mut self, f: &InFlight) -> Option<InFlight> {
        let scenarios = self.scenarios.clone();
        let mut r = self.round.take().unwrap();
        let s = &scenarios[r.index];
        let out = match f {
            InFlight::TokenRequest { audience, scope, .. } => {
                let t = self.mint(&mut r, TokenKind::Access, s.user(), SubjectType::User, audience.clone(), scope.clone());
                r.held.entry(Role::Client).or_default().push(Held { key: "issued".into(), token: t.clone() });
                r.slips.push(Slip {
                    from: Role::Idp,
                    to: Role::Client,
                    label: format!("Token slip → Client (aud {}, scope {})", t.audience, t.scope.join(" ")),
                    item: InFlight::Request { from: Role::Idp, to: Role::Client, request: s.request.clone(), token: Some(t) },
                });
                None
            }
            InFlight::Exchange { subject_token, requested_audience, requested_scope, requested_type, request, .. } => {
                let kind = if *requested_type == RequestedType::IdJag { TokenKind::IdJag } else { TokenKind::Access };
                let (sub, st) = subject_token.as_ref().map(|t| (t.subject.clone(), t.subject_type)).unwrap_or(("unknown".into(), SubjectType::User));
                let t = self.mint(&mut r, kind, sub, st, requested_audience.clone(), requested_scope.clone());
                Some(InFlight::Call { from: Role::Idp, to: Role::Mcp, request: request.clone(), credential: Some(Credential::Bearer { token: t }), confirmed_by_idp: false })
            }
            InFlight::Assertion { assertion, request, .. } => {
                let t = self.mint(&mut r, TokenKind::Access, assertion.sub.clone(), SubjectType::App, "mcp".into(), assertion.scope.clone());
                Some(InFlight::Call { from: Role::Idp, to: Role::Mcp, request: request.clone(), credential: Some(Credential::Bearer { token: t }), confirmed_by_idp: false })
            }
            InFlight::Introspect { request, credential, .. } => {
                Some(InFlight::Call { from: Role::Idp, to: Role::Mcp, request: request.clone(), credential: credential.clone(), confirmed_by_idp: true })
            }
            _ => None,
        };
        self.round = Some(r);
        out
    }

    fn free_check(&mut self, role: Role, name: &str, card: &Card) {
        let r = self.round.as_ref().unwrap();
        let Some(f) = r.in_flight.clone() else { return };
        let v = self.judge_item(r, &f);
        let rules: &[Rule] = match card.card_type {
            CardType::ValidateAudience => &[Rule::AudienceMismatch, Rule::NoToken],
            CardType::ValidateScope => &[Rule::ScopeInsufficient, Rule::AppSubjectUserData, Rule::NoToken],
            CardType::RegisteredKey => &[Rule::BadSignature, Rule::UnregisteredIssuer],
            _ => &[],
        };
        let checks: Vec<&Check> = v.checks.iter().filter(|c| rules.contains(&c.rule)).collect();
        let text = if !checks.is_empty() {
            checks.iter().map(|c| format!("{} {}", if c.ok { "✓" } else { "✗" }, c.detail)).collect::<Vec<_>>().join(" ")
        } else if matches!(&f, InFlight::Call { credential: Some(c), .. } if !matches!(c, Credential::Bearer { .. })) {
            "Not an OAuth token: this check doesn't apply. Look at the credential itself.".into()
        } else {
            "Nothing to check.".into()
        };
        let r = self.round.as_mut().unwrap();
        Self::log(r, Some(role), &format!("{}: {text}", card.label), Verdict::Info, None, Some(name.to_string()));
    }

    fn finish(&mut self) {
        let scenarios = self.scenarios.clone();
        let mut r = self.round.take().unwrap();
        let s = &scenarios[r.index];
        r.status = RoundStatus::Done;
        r.active_role = None;
        let name_of = |g: &Game, id: &str| g.player(id).map(|p| p.name.clone()).unwrap_or_else(|| "?".into());
        let broke = r.moves.iter().find(|m| m.correct == Some(false)).cloned();
        let mut awards = vec![];
        for m in r.moves.iter().filter(|m| m.correct == Some(true)) {
            awards.push(Award { player_id: m.player_id.clone(), name: name_of(self, &m.player_id), points: 1, why: format!("Correct call as {}", m.role.name()) });
        }
        for (id, why) in &r.bonuses {
            awards.push(Award { player_id: id.clone(), name: name_of(self, id), points: 1, why: why.clone() });
        }
        let expected = s.expected_flows.clone().unwrap_or_default();
        let mut guesses = vec![];
        if s.phase == Phase::Assessment {
            for (id, flow) in r.guesses.clone() {
                let correct = expected.contains(&flow);
                guesses.push(Guess { player_id: id.clone(), name: name_of(self, &id), flow, correct });
                if correct {
                    if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
                        p.score.identify += 1;
                    }
                    awards.push(Award { player_id: id.clone(), name: name_of(self, &id), points: 1, why: "Identified the flow".into() });
                }
            }
        }
        let flow_text = match expected.first() {
            Some(first) => format!(
                " The right call: {}. In short, {}.",
                expected.iter().map(|f| f.name()).collect::<Vec<_>>().join(" or "),
                flow_why(*first)
            ),
            None => String::new(),
        };
        let success = broke.is_none();
        r.result = Some(RoundResult {
            success,
            failed_step: broke.as_ref().map(|b| FailedStep { role: b.role, player_name: name_of(self, &b.player_id), text: b.label.clone() }),
            explanation: match &broke {
                None => format!("Chain unbroken end to end.{flow_text}"),
                Some(b) => format!(
                    "{}{flow_text}",
                    b.explanation.clone().unwrap_or_else(|| explain(b.reason.as_deref().unwrap_or("")).to_string())
                ),
            },
            expected_flows: expected,
            tells: s.tells.clone(),
            discussion: s.discussion.clone(),
            teaches: s.teaches.clone(),
            guesses,
            awards,
            traps: r.moves.iter().filter(|m| m.trap).map(|m| format!("{} played a trap: \"{}\"", m.role.name(), m.label)).collect(),
        });
        let line = match &broke {
            None => ("Round succeeded: the chain held.".to_string(), Verdict::Correct),
            Some(b) => (format!("Chain broken at {}.", b.role.name()), Verdict::Incorrect),
        };
        Self::log(&mut r, None, &line.0, line.1, None, None);
        self.round = Some(r);
    }

    fn log(r: &mut Round, role: Option<Role>, text: &str, verdict: Verdict, detail: Option<String>, player_name: Option<String>) {
        r.seq += 1;
        r.log.push(LogEntry { seq: r.seq, at: now_ms(), role, player_name, text: text.to_string(), verdict, detail, call: None });
        if r.log.len() > MAX_LOG {
            r.log.remove(0);
        }
    }

    // ---- views ------------------------------------------------------------------------------

    fn assessment_offset(&self) -> usize {
        self.scenarios.iter().filter(|s| s.phase != Phase::Assessment).count()
    }

    pub fn public_state(&self, connected: &dyn Fn(&str) -> bool, spectators: usize) -> PublicState {
        let offset = self.assessment_offset();
        let round = self.round.as_ref().map(|r| {
            let s = &self.scenarios[r.index];
            let reveal = s.phase != Phase::Assessment || r.status == RoundStatus::Done;
            let label = s.flow_label.clone().unwrap_or_else(|| {
                s.expected_flows.clone().unwrap_or_default().iter().map(|f| f.name()).collect::<Vec<_>>().join(" / ")
            });
            PublicRound {
                index: r.index,
                phase: s.phase,
                title: if reveal { s.title.clone() } else { format!("Scenario {}", r.index + 1 - offset) },
                text: s.text.clone(),
                flow_label: if reveal && !label.is_empty() { Some(label) } else { None },
                status: r.status,
                active_role: r.active_role,
                in_flight: r.in_flight.clone(),
                slips: r.slips.clone(),
                log: r.log.clone(),
                identify_submitted: r.guesses.iter().map(|(id, _)| id.clone()).collect(),
                tell_awarded_to: r.tell_awarded_to.clone(),
                seats: r.seats.clone(),
                result: r.result.clone(),
                flow_choices: if s.phase == Phase::Assessment { FLOWS.to_vec() } else { vec![] },
                tell_enabled: s.phase != Phase::Warmup && r.status != RoundStatus::Done,
            }
        });
        PublicState {
            room: self.room.clone(),
            keys: PublicKeys { application: self.keys.app.public_key.clone(), gateway: self.keys.gateway.public_key.clone() },
            started: self.started,
            players: self
                .players
                .iter()
                .map(|p| PublicPlayer {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    role: p.role,
                    connected: p.bot || connected(&p.id),
                    bot: p.bot,
                    is_host: self.host_id.as_deref() == Some(&p.id),
                    score: p.score.clone(),
                })
                .collect(),
            spectators,
            rounds: self
                .scenarios
                .iter()
                .enumerate()
                .map(|(i, s)| RoundSummary {
                    index: i,
                    phase: s.phase,
                    title: if s.phase == Phase::Assessment { format!("Assessment {}", i + 1 - offset) } else { s.title.clone() },
                })
                .collect(),
            round,
            host_id: self.host_id.clone(),
        }
    }

    pub fn private_view(&self, player_id: &str) -> PrivateView {
        let p = self.player(player_id);
        let r = self.round.as_ref();
        let role = r.and_then(|r| r.seats.role_of(player_id));
        let hand: Vec<Card> = match (r, role) {
            (Some(r), Some(role)) if r.status != RoundStatus::Done => r.hands.get(&role).cloned().unwrap_or_default(),
            _ => vec![],
        };
        let can_play = match (r, role) {
            (Some(r), Some(role)) => hand.iter().filter(|c| Self::playable(r, role, c)).map(|c| c.id.clone()).collect(),
            _ => vec![],
        };
        PrivateView {
            player_id: player_id.to_string(),
            name: p.map(|p| p.name.clone()).unwrap_or_default(),
            role: p.and_then(|p| p.role),
            is_host: self.host_id.as_deref() == Some(player_id),
            slips: match (r, role) {
                (Some(r), Some(role)) => r.held.get(&role).map(|h| h.iter().map(|x| x.token.clone()).collect()).unwrap_or_default(),
                _ => vec![],
            },
            my_guess: r.and_then(|r| r.guesses.iter().find(|(id, _)| id == player_id).map(|g| g.1)),
            can_play,
            hand,
        }
    }
}

/// One-line description of a slip in transit.
pub fn describe(f: &InFlight) -> String {
    let tok = |t: &Option<Token>| match t {
        Some(t) => format!(
            "{} (aud {}, scope {})",
            match t.kind {
                TokenKind::Id => "ID token",
                TokenKind::IdJag => "ID-JAG",
                TokenKind::Access => "token",
            },
            t.audience,
            t.scope.join(" ")
        ),
        None => "no token".into(),
    };
    match f {
        InFlight::Request { token, .. } => format!("Request + {}", tok(token)),
        InFlight::TokenRequest { audience, pkce, .. } => {
            format!("Authorization request (resource {audience}, {} PKCE)", if *pkce { "with" } else { "without" })
        }
        InFlight::Exchange { subject_token, requested_type, requested_audience, .. } => format!(
            "Exchange {} → {} for {requested_audience}",
            tok(subject_token),
            if *requested_type == RequestedType::IdJag { "ID-JAG" } else { "token" }
        ),
        InFlight::Assertion { assertion, .. } => format!("Signed assertion (iss {}, aud {})", assertion.iss, assertion.aud),
        InFlight::Introspect { .. } => "Is this token yours?".into(),
        InFlight::Call { credential, confirmed_by_idp, .. } => match credential {
            None => "Call with no credential".into(),
            Some(Credential::Bearer { token }) => {
                format!("Call + {}{}", tok(&Some(token.clone())), if *confirmed_by_idp { " (IdP says: minted by me)" } else { "" })
            }
            Some(Credential::ApiKey { key }) => format!("Call + API key ({})", if key.placement == Placement::Query { "in URL" } else { "header" }),
            Some(Credential::Sigv4 { .. }) => "Call signed with SigV4".into(),
            Some(Credential::GatewayJwt { jwt }) => format!("Call + gateway JWT (alg {})", if jwt.alg == Alg::None { "none" } else { "EdDSA" }),
            Some(Credential::AwsSecretBearer) => "Call + AWS secret key as bearer".into(),
        },
    }
}

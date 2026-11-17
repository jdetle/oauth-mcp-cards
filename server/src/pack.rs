//! Game packs. The series is one engine and one table; a game is a folder under `games/`:
//!
//!   games/<id>/game.json     what the game is called and what its four seats are
//!   games/<id>/rounds/*.json the rounds
//!
//! The OAuth game's rounds are rule-driven scenarios (`scenario.rs`, judged by `validate.rs`).
//! Every other game is *scripted*: each round spells out who acts, what is on the wire, which
//! values are sealed, which cards are right or wrong and why, and what an intruder might swap.
//! `script.rs` plays them.

use crate::scenario::Scenario;
use crate::types::*;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

pub const DEFAULT_GAME: &str = "oauth-mcp";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeatInfo {
    pub name: String,
    pub brief: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryEntry {
    pub term: String,
    pub means: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackInfo {
    pub id: String,
    pub order: i64,
    pub title: String,
    pub tagline: String,
    /// CSS colour for this game's accent
    pub accent: String,
    /// "rules" (the OAuth engine) or "scripted"
    #[serde(default)]
    pub engine: String,
    pub seats: BTreeMap<Role, SeatInfo>,
    #[serde(default)]
    pub teaches: Vec<String>,
    #[serde(default)]
    pub glossary: Vec<GlossaryEntry>,
}

#[derive(Clone, Debug)]
pub struct Pack {
    pub info: PackInfo,
    pub scenarios: Arc<Vec<Scenario>>,
}

impl Pack {
    pub fn scripted(&self) -> bool {
        self.scenarios.iter().any(|s| s.script.is_some())
    }
    pub fn seat_names(&self) -> SeatNames {
        let n = |r: Role| self.info.seats.get(&r).map(|s| s.name.clone()).unwrap_or_else(|| r.name().to_string());
        SeatNames { client: n(Role::Client), application: n(Role::Application), idp: n(Role::Idp), mcp: n(Role::Mcp) }
    }
    pub fn public(&self) -> PublicGame {
        let b = |r: Role| self.info.seats.get(&r).map(|s| s.brief.clone()).unwrap_or_default();
        PublicGame {
            id: self.info.id.clone(),
            title: self.info.title.clone(),
            accent: self.info.accent.clone(),
            seats: self.seat_names(),
            briefs: SeatNames { client: b(Role::Client), application: b(Role::Application), idp: b(Role::Idp), mcp: b(Role::Mcp) },
            scripted: self.scripted(),
        }
    }
}

pub type Packs = BTreeMap<String, Arc<Pack>>;

// ---------- scripted rounds ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardVerdict {
    Correct,
    Wrong,
    /// wrong, and a classic mistake worth naming at the end
    Trap,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptCard {
    pub label: String,
    /// shown on the card face, e.g. "send", "accept", "refuse"
    pub category: String,
    /// go (accept/issue), stop (refuse), send (pass something on)
    pub tone: Tone,
    pub verdict: CardVerdict,
    /// shown when this card is played and it was wrong
    #[serde(default)]
    pub why: Option<String>,
    /// a few words for the expected-vs-played chip (defaults to the label)
    #[serde(default)]
    pub chip: Option<String>,
    /// the step that follows a correct play, or "end"
    #[serde(default = "end")]
    pub next: String,
}

fn end() -> String {
    "end".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSpec {
    pub label: String,
    pub value: String,
    /// hidden until the receiver checks it
    #[serde(default)]
    pub sealed: bool,
    /// what the check card is called, e.g. "Check who this is addressed to"
    #[serde(default)]
    pub check: Option<String>,
    /// what the check reports when the value is genuine
    #[serde(default)]
    pub ok: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlipSpec {
    pub from: Role,
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    pub fields: Vec<FieldSpec>,
}

/// What an intruder swaps on this step's slip, some of the time. The sender did nothing wrong;
/// only the receiver's check on that field can tell.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntrusionSpec {
    pub field: String,
    pub value: String,
    /// what the check reports
    pub detail: String,
    /// label of the card that is now the right call (every other one is wrong)
    pub correct: String,
    /// shown to whoever trusted it
    pub why: String,
    /// revealed to the table at the end of the round
    pub reveal: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Temptation {
    pub label: String,
    /// shown when someone plays it
    pub why: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub actor: Role,
    /// optional cards that look helpful and aren't: playing one breaks the chain
    #[serde(default)]
    pub temptations: Vec<Temptation>,
    /// what arrived for the actor (none for a step that starts something)
    #[serde(default)]
    pub slip: Option<SlipSpec>,
    pub cards: Vec<ScriptCard>,
    #[serde(default)]
    pub intrusion: Option<IntrusionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub text: String,
    pub options: Vec<QuestionOption>,
    pub answer: String,
    pub why: String,
}

#[derive(Clone, Debug)]
pub struct Script {
    pub steps: Vec<Step>,
    pub question: Option<Question>,
    /// said when the chain holds
    pub held: String,
}

impl Script {
    pub fn step(&self, id: &str) -> Option<(usize, &Step)> {
        self.steps.iter().enumerate().find(|(_, s)| s.id == id)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScriptRound {
    id: String,
    order: i64,
    phase: Phase,
    title: String,
    text: String,
    /// one line shown when the round ends with the chain intact
    held: String,
    #[serde(default)]
    teaches: Vec<String>,
    #[serde(default)]
    discussion: Option<String>,
    #[serde(default)]
    question: Option<Question>,
    steps: Vec<Step>,
}

/// Parse and check one scripted round. Anything a player could get stuck on fails here.
pub fn parse_round(text: &str, file: &str) -> Result<Scenario, String> {
    let r: ScriptRound = serde_json::from_str(text).map_err(|e| format!("{file}: {e}"))?;
    let fail = |m: String| Err(format!("{file}: {m}"));
    for (k, v) in [("id", &r.id), ("title", &r.title), ("text", &r.text), ("held", &r.held)] {
        if v.trim().is_empty() {
            return fail(format!("\"{k}\" must not be empty"));
        }
    }
    if r.steps.is_empty() {
        return fail("needs at least one step".into());
    }
    let ids: Vec<&str> = r.steps.iter().map(|s| s.id.as_str()).collect();
    for (i, st) in r.steps.iter().enumerate() {
        let at = |m: String| Err(format!("{file}: step \"{}\": {m}", st.id));
        if ids.iter().filter(|x| **x == st.id).count() != 1 {
            return at("duplicate step id".into());
        }
        if st.cards.len() < 2 {
            return at("needs at least two cards (a choice)".into());
        }
        if st.cards.iter().filter(|c| c.verdict == CardVerdict::Correct).count() != 1 {
            return at("needs exactly one correct card".into());
        }
        for t in &st.temptations {
            if t.why.trim().len() < 20 {
                return at(format!("temptation \"{}\" doesn't say why it is a bad idea", t.label));
            }
        }
        let mut labels: Vec<&str> = st.cards.iter().map(|c| c.label.as_str()).chain(st.temptations.iter().map(|t| t.label.as_str())).collect();
        labels.sort();
        labels.dedup();
        if labels.len() != st.cards.len() + st.temptations.len() {
            return at("two cards share a label".into());
        }
        for c in &st.cards {
            if c.verdict != CardVerdict::Correct && c.why.as_deref().unwrap_or("").trim().len() < 20 {
                return at(format!("card \"{}\" is wrong but doesn't say why", c.label));
            }
            if c.verdict == CardVerdict::Correct && c.next != "end" {
                match ids.iter().position(|x| *x == c.next) {
                    None => return at(format!("card \"{}\": next \"{}\" is not a step", c.label, c.next)),
                    Some(j) if j <= i => return at(format!("card \"{}\": next must be a later step", c.label)),
                    _ => {}
                }
            }
        }
        if let Some(slip) = &st.slip {
            if slip.from == st.actor {
                return at("the slip is from the actor to themselves".into());
            }
            for f in &slip.fields {
                if f.sealed && (f.check.as_deref().unwrap_or("").is_empty() || f.ok.as_deref().unwrap_or("").is_empty()) {
                    return at(format!("sealed field \"{}\" needs \"check\" (the card's name) and \"ok\" (what it reports)", f.label));
                }
            }
        }
        if let Some(x) = &st.intrusion {
            let Some(slip) = &st.slip else { return at("an intrusion needs a slip to tamper with".into()) };
            match slip.fields.iter().find(|f| f.label == x.field) {
                None => return at(format!("intrusion field \"{}\" is not on the slip", x.field)),
                Some(f) if !f.sealed => return at(format!("intrusion field \"{}\" must be sealed (or everyone sees the swap)", x.field)),
                _ => {}
            }
            match st.cards.iter().find(|c| c.label == x.correct) {
                None => return at(format!("intrusion.correct \"{}\" is not one of the cards", x.correct)),
                Some(c) if c.verdict == CardVerdict::Correct => return at("intrusion.correct must differ from the normally correct card".into()),
                _ => {}
            }
            if r.phase == Phase::Warmup {
                return at("warm-ups have no intruder".into());
            }
        }
    }
    if r.steps[0].slip.is_some() && r.steps[0].slip.as_ref().is_some_and(|s| s.from == r.steps[0].actor) {
        return fail("first step is malformed".into());
    }
    if let Some(q) = &r.question {
        if r.phase != Phase::Assessment {
            return fail("only assessment rounds ask a question first".into());
        }
        if q.options.len() < 3 || !q.options.iter().any(|o| o.id == q.answer) {
            return fail("question needs 3+ options and an answer that is one of them".into());
        }
    }
    if r.phase != Phase::Warmup && r.teaches.is_empty() {
        return fail("learning and assessment rounds need \"teaches\"".into());
    }
    Ok(Scenario {
        id: r.id,
        order: r.order,
        phase: r.phase,
        title: r.title,
        flow_label: None,
        text: r.text,
        user_present: true,
        request: RequestSpec { action: String::new(), required_scope: String::new(), user_scoped: false, user: None },
        expected_flows: None,
        tokens: None,
        holders: None,
        hands: None,
        beats: None,
        idp_audiences: None,
        app_allowed_scopes: None,
        api_keys: None,
        trusts_gateway: false,
        refresh_token: false,
        tells: None,
        discussion: r.discussion,
        teaches: r.teaches,
        covers: vec![],
        script: Some(Arc::new(Script { steps: r.steps, question: r.question, held: r.held })),
    })
}

fn json_files(dir: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("can't read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort();
    Ok(files)
}

/// Load one game folder.
pub fn load_pack(dir: &Path) -> Result<Pack, String> {
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let info_text = std::fs::read_to_string(dir.join("game.json")).map_err(|e| format!("{name}/game.json: {e}"))?;
    let info: PackInfo = serde_json::from_str(&info_text).map_err(|e| format!("{name}/game.json: {e}"))?;
    if info.id != name {
        return Err(format!("{name}/game.json: id \"{}\" must match the folder name", info.id));
    }
    for role in ROLES {
        if info.seats.get(&role).is_none_or(|s| s.name.trim().is_empty() || s.brief.trim().is_empty()) {
            return Err(format!("{name}/game.json: seat \"{}\" needs a name and a brief", role.aud()));
        }
    }
    let rounds = dir.join("rounds");
    let scenarios = if info.engine == "rules" {
        crate::scenario::load_dir(&rounds)?
    } else {
        let mut out: Vec<Scenario> = vec![];
        for f in json_files(&rounds)? {
            let file = format!("{name}/rounds/{}", f.file_name().unwrap().to_string_lossy());
            let text = std::fs::read_to_string(&f).map_err(|e| format!("{file}: {e}"))?;
            let s = parse_round(&text, &file)?;
            if out.iter().any(|o| o.id == s.id) {
                return Err(format!("{file}: duplicate id \"{}\"", s.id));
            }
            out.push(s);
        }
        if out.is_empty() {
            return Err(format!("{name}: no rounds"));
        }
        out.sort_by_key(|s| s.order);
        out
    };
    Ok(Pack { info, scenarios: Arc::new(scenarios) })
}

/// Load every game under `dir`. A broken pack stops the server from starting: better than a
/// table that gets stuck mid-round.
pub fn load_all(dir: &Path) -> Result<Packs, String> {
    let mut packs = Packs::new();
    let mut dirs: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("can't read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("game.json").is_file())
        .collect();
    dirs.sort();
    for d in dirs {
        let p = load_pack(&d)?;
        packs.insert(p.info.id.clone(), Arc::new(p));
    }
    if !packs.contains_key(DEFAULT_GAME) {
        return Err(format!("{}: the \"{DEFAULT_GAME}\" game is missing", dir.display()));
    }
    Ok(packs)
}

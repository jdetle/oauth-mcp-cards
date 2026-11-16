//! Engine, scoring and fuzz tests (validation rule tests live in validate.rs).
use crate::engine::*;
use crate::scenario::load_dir;
use crate::server::{apply, parse_client_message};
use crate::types::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const NOW: i64 = 1_800_000_000_000;

fn scenarios() -> Arc<Vec<crate::scenario::Scenario>> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scenarios");
    Arc::new(load_dir(&dir).expect("scenarios load"))
}

struct T {
    g: Game,
    ids: [String; 4], // client, application, idp, mcp at the start
}

fn new_game() -> T {
    let counter = Arc::new(AtomicU64::new(0));
    let mut g = Game::new("test-room", scenarios()).with_clock(|| NOW, move || format!("id{}", counter.fetch_add(1, Ordering::Relaxed)));
    let ids = ROLES.map(|r| g.add_player(r.aud(), Some(r), false).id);
    T { g, ids }
}

fn index_of(g: &Game, id: &str) -> u32 {
    g.scenarios.iter().position(|s| s.id == id).expect("scenario") as u32
}

fn active(g: &Game) -> String {
    let r = g.round.as_ref().unwrap();
    r.seats.get(r.active_role.unwrap()).unwrap().clone()
}

/// Try every playable card on a clone; return the first that isn't a mistake.
fn best_card(g: &Game) -> String {
    let pid = active(g);
    let v = g.private_view(&pid);
    let cands: Vec<&Card> = v.hand.iter().filter(|c| v.can_play.contains(&c.id) && !c.card_type.is_free()).collect();
    for c in &cands {
        let mut copy = g.clone();
        copy.play(&pid, &c.id).unwrap();
        let r = copy.round.as_ref().unwrap();
        if r.moves.last().unwrap().correct != Some(false) && !(r.status == RoundStatus::Done && !r.result.as_ref().unwrap().success) {
            return c.id.clone();
        }
    }
    panic!("no good card in {}: {:?}", g.scenarios[g.round.as_ref().unwrap().index].id, cands.iter().map(|c| &c.label).collect::<Vec<_>>());
}

fn solve(g: &mut Game) {
    if g.round.as_ref().unwrap().status == RoundStatus::Identify {
        let flow = g.scenarios[g.round.as_ref().unwrap().index].expected_flows.as_ref().unwrap()[0];
        for role in ROLES {
            let r = g.round.as_ref().unwrap();
            let id = r.seats.get(role).unwrap().clone();
            if !r.guesses.iter().any(|(g2, _)| *g2 == id) {
                g.identify(&id, flow).unwrap();
            }
        }
    }
    for _ in 0..30 {
        if g.round.as_ref().unwrap().status != RoundStatus::Playing {
            break;
        }
        let pid = active(g);
        let c = best_card(g);
        g.play(&pid, &c).unwrap();
    }
}

fn card_by_label(g: &Game, text: &str) -> (String, String) {
    let pid = active(g);
    let v = g.private_view(&pid);
    let c = v.hand.iter().find(|c| c.label.contains(text)).unwrap_or_else(|| panic!("no card {text}: {:?}", v.hand.iter().map(|h| &h.label).collect::<Vec<_>>()));
    (pid, c.id.clone())
}

fn play_label(g: &mut Game, text: &str) {
    let (p, c) = card_by_label(g, text);
    g.play(&p, &c).unwrap();
}

#[test]
fn every_scenario_has_an_unbroken_chain() {
    let t = new_game();
    for i in 0..t.g.scenarios.len() {
        let mut t = new_game();
        let host = t.ids[0].clone();
        t.g.host_action(&host, HostAction::Goto, Some(i as u32)).unwrap();
        solve(&mut t.g);
        let r = t.g.round.as_ref().unwrap();
        assert_eq!(r.status, RoundStatus::Done, "{}", t.g.scenarios[i].id);
        assert!(r.result.as_ref().unwrap().success, "{} not solvable", t.g.scenarios[i].id);
    }
}

#[test]
fn obo_correct_play_scores_each_role() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "scope calendar.read)");
    play_label(&mut t.g, "Issue");
    play_label(&mut t.g, "Accept");
    assert!(t.g.round.as_ref().unwrap().result.as_ref().unwrap().success);
    for id in &t.ids {
        assert_eq!(t.g.player(id).unwrap().score.calls, 1);
    }
}

#[test]
fn obo_forwarding_breaks_chain_and_mcp_scores_reject() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "Forward the token");
    assert_eq!(t.g.round.as_ref().unwrap().active_role, Some(Role::Mcp));
    play_label(&mut t.g, "Reject");
    let res = t.g.round.as_ref().unwrap().result.clone().unwrap();
    assert!(!res.success);
    assert_eq!(res.failed_step.unwrap().role, Role::Application);
    assert!(res.explanation.contains("exchange, not relay"));
    assert_eq!(t.g.player(&t.ids[3]).unwrap().score.calls, 1);
    assert_eq!(t.g.player(&t.ids[1]).unwrap().score.calls, 0);
}

#[test]
fn over_broad_exchange_idp_rejects() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "scope calendar.*)");
    play_label(&mut t.g, "Reject");
    let res = t.g.round.as_ref().unwrap().result.clone().unwrap();
    assert!(!res.success);
    assert!(res.explanation.contains("consented"));
    assert_eq!(t.g.player(&t.ids[2]).unwrap().score.calls, 1);
    assert!(res.traps[0].contains("trap"));
}

#[test]
fn app_subject_on_user_data_is_rejected_by_mcp() {
    let mut t = new_game();
    let i = index_of(&t.g, "assess-inbox");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    for id in t.ids.clone() {
        t.g.identify(&id, Flow::Jag).unwrap();
    }
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "Signed Assertion: JWT signed with your private key, audience = IdP");
    play_label(&mut t.g, "Issue");
    play_label(&mut t.g, "Reject");
    let r = t.g.round.as_ref().unwrap();
    assert!(!r.result.as_ref().unwrap().success);
    assert!(r.result.as_ref().unwrap().guesses.iter().all(|g| !g.correct));
}

#[test]
fn idp_bonus_for_refusing_wrong_flow() {
    let mut t = new_game();
    let i = index_of(&t.g, "assess-inbox");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    for id in t.ids.clone() {
        t.g.identify(&id, Flow::Obo).unwrap();
    }
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "Signed Assertion: JWT signed with your private key, audience = IdP");
    play_label(&mut t.g, "Reject");
    let idp = t.g.player(&t.ids[2]).unwrap();
    assert_eq!((idp.score.calls, idp.score.identify, idp.score.bonus), (1, 1, 1));
}

#[test]
fn guesses_private_until_round_ends() {
    let mut t = new_game();
    let i = index_of(&t.g, "assess-archive");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    t.g.identify(&t.ids[0].clone(), Flow::Obo).unwrap();
    let pub_state = t.g.public_state(&|_| true, 0);
    let mut round = serde_json::to_value(pub_state.round.as_ref().unwrap()).unwrap();
    round["flowChoices"] = serde_json::json!([]);
    assert!(!round.to_string().contains("\"obo\""));
    assert!(!serde_json::to_string(&pub_state).unwrap().contains("Archive"));
    assert!(pub_state.round.as_ref().unwrap().flow_label.is_none());
    let card = t.g.private_view(&t.ids[0]).hand[0].id.clone();
    assert!(t.g.play(&t.ids[0].clone(), &card).is_err());
    solve(&mut t.g);
    let res = t.g.round.as_ref().unwrap().result.clone().unwrap();
    assert!(!res.guesses.iter().find(|g| g.player_id == t.ids[0]).unwrap().correct);
    assert_eq!(t.g.player(&t.ids[3]).unwrap().score.identify, 1);
}

#[test]
fn spot_the_tell() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-jag");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    t.g.tell(&t.ids[2].clone()).unwrap();
    assert!(t.g.tell(&t.ids[3].clone()).is_err());
    assert_eq!(t.g.player(&t.ids[2]).unwrap().score.bonus, 1);
    assert_eq!(t.g.player(&t.ids[3]).unwrap().score.bonus, 0);

    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    t.g.tell(&t.ids[2].clone()).unwrap();
    assert_eq!(t.g.player(&t.ids[2]).unwrap().score.bonus, 0);
}

#[test]
fn seats_rotate_and_full_game_runs() {
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.start(&host).unwrap();
    solve(&mut t.g);
    t.g.host_action(&host, HostAction::Next, None).unwrap();
    assert_eq!(t.g.player(&t.ids[0]).unwrap().role, Some(Role::Application));
    assert_eq!(t.g.player(&t.ids[3]).unwrap().role, Some(Role::Client));
    for i in 1..t.g.scenarios.len() {
        if i > 1 {
            t.g.host_action(&host, HostAction::Next, None).unwrap();
        }
        solve(&mut t.g);
        assert!(t.g.round.as_ref().unwrap().result.as_ref().unwrap().success);
    }
    assert!(t.g.host_action(&host, HostAction::Next, None).is_err());
}

#[test]
fn refuses_out_of_turn_forged_and_non_host() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    let mcp_card = t.g.private_view(&t.ids[3]).hand[0].id.clone();
    assert_eq!(t.g.play(&t.ids[3].clone(), &mcp_card).unwrap_err().0, "It is not your turn.");
    assert_eq!(t.g.play(&t.ids[0].clone(), &mcp_card).unwrap_err().0, "No such card in your hand.");
    assert_eq!(t.g.play(&t.ids[0].clone(), "forged").unwrap_err().0, "No such card in your hand.");
    assert!(t.g.host_action(&t.ids[3].clone(), HostAction::Next, None).unwrap_err().0.contains("host"));
}

#[test]
fn private_view_only_own_hand_never_traps() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    let mine = t.g.private_view(&t.ids[1]);
    assert!(mine.hand.len() > 3);
    let json = serde_json::to_string(&mine).unwrap();
    assert!(!json.contains("\"trap\""));
    for (k, id) in t.ids.iter().enumerate() {
        if k == 1 {
            continue;
        }
        for c in t.g.private_view(id).hand {
            assert!(!mine.hand.iter().any(|m| m.id == c.id));
        }
    }
    let public = serde_json::to_string(&t.g.public_state(&|_| true, 0)).unwrap();
    assert!(!public.contains(&mine.hand[0].id));
}

#[test]
fn need_four_seats() {
    let mut t = new_game();
    t.g.players[3].role = None;
    let host = t.ids[0].clone();
    assert!(t.g.start(&host).unwrap_err().0.contains("Need all four seats"));
}

#[test]
fn wire_format_matches_typescript() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    let v = serde_json::to_value(t.g.public_state(&|_| true, 0)).unwrap();
    let f = &v["round"]["inFlight"];
    assert_eq!(f["kind"], "request");
    assert_eq!(f["token"]["subjectType"], "user");
    assert_eq!(f["request"]["requiredScope"], "calendar.read");
    assert_eq!(v["round"]["activeRole"], "application");
    let you = serde_json::to_value(t.g.private_view(&t.ids[1])).unwrap();
    assert!(you["canPlay"].is_array());
    assert_eq!(you["hand"][0]["type"], "forward");
    assert_eq!(you["hand"][0]["category"], "Request");
}

// ---- fuzz --------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() % xs.len() as u64) as usize]
    }
}

fn junk(rng: &mut Rng, cards: &[String]) -> String {
    let t = *rng.pick(&["play", "sit", "identify", "host", "tell", "start", "stand", "ping", "nope", ""]);
    let card = cards.first().cloned().unwrap_or_else(|| "x".into());
    let variants = [
        format!(r#"{{"t":"{t}","cardId":"{}"}}"#, rng.pick(&[card.as_str(), "forged", "", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"])),
        format!(r#"{{"t":"{t}","cardId":42}}"#),
        format!(r#"{{"t":"{t}","role":"{}"}}"#, rng.pick(&["client", "application", "idp", "mcp", "admin", ""])),
        format!(r#"{{"t":"{t}","flow":"{}"}}"#, rng.pick(&["obo", "jag", "OBO", "__proto__"])),
        format!(r#"{{"t":"host","action":"{}","round":{}}}"#, rng.pick(&["next", "replay", "goto", "forceReveal", "delete"]), rng.pick(&["0", "3", "-1", "1.5", "9999", "\"1\""])),
        format!(r#"{{"t":"play","cardId":"{card}","extra":1}}"#),
        r#"{"t":"play","__proto__":{"admin":true},"cardId":"x"}"#.to_string(),
        "[1,2,3]".to_string(),
        "{".repeat((rng.next() % 500) as usize),
        format!(r#"{{"t":"play","cardId":"a"}}{}"#, "x".repeat(2000)),
        "null".to_string(),
        (0..(rng.next() % 200)).map(|_| char::from_u32((rng.next() % 0xd7ff) as u32).unwrap_or('?')).collect(),
    ];
    rng.pick(&variants).clone()
}

#[test]
fn fuzz_parser_never_panics_and_is_strict() {
    let mut rng = Rng(0x9e3779b97f4a7c15);
    for _ in 0..20_000 {
        let raw = junk(&mut rng, &["c1".into()]);
        let _ = parse_client_message(&raw);
    }
    assert!(parse_client_message(r#"{"t":"play","cardId":"x","extra":1}"#).is_none());
    assert!(parse_client_message(r#"{"t":"host","action":"goto","round":-1}"#).is_none());
    assert!(parse_client_message(r#"{"t":"host","action":"goto","round":1.5}"#).is_none());
    assert!(parse_client_message(r#"{"t":"sit","role":"admin"}"#).is_none());
    assert_eq!(parse_client_message(r#"{"t":"play","cardId":"abc"}"#), Some(ClientMessage::Play { card_id: "abc".into() }));
    assert_eq!(
        parse_client_message(r#"{"t":"host","action":"goto","round":3}"#),
        Some(ClientMessage::Host { action: HostAction::Goto, round: Some(3) })
    );
}

#[test]
fn fuzz_engine_survives_random_input_and_keeps_invariants() {
    let mut rng = Rng(0xdeadbeefcafef00d);
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.start(&host).unwrap();
    let mut ids: Vec<String> = t.ids.to_vec();
    ids.push("ghost".into());
    let mut refused = 0;
    for _ in 0..20_000 {
        let who = rng.pick(&ids).clone();
        let view = t.g.private_view(&who);
        let raw = if rng.next() % 2 == 0 && !view.can_play.is_empty() {
            format!(r#"{{"t":"play","cardId":"{}"}}"#, rng.pick(&view.can_play))
        } else {
            junk(&mut rng, &view.hand.iter().map(|c| c.id.clone()).collect::<Vec<_>>())
        };
        if let Some(m) = parse_client_message(&raw) {
            if apply(&mut t.g, &who, m).is_err() {
                refused += 1;
            }
        }
        let roles: Vec<Role> = t.g.players.iter().filter_map(|p| p.role).collect();
        let mut dedup = roles.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(dedup.len(), roles.len(), "two players in one seat");
        if let Some(r) = &t.g.round {
            let all: Vec<&String> = r.hands.values().flatten().map(|c| &c.id).collect();
            let mut d = all.clone();
            d.sort();
            d.dedup();
            assert_eq!(d.len(), all.len(), "duplicate card ids");
        }
    }
    assert!(refused > 0);
}

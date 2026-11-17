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

// ---- sims ---------------------------------------------------------------------------------------

#[test]
fn sims_fill_empty_seats_and_finish_a_round() {
    let counter = Arc::new(AtomicU64::new(0));
    let mut g = Game::new("solo", scenarios()).with_clock(|| NOW, move || format!("id{}", counter.fetch_add(1, Ordering::Relaxed)));
    let me = g.add_player("Solo", Some(Role::Client), false).id;
    assert!(g.start(&me).is_err(), "can't start with empty seats");
    g.host_action(&me, HostAction::AddBots, None).unwrap();
    assert_eq!(g.seated_roles().len(), 4);
    assert_eq!(g.players.iter().filter(|p| p.bot).count(), 3);
    assert!(g.host_action(&me, HostAction::AddBots, None).is_err(), "no empty seats left");
    // perfect sims + a perfect human finish every learning round with an unbroken chain
    for i in 3..13 {
        g.host_action(&me, HostAction::Goto, Some(i)).unwrap();
        for _ in 0..40 {
            let r = g.round.as_ref().unwrap();
            if r.status == RoundStatus::Done {
                break;
            }
            if let Some(sim) = g.next_sim() {
                let m = g.sim_choice(&sim, 1.0).expect("sim has a move");
                apply(&mut g, &sim, m).unwrap();
            } else {
                let pid = active(&g);
                assert_eq!(pid, me);
                let c = best_card(&g);
                g.play(&pid, &c).unwrap();
            }
        }
        let r = g.round.as_ref().unwrap();
        assert_eq!(r.status, RoundStatus::Done);
        assert!(r.result.as_ref().unwrap().success, "{}", g.scenarios[i as usize].id);
    }
}

#[test]
fn humans_take_over_sim_seats_and_host_removes_sims() {
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.players.retain(|p| p.id == host); // only the host is left
    t.g.host_action(&host, HostAction::AddBots, None).unwrap();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&host, HostAction::Goto, Some(i)).unwrap();
    // a human joins mid-round and takes the IdP seat from its sim
    let bob = t.g.add_player("Bob", Some(Role::Idp), false);
    assert_eq!(bob.role, Some(Role::Idp));
    assert_eq!(t.g.round.as_ref().unwrap().seats.idp.as_deref(), Some(bob.id.as_str()));
    assert_eq!(t.g.players.iter().filter(|p| p.bot).count(), 2);
    assert!(!t.g.private_view(&bob.id).hand.is_empty(), "inherits the sim's hand");
    // sims can't be removed mid-round, or by non-hosts
    assert!(t.g.host_action(&host, HostAction::RemoveBots, None).is_err());
    solve(&mut t.g);
    assert!(t.g.host_action(&bob.id, HostAction::RemoveBots, None).is_err());
    t.g.host_action(&host, HostAction::RemoveBots, None).unwrap();
    assert_eq!(t.g.players.iter().filter(|p| p.bot).count(), 0);
}

#[test]
fn sims_are_marked_on_the_wire() {
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.players.retain(|p| p.id == host);
    t.g.host_action(&host, HostAction::AddBots, None).unwrap();
    let v = serde_json::to_value(t.g.public_state(&|_| false, 0)).unwrap();
    let players = v["players"].as_array().unwrap();
    assert_eq!(players.iter().filter(|p| p["bot"] == true).count(), 3);
    assert!(players.iter().filter(|p| p["bot"] == true).all(|p| p["connected"] == true));
    assert!(parse_client_message(r#"{"t":"host","action":"addBots"}"#).is_some());
}

#[test]
fn only_public_keys_are_ever_sent() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-jag");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    solve(&mut t.g);
    let public = serde_json::to_string(&t.g.public_state(&|_| true, 0)).unwrap();
    assert!(public.contains(&t.g.keys.app.public_key));
    assert!(public.contains(&t.g.keys.gateway.public_key));
    for secret in [&t.g.keys.app.secret_key, &t.g.keys.gateway.secret_key, &t.g.keys.sigv4_secret] {
        assert!(!public.contains(secret.as_str()), "a private key leaked into public state");
        for id in &t.ids {
            assert!(!serde_json::to_string(&t.g.private_view(id)).unwrap().contains(secret.as_str()));
        }
    }
}

#[test]
fn finished_rounds_are_archived_for_the_timeline() {
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.start(&host).unwrap();
    solve(&mut t.g);
    assert!(t.g.archive.is_empty());
    t.g.host_action(&host, HostAction::Next, None).unwrap();
    solve(&mut t.g);
    t.g.host_action(&host, HostAction::Goto, Some(index_of(&t.g, "assess-archive"))).unwrap();
    assert_eq!(t.g.archive.len(), 2);
    assert_eq!(t.g.archive[0].index, 0);
    assert_eq!(t.g.archive[0].success, Some(true));
    assert!(t.g.archive[0].log.iter().any(|l| l.role.is_some()), "moves are kept");
    assert!(t.g.archive[0].log.iter().all(|l| l.at > 0), "entries are timestamped");
    // an abandoned assessment round is archived without leaking its real title
    solve(&mut t.g);
    t.g.host_action(&host, HostAction::Replay, None).unwrap();
    let last = t.g.archive.last().unwrap();
    assert!(last.title.starts_with("Assessment "));
    assert!(!serde_json::to_string(last.as_ref()).unwrap().contains("Archive"));
}

// ---- expected vs played ---------------------------------------------------------------------

fn last_call(g: &Game) -> Call {
    g.round.as_ref().unwrap().log.iter().rev().find_map(|l| l.call.clone()).expect("a judged move")
}

#[test]
fn a_correct_reject_is_stop_equals_stop() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    let c = last_call(&t.g);
    assert!(c.matched && c.played.tone == Tone::Send && c.expected == c.played);
    // the Application forwards the raw token: expected the exchange, played the forward
    play_label(&mut t.g, "Forward the token");
    let c = last_call(&t.g);
    assert!(!c.matched);
    assert_eq!((c.expected.label.as_str(), c.played.label.as_str()), ("Exchange (OBO)", "Forward the token"));
    // the MCP Server rejects it: a red action that is exactly what was expected
    play_label(&mut t.g, "Reject");
    let c = last_call(&t.g);
    assert!(c.matched);
    assert_eq!(c.expected, Chip { label: "Reject".into(), tone: Tone::Stop });
    assert_eq!(c.played, Chip { label: "Reject".into(), tone: Tone::Stop });
}

#[test]
fn accepting_something_invalid_is_go_versus_stop() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "Forward the token");
    play_label(&mut t.g, "Accept");
    let c = last_call(&t.g);
    assert!(!c.matched);
    assert_eq!((c.expected.tone, c.played.tone), (Tone::Stop, Tone::Go));
}

#[test]
fn right_kind_of_call_with_a_defect_names_the_defect() {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "scope calendar.*)");
    let c = last_call(&t.g);
    assert!(!c.matched);
    assert_eq!(c.expected.label, "Exchange (OBO)");
    assert_eq!(c.played.label, "Exchange (OBO) · scope beyond consent");
}

#[test]
fn every_correct_move_matches_and_every_wrong_move_does_not() {
    // across all scenarios with perfect play: matched everywhere
    for i in 0..new_game().g.scenarios.len() {
        let mut t = new_game();
        t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i as u32)).unwrap();
        solve(&mut t.g);
        let r = t.g.round.as_ref().unwrap();
        for l in r.log.iter().filter(|l| l.call.is_some()) {
            let c = l.call.as_ref().unwrap();
            assert_eq!(c.matched, l.verdict != Verdict::Incorrect, "{}: {:?}", t.g.scenarios[i].id, c);
            assert!(c.matched, "{}: perfect play should always match: {:?}", t.g.scenarios[i].id, c);
        }
    }
}

#[test]
fn a_perfect_sim_rejects_what_a_human_got_wrong() {
    for _ in 0..20 {
        let mut t = new_game();
        let host = t.ids[0].clone();
        t.g.players.retain(|p| p.id == host);
        t.g.host_action(&host, HostAction::AddBots, None).unwrap();
        t.g.host_action(&host, HostAction::Goto, Some(index_of(&t.g, "learning-obo"))).unwrap();
        // the human Client skips the Application; the MCP Server sim must reject, never accept
        play_label(&mut t.g, "Skip the Application");
        for _ in 0..6 {
            let Some(sim) = t.g.next_sim() else { break };
            let m = t.g.sim_choice(&sim, 1.0).unwrap();
            apply(&mut t.g, &sim, m).unwrap();
        }
        let r = t.g.round.as_ref().unwrap();
        assert_eq!(r.status, RoundStatus::Done);
        let mcp = r.moves.iter().rev().find(|m| m.role == Role::Mcp).unwrap();
        assert_eq!(mcp.correct, Some(true), "sim played: {}", mcp.label);
    }
}

// ---- base path and edge-signed visitor address ------------------------------------------------

#[test]
fn base_path_is_normalized_and_validated() {
    use crate::server::normalize_base_path as n;
    assert_eq!(n("/mcp-oauth"), "/mcp-oauth");
    assert_eq!(n("mcp-oauth/"), "/mcp-oauth");
    assert_eq!(n("/a/b_c"), "/a/b_c");
    for bad in ["", "/", "//", "/a//b", "/a b", "/../etc", "/a?x", "/<script>"] {
        assert_eq!(n(bad), "", "{bad:?} should mean site root");
    }
}

#[test]
fn edge_signed_visitor_address_verifies_and_resists_forgery() {
    use crate::crypto::{ed_sign, new_key_pair};
    use crate::server::edge_ip;
    use axum::http::{HeaderMap, HeaderValue};
    let kp = new_key_pair();
    let now = 1_800_000_000_000i64;
    let make = |ip: &str, ts: i64, secret: &str| {
        let mut h = HeaderMap::new();
        h.insert("x-edge-ip", HeaderValue::from_str(ip).unwrap());
        h.insert("x-edge-ts", HeaderValue::from_str(&ts.to_string()).unwrap());
        h.insert("x-edge-sig", HeaderValue::from_str(&ed_sign(&format!("{ts}.{ip}"), secret)).unwrap());
        h
    };
    assert_eq!(edge_ip(&make("203.0.113.9", now, &kp.secret_key), &kp.public_key, now).as_deref(), Some("203.0.113.9"));
    // signed by someone else
    assert_eq!(edge_ip(&make("203.0.113.9", now, &new_key_pair().secret_key), &kp.public_key, now), None);
    // a captured header replayed later
    assert_eq!(edge_ip(&make("203.0.113.9", now - 600_000, &kp.secret_key), &kp.public_key, now), None);
    // the address swapped after signing
    let mut h = make("203.0.113.9", now, &kp.secret_key);
    h.insert("x-edge-ip", HeaderValue::from_static("198.51.100.1"));
    assert_eq!(edge_ip(&h, &kp.public_key, now), None);
    // no headers at all
    assert_eq!(edge_ip(&HeaderMap::new(), &kp.public_key, now), None);
}

#[test]
fn paths_route_correctly_under_a_base_path() {
    use crate::server::route_under_base as r;
    let b = "/mcp-oauth";
    assert_eq!(r("/mcp-oauth/", b), "/");
    assert_eq!(r("/mcp-oauth/play/", b), "/play/");
    assert_eq!(r("/mcp-oauth/api/rooms", b), "/api/rooms");
    assert_eq!(r("/mcp-oauth/ws/amber-falcon", b), "/ws/amber-falcon");
    assert_eq!(r("/", b), "/__omcp_root");
    assert_eq!(r("/mcp-oauth", b), "/__omcp_root");
    assert_eq!(r("/api/health", b), "/api/health");
    assert_eq!(r("/api/rooms", b), "/__omcp_outside");
    assert_eq!(r("/mcp-oauthx/secret", b), "/__omcp_outside");
    assert_eq!(r("/anything", ""), "/anything");
}

// ---- ready check between rounds ---------------------------------------------------------------

/// A game with a settable clock: two humans (client, application) and two sims.
fn ready_game() -> (Game, Arc<std::sync::atomic::AtomicI64>, String, String) {
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(NOW));
    let c = clock.clone();
    let counter = Arc::new(AtomicU64::new(0));
    let mut g = Game::new("ready", scenarios()).with_clock(move || c.load(Ordering::Relaxed), move || format!("id{}", counter.fetch_add(1, Ordering::Relaxed)));
    let a = g.add_player("Ann", Some(Role::Client), false).id;
    let b = g.add_player("Ben", Some(Role::Application), false).id;
    g.host_action(&a, HostAction::AddBots, None).unwrap();
    g.start(&a).unwrap();
    solve(&mut g);
    (g, clock, a, b)
}

#[test]
fn ready_check_opens_when_a_round_ends() {
    let (g, _, a, b) = ready_game();
    let r = g.round.as_ref().unwrap();
    assert_eq!(r.status, RoundStatus::Done);
    assert_eq!(r.ready_deadline, Some(NOW + 60_000));
    let mut req = g.ready_required();
    req.sort();
    let mut want = vec![a.clone(), b.clone()];
    want.sort();
    assert_eq!(req, want, "only the humans are waited for, not the sims");
    let v = g.ready_view(&|_| true).unwrap();
    assert_eq!(v.remaining_ms, 60_000);
    assert_eq!(v.waiting.len(), 2);
}

#[test]
fn everyone_ready_moves_on_and_rotates_seats() {
    let (mut g, _, a, b) = ready_game();
    let online = |_: &str| true;
    g.set_ready(&a, true).unwrap();
    assert_eq!(g.ready_outcome(&online), None, "still waiting for Ben");
    g.set_ready(&b, true).unwrap();
    assert_eq!(g.ready_outcome(&online), Some(ReadyAdvance::AllReady));
    g.advance_after_ready(ReadyAdvance::AllReady).unwrap();
    let r = g.round.as_ref().unwrap();
    assert_eq!(r.index, 1);
    assert_eq!(r.ready_deadline, None);
    assert_eq!(g.player(&a).unwrap().role, Some(Role::Application), "seats rotated");
    assert!(g.archive.last().unwrap().log.iter().any(|l| l.text.contains("Everyone's ready")));
}

#[test]
fn a_minute_of_inactivity_moves_on_and_each_click_restarts_it() {
    let (g0, clock, a, _b) = ready_game();
    let mut g = g0;
    let online = |_: &str| true;
    clock.store(NOW + 50_000, Ordering::Relaxed);
    assert_eq!(g.ready_outcome(&online), None);
    // a click 50s in restarts the minute
    g.set_ready(&a, true).unwrap();
    assert_eq!(g.round.as_ref().unwrap().ready_deadline, Some(NOW + 110_000));
    clock.store(NOW + 70_000, Ordering::Relaxed);
    assert_eq!(g.ready_outcome(&online), None, "the click bought another minute");
    // changing your mind is activity too
    g.set_ready(&a, false).unwrap();
    assert_eq!(g.round.as_ref().unwrap().ready_deadline, Some(NOW + 130_000));
    clock.store(NOW + 130_000, Ordering::Relaxed);
    assert_eq!(g.ready_outcome(&online), Some(ReadyAdvance::Idle));
    g.advance_after_ready(ReadyAdvance::Idle).unwrap();
    assert_eq!(g.round.as_ref().unwrap().index, 1);
    assert!(g.archive.last().unwrap().log.iter().any(|l| l.text.contains("No one moved for 60 seconds")));
}

#[test]
fn disconnected_humans_are_not_waited_for_and_an_empty_table_pauses() {
    let (mut g, clock, a, b) = ready_game();
    // Ben has left: Ann alone readying is enough
    let only_ann = |id: &str| id == a;
    g.set_ready(&a, true).unwrap();
    assert_eq!(g.ready_outcome(&only_ann), Some(ReadyAdvance::AllReady));
    let v = g.ready_view(&only_ann).unwrap();
    assert_eq!(v.away, vec![b.clone()]);
    // nobody connected: never moves on, even long after the deadline
    clock.store(NOW + 10 * 60_000, Ordering::Relaxed);
    assert_eq!(g.ready_outcome(&|_| false), None);
}

#[test]
fn only_players_at_the_table_can_ready_and_only_between_rounds() {
    let (mut g, _, _a, _b) = ready_game();
    let sim = g.players.iter().find(|p| p.bot).unwrap().id.clone();
    assert!(g.set_ready(&sim, true).is_err());
    let watcher = g.add_player("Wat", None, true).id;
    assert!(g.set_ready(&watcher, true).is_err());
    assert!(g.set_ready("ghost", true).is_err());
    // mid-round there is nothing to ready for
    let host = g.host_id.clone().unwrap();
    g.host_action(&host, HostAction::Replay, None).unwrap();
    let a = g.ready_required()[0].clone();
    assert!(g.set_ready(&a, true).is_err());
}

#[test]
fn no_ready_check_after_the_last_round() {
    let (mut g, _, a, _) = ready_game();
    let last = g.scenarios.len() as u32 - 1;
    g.host_action(&a, HostAction::Goto, Some(last)).unwrap();
    solve(&mut g);
    assert_eq!(g.round.as_ref().unwrap().ready_deadline, None);
    assert!(g.ready_view(&|_| true).is_none());
}

#[test]
fn ready_message_parses_strictly() {
    assert_eq!(parse_client_message(r#"{"t":"ready","ready":true}"#), Some(ClientMessage::Ready { ready: true }));
    assert!(parse_client_message(r#"{"t":"ready"}"#).is_none());
    assert!(parse_client_message(r#"{"t":"ready","ready":"yes"}"#).is_none());
    assert!(parse_client_message(r#"{"t":"ready","ready":true,"who":"x"}"#).is_none());
}

// ---- required vs optional: sealed tokens, checks, diligence, intruders --------------------------

/// Get the OBO round to the MCP Server's decision, optionally with an intruder at work.
fn obo_at_mcp(intruder: Option<(Role, Defect)>) -> T {
    let mut t = new_game();
    let i = index_of(&t.g, "learning-obo");
    t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
    if let Some((role, defect)) = intruder {
        t.g.plant_intrusion(role, defect);
    }
    play_label(&mut t.g, "with the user's token slip");
    play_label(&mut t.g, "scope calendar.read)");
    play_label(&mut t.g, "Issue");
    assert_eq!(t.g.round.as_ref().unwrap().active_role, Some(Role::Mcp));
    t
}

fn last_diligence(g: &Game) -> Diligence {
    g.round.as_ref().unwrap().log.iter().rev().find_map(|l| l.diligence.clone()).expect("a diligence tag")
}

#[test]
fn receivers_hold_every_optional_check_after_the_warm_ups() {
    let t = obo_at_mcp(None);
    let mcp = t.g.private_view(&t.ids[3]);
    for label in ["Validate Audience", "Validate Scope", "Validate Expiry", "Validate Issuer", "Validate Subject"] {
        assert!(mcp.hand.iter().any(|c| c.label == label && mcp.can_play.contains(&c.id)), "MCP Server should be able to play {label}");
    }
    let app = t.g.private_view(&t.ids[1]);
    assert!(app.hand.iter().any(|c| c.label == "Check the token hasn't expired"));
    // warm-ups stay as they were: nothing extra is dealt
    let mut w = new_game();
    w.g.start(&w.ids[0].clone()).unwrap();
    assert!(!w.g.private_view(&w.ids[1]).hand.iter().any(|c| c.label.starts_with("Check ")));
}

#[test]
fn a_sealed_token_shows_only_what_has_been_checked() {
    let mut t = obo_at_mcp(None);
    let view = |g: &Game| serde_json::to_value(g.public_state(&|_| true, 0)).unwrap();
    let v = view(&t.g);
    let tok = &v["round"]["inFlight"]["credential"]["token"];
    assert_eq!(tok["audience"], "");
    assert_eq!(tok["scope"], serde_json::json!([]));
    assert_eq!(tok["expiry"], 0);
    assert_eq!(tok["issuer"], "");
    assert_eq!(tok["subject"], "");
    assert_eq!(v["round"]["sealed"]["fields"], serde_json::json!(["audience", "scope", "expiry", "issuer", "subject"]));
    assert_eq!(v["round"]["sealed"]["revealed"], serde_json::json!([]));
    // nothing about the token leaks through the chain so far either
    let slips = v["round"]["slips"].to_string();
    assert!(!slips.contains("calendar.read") || !slips.contains("\"audience\":\"mcp\""), "sealed slips must not show token fields");
    assert!(!v["round"]["slips"].as_array().unwrap().iter().any(|s| s["item"]["token"]["audience"] == "application"));

    play_label(&mut t.g, "Validate Audience");
    let v = view(&t.g);
    assert_eq!(v["round"]["inFlight"]["credential"]["token"]["audience"], "mcp");
    assert_eq!(v["round"]["inFlight"]["credential"]["token"]["scope"], serde_json::json!([]), "scope still sealed");
    assert_eq!(v["round"]["sealed"]["revealed"][0]["kind"], "audience");
    assert_eq!(v["round"]["sealed"]["revealed"][0]["ok"], true);

    // once the round is over, everything is shown
    play_label(&mut t.g, "Accept");
    let v = view(&t.g);
    assert!(v["round"]["sealed"].is_null());
    assert!(v["round"]["slips"].to_string().contains("calendar.read"));
}

#[test]
fn accepting_blind_works_but_is_marked_unverified() {
    let mut t = obo_at_mcp(None);
    play_label(&mut t.g, "Accept");
    let r = t.g.round.as_ref().unwrap();
    assert!(r.result.as_ref().unwrap().success, "it functions: nothing forced a check");
    let d = last_diligence(&t.g);
    assert_eq!(d.tag, DiligenceTag::Unverified);
    assert_eq!(d.skipped.len(), 5);
    let mcp = t.g.player(&t.ids[3]).unwrap();
    assert_eq!((mcp.score.calls, mcp.score.bonus), (1, 0), "the call scores, but no diligence bonus");
    assert_eq!(mcp.diligence, DiligenceStats { verified: 0, unverified: 1, breaches: 0 });
    assert!(r.log.iter().any(|l| l.detail.as_deref().is_some_and(|d| d.contains("nothing forced a check"))));
}

#[test]
fn running_every_check_first_is_verified_and_earns_a_bonus() {
    let mut t = obo_at_mcp(None);
    for c in ["Validate Audience", "Validate Scope", "Validate Expiry", "Validate Issuer"] {
        play_label(&mut t.g, c);
    }
    // four of five: still not fully verified
    let mut partial = t.g.clone();
    play_label(&mut partial, "Accept");
    assert_eq!(last_diligence(&partial).tag, DiligenceTag::Unverified);
    assert_eq!(last_diligence(&partial).skipped, vec![CheckKind::Subject]);

    play_label(&mut t.g, "Validate Subject");
    play_label(&mut t.g, "Accept");
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Verified);
    let mcp = t.g.player(&t.ids[3]).unwrap();
    assert_eq!((mcp.score.calls, mcp.score.bonus), (1, 1));
    assert_eq!(mcp.diligence.verified, 1);
    assert!(t.g.round.as_ref().unwrap().result.as_ref().unwrap().awards.iter().any(|a| a.why == "Verified before trusting"));
}

#[test]
fn an_intruder_gets_through_a_receiver_who_skips_the_check() {
    for (defect, kind) in [
        (Defect::Audience, CheckKind::Audience),
        (Defect::Scope, CheckKind::Scope),
        (Defect::Expiry, CheckKind::Expiry),
        (Defect::Issuer, CheckKind::Issuer),
        (Defect::Subject, CheckKind::Subject),
    ] {
        let mut t = obo_at_mcp(Some((Role::Mcp, defect)));
        // the senders did everything right and keep their points
        for id in &t.ids[..3] {
            assert_eq!(t.g.player(id).unwrap().score.calls, 1);
        }
        // still sealed: the swap is invisible
        let v = serde_json::to_value(t.g.public_state(&|_| true, 0)).unwrap();
        assert_eq!(v["round"]["inFlight"]["credential"]["token"]["audience"], "");
        assert!(v["round"]["result"].is_null());

        play_label(&mut t.g, "Accept");
        let r = t.g.round.as_ref().unwrap();
        let res = r.result.as_ref().unwrap();
        assert!(!res.success, "{defect:?}");
        assert_eq!(res.failed_step.as_ref().unwrap().role, Role::Mcp);
        assert!(res.intrusion.as_ref().unwrap().contains("An intruder swapped the token"));
        let d = last_diligence(&t.g);
        assert_eq!(d.tag, DiligenceTag::Breach);
        assert_eq!(d.would_catch, vec![kind], "{defect:?}");
        assert!(res.explanation.contains(&format!("Checking {} would have shown it", kind.label())), "{}", res.explanation);
        assert_eq!(t.g.player(&t.ids[3]).unwrap().diligence.breaches, 1);
    }
}

#[test]
fn the_right_check_catches_the_intruder() {
    let mut t = obo_at_mcp(Some((Role::Mcp, Defect::Audience)));
    play_label(&mut t.g, "Validate Scope"); // passes: the scope is fine
    play_label(&mut t.g, "Validate Audience"); // fails
    let v = serde_json::to_value(t.g.public_state(&|_| true, 0)).unwrap();
    let revealed = v["round"]["sealed"]["revealed"].as_array().unwrap();
    assert!(revealed.iter().any(|x| x["kind"] == "audience" && x["ok"] == false));
    assert_eq!(v["round"]["inFlight"]["credential"]["token"]["audience"], "billing-api");
    play_label(&mut t.g, "Reject");
    let r = t.g.round.as_ref().unwrap();
    assert!(r.result.as_ref().unwrap().success, "intruder stopped: the chain held");
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Caught);
    let mcp = t.g.player(&t.ids[3]).unwrap();
    assert_eq!((mcp.score.calls, mcp.score.bonus), (1, 1));
    assert!(r.result.as_ref().unwrap().awards.iter().any(|a| a.why == "Caught it with a check"));
    // rejecting without having looked is right, but only a hunch
    let mut t = obo_at_mcp(Some((Role::Mcp, Defect::Audience)));
    play_label(&mut t.g, "Reject");
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Hunch);
    assert_eq!(t.g.player(&t.ids[3]).unwrap().score.bonus, 0);
}

#[test]
fn the_application_must_stop_on_a_dead_token_it_could_have_checked() {
    let setup = || {
        let mut t = new_game();
        let i = index_of(&t.g, "learning-obo");
        t.g.host_action(&t.ids[0].clone(), HostAction::Goto, Some(i)).unwrap();
        t.g.plant_intrusion(Role::Application, Defect::Expiry);
        play_label(&mut t.g, "with the user's token slip");
        t
    };
    // blind: exchanges a dead token
    let mut t = setup();
    assert_eq!(t.g.player(&t.ids[0]).unwrap().score.calls, 1, "the Client isn't blamed for the swap");
    play_label(&mut t.g, "scope calendar.read)");
    let c = last_call(&t.g);
    assert!(!c.matched);
    assert_eq!(c.expected.label, "Stop: re-authenticate");
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Breach);
    assert!(t.g.round.as_ref().unwrap().log.iter().any(|l| l.detail.as_deref().is_some_and(|d| d.contains("never checked"))));
    // the IdP is a second line of defence: the exchange fails its own check
    play_label(&mut t.g, "Reject");
    assert_eq!(t.g.player(&t.ids[2]).unwrap().score.calls, 1);

    // diligent: checks, sees it, stops
    let mut t = setup();
    play_label(&mut t.g, "Check the token hasn't expired");
    play_label(&mut t.g, "Stop: reject the job");
    let r = t.g.round.as_ref().unwrap();
    assert!(r.result.as_ref().unwrap().success);
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Caught);
    assert!(last_call(&t.g).matched);
}

#[test]
fn sims_only_know_what_they_check() {
    // a careless sim (skill 0) never checks, so the intruder always gets through
    let mut t = obo_at_mcp(Some((Role::Mcp, Defect::Expiry)));
    t.g.players[3].bot = true;
    let sim = t.ids[3].clone();
    let m = t.g.sim_choice(&sim, 0.0).unwrap();
    apply(&mut t.g, &sim, m).unwrap();
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Breach);

    // a diligent sim (skill 1) runs every check, then rejects
    let mut t = obo_at_mcp(Some((Role::Mcp, Defect::Expiry)));
    t.g.players[3].bot = true;
    let sim = t.ids[3].clone();
    let mut steps = 0;
    while t.g.round.as_ref().unwrap().status == RoundStatus::Playing {
        let m = t.g.sim_choice(&sim, 1.0).unwrap();
        apply(&mut t.g, &sim, m).unwrap();
        steps += 1;
        assert!(steps < 10);
    }
    assert_eq!(steps, 6, "five checks, then the decision");
    assert_eq!(last_diligence(&t.g).tag, DiligenceTag::Caught);
    assert!(t.g.round.as_ref().unwrap().result.as_ref().unwrap().success);
}

#[test]
fn perfect_sims_beat_every_intruder_in_every_round() {
    // every learning/assessment scenario, intruder always on, all four seats diligent sims
    let n = new_game().g.scenarios.len();
    for i in 3..n {
        for target in [Role::Mcp, Role::Application] {
            let mut t = new_game();
            for p in t.g.players.iter_mut().skip(1) {
                p.bot = true;
            }
            let host = t.ids[0].clone();
            t.g.host_action(&host, HostAction::Goto, Some(i as u32)).unwrap();
            t.g.plant_intrusion(target, Defect::Expiry);
            if t.g.round.as_ref().unwrap().status == RoundStatus::Identify {
                t.g.identify(&host, Flow::Obo).unwrap();
            }
            for _ in 0..80 {
                let status = t.g.round.as_ref().unwrap().status;
                if status == RoundStatus::Done {
                    break;
                }
                if let Some(sim) = t.g.next_sim() {
                    // sims guess during the identify phase and play during the round
                    let m = t.g.sim_choice(&sim, 1.0).unwrap_or_else(|| panic!("{}: sim stuck", t.g.scenarios[i].id));
                    apply(&mut t.g, &sim, m).unwrap();
                } else {
                    assert_eq!(status, RoundStatus::Playing, "{}: waiting on a guess nobody will make", t.g.scenarios[i].id);
                    // the human Client: play its right card
                    let pid = active(&t.g);
                    let c = best_card(&t.g);
                    t.g.play(&pid, &c).unwrap();
                }
            }
            let r = t.g.round.as_ref().unwrap();
            assert_eq!(r.status, RoundStatus::Done, "{}", t.g.scenarios[i].id);
            assert!(r.result.as_ref().unwrap().success, "{} with an intruder at {:?}: {}", t.g.scenarios[i].id, target, r.result.as_ref().unwrap().explanation);
        }
    }
}

#[test]
fn telemetry_routes_hide_room_names() {
    use crate::server::telemetry_route;
    assert_eq!(telemetry_route("/api/rooms/amber-otter/join"), "/api/rooms/:room/join");
    assert_eq!(telemetry_route("/api/admin/rooms/amber-otter"), "/api/admin/rooms/:room");
    assert_eq!(telemetry_route("/ws/amber-otter"), "/ws/:room");
    assert_eq!(telemetry_route("/api/rooms"), "/api/rooms");
}

/// A game saved mid-round and restored is the same game: same views for everyone, and it
/// plays on identically. This is what lets a deploy replace the server under a live game.
#[test]
fn snapshot_restores_a_game_mid_round() {
    let mut t = new_game();
    let host = t.ids[0].clone();
    t.g.start(&host).unwrap();
    solve(&mut t.g);
    t.g.host_action(&host, HostAction::Next, None).unwrap();
    // part-way through the second round
    let first = best_card(&t.g);
    let p = active(&t.g);
    t.g.play(&p, &first).unwrap();

    let saved = crate::store::encode(&t.g).unwrap();
    let counter = Arc::new(AtomicU64::new(10_000));
    let mut back = crate::store::decode(&saved, scenarios()).unwrap().with_clock(|| NOW, move || format!("r{}", counter.fetch_add(1, Ordering::Relaxed)));

    let view = |g: &Game| {
        let pub_ = serde_json::to_value(g.public_state(&|_| true, 0)).unwrap();
        let mine: Vec<_> = t.ids.iter().map(|id| serde_json::to_value(g.private_view(id)).unwrap()).collect();
        (pub_, mine)
    };
    assert_eq!(view(&t.g), view(&back));
    assert_eq!(back.archive.len(), t.g.archive.len());

    // and it plays on
    while back.round.as_ref().unwrap().status != RoundStatus::Done {
        let c = best_card(&back);
        let p = active(&back);
        back.play(&p, &c).unwrap();
    }
    assert!(back.round.as_ref().unwrap().result.as_ref().unwrap().success);
}

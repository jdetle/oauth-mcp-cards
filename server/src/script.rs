//! Scripted rounds: the engine for every game in the series except OAuth (see `pack.rs`).
//!
//! A step puts a slip on the wire for one seat and deals that seat its cards. Sealed fields
//! stay hidden (from every browser) until the receiver plays the free check for them. Then
//! the receiver decides. A wrong card breaks the chain and ends the round; the right one moves
//! to the next step or ends the round intact. Some of the time an intruder has swapped one
//! sealed value, and then the right call is the one the pack names for that case.
//!
//! Everything around a round (seats, sims, ready check, scoring, timeline, persistence) is the
//! same code the OAuth game uses.

use super::*;
use crate::pack::{CardVerdict, Script, Step};

const CARD: &str = "c:";
const CHECK: &str = "k:";

fn fields_mut(r: &mut Round) -> Option<&mut Vec<PacketField>> {
    match r.in_flight.as_mut() {
        Some(InFlight::Packet { fields, .. }) => Some(fields),
        _ => None,
    }
}

fn fields(r: &Round) -> &[PacketField] {
    match r.in_flight.as_ref() {
        Some(InFlight::Packet { fields, .. }) => fields,
        _ => &[],
    }
}

/// What a browser may see of a packet. While the round is live a sealed value is withheld;
/// once it's over everything is shown, with any swapped value marked.
pub fn mask_packet(item: &InFlight, live: bool) -> InFlight {
    let InFlight::Packet { from, to, title, note, fields } = item else { return item.clone() };
    let fields = fields
        .iter()
        .map(|f| {
            let mut out = PacketField { label: f.label.clone(), value: f.value.clone(), state: f.state, detail: f.detail.clone(), bad: false, check_detail: None };
            if f.state == FieldState::Sealed {
                if live {
                    out.value = None;
                    out.detail = None;
                } else if f.bad {
                    out.state = FieldState::Bad;
                    out.detail = f.check_detail.clone();
                } else {
                    out.state = FieldState::Open;
                }
            }
            out
        })
        .collect();
    InFlight::Packet { from: *from, to: *to, title: title.clone(), note: note.clone(), fields }
}

impl Game {
    pub(super) fn script_of(&self, r: &Round) -> Option<Arc<Script>> {
        self.scenarios.get(r.index).and_then(|s| s.script.clone())
    }

    pub fn is_scripted(&self) -> bool {
        self.round.as_ref().and_then(|r| self.script_of(r)).is_some()
    }

    /// Called by `start_round` for a scripted scenario.
    pub(super) fn script_begin(&self, r: &mut Round, sc: &Script, phase: Phase) {
        r.status = if sc.question.is_some() { RoundStatus::Identify } else { RoundStatus::Playing };
        if phase != Phase::Warmup && self.intruder_rate > 0.0 {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            let targets: Vec<&Step> = sc.steps.iter().filter(|s| s.intrusion.is_some()).collect();
            if !targets.is_empty() && rng.gen_bool(self.intruder_rate.clamp(0.0, 1.0)) {
                r.script_intrusion = Some(targets[rng.gen_range(0..targets.len())].id.clone());
            }
        }
        self.script_enter(r, sc, 0);
    }

    /// Put step `idx` on the table: its slip on the wire, its cards in the actor's hand.
    fn script_enter(&self, r: &mut Round, sc: &Script, idx: usize) {
        use rand::seq::SliceRandom;
        let step = &sc.steps[idx];
        r.beat = idx;
        r.active_role = Some(step.actor);
        for role in ROLES {
            r.hands.insert(role, vec![]);
        }
        let intr = step.intrusion.as_ref().filter(|_| r.script_intrusion.as_deref() == Some(step.id.as_str()));
        let mut hand: Vec<Card> = step
            .cards
            .iter()
            .enumerate()
            .map(|(i, c)| Card {
                id: self.new_id(),
                card_type: CardType::Script,
                label: c.label.clone(),
                category: c.category.clone(),
                params: CardParams { attach: Some(format!("{CARD}{i}")), ..Default::default() },
            })
            .collect();
        // the order on the page must not give the answer away
        hand.shuffle(&mut rand::thread_rng());
        r.in_flight = step.slip.as_ref().map(|slip| {
            let fields = slip
                .fields
                .iter()
                .map(|f| {
                    let swapped = intr.filter(|x| x.field == f.label);
                    PacketField {
                        label: f.label.clone(),
                        value: Some(swapped.map(|x| x.value.clone()).unwrap_or_else(|| f.value.clone())),
                        state: if f.sealed { FieldState::Sealed } else { FieldState::Open },
                        detail: None,
                        bad: swapped.is_some(),
                        check_detail: if f.sealed { Some(swapped.map(|x| x.detail.clone()).unwrap_or_else(|| f.ok.clone().unwrap_or_default())) } else { None },
                    }
                })
                .collect();
            for f in slip.fields.iter().filter(|f| f.sealed) {
                hand.push(Card {
                    id: self.new_id(),
                    card_type: CardType::ScriptCheck,
                    label: f.check.clone().unwrap_or_else(|| format!("Check the {}", f.label)),
                    category: "optional check".into(),
                    params: CardParams { attach: Some(format!("{CHECK}{}", f.label)), ..Default::default() },
                });
            }
            InFlight::Packet { from: slip.from, to: step.actor, title: slip.title.clone(), note: slip.note.clone(), fields }
        });
        if let (Some(item), Some(slip)) = (r.in_flight.clone(), step.slip.as_ref()) {
            r.slips.push(Slip { from: slip.from, to: step.actor, label: slip.title.clone(), item });
        }
        r.hands.insert(step.actor, hand);
    }

    pub(super) fn script_playable(r: &Round, role: Role, card: &Card) -> bool {
        if r.status != RoundStatus::Playing || r.active_role != Some(role) {
            return false;
        }
        match (card.card_type, card.params.attach.as_deref().and_then(|a| a.strip_prefix(CHECK))) {
            (CardType::ScriptCheck, Some(label)) => fields(r).iter().any(|f| f.label == label && f.state == FieldState::Sealed),
            (CardType::Script, _) => true,
            _ => false,
        }
    }

    /// Test hook: decide that the intruder strikes at `step_id` this round.
    #[cfg(test)]
    pub fn plant_script_intrusion(&mut self, step_id: &str) {
        let Some(mut r) = self.round.take() else { return };
        let sc = self.script_of(&r).expect("scripted round");
        r.script_intrusion = Some(step_id.to_string());
        if sc.steps[r.beat].id == step_id {
            r.slips.pop();
            let beat = r.beat;
            self.script_enter(&mut r, &sc, beat);
        }
        self.round = Some(r);
    }

    pub(super) fn script_play(&mut self, player_id: &str, card_id: &str) -> Result<(), GameError> {
        let r = self.round.as_ref().ok_or_else(|| GameError("No round in progress.".into()))?;
        let sc = self.script_of(r).ok_or_else(|| GameError("Not a scripted round.".into()))?;
        match r.status {
            RoundStatus::Identify => return err("Waiting for everyone's answer."),
            RoundStatus::Done => return err("Round is over."),
            RoundStatus::Playing => {}
        }
        let role = r.seats.role_of(player_id).ok_or_else(|| GameError("You are not seated in this round.".into()))?;
        if r.active_role != Some(role) {
            return err("It is not your turn.");
        }
        let card = r.hands.get(&role).and_then(|h| h.iter().find(|c| c.id == card_id)).cloned().ok_or_else(|| GameError("No such card in your hand.".into()))?;
        if !Self::script_playable(r, role, &card) {
            return err("That card can't be played right now.");
        }
        let name = self.player(player_id).map(|p| p.name.clone()).unwrap_or_default();
        let key = card.params.attach.clone().unwrap_or_default();

        // an optional check: free, reveals one sealed value to the whole table
        if let Some(label) = key.strip_prefix(CHECK) {
            let r = self.round.as_mut().unwrap();
            let Some(f) = fields_mut(r).and_then(|fs| fs.iter_mut().find(|f| f.label == label)) else { return err("Nothing to check.") };
            f.state = if f.bad { FieldState::Bad } else { FieldState::Ok };
            f.detail = f.check_detail.clone();
            let (ok, detail, value) = (!f.bad, f.detail.clone().unwrap_or_default(), f.value.clone().unwrap_or_default());
            // the copy in the chain of slips shows the same
            if let (Some(item), Some(last)) = (r.in_flight.clone(), r.slips.last_mut()) {
                last.item = item;
            }
            r.seq += 1;
            let seq = r.seq;
            r.log.push(LogEntry {
                seq,
                at: now_ms(),
                role: Some(role),
                player_name: Some(name),
                text: format!("Checked {label}: {value}"),
                verdict: if ok { Verdict::Info } else { Verdict::Incorrect },
                detail: Some(detail),
                call: None,
                diligence: None,
            });
            return Ok(());
        }

        let idx: usize = key.strip_prefix(CARD).and_then(|i| i.parse().ok()).ok_or_else(|| GameError("Unknown card.".into()))?;
        let step = &sc.steps[r.beat];
        let played = step.cards.get(idx).ok_or_else(|| GameError("Unknown card.".into()))?;
        let bad_field = fields(r).iter().find(|f| f.bad).cloned();
        let intr = step.intrusion.as_ref().filter(|_| bad_field.is_some());
        let normal = step.cards.iter().find(|c| c.verdict == CardVerdict::Correct).expect("checked at load");
        let expected = match intr {
            Some(x) => step.cards.iter().find(|c| c.label == x.correct).expect("checked at load"),
            None => normal,
        };
        let correct = played.label == expected.label;

        // was the decision made with eyes open?
        let sealed_here = step.slip.as_ref().is_some_and(|s| s.fields.iter().any(|f| f.sealed));
        let skipped: Vec<String> = fields(r).iter().filter(|f| f.state == FieldState::Sealed).map(|f| f.label.clone()).collect();
        let saw_it = bad_field.as_ref().is_some_and(|f| f.state == FieldState::Bad);
        let dil = if !sealed_here {
            None
        } else {
            match (intr.is_some(), correct) {
                (true, false) => Some(DiligenceTag::Breach),
                (true, true) => Some(if saw_it { DiligenceTag::Caught } else { DiligenceTag::Hunch }),
                (false, true) => Some(if skipped.is_empty() { DiligenceTag::Verified } else { DiligenceTag::Unverified }),
                (false, false) => None,
            }
        }
        .map(|tag| Diligence {
            tag,
            skipped: skipped.clone(),
            would_catch: if tag == DiligenceTag::Breach { bad_field.iter().map(|f| f.label.clone()).collect() } else { vec![] },
        });

        let explanation = if correct {
            None
        } else if let (Some(x), Some(f)) = (intr, bad_field.as_ref()) {
            Some(format!(
                "{} {}",
                x.why,
                if saw_it {
                    "The check was run, it failed, and it was trusted anyway.".to_string()
                } else {
                    format!("Nothing forced a check, and none was made on the {}. Checking it would have shown this.", f.label)
                }
            ))
        } else {
            played.why.clone()
        };
        let detail = match (&explanation, dil.as_ref().map(|d| d.tag)) {
            (Some(e), _) => Some(e.clone()),
            (None, Some(DiligenceTag::Unverified)) => Some(format!("It worked, and nothing forced a check. Never checked: {}. This time nothing was wrong with it.", skipped.join(", "))),
            (None, Some(DiligenceTag::Hunch)) => Some("Right to refuse, but on a hunch: the check that shows the problem was never run.".to_string()),
            _ => None,
        };
        let dil_bonus = correct && matches!(dil.as_ref().map(|d| d.tag), Some(DiligenceTag::Verified | DiligenceTag::Caught));
        let chip_of = |c: &crate::pack::ScriptCard| chip(c.chip.as_deref().unwrap_or(&c.label), c.tone);
        let call = Call { expected: chip_of(expected), played: chip_of(played), matched: correct };
        let (label, trap, next) = (played.label.clone(), played.verdict == CardVerdict::Trap, played.next.clone());
        let caught = dil.as_ref().map(|d| d.tag) == Some(DiligenceTag::Caught);

        {
            let p = self.player_mut(player_id)?;
            if correct {
                p.score.calls += 1;
            }
            if dil_bonus {
                p.score.bonus += 1;
            }
            match dil.as_ref().map(|d| d.tag) {
                Some(DiligenceTag::Verified | DiligenceTag::Caught) => p.diligence.verified += 1,
                Some(DiligenceTag::Unverified | DiligenceTag::Hunch) => p.diligence.unverified += 1,
                Some(DiligenceTag::Breach) => p.diligence.breaches += 1,
                None => {}
            }
        }
        let r = self.round.as_mut().unwrap();
        if dil_bonus {
            r.bonuses.push((player_id.to_string(), if caught { "Caught it with a check" } else { "Verified before trusting" }.into()));
        }
        r.moves.push(Move { player_id: player_id.to_string(), role, label: label.clone(), correct: Some(correct), reason: None, explanation, trap });
        r.seq += 1;
        let seq = r.seq;
        r.log.push(LogEntry {
            seq,
            at: now_ms(),
            role: Some(role),
            player_name: Some(name),
            text: label,
            verdict: if correct { Verdict::Correct } else { Verdict::Incorrect },
            detail,
            call: Some(call),
            diligence: dil,
        });
        if r.log.len() > MAX_LOG {
            r.log.remove(0);
        }

        if !correct || next == "end" {
            self.finish();
        } else {
            let (i, _) = sc.step(&next).expect("checked at load");
            let mut r = self.round.take().unwrap();
            self.script_enter(&mut r, &sc, i);
            self.round = Some(r);
        }
        Ok(())
    }

    /// Answer the round's question (assessment rounds), in secret, before play starts.
    pub fn pick(&mut self, player_id: &str, option: &str) -> Result<(), GameError> {
        let r = self.round.as_ref().filter(|r| r.status == RoundStatus::Identify).ok_or_else(|| GameError("Not accepting answers right now.".into()))?;
        let sc = self.script_of(r).ok_or_else(|| GameError("This round has no question.".into()))?;
        let q = sc.question.as_ref().ok_or_else(|| GameError("This round has no question.".into()))?;
        if !q.options.iter().any(|o| o.id == option) {
            return err("That isn't one of the options.");
        }
        let r = self.round.as_mut().unwrap();
        if r.seats.role_of(player_id).is_none() {
            return err("Only seated players answer.");
        }
        match r.picks.iter_mut().find(|(id, _)| id == player_id) {
            Some(p) => p.1 = option.to_string(),
            None => r.picks.push((player_id.to_string(), option.to_string())),
        }
        let all_in = ROLES.into_iter().filter_map(|role| r.seats.get(role)).all(|id| r.picks.iter().any(|(p, _)| p == id));
        if all_in {
            r.status = RoundStatus::Playing;
            Self::log(r, None, "All answers are in. Play begins.", Verdict::Info, None, None);
        }
        Ok(())
    }

    /// A sim knows only what it has checked, same as a person.
    pub(super) fn script_sim_choice(&self, sim: &str, skill: f64) -> Option<ClientMessage> {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let skill = skill.clamp(0.0, 1.0);
        let r = self.round.as_ref()?;
        let sc = self.script_of(r)?;
        if r.status == RoundStatus::Identify {
            let q = sc.question.as_ref()?;
            let option = if rng.gen_bool(skill * 0.85) { q.answer.clone() } else { q.options[rng.gen_range(0..q.options.len())].id.clone() };
            return Some(ClientMessage::Pick { option });
        }
        let role = r.seats.role_of(sim)?;
        let hand = r.hands.get(&role)?;
        let unrun: Vec<&Card> = hand.iter().filter(|c| c.card_type == CardType::ScriptCheck && Self::script_playable(r, role, c)).collect();
        if !unrun.is_empty() && rng.gen_bool(skill) {
            return Some(ClientMessage::Play { card_id: unrun[0].id.clone() });
        }
        let step = &sc.steps[r.beat];
        let seen_bad = fields(r).iter().any(|f| f.state == FieldState::Bad);
        // it acts on what it has seen: an unchecked swap looks fine to it
        let believed = match step.intrusion.as_ref().filter(|_| seen_bad) {
            Some(x) => x.correct.clone(),
            None => step.cards.iter().find(|c| c.verdict == CardVerdict::Correct)?.label.clone(),
        };
        let real: Vec<&Card> = hand.iter().filter(|c| c.card_type == CardType::Script).collect();
        let good = real.iter().find(|c| c.label == believed)?;
        let others: Vec<&&Card> = real.iter().filter(|c| c.label != believed).collect();
        let pick = if others.is_empty() || rng.gen_bool(skill) { good } else { others[rng.gen_range(0..others.len())] };
        Some(ClientMessage::Play { card_id: pick.id.clone() })
    }

    /// For `finish`: the round's closing line, the answers to its question, the intruder's reveal.
    pub(super) fn script_reveal(&self, r: &Round) -> Option<String> {
        let sc = self.script_of(r)?;
        let hit = r.slips.iter().any(|s| matches!(&s.item, InFlight::Packet { fields, .. } if fields.iter().any(|f| f.bad)));
        let id = r.script_intrusion.as_deref().filter(|_| hit)?;
        sc.step(id).and_then(|(_, s)| s.intrusion.as_ref()).map(|x| format!("An intruder was at work this round. {}", x.reveal))
    }
}

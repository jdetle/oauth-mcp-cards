"""Helpers for writing game packs (games/<id>/). A pack is authored as Python data, which needs
far less quoting than raw JSON, and emitted as game.json plus one JSON file per round. The server
lints every pack when it loads (server/src/pack.rs), and `cargo test` plays every card.

    python3 scripts/packs/<name>.py
"""
import json, os

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "games")
U, O, S, T = "client", "application", "idp", "mcp"  # the engine's four seat slots, in table order

# said when someone refuses a slip that had nothing wrong with it
REFUSE_OK = "Nothing was wrong with it. Refusing something legitimate without looking is its own failure: check, then act."

def card(label, verdict="correct", tone="send", category=None, why=None, next="end", chip=None):
    c = {"label": label, "category": category or {"send": "send", "go": "accept", "stop": "refuse"}[tone], "tone": tone, "verdict": verdict, "next": next}
    if why: c["why"] = why
    if chip: c["chip"] = chip
    return c

def ok(label, next="end", chip=None):
    """The right call, and it lets something through."""
    return card(label, tone="go", next=next, chip=chip)

def send(label, next="end", chip=None):
    """The right call, and it passes something on."""
    return card(label, next=next, chip=chip)

def no(label, why=REFUSE_OK, chip=None):
    """Refusing: wrong unless an intruder has swapped something (then the intrusion names it)."""
    return card(label, "wrong", tone="stop", why=why, chip=chip)

def wrong(label, why, tone="send", chip=None):
    return card(label, "wrong", tone=tone, why=why, chip=chip)

def trap(label, why, tone="send", chip=None):
    return card(label, "trap", tone=tone, why=why, chip=chip)

def f(label, value, check=None, ok=None):
    """A field on a slip. With `check` (the check card's name) and `ok` (what it reports), it is sealed."""
    d = {"label": label, "value": value}
    if check: d.update(sealed=True, check=check, ok=ok)
    return d

def slip(frm, title, fields, note=None):
    s = {"from": frm, "title": title, "fields": fields}
    if note: s["note"] = note
    return s

def intr(field, value, detail, correct, why, reveal):
    return {"field": field, "value": value, "detail": detail, "correct": correct, "why": why, "reveal": reveal}

def step(id, actor, cards, slip=None, intrusion=None, tempt=None):
    """tempt: [(label, why)] optional cards that look helpful and break the chain if played."""
    s = {"id": id, "actor": actor, "cards": cards}
    if slip: s["slip"] = slip
    if intrusion: s["intrusion"] = intrusion
    if tempt: s["temptations"] = [{"label": l, "why": w} for l, w in tempt]
    return s

def question(text, options, answer, why):
    return {"text": text, "answer": answer, "why": why, "options": [{"id": k, "label": v} for k, v in options.items()]}

def rnd(id, order, phase, title, text, held, steps, teaches=None, question=None, discussion=None):
    r = dict(id=id, order=order, phase=phase, title=title, text=text, held=held, steps=steps)
    if teaches: r["teaches"] = teaches
    if question: r["question"] = question
    if discussion: r["discussion"] = discussion
    return r

def game(id, order, title, tagline, accent, seats, teaches, glossary):
    return {"id": id, "order": order, "title": title, "tagline": tagline, "accent": accent, "engine": "scripted",
            "seats": {k: {"name": n, "brief": b} for k, (n, b) in seats.items()},
            "teaches": teaches, "glossary": [{"term": t, "means": m} for t, m in glossary]}

def write(g, rounds):
    out = os.path.join(ROOT, g["id"])
    os.makedirs(os.path.join(out, "rounds"), exist_ok=True)
    for old in os.listdir(os.path.join(out, "rounds")):
        os.remove(os.path.join(out, "rounds", old))
    json.dump(g, open(os.path.join(out, "game.json"), "w"), indent=2, ensure_ascii=False)
    for r in rounds:
        json.dump(r, open(os.path.join(out, "rounds", f"{r['order']:02d}-{r['id']}.json"), "w"), indent=2, ensure_ascii=False)
    phases = [r["phase"] for r in rounds]
    print(f"{g['id']}: {len(rounds)} rounds ({phases.count('warmup')} warm-up, {phases.count('learning')} learning, {phases.count('assessment')} assessment)")

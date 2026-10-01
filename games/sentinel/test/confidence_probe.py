"""Probe: does a richer state description raise Jev's confidence?

Run against the user's own endpoint through the dev-server relay.
Usage: python3 test/confidence_probe.py <api-key>
"""

import json
import sys
import urllib.request

PROXY = "http://127.0.0.1:8123/api/proxy"
UPSTREAM = "https://9router.wempyaw.com/v1/systemone"
MODEL = "oc/jev-1.13-free"

QUESTIONS = {
    "difficulty": {
        "type": "choice",
        "instructions": "How hard should the next wave be, given the lives and gold the player has left?",
        "criteria": {
            "gentle": "The player is losing lives or broke; give them room to recover",
            "balanced": "A normal challenge matching the current wave number",
            "aggressive": "The player is ahead, safe and rich; push them hard",
        },
    },
    "focus": {
        "type": "choice",
        "instructions": "Which enemy type should this wave emphasise, given the towers the player has built?",
        "criteria": {
            "grunt": "Basic enemies, good against single-target towers",
            "runner": "Fast weak enemies, good against slow heavy towers",
            "brute": "Armoured high-health enemies, good against area damage",
            "shielded": "Armoured enemies, punishes towers with no armour penetration",
            "swift": "Very fast enemies, punishes towers with short range",
        },
    },
}

STATES = {
    "thin (what the game sends now)": (
        "Wave 3 of a tower defence run. Lives remaining: 20. Gold available: 3000. "
        "Towers on the map: 5x arrow. Enemies killed so far: 8. "
        "Enemies that reached the core: 0."
    ),
    "rich (explicit read of the board)": (
        "Tower defence run. Wave 3 is about to start.\n"
        "Core status: the core has taken ZERO damage. The player has never lost a life.\n"
        "Gold: 3000 unspent. The player is sitting on far more gold than any tower "
        "costs, so they are saving up or ignoring the shop.\n"
        "Board: 5 Arrow towers. An Arrow tower does single-target damage only: it "
        "picks one enemy and shoots it. It cannot splash and it cannot slow.\n"
        "There is no area damage and no slow on the board at all.\n"
        "The player has lost nothing so far, which usually means the previous waves "
        "were too easy for what they built.\n"
        "Given a perfect core, a large untouched gold pile, and a board with no "
        "answer to fast or armoured enemies, what should this wave be?"
    ),
    "in trouble (should pick gentle)": (
        "Tower defence run. Wave 9 is about to start.\n"
        "Core status: the core has taken heavy damage. Lives have dropped from 20 "
        "to 4 this run and 31 enemies have already reached the core.\n"
        "Gold: 180. That is barely enough for one Arrow tower, so the player cannot "
        "buy anything meaningful before the wave hits.\n"
        "Board: 3 Frost towers, which slow enemies but deal almost no damage.\n"
        "The player is one bad wave from losing. What should this wave be?"
    ),
}


def ask(key: str, state: str) -> dict:
    body = {
        "url": UPSTREAM,
        "apiKey": key,
        "body": {"model": MODEL, "state": state, "questions": QUESTIONS},
    }
    req = urllib.request.Request(
        PROXY,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:8123"},
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        # The relay decodes the upstream body, so `data` is already an object.
        payload = json.loads(resp.read())
        return payload.get("data") or {}


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else ""
    if not key:
        raise SystemExit("usage: python3 test/confidence_probe.py <api-key>")

    for label, state in STATES.items():
        out = ask(key, state)
        answers = out.get("answers", {})
        print(f"\n=== {label}")
        for name, ans in answers.items():
            probs = ans.get("probabilities", {})
            top = max(probs.items(), key=lambda kv: kv[1]) if probs else ("-", 0)
            print(f"  {name:<11} chose={ans.get('choice','-'):<10} "
                  f"confidence={ans.get('confidence')!s:<6} "
                  f"spread={top[1] - min(probs.values()) if probs else 0:.2f}")
            print(f"              {probs}")
        usage = out.get("usage", {})
        print(f"  tokens: in={usage.get('input_tokens')} out={usage.get('output_tokens')}")


if __name__ == "__main__":
    main()

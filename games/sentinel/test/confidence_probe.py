"""Measure the effect of the richer state description on Jev's confidence.

Sends the exact state the game now produces (built with the real Sim) and
compares it against the old thin one, plus two situations where the right
answer is knowable in advance.

Usage: python3 test/confidence_probe.py <api-key> [--proxy http://127.0.0.1:8123]
"""

import json
import subprocess
import sys
import urllib.request

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
    "gap": {
        "type": "noul",
        "instructions": "How badly does this board need a fix before the next wave: "
        "a slow tower, area damage, more gold, a wider range, or nothing at all? "
        "Answer 0 if the board is fine, 1 if it clearly is not.",
    },
}

# The state text the game produced before this change, kept for comparison.
OLD_THIN = (
    "Wave 3 of a tower defence run. Lives remaining: 20. Gold available: 3000. "
    "Towers on the map: 5x arrow. Enemies killed so far: 8. "
    "Enemies that reached the core: 0."
)

# Hand-written checks where the right answer is not a matter of taste.
SCENARIOS = [
    ("hurting: should pick gentle", (
        "Tower defence run. Wave 10 is about to start.\n"
        "Core health: 20% (4 of 20 lives, 16 enemies have already reached the core).\n"
        "The player is in real trouble and one bad wave could end the run.\n"
        "Gold: 180, enough for about 3 more of the cheapest tower. "
        "That is not enough for even one tower, so they cannot react before the wave hits.\n"
        "Board: 3x frost (single target only, slow) (slow).\n"
        "Enemies destroyed so far: 61."
    )),
    ("safe and rich: should pick aggressive", (
        "Tower defence run. Wave 3 is about to start.\n"
        "Core health: 100% (20 of 20 lives, 0 enemies have already reached it).\n"
        "The player has never lost a life, which usually means the waves so far were too easy "
        "for what they built.\n"
        "Gold: 3000, enough for about 60 more of the cheapest tower. "
        "That is a lot of unspent gold, so the player is saving or ignoring the shop.\n"
        "Board: 5x arrow (single target only).\n"
        "Nothing on the board slows enemies down, so anything fast will get through much more easily.\n"
        "Nothing on the board does area damage, so armoured groups will not be punished.\n"
        "Enemies destroyed so far: 8."
    )),
]


def ask(proxy: str, key: str, state: str) -> dict:
    body = {
        "url": UPSTREAM,
        "apiKey": key,
        "body": {"model": MODEL, "state": state, "questions": QUESTIONS},
    }
    req = urllib.request.Request(
        f"{proxy}/api/proxy",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Origin": proxy},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return (json.loads(resp.read()).get("data") or {})


def report(label: str, out: dict) -> None:
    print(f"\n=== {label}")
    for name, ans in out.get("answers", {}).items():
        probs = ans.get("probabilities") or {}
        conf = ans.get("confidence")
        if probs:
            ranked = sorted(probs.items(), key=lambda kv: -kv[1])
            margin = ranked[0][1] - (ranked[1][1] if len(ranked) > 1 else 0)
            print(f"  {name:<11} chose={ans.get('choice', '-'):<10} "
                  f"confidence={conf!s:<6} margin={margin:.2f}")
            print(f"              {dict(ranked)}")
        else:
            print(f"  {name:<11} {ans.get('noul')}  confidence={conf!s:<6} "
                  f"({ans.get('type')})")
    usage = out.get("usage", {})
    print(f"  tokens: in={usage.get('input_tokens')} out={usage.get('output_tokens')}")


def live_states() -> list[tuple[str, str]]:
    """Ask the real game for its state text, so the probe cannot drift from it."""
    script = r"""
import { Sim } from '/home/wempya/projects/mini-games/games/sentinel/src/sim.js';
import { summarizeState } from '/home/wempya/projects/mini-games/games/sentinel/src/advisor.js';

const cruise = new Sim();
cruise.gold = 3000;
cruise.wave = 2;
cruise.kills = 8;
for (const c of [[1,1],[1,3],[3,1],[4,2],[2,4]]) cruise.build('arrow', c[0], c[1]);

const rich = new Sim({ gold: 3000 });
rich.wave = 2;
rich.kills = 8;
rich.build('cannon', 1, 1);
rich.build('tesla', 1, 3);

const hurt = new Sim({ gold: 180 });
hurt.wave = 9;
hurt.kills = 61;
hurt.leaked = 16;
hurt.lives = 4;
hurt.build('frost', 1, 1);
hurt.build('frost', 3, 1);
hurt.build('frost', 4, 2);

const blank = new Sim();
blank.wave = 1;

console.log(JSON.stringify({
  cruise: summarizeState(cruise).text,
  rich: summarizeState(rich).text,
  hurt: summarizeState(hurt).text,
  blank: summarizeState(blank).text,
}));
"""
    with open("/tmp/probe-state.mjs", "w", encoding="utf-8") as fh:
        fh.write(script)
    out = subprocess.run(
        ["node", "/tmp/probe-state.mjs"],
        capture_output=True, text=True, timeout=60, check=True,
    )
    data = json.loads(out.stdout)
    return [
        ("OLD thin (before the change)", OLD_THIN),
        ("NEW cruise: real Sim, 5 arrow", data["cruise"]),
        ("NEW blank: real Sim, nothing built", data["blank"]),
    ]


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    key = args[0] if args else ""
    if not key:
        raise SystemExit("usage: python3 test/confidence_probe.py <api-key>")
    proxy = "http://127.0.0.1:8123"
    for i, a in enumerate(sys.argv):
        if a == "--proxy" and i + 1 < len(sys.argv):
            proxy = sys.argv[i + 1]

    for label, state in live_states() + SCENARIOS:
        report(label, ask(proxy, key, state))


if __name__ == "__main__":
    main()

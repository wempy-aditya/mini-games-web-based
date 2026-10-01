"""Which phrasing of the focus question actually gets a confident answer?

The current question asks "which enemy type should this wave emphasise", where
all five options are plausible at once. The measured confidences were 0.22-0.41,
which is below any sensible trust floor. This tries sharper framings on the
same state and reports what the model does with each.

Usage: python3 test/focus_question_probe.py <api-key>
"""

import json
import subprocess
import sys
import urllib.request

UPSTREAM = "https://9router.wempyaw.com/v1/systemone"
MODEL = "oc/jev-1.13-free"
PROXY = "http://127.0.0.1:8123"

CRITERIA = {
    "grunt": "Basic enemies, good against single-target towers",
    "runner": "Fast weak enemies, good against slow heavy towers",
    "brute": "Armoured high-health enemies, good against area damage",
    "shielded": "Armoured enemies, punishes towers with no armour penetration",
    "swift": "Very fast enemies, punishes towers with short range",
}

VARIANTS = {
    "A current (emphasise)": {
        "type": "choice",
        "instructions": "Which enemy type should this wave emphasise, given the towers the player has built?",
        "criteria": CRITERIA,
    },
    "B worst at (punish)": {
        "type": "choice",
        "instructions": "This board has no slow and no area damage. Which enemy type would "
        "get through it most easily and do the most damage to the core?",
        "criteria": CRITERIA,
    },
    "C counter-fit (pick the counter)": {
        "type": "choice",
        "instructions": "The player can only afford one more tower before the wave. Which enemy "
        "type should they worry about most on this board?",
        "criteria": CRITERIA,
    },
    "D single best fit": {
        "type": "choice",
        "instructions": "Name the one enemy type this board is worst equipped to stop. "
        "If the board can handle all five equally, answer with your best single guess.",
        "criteria": CRITERIA,
    },
    "E score not choice": {
        "type": "score",
        "instructions": "Rank the five enemy types from least to most dangerous for this board.",
        "criteria": CRITERIA,
    },
}


def state_text() -> str:
    return _state("cruise")


def _state(kind: str) -> str:
    script = f"""
import {{ Sim }} from '/home/wempya/projects/mini-games/games/sentinel/src/sim.js';
import {{ summarizeState }} from '/home/wempya/projects/mini-games/games/sentinel/src/advisor.js';
const s = new Sim({{ gold: 3000 }});
s.wave = 2; s.kills = 8;
if ({kind!r} === 'cruise') {{
  for (const c of [[1,1],[1,3],[3,1],[4,2],[2,4]]) s.build('arrow', c[0], c[1]);
}} else if ({kind!r} === 'mixed') {{
  s.build('cannon', 1, 1); s.build('frost', 1, 3); s.build('tesla', 3, 1);
}} else if ({kind!r} === 'far') {{
  for (const c of [[1,1],[1,3],[3,1],[4,2],[2,4]]) s.build('sniper', c[0], c[1]);
}}
console.log(summarizeState(s).text);
"""
    with open("/tmp/focus-state.mjs", "w", encoding="utf-8") as fh:
        fh.write(script)
    out = subprocess.run(["node", "/tmp/focus-state.mjs"], capture_output=True,
                         text=True, timeout=60, check=True)
    return out.stdout


def ask(key: str, state: str, question: dict) -> dict:
    body = {
        "url": UPSTREAM,
        "apiKey": key,
        "body": {"model": MODEL, "state": state, "questions": {"focus": question}},
    }
    req = urllib.request.Request(
        f"{PROXY}/api/proxy",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Origin": PROXY},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return (json.loads(resp.read()).get("data") or {}).get("answers", {}).get("focus", {})


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else ""
    if not key:
        raise SystemExit("usage: python3 test/focus_question_probe.py <api-key>")
    state = state_text()
    print("state:\n ", state, "\n")

    for label, question in VARIANTS.items():
        ans = ask(key, state, question)
        probs = ans.get("probabilities") or {}
        conf = ans.get("confidence")
        if probs:
            ranked = sorted(probs.items(), key=lambda kv: -kv[1])
            margin = ranked[0][1] - (ranked[1][1] if len(ranked) > 1 else 0)
            print(f"{label:<28} chose={ans.get('choice','-'):<10} "
                  f"confidence={conf!s:<6} margin={margin:.2f}  {dict(ranked)}")
        else:
            print(f"{label:<28} score={ans.get('score')} confidence={conf} "
                  f"legend={ans.get('legend')}")

    # The winner has to hold up on other boards, or it only flattered this one.
    print("\n-- variant B on other boards --")
    best = VARIANTS["B worst at (punish)"]
    for kind in ("mixed", "far"):
        s = _state(kind)
        print(f"\n[{kind}] {s[:150]}...")
        ans = ask(key, s, best)
        probs = ans.get("probabilities") or {}
        ranked = sorted(probs.items(), key=lambda kv: -kv[1])
        margin = ranked[0][1] - (ranked[1][1] if len(ranked) > 1 else 0)
        print(f"  chose={ans.get('choice')} confidence={ans.get('confidence')} "
              f"margin={margin:.2f} {dict(ranked)}")


if __name__ == "__main__":
    main()

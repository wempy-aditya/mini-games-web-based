#!/usr/bin/env python3
"""Flag characters that slipped into source files by accident.

The recurring failure in this repo is a stray CJK or Cyrillic glyph landing in
Indonesian prose, where it is invisible to the author and ruins the text. This
walks the tracked files and prints anything outside the allowed set.

    python3 tools/scan_characters.py [root ...]
"""

import glob
import sys
import os
import unicodedata

# Ranges that are never a mistake in this repo: Latin-1 punctuation, box
# drawing, arrows and a few symbols used deliberately in UI copy.
ALLOWED = set(
    "─│┌┐└┘├┤┬┴┼═║╔╗╚╝━┃┏┓┗┛•·°×÷±≤≥≠→←↑↓↔⇒⇔≈"
    "–—‘’“”…€™®©"
)
ALLOWED_RANGES = (
    (0x00A0, 0x00FF),   # Latin-1 supplement
    (0x2010, 0x205E),   # general punctuation
    (0x20A0, 0x20BF),   # currency
    (0x2190, 0x21FF),   # arrows
    (0x2200, 0x22FF),   # math operators
    (0x25A0, 0x25FF),   # geometric shapes
    (0x2600, 0x26FF),   # misc symbols
    (0x2700, 0x27BF),   # dingbats
)
EXTS = (".js", ".mjs", ".html", ".css", ".json", ".py", ".md", ".txt")
# Vendored third-party code is upstream's business, not ours. Scanning it would
# only ever report maths symbols in their own comments.
SKIP_DIRS = {"vendor", "node_modules", ".git"}


def suspicious(ch):
    # ASCII is always fine; the point of this tool is the scripts where a
    # stray glyph is invisible to the author.
    if ord(ch) < 0x00A0:
        return False
    if ch in ALLOWED:
        return False
    cp = ord(ch)
    return not any(lo <= cp <= hi for lo, hi in ALLOWED_RANGES)


def main(roots):
    hits = 0
    for root in roots:
        pattern = os.path.join(root, "**", "*")
        for path in sorted(glob.glob(pattern, recursive=True)):
            if not path.endswith(EXTS) or not os.path.isfile(path):
                continue
            if SKIP_DIRS.intersection(path.split(os.sep)):
                continue
            try:
                text = open(path, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                print(f"{path}: UNREADABLE")
                hits += 1
                continue

            for lineno, line in enumerate(text.split("\n"), 1):
                bad = sorted({c for c in line if suspicious(c)})
                if not bad:
                    continue
                hits += 1
                names = ", ".join(
                    f"{c!r} U+{ord(c):04X} {unicodedata.name(c, '?')}" for c in bad
                )
                print(f"{path}:{lineno}: {names}")
                print(f"    {line.strip()[:110]}")

    print(f"\n{'FAIL' if hits else 'OK'}: {hits} suspicious line(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    targets = sys.argv[1:] or ["."]
    sys.exit(main(targets))

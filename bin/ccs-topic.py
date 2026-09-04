#!/usr/bin/env python3
"""Derive a short slug from the first user message in a Claude Code transcript.

Prints an empty string when the session has not been used yet, which is how
ccs-pool.sh tells an idle session apart from one somebody is working in.

    ccs-topic.py ~/.claude/projects/-home-me-work/<uuid>.jsonl
"""

import json
import re
import sys
import unicodedata

# Characters unicodedata cannot fold on its own, notably Turkish dotless i.
TRANSLIT = str.maketrans(
    "çğıöşü",  # c-cedilla, g-breve, dotless i, o, s-cedilla, u
    "cgiosu",
)


# Not everything with role "user" was typed by one. A resumed session opens with
# the client's own nudge, and every resumed session opens with the same one, so
# without this a pool fills up with sessions called "continue-from-where-you".
BOILERPLATE = (
    "continue from where you left off",
    "caveat: the messages below were generated",
    "this session is being continued from a previous",
)


def first_user_text(path):
    """Return the text of the first message a person actually wrote, or None."""
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "user":
                    continue
                content = (entry.get("message") or {}).get("content")
                candidate = None
                if isinstance(content, str) and content.strip():
                    candidate = content
                elif isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "text"
                            and block.get("text", "").strip()
                        ):
                            candidate = block["text"]
                            break
                if candidate is None:
                    continue
                lowered = candidate.strip().lower()
                if any(lowered.startswith(b) for b in BOILERPLATE):
                    continue
                return candidate
    except OSError:
        pass
    return None


def slugify(text, max_words=4, max_len=32):
    text = text.strip().lower().translate(TRANSLIT)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    words = [word for word in text.split() if len(word) > 1][:max_words]
    return "-".join(words)[:max_len].strip("-") or "session"


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: ccs-topic.py <transcript.jsonl>")
    text = first_user_text(sys.argv[1])
    print(slugify(text) if text else "")


if __name__ == "__main__":
    main()

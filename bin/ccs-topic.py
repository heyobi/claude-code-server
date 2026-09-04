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


def first_user_text(path):
    """Return the text of the first user message, or None."""
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
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "text"
                            and block.get("text", "").strip()
                        ):
                            return block["text"]
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

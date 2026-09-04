"""Shared ground for anything that drives the session pool.

The bot and the API server both need to know which sessions exist, which
transcript belongs to one, and how to read an answer out of it. Those answers
were wrong in interesting ways more than once, so they live here rather than in
two places that drift apart.

Standard library only.
"""

import json
import os
import re
import subprocess
import time

HOME = os.path.expanduser("~")
STATE_DIR = os.path.join(HOME, ".claude", "claude-code-server")
BIN = os.path.dirname(os.path.realpath(__file__))


def load_env(path):
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values


def load_config():
    """Read the pool config the same way the shell scripts do."""
    path = os.path.join(HOME, ".config", "claude-code-server", "config")
    cfg = load_env(path)
    cfg.setdefault("CCS_PREFIX", os.uname().nodename.split(".")[0])
    cfg.setdefault("CCS_WORKDIR", os.path.join(HOME, "workspace"))
    return cfg


CFG = load_config()
PREFIX = CFG["CCS_PREFIX"]
WORKDIR = CFG["CCS_WORKDIR"]
PROJDIR = os.path.join(HOME, ".claude", "projects", WORKDIR.replace("/", "-"))
POOLDIR = os.path.join(STATE_DIR, "sessions")


def run(args, timeout=60):
    try:
        done = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "PATH": "{}/.local/bin:/usr/local/bin:/usr/bin:/bin".format(HOME)},
        )
        return (done.stdout or "") + (done.stderr or "")
    except (subprocess.TimeoutExpired, OSError) as exc:
        return "command failed: {}".format(exc)


_CACHE = {}


def cached(key, ttl, produce):
    """Menus fire several lookups per tap; a couple of seconds of memory keeps
    the interface instant without ever showing properly stale data."""
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = produce()
    _CACHE[key] = (now, value)
    return value


def tmux(*args, timeout=15):
    return run(["tmux", *args], timeout=timeout)


def tmux_sessions():
    def produce():
        out = tmux("list-sessions", "-F", "#{session_name}")
        return [l for l in out.splitlines() if l and not l.startswith("no server")]
    return cached("sessions", 2.0, produce)


def ccs_sessions():
    return [s for s in tmux_sessions() if s.startswith(PREFIX)]


def ccs(cmd, *args, timeout=90):
    return run([os.path.join(BIN, cmd), *args], timeout=timeout)


def session_uuid(name):
    try:
        with open(os.path.join(POOLDIR, name + ".uuid"), encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return None


def transcript_of(name):
    uid = session_uuid(name)
    if not uid:
        return None
    path = os.path.join(PROJDIR, uid + ".jsonl")
    return path if os.path.exists(path) else None


def session_profile(name):
    try:
        with open(os.path.join(POOLDIR, name + ".profile"), encoding="utf-8") as handle:
            return handle.read().strip() or "-"
    except OSError:
        return CFG.get("CCS_DEFAULT_PROFILE", "-") or "-"


def assistant_text(entry):
    """Pull plain text out of one transcript entry, ignoring tool traffic."""
    if entry.get("type") != "assistant":
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip() or None
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        joined = "\n".join(p for p in parts if p.strip())
        return joined.strip() or None
    return None


def user_text(entry):
    """The other half of a transcript line: what was actually typed. Tool
    results and the app's own bracketed notes are not conversation."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(b.get("text", "") for b in content
                          if isinstance(b, dict) and b.get("type") == "text")
    else:
        return None
    text = text.strip()
    if not text or text.startswith("<"):
        return None
    return text


def entries_from(path, offset):
    """Parsed transcript entries added since offset, and the new offset.

    Bytes rather than lines: the file is appended to while we read it, so the
    tail is often half a line. That fragment is left where it is and picked up
    whole on the next pass."""
    items = []
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            data = handle.read()
    except OSError:
        return items, offset
    consumed = data.rfind(b"\n") + 1
    if consumed <= 0:
        return items, offset
    for raw in data[:consumed].splitlines():
        if not raw.strip():
            continue
        try:
            items.append(json.loads(raw.decode("utf-8", "ignore")))
        except ValueError:
            continue
    return items, offset + consumed


def read_from(path, offset):
    """Assistant messages added since offset, as (id, text), and the new offset.

    The id lets a caller be certain it never forwards the same message twice,
    whatever the offset arithmetic does."""
    items = []
    entries, offset = entries_from(path, offset)
    for entry in entries:
        text = assistant_text(entry)
        if text:
            items.append((entry.get("uuid") or text, text))
    return items, offset


def last_words(path, window=48000):
    """The most recent thing said, and when.

    Reads the tail rather than the file: a session that has been going all day
    has a transcript of megabytes, and a list of six of them is drawn every
    time someone opens the menu."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            handle.seek(max(0, size - window))
            data = handle.read()
    except OSError:
        return "", 0
    best_text, best_at = "", 0
    for raw in data.split(b"\n"):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw.decode("utf-8", "ignore"))
        except ValueError:
            continue
        text = user_text(entry)
        if text is None:
            text = assistant_text(entry)
        if not text:
            continue
        best_text = text
        stamp = entry.get("timestamp") or ""
        if stamp:
            try:
                import datetime
                best_at = int(datetime.datetime.fromisoformat(
                    stamp.replace("Z", "+00:00")).timestamp())
            except ValueError:
                pass
    return " ".join(best_text.split())[:120], best_at

def tool_calls(entry):
    """The tool invocations in one assistant entry."""
    if entry.get("type") != "assistant":
        return []
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    out = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            out.append({
                "id": block.get("id") or "",
                "name": block.get("name") or "tool",
                "input": block.get("input") or {},
            })
    return out


def tool_results(entry):
    """What came back. These arrive on a later user entry, keyed by call id."""
    if entry.get("type") != "user":
        return []
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        body = block.get("content")
        if isinstance(body, list):
            body = "\n".join(b.get("text", "") for b in body
                             if isinstance(b, dict))
        out.append({
            "for": block.get("tool_use_id") or "",
            "text": str(body or ""),
            "error": bool(block.get("is_error")),
        })
    return out

def turns_from(path, offset):
    """Conversation turns since offset, each labelled with the model behind it.

    The label matters more here than it would in an ordinary chat: a session can
    change backend halfway through, and showing which one said what is the whole
    reason for having our own client rather than borrowing someone else's."""
    turns = []
    entries, offset = entries_from(path, offset)
    for entry in entries:
        stamp = entry.get("timestamp", "")
        # The work comes before the conclusion, in that order.
        for call in tool_calls(entry):
            turns.append({
                "id": call["id"],
                "role": "tool",
                "name": call["name"],
                "input": call["input"],
                "ts": stamp,
            })
        for done in tool_results(entry):
            turns.append({
                "id": done["for"] + ":r",
                "role": "result",
                "for": done["for"],
                "text": done["text"][:4000],
                "error": done["error"],
                "ts": stamp,
            })
        text = user_text(entry)
        role = "user"
        if text is None:
            text = assistant_text(entry)
            role = "assistant"
        if not text:
            continue
        turns.append({
            "id": entry.get("uuid") or "",
            "role": role,
            "text": text,
            "model": (entry.get("message") or {}).get("model", ""),
            "ts": stamp,
        })
    return turns, offset

def send_to_session(name, text):
    tmux("send-keys", "-t", name, "-l", text)
    time.sleep(0.3)
    tmux("send-keys", "-t", name, "Enter")


def pane_lines(name):
    """The pane as it is drawn right now.

    Three separate readers used to each capture it for themselves, which put
    the ceiling on how often the live preview could refresh: at three captures
    a tick, polling faster meant three times the work. They take the lines now
    and the caller reads once.
    """
    return tmux("capture-pane", "-p", "-t", name).splitlines()


def pane_ready(name, lines=None):
    """A tmux session exists well before Claude Code has finished loading a
    resumed conversation. Typing into that gap loses the message, or gets an
    answer from a session that has not read its own history yet."""
    tail = (lines if lines is not None else pane_lines(name))[-8:]
    if any(re.search(r'to interrupt', line, re.I) for line in tail):
        return False
    return any(re.match(r'^\s*[>\u276f]', line) for line in tail)


# The word in the spinner is one of Claude Code's inventions and half of them
# are hyphenated — "Fiddle-faddling", "Noodle-doodling". A pattern that stopped
# at a hyphen matched none of those, so the status went blank and the spinner
# line was not recognised as furniture either: it went out as part of the
# answer, once a second, changing every time.
SPINNER = re.compile(r"[✽✻✳✶✢·*]\s+(\w[\w '\-]*)…\s*\(([^)]*)\)")
# The pane carries the answer and also the furniture around it: the spinner,
# the finished-in-Ns line, and the rotating tips. None of that is the answer.
DONE_LINE = re.compile(r"[✻✽✳✶✢]\s+[\w'\-]+ for .*· done")
CHROME = ("⎿", "auto mode on", "for shortcuts", "esc to interrupt",
          "Tip:", "free reviews left", "to run in background")


def pane_progress(name, lines=None):
    """What the session is saying right now, before it is written down.

    A turn only reaches the transcript once it is finished, so a client reading
    the transcript alone waits in silence through the whole answer. The pane has
    it as it arrives — the terminal is being drawn into, after all. This reads
    that, which means it is limited to what fits on screen and is a preview
    rather than a record: the real text arrives with the turn.
    """
    lines = [l.rstrip() for l in
             (lines if lines is not None else pane_lines(name))]

    status = ""
    for line in reversed(lines):
        found = SPINNER.search(line)
        if found:
            status = found.group(2).strip()
            break

    # Start from what you asked, not from the last thing it said. An answer is
    # drawn as several "●" blocks — a sentence, a tool, another sentence — and
    # starting at the newest one meant the preview threw away everything above
    # it each time a new block appeared: text arrived, vanished, arrived again.
    # The line you typed is drawn with "❯", and so is the input box at the
    # bottom, so the last ten lines are left out of the search.
    asked = None
    for index, line in enumerate(lines[:-10]):
        if line.startswith("\u276f"):
            asked = index
    start = None
    if asked is not None:
        for index in range(asked + 1, len(lines)):
            if lines[index].lstrip().startswith("●"):
                start = index
                break
    if start is None:
        for index, line in enumerate(lines):
            if line.lstrip().startswith("●"):
                start = index
    if start is None:
        return {"text": "", "status": status}

    body = []
    for line in lines[start:]:
        bare = line.strip()
        if line.startswith("─") or bare.startswith("❯"):
            break
        if (not bare or SPINNER.search(line) or DONE_LINE.search(line)
                or any(c in line for c in CHROME)):
            continue
        body.append(bare[2:].strip() if bare.startswith("● ") else bare)
    return {"text": "\n".join(body).strip(), "status": status}


def wait_ready(name, limit=45.0):
    began = time.time()
    while time.time() - began < limit:
        if pane_ready(name):
            return True
        time.sleep(1.0)
    return False


def next_auto_name():
    taken = set(ccs_sessions())
    number = 1
    while True:
        candidate = "{}-{:02d}".format(PREFIX, number)
        if candidate not in taken and not any(t.startswith(candidate + "-") for t in taken):
            return candidate
        number += 1

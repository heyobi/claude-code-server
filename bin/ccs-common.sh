#!/usr/bin/env bash
# Shared helpers for claude-code-server.
# Sourced by ccs-pool.sh, ccs-new and ccs-list.

# ---- defaults, override them in ~/.config/claude-code-server/config ----
: "${CCS_PREFIX:=$(hostname -s)}"          # session name prefix
: "${CCS_WORKDIR:=$HOME/workspace}"        # Claude Code working directory
: "${CCS_EXTRA_DIRS:=}"                    # space separated extra --add-dir paths
: "${CCS_MAX_SESSIONS:=4}"                 # each session is its own claude process
: "${CCS_AUTO_RENAME:=1}"                  # 1 = rename sessions after their topic
: "${CCS_PANE_WIDTH:=200}"
: "${CCS_PANE_HEIGHT:=50}"

CCS_CONF="${CCS_CONF:-$HOME/.config/claude-code-server/config}"
# shellcheck source=/dev/null
[ -f "$CCS_CONF" ] && . "$CCS_CONF"

export PATH="$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CCS_STATE="$HOME/.claude/claude-code-server"
CCS_POOLDIR="$CCS_STATE/sessions"
CCS_MARKDIR="$CCS_STATE/renamed"
CCS_LOG="$CCS_STATE/pool.log"
mkdir -p "$CCS_POOLDIR" "$CCS_MARKDIR"

# Claude Code keeps transcripts in a directory named after the working
# directory with every "/" replaced by "-":  /home/me/work -> -home-me-work
ccs_projdir() {
  printf '%s/.claude/projects/%s\n' "$HOME" "$(printf '%s' "$CCS_WORKDIR" | tr '/' '-')"
}

ccs_log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$CCS_LOG"; }

ccs_adddirs() {
  local d out=""
  for d in $CCS_EXTRA_DIRS; do out="$out --add-dir $d"; done
  printf '%s' "$out"
}

# Start a session. We pass an explicit --session-id so the transcript path is
# deterministic. Do not try to read the session id off the terminal instead:
# tmux wraps long lines and you will silently capture a truncated id.
ccs_start() {
  local name="$1" uuid
  uuid=$(cat /proc/sys/kernel/random/uuid)
  # shellcheck disable=SC2086
  tmux new-session -d -s "$name" -x "$CCS_PANE_WIDTH" -y "$CCS_PANE_HEIGHT" -c "$CCS_WORKDIR" \
    "claude --session-id $uuid --remote-control $name$(ccs_adddirs)"
  printf '%s\n' "$uuid" > "$CCS_POOLDIR/${name}.uuid"
  ccs_log "started: $name (session-id $uuid)"
}

# Bring an existing conversation back under Remote Control. Claude Code reuses
# the same bridge session id when resuming, so the chat reappears at the URL it
# already had: an archived conversation in the apps becomes live again.
ccs_resume() {
  local name="$1" uuid="$2"
  # shellcheck disable=SC2086
  tmux new-session -d -s "$name" -x "$CCS_PANE_WIDTH" -y "$CCS_PANE_HEIGHT" -c "$CCS_WORKDIR" \
    "claude --resume $uuid --remote-control $name$(ccs_adddirs)"
  printf '%s\n' "$uuid" > "$CCS_POOLDIR/${name}.uuid"
  ccs_log "resumed: $name ($uuid)"
}

# tmux session name -> transcript path
ccs_transcript() {
  local name="$1" uuid projdir link cse
  projdir=$(ccs_projdir)
  if [ -f "$CCS_POOLDIR/${name}.uuid" ]; then
    uuid=$(cat "$CCS_POOLDIR/${name}.uuid")
    if [ -f "$projdir/${uuid}.jsonl" ]; then
      printf '%s\n' "$projdir/${uuid}.jsonl"
      return 0
    fi
  fi
  # Fallback for sessions started outside this tool: match on the link printed
  # in the pane. Prefix match, because that line may be wrapped.
  link=$(tmux capture-pane -p -S - -J -t "$name" 2>/dev/null \
         | grep -oE 'claude\.ai/code/session_[A-Za-z0-9]+' | head -1)
  [ -z "$link" ] && return 1
  cse="cse_${link##*session_}"
  grep -l "\"bridgeSessionId\":\"${cse}" "$projdir"/*.jsonl 2>/dev/null | head -1
}

# transcript -> number of user messages. 0 means nobody has used the session.
ccs_usercount() {
  local t="$1" n
  [ -f "$t" ] || { echo 0; return; }
  n=$(grep -c '"type":"user"' "$t" 2>/dev/null) || n=0
  printf '%s\n' "${n:-0}"
}

# transcript -> the URL to open on a phone or at claude.ai
ccs_link() {
  local t="$1" id
  [ -f "$t" ] || return 1
  id=$(CCS_T="$t" python3 -c 'import os,re
p = os.environ["CCS_T"]
m = re.search(r"bridgeSessionId\"\s*:\s*\"cse_([A-Za-z0-9]+)\"",
              open(p, encoding="utf-8", errors="ignore").read())
print(m.group(1) if m else "")' 2>/dev/null)
  [ -n "$id" ] && printf 'https://claude.ai/code/session_%s\n' "$id"
}

# Is it safe to type into this session right now? No, if Claude is generating,
# and no if there is unsent text in the prompt: somebody may be typing on their
# phone and our keystrokes would be appended to their draft.
ccs_idle() {
  local name="$1" tail_txt input
  tail_txt=$(tmux capture-pane -p -t "$name" 2>/dev/null | tail -8)
  printf '%s' "$tail_txt" | grep -qiE 'to interrupt' && return 1
  input=$(printf '%s' "$tail_txt" | grep -E '^[[:space:]]*(>|❯)' | tail -1 \
          | sed -E 's/^[[:space:]]*(>|❯)[[:space:]]*//')
  [ -n "$input" ] && return 1
  return 0
}

ccs_sessions() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${CCS_PREFIX}" || true
}

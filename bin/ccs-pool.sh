#!/usr/bin/env bash
# Keep exactly one idle Claude Code session waiting at all times.
#
# When the idle session receives its first message it is renamed after the topic
# of that message, in the tmux session name and, through /rename, in the name
# the Claude apps show. A fresh idle session is then started to replace it.
#
# Run from systemd: once at boot and every couple of minutes from a timer.
set -uo pipefail

CCS_BIN="$(dirname "$(readlink -f "$0")")"
# shellcheck source=ccs-common.sh
. "$CCS_BIN/ccs-common.sh"

have_idle=0
count=0

for session in $(ccs_sessions); do
  count=$((count + 1))

  transcript=$(ccs_transcript "$session") || transcript=""
  if [ -z "$transcript" ]; then
    have_idle=1          # still starting up, treat as the idle one
    continue
  fi

  if [ "$(ccs_usercount "$transcript")" -eq 0 ]; then
    have_idle=1
    continue
  fi

  # This session is in use. Only auto generated names are renamed; a name you
  # picked yourself with ccs-new is left alone.
  case "$session" in
    "$CCS_PREFIX" | "$CCS_PREFIX"-[0-9][0-9])
      slug=$("$CCS_BIN/ccs-topic.py" "$transcript" 2>/dev/null)
      [ -z "$slug" ] && continue
      newname="${session}-${slug}"

      if [ "$CCS_AUTO_RENAME" = "1" ] && [ ! -f "$CCS_MARKDIR/$newname" ]; then
        if ccs_idle "$session"; then
          tmux send-keys -t "$session" "/rename ${newname}" Enter 2>/dev/null
          touch "$CCS_MARKDIR/$newname"
          ccs_log "sent /rename: $newname"
          sleep 3
        else
          ccs_log "busy, deferring rename: $session"
          continue
        fi
      fi

      if [ -f "$CCS_POOLDIR/${session}.uuid" ]; then
        mv -f "$CCS_POOLDIR/${session}.uuid" "$CCS_POOLDIR/${newname}.uuid"
      fi
      tmux rename-session -t "$session" "$newname" 2>/dev/null \
        && ccs_log "renamed: $session -> $newname"
      ;;
  esac
done

if [ "$have_idle" -eq 1 ]; then
  ccs_log "idle session available ($count total)"
  exit 0
fi

if [ "$count" -ge "$CCS_MAX_SESSIONS" ]; then
  ccs_log "no idle session, at limit ($count/$CCS_MAX_SESSIONS)"
  exit 0
fi

n=1
while :; do
  candidate=$(printf '%s-%02d' "$CCS_PREFIX" "$n")
  if ! tmux list-sessions -F '#{session_name}' 2>/dev/null \
       | grep -q "^${candidate}\$\|^${candidate}-"; then
    break
  fi
  n=$((n + 1))
done

ccs_start "$candidate"

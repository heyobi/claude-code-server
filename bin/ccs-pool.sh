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

# ---------------------------------------------------------------------------
# After a reboot, bring back the conversations that were live before it.
#
# Rebooting from inside a session kills tmux and the claude process with it, so
# the Remote Control bridge drops and the chat goes quiet in the apps. Resuming
# reuses the same bridge id, so those conversations come back where they were.
#
# This runs only on the first pool tick after a boot. A session you close
# yourself during normal operation stays closed.
# ---------------------------------------------------------------------------
restore_after_boot() {
  local projdir restored=0 uuid_file name uuid transcript
  projdir=$(ccs_projdir)

  # Most recently touched conversations first.
  for uuid_file in $(ls -t "$CCS_POOLDIR"/*.uuid 2>/dev/null); do
    name=$(basename "$uuid_file" .uuid)

    # Records left over from a different CCS_PREFIX are not ours to revive.
    case "$name" in
      "$CCS_PREFIX" | "$CCS_PREFIX"-*) ;;
      *) continue ;;
    esac

    uuid=$(cat "$uuid_file" 2>/dev/null)
    transcript="$projdir/${uuid}.jsonl"

    tmux has-session -t "$name" 2>/dev/null && continue

    # Never used, or the transcript is gone: just a leftover, drop the record.
    if [ ! -f "$transcript" ] || [ "$(ccs_usercount "$transcript")" -eq 0 ]; then
      rm -f "$uuid_file"
      continue
    fi

    if [ "$restored" -ge "$CCS_MAX_SESSIONS" ]; then
      ccs_log "restore: reached limit, $name left for ccs-resume"
      continue
    fi

    # The dedicated channel session has to come back with its channel attached,
    # otherwise the messaging bridge is silently missing after a reboot.
    if [ "$name" = "$(ccs_channel_name 2>/dev/null)" ]; then
      ccs_resume "$name" "$uuid" "$CCS_CHANNEL"
    else
      ccs_resume "$name" "$uuid"
    fi
    restored=$((restored + 1))
    sleep 2
  done

  ccs_log "restore after boot: $restored conversation(s) brought back"
}

current_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
stored_boot=$(cat "$CCS_STATE/boot_id" 2>/dev/null || true)
if [ -n "$current_boot" ] && [ "$current_boot" != "$stored_boot" ]; then
  printf '%s\n' "$current_boot" > "$CCS_STATE/boot_id"
  [ -n "$stored_boot" ] && restore_after_boot
fi

# The dedicated channel session is not part of the idle pool: it is always the
# same session so the bot token has exactly one listener.
channel_session=$(ccs_channel_name 2>/dev/null) || channel_session=""
if [ -n "$channel_session" ] && ! tmux has-session -t "$channel_session" 2>/dev/null; then
  ccs_start "$channel_session" "$CCS_CHANNEL"
  sleep 2
fi

have_idle=0
count=0

for session in $(ccs_sessions); do
  # Counted, but never treated as the spare and never auto renamed.
  [ -n "$channel_session" ] && [ "$session" = "$channel_session" ] && continue
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

      # The record is the uuid and the backend it runs on. Moving only half of
      # it leaves the profile behind under a name that may be handed out again.
      for part in uuid profile; do
        if [ -f "$CCS_POOLDIR/${session}.${part}" ]; then
          mv -f "$CCS_POOLDIR/${session}.${part}" "$CCS_POOLDIR/${newname}.${part}"
        fi
      done
      tmux rename-session -t "$session" "$newname" 2>/dev/null \
        && ccs_log "renamed: $session -> $newname"
      ;;
  esac
done

if [ "$have_idle" -eq 1 ]; then
  ccs_log "idle session available ($count total)"
  exit 0
fi

# A spare session was how you opened a new chat before there was an interface:
# something had to be waiting, because nothing could start one on demand. The
# app can, so the seat is optional now — and an empty one costs a quarter of a
# gigabyte to sit there.
if [ "$CCS_POOL_IDLE" = "0" ]; then
  ccs_log "no spare kept (CCS_POOL_IDLE=0)"
  exit 0
fi

if [ "$count" -ge "$CCS_MAX_SESSIONS" ]; then
  ccs_log "no idle session, at limit ($count/$CCS_MAX_SESSIONS)"
  exit 0
fi

# Something is mid relaunch and will be back in a moment. Adding a spare now
# only churns processes, and the name it would pick may be the one coming back.
if ccs_any_reserved; then
  ccs_log "a session is relaunching, leaving the spare for the next tick"
  exit 0
fi

n=1
while :; do
  candidate=$(printf '%s-%02d' "$CCS_PREFIX" "$n")
  if ! tmux list-sessions -F '#{session_name}' 2>/dev/null \
       | grep -q "^${candidate}\$\|^${candidate}-" \
     && ! ccs_reserved "$candidate"; then
    break
  fi
  n=$((n + 1))
done

ccs_start "$candidate"

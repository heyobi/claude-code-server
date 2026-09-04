#!/usr/bin/env bash
# Install claude-code-server for the current user.
#
#   ./install.sh
#
# Installs into ~/.local/share/claude-code-server, links ccs-new and ccs-list
# into ~/.local/bin, writes a default config, enables the systemd user units and
# turns on lingering so the pool survives logout and reboot.
#
# Nothing here needs root except `loginctl enable-linger`, which the script asks
# for explicitly. Re-running it is safe.
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DEST="$HOME/.local/share/claude-code-server"
BINDIR="$HOME/.local/bin"
UNITDIR="$HOME/.config/systemd/user"
CONFDIR="$HOME/.config/claude-code-server"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks ----
command -v tmux    >/dev/null || die "tmux is not installed (apt install tmux)"
command -v python3 >/dev/null || die "python3 is not installed"
command -v claude  >/dev/null || die "the claude CLI is not on PATH; install Claude Code first"
command -v systemctl >/dev/null || die "this installer targets systemd systems"

# --------------------------------------------------------------- install ----
say "Installing to $DEST"
mkdir -p "$DEST" "$BINDIR" "$UNITDIR" "$CONFDIR" "$CONFDIR/profiles"
rm -rf "$DEST/bin"
cp -r "$SRC/bin" "$DEST/bin"
rm -rf "$DEST/web"
cp -r "$SRC/web" "$DEST/web"
chmod +x "$DEST"/bin/*

ln -sf "$DEST/bin/ccs-new"    "$BINDIR/ccs-new"
ln -sf "$DEST/bin/ccs-list"   "$BINDIR/ccs-list"
ln -sf "$DEST/bin/ccs-resume" "$BINDIR/ccs-resume"
ln -sf "$DEST/bin/ccs-close"   "$BINDIR/ccs-close"
ln -sf "$DEST/bin/ccs-profile" "$BINDIR/ccs-profile"
ln -sf "$DEST/bin/ccs-bot"     "$BINDIR/ccs-bot"
ln -sf "$DEST/bin/ccs-gateway-sync" "$BINDIR/ccs-gateway-sync"
ln -sf "$DEST/bin/ccs-api"     "$BINDIR/ccs-api"
ln -sf "$DEST/bin/ccs-agy-bridge" "$BINDIR/ccs-agy-bridge"
say "Linked ccs-new, ccs-list, ccs-resume, ccs-close and ccs-profile into $BINDIR"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) warn "$BINDIR is not on your PATH; add it to your shell profile" ;;
esac

# ---------------------------------------------------------------- config ----
if [ -f "$CONFDIR/config" ]; then
  say "Keeping existing config at $CONFDIR/config"
else
  cp "$SRC/config.example" "$CONFDIR/config"
  sed -i "s|^CCS_PREFIX=.*|CCS_PREFIX=$(hostname -s)|" "$CONFDIR/config"
  sed -i "s|^CCS_WORKDIR=.*|CCS_WORKDIR=$HOME/workspace|" "$CONFDIR/config"
  say "Wrote default config to $CONFDIR/config"
fi

# shellcheck source=/dev/null
. "$CONFDIR/config"
mkdir -p "$CCS_WORKDIR"

# ---------------------------------------------------------------- systemd ---
cp "$SRC/systemd/claude-code-server.service"       "$UNITDIR/"
cp "$SRC/systemd/claude-code-server-check.service" "$UNITDIR/"
cp "$SRC/systemd/claude-code-server.timer"         "$UNITDIR/"
cp "$SRC/systemd/ccs-bot.service"                  "$UNITDIR/"
cp "$SRC/systemd/ccs-api.service"                  "$UNITDIR/"
cp "$SRC/systemd/ccs-agy-bridge.service"           "$UNITDIR/"
systemctl --user daemon-reload
systemctl --user enable claude-code-server.service claude-code-server.timer >/dev/null
systemctl --user start  claude-code-server.timer
say "Enabled systemd user units"

# The control bot only makes sense once a Telegram token exists.
if [ -f "$HOME/.claude/channels/telegram/.env" ]; then
  systemctl --user enable --now ccs-bot.service >/dev/null 2>&1     && say "Control bot enabled (ccs-bot)"     || warn "Could not start ccs-bot; check: journalctl --user -u ccs-bot"
else
  warn "No Telegram token yet; ccs-bot installed but not enabled"
fi

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  say "Enabling lingering so sessions survive logout and reboot (needs sudo)"
  sudo loginctl enable-linger "$USER"
fi

# ------------------------------------------------------- workspace notes ----
# Tells the assistant in each session how to close itself, so the user can say
# "close this" from their phone instead of opening an SSH connection.
if [ ! -f "$CCS_WORKDIR/CLAUDE.md" ]; then
  cp "$SRC/workspace-CLAUDE.md" "$CCS_WORKDIR/CLAUDE.md"
  say "Wrote session notes to $CCS_WORKDIR/CLAUDE.md"
else
  warn "$CCS_WORKDIR/CLAUDE.md exists; not overwriting (see workspace-CLAUDE.md)"
fi

# ------------------------------------------------------------------ tmux ----
if ! grep -q 'claude-code-server' "$HOME/.tmux.conf" 2>/dev/null; then
  cat "$SRC/tmux.conf.snippet" >> "$HOME/.tmux.conf"
  say "Appended tmux settings to ~/.tmux.conf"
  tmux source-file "$HOME/.tmux.conf" 2>/dev/null || true
fi

# ------------------------------------------------------------------ done ----
cat <<EOF

Installed.

  workspace : $CCS_WORKDIR
  prefix    : $CCS_PREFIX
  config    : $CONFDIR/config

One manual step is left. Claude Code asks you to trust a working directory the
first time it opens one, and no script can answer that for you:

  cd $CCS_WORKDIR && claude

Choose "Yes, I trust this folder", then leave with Ctrl+B then D, or /exit.
After that the pool starts sessions unattended.

  ccs-list            show sessions and where to open them
  ccs-new <topic>     start a named session
  ccs-resume          list and reopen earlier conversations
  ccs-close <name>    stop a session for good
  ccs-profile         list backends; ccs-profile <name> switches one
  ccs-bot             Telegram control bot (runs as a systemd user service)

EOF

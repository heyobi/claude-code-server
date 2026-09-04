# claude-code-server

Turn a spare Linux box into a Claude Code server you can drive from your phone.

Claude Code sessions live in a terminal. Close the terminal and the session is
gone. This project keeps a pool of sessions running on a machine you own, under
`tmux` and `systemd`, so they survive a dropped SSH connection, a logout, and a
reboot — and stay reachable from the Claude mobile app, the desktop app, and
claude.ai.

There is always an idle session waiting. The moment you send it your first
message it renames itself after what you asked about, and a new idle session
takes its place.

```
$ ccs-list
SESSION                                  STATE          OPEN AT
---------------------------------------- -------------- ---------------------------------------------
myhost-01                                idle           https://claude.ai/code/session_XXXXXXXXXXXX...
myhost-02-fix-the-nginx-config           in use (7)     https://claude.ai/code/session_XXXXXXXXXXXX...
myhost-model-download                    in use (23)    https://claude.ai/code/session_XXXXXXXXXXXX...
```

## Why

A laptop in a cupboard is a fine place to run long jobs. The awkward part is
reaching it. You do not want to open SSH to the internet, you do not want to
lose a two-hour job because your Wi-Fi blinked, and you would rather kick
something off from your phone than open a laptop.

Claude Code already talks to the Claude apps through Remote Control. What is
missing is everything around it: keeping sessions alive, starting them at boot,
naming them so a list of six is still readable, and not stepping on a session
somebody is typing into. That is what this is.

## What you get

- **Survives everything short of power loss.** `tmux` for dropped connections,
  a systemd user unit plus lingering for logout and reboot.
- **An idle session is always ready.** A timer checks every couple of minutes
  and starts a replacement as soon as the spare one gets used.
- **Sessions name themselves.** First message in, and the session becomes
  `myhost-01-fix-the-nginx-config` — in tmux and in the Claude apps.
- **It will not type over you.** Before renaming, it checks that Claude is not
  generating and that the prompt is empty, because you may be mid-sentence on
  your phone.
- **A bounded pool.** `CCS_MAX_SESSIONS` stops a small machine from being eaten
  by claude processes.

## Requirements

- Linux with systemd (developed on Ubuntu 24.04)
- [Claude Code](https://claude.com/claude-code) installed and signed in
- `tmux`, `python3`, `git`
- Optional but recommended: [Tailscale](https://tailscale.com), so you can reach
  the box from anywhere without exposing SSH

## Install

```bash
git clone https://github.com/heyobi/claude-code-server.git
cd claude-code-server
./install.sh
```

The installer copies the scripts to `~/.local/share/claude-code-server`, links
`ccs-new` and `ccs-list` into `~/.local/bin`, writes a config, enables the
systemd user units, and turns on lingering. It needs `sudo` only for
`loginctl enable-linger`.

Then do the one thing no script can do for you:

```bash
cd ~/workspace && claude
```

Answer **Yes, I trust this folder**, then leave with `Ctrl+B` `D`. Claude Code
records the trust decision on disk, and from then on the pool can start sessions
unattended. See [the trust note](#the-home-directory-trust-trap) for why this
step exists and why it must not be automated.

## Usage

```bash
ccs-list                    # sessions, state, and where to open each one
ccs-new database migration  # a session named myhost-database-migration
ccs-resume                  # list earlier conversations
ccs-resume 4f2c91ab         # bring one back, an id prefix is enough
ccs-close myhost-02-fix     # stop a session for good
tmux attach -t myhost-01    # attach locally
```

### Archiving a chat does not close it

Archiving in the Claude apps only tidies your list. On this machine the tmux
session and its claude process keep running — a few hundred MB each — and after
a reboot the pool resumes the conversation, so it reappears.

`ccs-close <name>` is what actually ends one: it stops the session and forgets
the record, so the restore pass leaves it alone. The transcript stays on disk,
and `ccs-resume` can reopen it whenever you want.

Detach with `Ctrl+B` then `D`. **Do not type `exit`** — that closes the window,
and closing the last window ends the session. Closing the terminal window is
safe; typing `exit` is not.

From a phone, open the Claude app and pick the session by name.

### Rebooting is fine, including from inside a session

Ask Claude to reboot the machine and it will take its own session down with it:
tmux dies, the process dies, the Remote Control bridge drops, and the chat goes
quiet in the apps.

On the first pool tick after the machine comes back, every conversation that was
live before the reboot is resumed. Claude Code keeps the same bridge session id
across a resume, so those chats come back **at the URL they already had** — an
archived conversation in the app goes live again instead of showing up as a new
one. Nothing is lost either way: the transcripts are on disk the whole time.

A session you close yourself during normal running stays closed. Only a reboot
triggers the restore, and only for conversations that actually have messages in
them. If more were open than `CCS_MAX_SESSIONS` allows, the rest are left for
`ccs-resume`.

## Configuration

`~/.config/claude-code-server/config`:

| Setting | Default | Notes |
| --- | --- | --- |
| `CCS_PREFIX` | hostname | Session name prefix |
| `CCS_WORKDIR` | `~/workspace` | Working directory. **Not `$HOME`** — see below |
| `CCS_EXTRA_DIRS` | empty | Extra `--add-dir` paths, space separated |
| `CCS_MAX_SESSIONS` | `4` | Each session is a separate claude process |
| `CCS_AUTO_RENAME` | `1` | `0` disables topic renaming |
| `CCS_PANE_WIDTH` / `CCS_PANE_HEIGHT` | `200` / `50` | Detached pane size |

## How it works

```
systemd timer ──every 2 min──> ccs-pool.sh
                                   │
                                   ├─ boot_id changed since last run?
                                   │    resume every conversation that was live
                                   │    before the reboot
                                   │
                                   ├─ for each tmux session matching the prefix:
                                   │    read its transcript
                                   │    0 user messages ──> this is the idle one
                                   │    otherwise ──> derive a topic slug,
                                   │                  /rename it, rename tmux
                                   │
                                   └─ no idle session and under the limit?
                                        start one with a fresh --session-id
```

Each session is started with an explicit `--session-id`, so its transcript path
is known: `~/.claude/projects/<workdir with / replaced by ->/<uuid>.jsonl`.
Counting `"type":"user"` lines in that file is how the pool tells an idle
session from a busy one, and the first user message is where the topic slug
comes from.

## Things that cost us an afternoon

### The home directory trust trap

Claude Code asks you to trust a working directory the first time it opens one.
For `$HOME` it **never persists your answer** — the flag stays `false` in
`~/.claude.json` even after a clean shutdown, so every new session asks again.
An unattended session started at boot in `$HOME` sits on that prompt forever.

Use a subdirectory. Trust is remembered there, and anything else you need can be
granted with `--add-dir`.

And do not automate the answer, by keystrokes or by editing the JSON. It is a
security prompt: a human should decide that Claude may read, write, and execute
in a directory.

### Do not read the session id off the screen

The obvious way to map a tmux session to its Claude session is to grep the pane
for the `claude.ai/code/session_...` link. It works until the pane wraps that
line, and then you silently capture a truncated id and every lookup fails. Pass
`--session-id` at launch instead.

### Renaming can clobber somebody's draft

`/rename` is sent by typing into the session. If the person is composing a
message on their phone, your keystrokes land in their draft. `ccs_idle()`
refuses to type when Claude is generating or when the prompt is not empty, and
the pool retries on the next tick.

### Remote Control is on by default

Recent Claude Code versions enable Remote Control for every session; `/status`
says *"To keep a session in this terminal only, run /remote-control"*. The
`--remote-control <name>` flag this project passes is really about **naming** a
session, not enabling the feature.

More in [docs/troubleshooting.md](docs/troubleshooting.md), including the USB
enclosure debugging that came out of the same build.

## Security

This gives a chat interface on your phone the ability to run commands on a
machine in your house. Be deliberate about it.

- **Do not open SSH to the internet.** Use Tailscale, WireGuard, or something
  like them. If you must expose SSH, disable password authentication first.
- **Think hard before adding passwordless `sudo`.** It is convenient and it
  means anyone who reaches your Claude account is root on that box. This project
  neither sets it up nor needs it.
- **Scope `CCS_WORKDIR` deliberately.** Pointing it at `$HOME` hands over your
  SSH keys, your shell history, and your credentials along with everything else.
- **Auto mode runs most commands without asking.** A vague instruction typed on
  a phone can do more than you meant. Say what you want precisely, or turn auto
  mode off.

## License

MIT. See [LICENSE](LICENSE).

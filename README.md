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
- **A phone that does not depend on one vendor.** A Telegram bot drives the
  pool without going through a model, so it still works on the day your Claude
  subscription lapses.
- **Swappable backends.** A session can be moved onto another provider through
  a local gateway and keeps its conversation.

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

You do not need a shell for this. The installer drops a `CLAUDE.md` in the
workspace telling the assistant to run `ccs-close --self` when you ask it to
close, so from your phone you can just say "close this session" and it does.

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
| `CCS_MODEL` | empty | `--model` for every session the pool starts |
| `CCS_PERMISSION_MODE` | empty | `auto`, `acceptEdits`, `plan`, `manual` |
| `CCS_DEFAULT_PROFILE` | `-` | Backend for new sessions; `-` is your Claude login |
| `CCS_CHANNEL` / `CCS_CHANNEL_SESSION` | empty | Channels bridge, experimental |

## Driving it from a phone

There are two ways in, and they fail differently, so it is worth having both.

**Remote Control** is Claude Code's own feature and needs nothing from this
project: every session the pool starts passes `--remote-control <name>`, and the
Claude apps pick them up. It is by far the nicer surface — streaming answers,
tool calls, diffs, real markdown. It authenticates against Anthropic, though,
which means it goes away the moment you point the session at another provider.

**`ccs-bot`** is the fallback, and the reason it exists is that last sentence.
It is a Telegram bot that runs beside the pool as its own systemd unit.

```
🗂 Oturumlar     🧠 Model
➕ Yeni oturum   ❌ Kapat
⚙ Izin modu      🔓 Onaylar
📎 Dosyalar      ℹ Durum
```

What it does:

- Switch between sessions. Switching clears the chat and replays the tail of
  that session's transcript, so the screen matches the session you are in.
- Pick a provider and a model, category by category rather than forty buttons
  at once. Choosing one restarts the session and resumes the conversation.
- Open and close sessions, change permission mode, send files out of the
  workspace and drop files into it.
- Relay permission prompts as buttons when a session stops to ask. Optional,
  and off is a reasonable setting if you run in `auto`.

Anything that is not a command is typed into the active session, and the answer
is read back out of the transcript.

**None of this goes through a model.** Commands run `ccs-*` and `tmux`
directly. That is deliberate rather than frugal: you reach for the model menu
exactly when the model is unreachable, so the control path must not need one.
It also means the bot costs no tokens.

Setting it up:

```sh
# talk to @BotFather, then:
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=...' > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env

# only these Telegram user ids may talk to it
echo '{"allowFrom": [123456789]}' > ~/.claude/channels/telegram/access.json

systemctl --user enable --now ccs-bot
```

Two Telegram limits are worth knowing: a bot can delete messages for 48 hours
and no longer, and it can upload 50 MB and download 20 MB. Running your own
Bot API server raises the transfer limits to 2 GB.

## The web app

`ccs-api` serves a small progressive web app and the HTTP control plane behind
it. It exists because both other surfaces show you a relay rather than the
conversation: the Claude apps only display what arrived while Remote Control was
connected, and a chat bot only what it was around to forward. The transcript on
disk always has more.

That difference is not academic. Move a session onto another backend and Remote
Control drops, because Claude Code turns it off whenever `ANTHROPIC_BASE_URL` is
set — measured, not assumed: a transparent proxy that forwarded everything to
Anthropic still got no bridge. The turns you exchange meanwhile are missing from
the app afterwards. The web app reads the transcript, so they are simply there,
each labelled with the model that produced it:

```
opus-5            İyiyim, sen nasılsın? İpucu 123 — aklımda
gemini-3.8-flash  Evet, ipucu 123'tü.
gemini-3.8-flash  Google tarafından geliştirilen Gemini 3.8 Flash modeliyim.
opus-5            İpucu 123. Bir de düzeltme: az önce "Gemini 3.8 Flash" dedim…
```

Live updates are Server-Sent Events, not websockets: the traffic is one
directional, the browser reconnects on its own, and it is a few lines of
standard library rather than a frame codec. A client says which byte of the
transcript it has reached, so reconnecting resumes exactly there and a duplicate
is not expressible.

```sh
systemctl --user enable --now ccs-api
ccs-api --print-token          # paste this into the app once
```

It listens on `127.0.0.1:8787`. Put it on your tailnet with TLS, which is what
makes it installable — a service worker and Add to Home Screen both need a
secure context, and plain `http://100.x.y.z` is not one:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

That gives `https://<host>.<tailnet>.ts.net` with a real certificate, reachable
from anywhere your phone can run Tailscale and from nowhere else. Enable *HTTPS
Certificates* in the tailnet's DNS settings first, or the cert request is
refused. Nothing is exposed to the internet; this is not `tailscale funnel`.

The token is the only thing standing between anyone already on your tailnet and
a shell on this machine, so treat `~/.config/claude-code-server/api-token` the
way you would an SSH key. Delete it and restart to roll it.

## Backends

A backend is chosen by environment variables that Claude Code reads at startup,
so switching one means relaunching the session. `ccs-profile` does that and
resumes the conversation, so history carries over.

A profile is a plain env file at `~/.config/claude-code-server/profiles/<name>.env`:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4000
ANTHROPIC_AUTH_TOKEN=whatever-your-gateway-wants
ANTHROPIC_API_KEY=
CCS_PROFILE_MODEL=gemini-flash
```

```sh
ccs-profile                     # list profiles and what each session uses
ccs-profile gemini my-session   # move a session onto one
ccs-profile -                   # back to your Claude login
```

Anything that speaks the Anthropic Messages API works. We use
[LiteLLM](https://github.com/BerriAI/litellm) in front of Gemini.
`ccs-gateway-sync` asks the provider which models your key can actually call,
drops the ones that are not for conversation, writes the gateway config and
restarts it — hardcoding model names goes stale the week a provider ships a new
one.

It also writes a `gemini-auto` group with several models behind one name, and
that is what the profile should point at. Free tier quota is counted per model:
one afternoon here produced a 503 "experiencing high demand" and, an hour later,
a 429, each stopping a session dead while five other models answered fine.
Fallbacks alone do not fix it, because on the streaming path this gateway
re-raises instead of falling — the client sees the error, retries without
streaming, and every message costs a wasted minute. A group avoids the failure
rather than recovering from it: a deployment that starts refusing goes into
cooldown and the next request is routed past it.

The trade-off is the one from the previous section: on another provider you keep
the sessions, the pool and the bot, and you lose Remote Control.

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

### A session record is more than its id

The pool remembers a session as `<name>.uuid`, and once backends arrived, also
as `<name>.profile`. Renaming moved the first and left the second; closing
deleted the first and left the second. Neither looked like a bug, because
nothing failed.

It surfaces later. Auto names get reused — close `host-03` and the next session
is called `host-03` again — and it inherits a profile file nobody remembers
writing. You ask for Claude and quietly get whatever the last tenant used.
Rename and close now move and delete the whole record.

### The pool will move into a name you are still using

Switching backends kills a session and brings it back a few seconds later.
The pool ticks on a timer, and if it ticks inside that window it sees a free
name and starts a fresh session on it. `ccs_resume` then ran `tmux new-session`
against a name that already existed, which fails — and wrote the session record
anyway.

Nothing errors. You get a session that answers you with no memory of the
conversation you were just having, while the record points at a transcript that
stopped growing, so anything reading it goes quiet. It took a pool log with
`started` and `resumed` one second apart to see it:

```
13:39:12 profile: host-01 -> gemini
13:39:17 started: host-01 (session-id ef25eab0…)   <- the pool
13:39:18 resumed: host-01 (e4d4b6e1…)              <- the relaunch, too late
```

A relaunch now reserves the name before anything is killed and releases it when
the session is back. The pool skips reserved names and does not add a spare
while one is outstanding; reservations expire after five minutes so a crashed
relaunch cannot block a name forever. Both launchers refuse to start on a name
that is already running, and neither writes a record unless tmux actually
started something.

### A failed send is not a send that did not happen

`sendMessage` was retried without markup whenever the call came back not-ok,
which is right for "unsupported start tag" and wrong for everything else. A
request that times out may well have arrived; resending it is how one answer
becomes two identical bubbles.

Retry only when Telegram says it was the markup. Everything else gets logged and
left alone, and the transcript reader now carries each entry's id so the relay
can prove it never sends the same message twice. One relay per session, too.

### Never answer out of a session the user did not pick

The bot kept the active session as a name, and looked it up like this:

```python
if name and name in tmux_sessions():
    return name
for candidate in ccs_sessions():   # fall back to whatever is there
    set_active(chat_id, candidate)
```

Switching backends kills a session and brings it back six seconds later. Send a
message inside that window and the lookup misses, adopts an unrelated session,
and writes that choice down. You are now talking to a different conversation
and nothing on screen says so — it looks exactly like the assistant forgetting
everything you just told it.

A chat now remembers the session id as well as the name. If the name is gone it
follows the id, since the record moves with a rename; failing that it waits for
the session to come back. What it never does is answer from a session you did
not choose.

### A tmux session exists before Claude is ready

After `ccs-profile` restarts a session, tmux has it back in about a second.
Claude Code is still reading the transcript for several more. Waiting for the
tmux session to reappear and then typing gets you an answer from a session that
has not read its own history yet — it will cheerfully tell you the thing you
just told it never came up.

Wait for the pane instead: a prompt line present and no "to interrupt" in the
last few rows.

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
- **Fill in the bot's allowlist.** Anyone who finds a Telegram bot can message
  it. `~/.claude/channels/telegram/access.json` is what stops them; with no
  `allowFrom` the bot answers whoever writes to it. The token file deserves
  `chmod 600` for the same reason.

## License

MIT. See [LICENSE](LICENSE).

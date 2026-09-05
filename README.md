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

### Sharing one

The menu hands the conversation over as a Markdown file, through whatever
share sheet the device has — Messages, Notes, Files, AirDrop are all one tap
from there. Markdown rather than a screenshot or our own HTML: it opens in
anything, it is still text afterwards, and the code blocks these answers are
full of survive being pasted. Tool calls come through as one line each; a
shared conversation is for reading, and the argument list of a command nobody
ran is not part of what was said.

It works on an archived conversation too, including one imported from another
machine, because all it needs is the transcript.

Two things it taught us. The times in a transcript are UTC with a Z on the end,
and slicing the hour out of the string puts every line three hours out — they
are converted to the reader's clock. And an HTTP header is latin-1, so a
filename taken straight from a Turkish question does not fail politely: it
raises inside `send_header` and the response never arrives. Filenames are
folded to ASCII.

### Reading an old conversation costs nothing

A closed conversation is a file. Opening one needs no process, no gateway and
no subscription, so tapping an archived conversation reads it rather than
resuming it — the whole transcript on screen, the composer greyed out because
there is nothing to send to, and bringing it back a second, deliberate step.

The archive holds every conversation on the machine, not only this workspace's.
Claude Code files a transcript under the folder it was held in, so one machine
can carry several folders' worth, and hiding the others would make it not an
archive. The folder is read off the transcript rather than decoded from the
directory name: that name is the path with the slashes turned into dashes,
which cannot be reversed once a folder has a dash of its own. Conversations
from another folder can be read but not resumed here — a resume starts a
session, a session starts in a working directory, and this server has one.

### Conversations from another machine

A transcript is a file and reading one needs nothing else, so a conversation
held on any machine can be read here. `ccs-import <label> <path>...` copies
transcripts in; the archive picks them up and shows each under the folder it
was actually held in, read from the transcript rather than the directory name.

```sh
scp -r ~/.claude/projects/* server:/tmp/incoming/
ssh server 'ccs-import windows /tmp/incoming'
```

Re-running refreshes: a transcript that has grown is copied again, one that has
not is left alone. Imported conversations are read-only — resuming starts a
session, a session starts in this server's working directory, and one held on
another machine was never in it. To actually continue one, put its transcript
in this workspace's project directory instead and `ccs-resume` it; the history
comes with it, the working directory does not.

A conversation whose first pages are all editor chatter used to vanish from the
list, because the title is read off the top and an empty title meant "opened,
never used". Those are two different questions: the second one is answered by
whether anyone ever spoke, and a conversation that cannot be titled is listed
without one rather than hidden.

### An archive that outlives the subscription

The point of all of this is what happens when the Claude subscription is not
there. Tested end to end: a conversation answered only by `claude-opus-5`, told
to remember the number 123, closed. Resumed, moved onto the Antigravity
profile, asked what the hint was — `gemini-3.7-flash-high` answered 123.

It works because of what the bridge sends on the first turn of a conversation
it has not seen: `whole(payload)`, the entire transcript flattened, rather than
just the newest message. After that the executor keeps the conversation on its
side and only the new message goes. So history crosses backends, and a
transcript written under one is readable and continuable under another.

The web app has an archive anyway, because a list you cannot tidy stops being
readable — and it holds everything, not just what is running. Closed
conversations are still on the disk, so the archive lists them too, newest
first, titled by the first thing that was asked in them; tapping one runs
`ccs-resume` and it comes back under the id it already had. Transcripts with no
user message in them are pool slots rather than conversations, and stay out.
The scan reads the head of every transcript, so it is cached for two minutes
rather than run on every poll. The archive says what it is, too. The session list carries its filters at the
top with their counts — all, working, archived — so the archive is somewhere
you can see rather than somewhere you have to already know about. The archived
view states that those conversations are still running, and closing is one tap
further. The marker is a `.archived` file
beside the session's other records, so it survives a restart, moves with a
rename, and goes when the session is closed. Archived sessions also stop
sending notifications: putting a conversation away and then being buzzed by it
is the one thing an archive must not do.

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

A turn only reaches the transcript once it is finished, though, and waiting in
silence through a two minute answer is the difference between a tool and a form
you submitted. The text is already visible somewhere — the pane is being drawn
into as it arrives — so while a session is busy the stream also carries what is
on screen, with the elapsed time and token count from the spinner. That preview
is whatever fits on the pane and is replaced by the real turn when it lands: a
window, not a record. Getting it out means leaving the furniture behind, since
the spinner, the finished-in-Ns line and the rotating tips share that region.

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

### Showing the work

An answer that took two minutes usually spent them running things, and reading
only the conclusion is reading half of it. The transcript has the whole of it —
`tool_use` blocks with their arguments, `tool_result` blocks with the output —
so the stream carries those too. Consecutive calls collapse to one quiet line
between the messages, "4 araç · Bash ›", and opening it shows each call: what
was run, and what came back.

That line is the only thing in the conversation that is not something someone
said, so it is the only thing that is not a bubble.

### Glass, and what a browser can do

The surfaces are frosted the way the platform's are, and the recipe is one class
used everywhere: a lit rim along the top edge, a shadowed one underneath, a
hairline all the way round, a specular gradient across the upper third, and a
two-part shadow — contact and ambient. Blur alone is not glass; those edges are.

The refraction is missing on purpose. Apple's version displaces the backdrop
through an SVG filter, which the open recreations reproduce with
`backdrop-filter: url(#displace)` and `feDisplacementMap`. WebKit does not
support `url()` in `backdrop-filter`
([bug 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)), so on Safari —
which is the browser this is built for — it renders as nothing. Chasing it would
have looked right on the development machine and wrong on the phone.

### Nothing has an edge

There is no header bar and no composer bar. Two floating controls and a title
sit at the top, the composer panel sits at the bottom, and the conversation runs
underneath both, fading into the page colour instead of stopping at a line. A
drawn edge across the top reads as a lid over the page; a fade reads as the page
continuing. The fade is two layers — a masked blur with the page colour over it
— so a browser that will not mask a `backdrop-filter` still carries the text
off, it just does it without the blur.

The tint is thin the whole way down, buttons included, and never flat at the
top: what keeps the title readable is the blur under it, not opacity. A blur
costs nothing in transparency — you still see what is behind the header, you
just cannot read it, which is all a header needs.

The ramp is measured in pixels from the top, not in percentages of the header.
The header is as tall as the status bar makes it, so a percentage puts the fade
across the title on one device and below it on another. It runs over some fifty
of them through four stops: a two-stop fade has a visible shoulder where the
ramp begins, and the shoulder is the thing that still reads as an edge.

### The composer

One panel: what you are writing on top, what you are writing it with underneath
— attach, the model it will go to, and send. Tapping the model name opens the
picker, so the thing you most often want to change is one tap from where you are
typing.

The model sits in a pill, not as plain text beside the attach button — a label
next to a control reads as a caption, and nobody taps a caption. The panel
keeps three quarters of the home indicator's inset off the floor, which is
where the apps it is measured against sit. It was flat on the floor for a
while, and correctly so: the window was then one status bar short of the
screen and everything needed dragging down. Once the window reached the glass
the same rule read as stuck to it.

Getting it to actually reach the floor took some finding, and one wrong turn.
On an installed iOS app with a translucent status bar the page is drawn from
the very top of the display, but the window is sized as though it began below
the status bar — so `window.innerHeight` comes up exactly one inset short and
everything fixed to the bottom of it floats that far above the glass. The
phone's own numbers gave the diagnosis: screen 874, window 812, top inset 62.

The wrong turn was assuming the missing strip was still the page's to paint,
and pushing the composer down into it. The composer came back cut in half: the
strip is off the end of the window, not part of it. The fix is to stop asking
for the translucent bar — with `apple-mobile-web-app-status-bar-style` at
`default` the window is placed below the status bar and its bottom edge lands
on the bottom of the screen. iOS reads that meta when the app is installed, so
one already on the home screen has to be removed and added again for it to
take.

There is a layout readout in the menu for exactly this kind of thing: screen,
window, visual viewport, both insets, where the panel's bottom edge actually
landed, the shortfall, and whether this is the installed app or a browser tab.
A gap reported from a phone and reproducible nowhere else is a measurement
problem, and the phone should be the one doing the measuring. The shortfall is
measured more than once, too — an installed app reports the full screen height
for its window until the layout settles, which is exactly when a script at the
end of the body runs.

The message box is a `contenteditable` region and the composer is not a form,
both for the same reason: iOS hangs an accessory bar over the keyboard —
previous, next, and a tick — for editable content, and the arrows have nowhere
to go when there is one field. There is no API to remove or relabel it, so the
only thing to try is not looking like a form: no `<textarea>`, no `<form>`
around it, the send button an ordinary button. `plaintext-only` is set from
script rather than in the markup, because a browser that does not know the
value treats the whole attribute as invalid and leaves the box uneditable,
which is a worse failure than a pasted `<b>`.

Return makes a line. It is the only way to write a second one on a phone, and
the send button is an inch away; a keyboard with modifiers gets ⌘/Ctrl+Return
instead. `enterkeyhint` says `enter`, because a key labelled "send" that makes
a newline is a lie and a key labelled "send" that sends costs you the second
line.

Whether a keyboard is up is decided by the field's focus as well as the visual
viewport. The viewport shrinks on some platforms and iOS scrolls the page
instead, so it cannot be asked on its own — but wherever the keyboard came
from, the field it came for has focus. The composer drops its clearance while
one is up: the keyboard is the floor then.

Nothing traps you behind the keyboard. Dragging the conversation dismisses it,
so does tapping anything in it that is not a control, and the layout puts the
composer on the keyboard's top edge rather than somewhere near it.

Scrolled back through a long answer, a round button appears over the composer
and takes you to the bottom. It jumps rather than glides: smooth scrolling is
silently ignored on that element in more than one browser, and a button that
sometimes does nothing is worse than one that does not animate.

The send button says what it will do. While a session is working it is a stop
— until you type something, at which point it goes back to being send, because
pressing it then queues the message rather than interrupting anything, and a
button that reads "stop" while it means "queue" is one nobody dares press.

Typing while a session is working is neither refused nor an interruption. The
message waits in a visible queue and goes when the session comes free; the send
button becomes a stop while it works, and stops the turn without ending the
session. Both backends behave the same way, because both report readiness the
same way — from the pane.

### The machine's name is not the conversation's

Every session is called `<prefix>-something` because that prefix is how the
pool finds its own tmux sessions among anyone else's on the machine. That is
plumbing, so it comes off before anything is shown: the list is titled with the
machine once — "Oturumlar · ziverbey" — and the conversations are called what
they are about. A session the pool only numbered is shown as a new chat with
its number, because a conversation called "01" is worse than one with no name.

It goes back on when you rename, whether you typed it or not. A session renamed
out of the prefix is a session the pool can no longer see.

### No empty seat

The pool used to keep one idle session waiting at all times, because before
there was an interface something had to be ready — nothing could start a
session on demand. The app can, so `CCS_POOL_IDLE=0` stops keeping one, and a
quarter of a gigabyte stops sitting in an empty chair. The rest of the pool's
work stays: restoring conversations after a reboot, and naming a session after
its topic once it has one.

### The session list

A session is a conversation, so the list shows what the conversation was about:
the last thing said, when it was said, and which backend said it, newest first.
That means reading each transcript, which would be slow done naively — a session
running all day has megabytes of it — so only the tail is read.

Sessions can be pinned, which keeps them above the rest; the pins live on the
device, because which conversations matter is a property of whoever is holding
the phone.

Rows answer a tap with a small haptic where the browser allows one. Safari has
never implemented the Vibration API, but it does give a switch control its own
haptic, and clicking that switch's label from script borrows it. Apple closed
that in iOS 26.5, so on a newer phone the call does nothing, which is the right
way for a decoration to fail.

### Tasks

Diagrams in an answer are drawn rather than printed. The library is loaded the
first time one turns up and not before — it is the largest thing this app could
pull in, and most conversations never contain one; without a network it falls
back to the source, which is still the answer.

A busy session is a running job, so the app shows them that way: what is
working, for how long and on how many tokens, and a stop button that sends the
interrupt the TUI listens for rather than closing the session. Sessions can be
renamed from there too, which moves the id and the backend record with the name
— leave either behind and the next session called that inherits it.

### Files

Files go both ways. The composer takes photos and documents, uploads them into
the workspace and shows what is queued before you send; the message then carries
the path, because a path is what a session can open. An image someone attached
appears in their own message rather than being described in it.

Whatever a session produces is on the machine, which is not the same as being
reachable. The file view opens on what this conversation touched — paths it mentioned and
files the executor wrote, that are really there, and nothing at all when there
are none. A browser rooted at the workspace shows you everything on the machine,
which is not what you want while reading one conversation; that view is still
one tap away.

The app browses the workspace and opens what it finds: images,
audio and video play in the conversation, text and code open in a block, and a
page or a PDF gets its own tab. Paths mentioned in an answer become buttons
underneath it, so a generated file is one tap from the sentence that announced
it.

`/api/file` resolves every request against the workspace root and refuses
anything that lands outside it, which matters more than usual here because the
API is reachable from the internet. Absolute paths are accepted when they are
already inside, because a model writing about a file it just made writes the
whole path.

Media is fetched and handed over as a blob rather than pointed at with a `src`.
An `<img>` cannot send a header, cannot say why it failed, and would put the
token in a URL; fetching returns all three. It also matters for the paths read
out of an answer, which are guesses — one that does not resolve removes itself
instead of leaving a broken icon behind.

### Notifications

A long job finishes minutes after you put the phone down, which is the case the
web app could not cover on its own. `ccs-api` watches every session's transcript
and sends a Web Push when an answer appears — but only when no stream is open on
that session, because if the app is in front of you the answer is already on
screen and a buzz is just noise.

Permission is asked for once; staying subscribed is not the user's problem
after that. Every launch, and every return to the app, puts the subscription
back — a reinstall, a new service worker, or an endpoint the push service
retires all leave notifications quietly off, and the only symptom is silence.
The server keys subscriptions on their endpoint, so putting the same one back
is an update rather than a second subscriber.

Turn it on from the menu. On iOS the app has to be on the Home Screen first;
Safari does not offer push to a page in a tab.

"No stream open" has to mean "not on screen", not "app not killed", so the
client lets go of the stream when it goes to the background and picks it up
again when it comes back. Otherwise an app left open in the background counts as
watching and nothing is ever sent. A session appearing is also worth knowing
about, so that is announced too.

This is the one part that needs a library outside the standard one: RFC 8291
wants ECDH on P-256 and RFC 8292 wants an ES256 signature. `python3-cryptography`
covers both, and without it push reports itself unavailable and nothing else
changes.

Worth knowing if you go changing it: the payload encryption is easy to get
subtly wrong, and a push service answers a wrong one with a bare 400. The order
of the two public keys in the `WebPush: info` string is receiver then sender, and
the JOSE signature is the raw `r||s` pair rather than the DER the library hands
back. A round trip — encrypt, then decrypt the way a browser would — catches
both in a second.

The other one is not in the crypto at all. `CCS_PUSH_CONTACT` ends up as the
`sub` claim, and Apple checks it: a placeholder like `mailto:admin@localhost` is
answered `403 BadJwtToken`, which reads like a signing problem and is not one.
Any routable address or `https:` URL is accepted, and the default is a URL for
that reason.

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
CCS_PROFILE_LABEL="Google API"

# Optional: run the gateway only while something is on this profile.
CCS_PROFILE_UP="docker start litellm"
CCS_PROFILE_DOWN="docker stop litellm"
CCS_PROFILE_HEALTH=http://127.0.0.1:4000/health/liveliness
```

Quote any value with a space in it. The file is sourced by the launcher, and
an unquoted `docker start litellm` sets the variable to `docker` and then tries
to run `start` — which is exactly what `CCS_PROFILE_LABEL=Google API` had been
doing, quietly, at every launch.

```sh
ccs-profile                     # list profiles and what each session uses
ccs-profile gemini my-session   # move a session onto one
ccs-profile -                   # back to your Claude login
```

### A gateway you are not using should not be running

The LiteLLM container was the largest thing on this machine — 800 MB, more than
any Claude session — and it is useful only to sessions on one profile, which is
usually none of them. So a profile can say how to start and stop its gateway:
`ccs-launch` brings it up and waits before starting a session on that profile,
and `ccs-api` sweeps every couple of minutes and stops the ones no live session
is on. Ten minutes of grace, because switching a session between profiles takes
the gateway out of use for a few seconds and a cold start costs more than the
memory does. `ccs-gateway status` shows what is up and who is on it.

Wait for a health check, not an open port. Docker publishes a container's port
the moment it starts, so a TCP connect succeeded here in 0.27 seconds against a
gateway that needed eighteen more before it would answer — and a session that
starts against a port with nothing behind it fails its first request with
nothing to explain why.

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

## Antigravity as a backend

`agy`, Google's Antigravity CLI, signs in to its own account with its own quota
and serves Gemini, GPT-OSS and Claude models alike. `ccs-agy-bridge` puts the
Anthropic Messages API in front of it, which makes Antigravity a profile you
pick from the same menu as everything else — and one that does not go away when
a Claude subscription does.

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash   # then run `agy` once to sign in
systemctl --user enable --now ccs-agy-bridge
```

```sh
# ~/.config/claude-code-server/profiles/antigravity.env
ANTHROPIC_BASE_URL=http://127.0.0.1:4001
ANTHROPIC_AUTH_TOKEN=antigravity-local
ANTHROPIC_API_KEY=
CCS_PROFILE_LABEL=Antigravity
CCS_PROFILE_MODEL=gemini-3.8-flash-medium
```

Two things about it are worth knowing, because they are not what a gateway
usually does.

**It does not forward the tools.** `agy --print` is not a model endpoint, it is
an agent: it reads files, runs commands and returns the finished answer. There
is nothing on the far side that would emit a `tool_use` block, so the tool
catalogue and system prompt are dropped rather than passed along. The work still
happens — agy does it, in its own workspace.

**It can use its tools, if you let it.** Headless mode cannot prompt for
permission and the CLI states that settings allow-rules do not apply there, so
it is every tool or none — `CCS_AGY_ALLOW_TOOLS`, off in the shipped config
because that is a decision about a machine rather than a preference. With it
off the executor can only talk; with it on it writes files and runs commands.
Either way it needs `--add-dir`: without one it invents a scratch project and
works there, ignoring the directory it was started in, and the file you asked
for lands somewhere nobody is looking.

**It reports what it did.** Work inside the executor never reaches the
transcript — Claude Code is only ever handed the finished answer — so a session
on this backend looked like it sat silent for two minutes and then spoke. The
bridge writes each finished tool call to a file named after the transcript, and
the API serves them as turns of the same shape the transcript produces, so the
client needs no special case: the same "3 araç" line, opening onto the same
commands and output.

**It resumes rather than replays.** Claude Code sends the whole transcript every
turn; agy keeps the conversation on its side. The bridge maps one to the other
and sends only the new message, which is the difference between a long session
costing a little and costing more each time you speak. The map is keyed on the
transcript id the client already sends, so it survives a rename and a switch to
another backend, and it is written to disk so it survives a restart of the
bridge. It records the workspace alongside and empties itself if that changes,
because a conversation is bound to the project it was created in and resuming
one keeps that binding whatever directories the new invocation names.

Sessions also launch with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. After
each answer Claude Code asks the model to guess your next message; on your own
subscription that is invisible, in front of a metered backend it is a second
full request per turn that costs about what the answer did.

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

### A status that never comes back

The header said "connecting" through a connection that had already come back.
Two halves to it. `EventSource` reports an error every time it *begins*
reconnecting, so the first blip painted the disconnected state; and the server
only sent a status event when readiness changed, so nothing ever repainted it.
Now the client waits several seconds to see whether the reconnect takes before
saying anything, asks for the state again when the stream opens, and the status
rides the heartbeat rather than only changes. Any client that missed one is
right again within fifteen seconds.

### The keyboard moves the window, not the page

iOS does not shrink the page when the keyboard opens. It leaves the layout
alone and slides a window over it, so anything `position: fixed` goes with the
layout, not with what you can see: the header off the top of the screen, the
composer down behind the keys. That is why the header disappeared while typing
and the composer floated a thumb's width above the keyboard — `env(safe-area-inset-bottom)`
still reports the home indicator that the keyboard is now covering.

What it does instead is scroll the page, so that whatever is fixed to the
bottom of the layout lands on top of the keyboard. That is the right outcome,
and it arrives for free — the composer was above the keys before anyone touched
this. The header going off the top is the same scroll seen from the other end.

We tried to do better and made it worse, twice, in the same change: a shell
sized to `visualViewport` fought the scroll iOS had just done, and a "defensive"
`window.scrollTo(0, 0)` — added on the theory that a page with `overflow:
hidden` should never be scrolled — undid the lift on every keyboard event and
put the composer back underneath the keys. Both are gone. The bars are fixed to
the viewport, iOS moves them, and the only thing measured from
`visualViewport` now is whether a keyboard is up at all, so the safe-area insets
can stand down and the view can stay at the bottom.

The lesson is narrow and worth keeping: when the platform's own handling of
something already produces the right result, an improvement has to beat it, not
merely be more explicit than it.

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
- **Put something that authenticates in front of it, or keep it on the tailnet.**
  A Cloudflare tunnel with an Access policy is the arrangement we ended up with:
  the token still guards the API, but nothing reaches the server at all until
  Cloudflare has established who you are. Worth checking with a request that
  carries a valid token — it should still be answered with a redirect to the
  login page, because the outer door does not know or care about the inner one.
- **Think twice before putting the web app on the public internet.** One
  `tailscale funnel` away is a real temptation, and what it publishes is an
  endpoint that types into a shell running in auto mode. The token is long and
  five wrong guesses lock an address out for fifteen minutes, but the token is
  then the only thing between the internet and your machine — and so is every
  line of the server in front of it. On a tailnet neither has to be perfect.
- **Fill in the bot's allowlist.** Anyone who finds a Telegram bot can message
  it. `~/.claude/channels/telegram/access.json` is what stops them; with no
  `allowFrom` the bot answers whoever writes to it. The token file deserves
  `chmod 600` for the same reason.

## License

MIT. See [LICENSE](LICENSE).

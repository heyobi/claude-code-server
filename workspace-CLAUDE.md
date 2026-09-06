# Workspace notes

This machine runs [claude-code-server](https://github.com/heyobi/claude-code-server).
Sessions live in tmux under a `ziverbey-` prefix, systemd keeps them alive across
reboots, and a phone app talks to them over a Cloudflare tunnel. You are one of
those sessions.

## The toolbox

These are on the PATH. They are ordinary commands: read `--help` or the header
comment of any of them before guessing.

| | |
|---|---|
| `ccs-list` | what is running, and what each session is on |
| `ccs-new <topic>` | start a named session |
| `ccs-resume [id]` | list closed conversations, or bring one back |
| `ccs-close <name>` | end one for good; the transcript stays |
| `ccs-profile [name] [session]` | which backend a session talks to |
| `ccs-gateway status` | gateways, and whether they are up |
| `ccs-import <label> <path>` | conversations from another machine into the archive |
| `ccs-check` | exercise the file path end to end and report what broke |

## Backends

A session runs on one of three, switched with `ccs-profile`:

- **`-`** — the Claude Code login. Needs the subscription.
- **`antigravity`** — the Antigravity CLI behind an Anthropic-shaped bridge on
  port 4001. **Needs no Claude subscription.** Gemini models.
- **`gemini`** — LiteLLM in front of a Google API key, port 4000. The container
  is stopped when nothing is on that profile and started when something is.

Switching relaunches the session and resumes the conversation, so history
carries over — including across backends.

## Where things are

- Work happens in `~/calisma`. Files arriving from the phone land in `gelen/`.
- Transcripts are `~/.claude/projects/<workdir>/<uuid>.jsonl`, one per
  conversation. They are plain files: readable with no login, no gateway and no
  subscription, which is the point of them.
- Server state is `~/.claude/claude-code-server/`; config is
  `~/.config/claude-code-server/config`.
- The source is `~/src/claude-code-server`; `./install.sh` deploys it to
  `~/.local/share/claude-code-server`. Editing the deployed copy is a mistake
  that survives until the next install and then vanishes.

## Scheduling work

Write a rule; do not loop. A model asked to check the time every minute is
expensive and answers differently each time. Put the intent in a systemd user
timer — `systemctl --user edit --force --full <name>.timer` — and let the timer
run a script. Ask a model again only when the intent changes or something
unexpected happens.

## Standing rules

- If the user asks to close **this** session, run `ccs-close --self`. Nothing
  else closes it; archiving in a client only tidies a list.
- Rebooting from inside a session is safe. The pool resumes the conversation
  afterwards at the same link.
- Do not manage other sessions unless asked. The phone app and `ccs-bot` are
  the usual way that happens.

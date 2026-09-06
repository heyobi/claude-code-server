# Working on claude-code-server

This is the source. It is deployed elsewhere, and that distinction is the first
thing to get right.

```
~/src/claude-code-server          you edit here
~/.local/share/claude-code-server ./install.sh copies it here; this is what runs
```

Editing the deployed copy appears to work and then vanishes at the next
install. If a change does not show up, check which copy you changed.

## The loop

```sh
./install.sh                       # source -> deployed
systemctl --user restart ccs-api   # only if bin/ changed; the web files are static
./bin/ccs-check                    # does it still work
```

The web app is cached by a service worker, so a client keeps the old files
until it reloads. Three numbers must move together or a phone will run new
markup against an old script:

- `BUILD` in `web/app.js`
- `app.js?v=NN` in `web/index.html`
- `ccs-shell-vNN` in `web/sw.js`

`ccs-check app` verifies exactly that, along with syntax and whether the
deployed copy still matches the source.

## What is where

| | |
|---|---|
| `bin/ccs-api` | the HTTP + SSE control plane the phone talks to |
| `bin/ccs_common.py` | session, transcript and pane helpers, shared |
| `bin/ccs-common.sh` | the same ideas for the shell tools |
| `bin/ccs-pool.sh` | restores after a reboot, renames a session after its topic |
| `bin/ccs-agy-bridge` | Anthropic Messages API in front of the Antigravity CLI |
| `bin/ccs-mcp` | the same capabilities as MCP tools, over stdio |
| `bin/ccs-check` | the tests: files end to end, and the app's own consistency |
| `web/` | the phone app: one page, one script, one worker |

## How to find out why something is wrong

The habit that has worked here, and the one that has not:

**Do not reason about the pane, read it.** `tmux capture-pane -p -t <session>`
is the ground truth for everything the live preview does, and three separate
preview bugs were found by looking at it and none by thinking about it.

**Record a whole turn before claiming a fix.** Open an SSE stream to a session,
send a message, and look at the events end to end:

```sh
T=$(ccs-api --print-token)
curl -sN -H "Authorization: Bearer $T" \
  "http://127.0.0.1:8787/api/events?session=NAME&offset=0&token=$T" > /tmp/turn.txt
```

A preview that flickers shows up as lengths going backwards. A duplicate shows
up as the same text arriving twice.

**The README holds the reasons.** Every non-obvious decision in here has a
paragraph explaining what went wrong first. Read the relevant section before
changing something that looks strange; it usually looks strange on purpose.

## Rules with teeth

- The token is in the query on `/api/file` and `/api/events`, because an `<img>`
  and an `EventSource` cannot send a header. Anything served from the workspace
  is therefore sandboxed by CSP. Do not relax that to make a report interactive.
- `inside()` is the boundary between browsing the project and browsing the
  disk. Every path from a client goes through it.
- Commands are run as argument lists, never through a shell.
- A filename from a client is folded to ASCII before it is stored: the pattern
  that finds a path in a message stops at a space, and the browser's `\w` is
  ASCII.

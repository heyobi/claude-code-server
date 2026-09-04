# Workspace notes

This machine runs [claude-code-server](https://github.com/heyobi/claude-code-server):
sessions live in tmux, a systemd timer keeps one idle session ready, and
conversations that were open before a reboot are resumed automatically.

## Closing this session

When the user asks to close, end, stop or archive **this** session — in any
language — run:

```bash
ccs-close --self
```

That stops the session and removes it from the pool's records, so it is not
brought back on the next reboot. The transcript stays on disk and the user can
reopen it later with `ccs-resume <session-id>`.

Do not just stop replying, and do not kill the tmux session by hand: without
removing the record the conversation reappears after a reboot.

Archiving the chat in the Claude apps does **not** close anything here. If the
user says they archived it and expects it gone, run `ccs-close --self`.

## Other session commands

| Command | What it does |
| --- | --- |
| `ccs-list` | sessions, whether each is idle, and where to open it |
| `ccs-new <topic>` | start another session named after a topic |
| `ccs-resume` | list earlier conversations; `ccs-resume <id>` reopens one |
| `ccs-close <name>` | close a different session |
| `ccs-close --idle` | close spare sessions, keeping one ready |

## Rebooting

Rebooting from inside a session is safe. The session dies with the machine, and
the pool resumes the conversation after boot at the same link, so the chat comes
back in the Claude apps on its own.

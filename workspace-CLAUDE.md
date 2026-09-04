# Workspace notes

This machine runs [claude-code-server](https://github.com/heyobi/claude-code-server):
sessions live in tmux, a systemd timer keeps one ready, and conversations that
were open before a reboot are resumed automatically.

Session control — switching model, listing sessions, opening and closing them —
is handled outside this session by `ccs-bot`, so you do not need to do any of it.

The one thing to do yourself: if the user asks to close **this** session, run
`ccs-close --self`. That stops it and drops the pool record so a reboot does not
bring it back; the transcript stays and `ccs-resume` reopens it. Archiving the
chat in the Claude apps does not close anything here.

Rebooting from inside a session is safe — the pool resumes the conversation
afterwards at the same link.

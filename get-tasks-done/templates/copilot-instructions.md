# Instructions for GTD

- Use the get-tasks-done skill when the user asks for GTD or uses a `gtd-*` command.
- Treat `/gtd-...` or `gtd-...` as command invocations and load the matching file from `.github/skills/gtd-*`.
- When a command says to spawn a subagent, prefer a matching custom agent from `.github/agents`.
- When a GTD command specifies required subagents, the command invocation is explicit authorization and request to spawn those subagents. If the runtime cannot spawn them, stop and ask instead of silently doing the required agent work inline.
- Do not apply GTD workflows unless the user explicitly asks for them.
- After completing any `gtd-*` command (or any deliverable it triggers: feature, bug fix, tests, docs, etc.), ALWAYS: (1) offer the user the next step by prompting via `ask_user`; repeat this feedback loop until the user explicitly indicates they are done.

---
name: gtd-manage
description: "config workspace | workstreams thread update inbox"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [config, workspace, workstreams, thread, pause-work, resume-work, update, inbox, pr-branch, undo]
---

Route to the appropriate management skill based on the user's intent.
`gtd-config` (settings + advanced + integrations + profile) and `gtd-workspace`
(new + list + remove) are post-#2790 consolidated entries.

| User wants | Invoke |
|---|---|
| Configure GTD settings (basic / advanced / integrations / profile) | gtd-config |
| Manage workspaces (create / list / remove) | gtd-workspace |
| Manage parallel workstreams | gtd-workstreams |
| Continue work in a fresh context thread | gtd-thread |
| Pause current work | gtd-pause-work |
| Resume paused work | gtd-resume-work |
| Update the GTD installation | gtd-update |
| Process inbox items | gtd-inbox |
| Create a clean PR branch | gtd-pr-branch |
| Undo the last GTD action | gtd-undo |

Invoke the matched skill directly using the Skill tool.

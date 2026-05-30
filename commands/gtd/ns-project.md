---
name: gtd-project
description: "project lifecycle | milestones audits summary"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
---

Route to the appropriate project / milestone skill based on the user's intent.
`gtd-plan-milestone-gaps` was deleted by #2790 — gap planning now happens
inline as part of `gtd-audit-milestone`'s output.

| User wants | Invoke |
|---|---|
| Start a new project | gtd-new-project |
| Create a new milestone | gtd-new-milestone |
| Complete the current milestone | gtd-complete-milestone |
| Audit a milestone for issues | gtd-audit-milestone |
| Summarize milestone status | gtd-milestone-summary |

Invoke the matched skill directly using the Skill tool.

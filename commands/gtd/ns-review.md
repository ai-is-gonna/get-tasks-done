---
name: gtd-quality
description: "quality gates | code review debug audit security eval ui"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [code-review, audit-uat, secure-phase, eval-review, ui-review, validate-phase, debug, forensics]
---

Route to the appropriate quality / review skill based on the user's intent.
`gtd-code-review-fix` was absorbed by `gtd-code-review --fix` in #2790.

| User wants | Invoke |
|---|---|
| Review code for quality and correctness | gtd-code-review |
| Auto-fix code review findings | gtd-code-review --fix |
| Audit UAT / acceptance testing | gtd-audit-uat |
| Security review of a phase | gtd-secure-phase |
| Evaluate AI response quality | gtd-eval-review |
| Review UI for design and accessibility | gtd-ui-review |
| Validate phase outputs | gtd-validate-phase |
| Debug a failing feature or error | gtd-debug |
| Forensic investigation of a broken system | gtd-forensics |

Invoke the matched skill directly using the Skill tool.

---
name: gtd-context
description: "codebase intelligence | map graphify docs learnings"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [map-codebase, graphify, docs-update, extract-learnings]
---

Route to the appropriate codebase-intelligence skill based on the user's intent.
`gtd-scan` and `gtd-intel` were folded into `gtd-map-codebase` flags by #2790.

| User wants | Invoke |
|---|---|
| Map the full codebase structure | gtd-map-codebase |
| Quick lightweight codebase scan | gtd-map-codebase --fast |
| Query mapped intelligence files | gtd-map-codebase --query |
| Generate a knowledge graph | gtd-graphify |
| Update project documentation | gtd-docs-update |
| Extract learnings from a completed phase | gtd-extract-learnings |

Invoke the matched skill directly using the Skill tool.

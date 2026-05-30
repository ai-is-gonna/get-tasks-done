---
name: gtd-workflow
description: "workflow | discuss plan tasks verify phase progress"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [discuss-phase, spec-phase, plan-phase, export-phase-issues, work-task-issue, orchestrate-tasks, verify-work, phase, progress, ultraplan-phase, plan-review-convergence]
---

Route to the appropriate phase-pipeline skill based on the user's intent.
Sub-skill names below are post-#2790 consolidated targets — `gtd-phase`
absorbs the former add/insert/remove/edit-phase commands and `gtd-progress`
absorbs the former next/do commands.

| User wants | Invoke |
|---|---|
| Gather context before planning | gtd-discuss-phase |
| Clarify what a phase delivers | gtd-spec-phase |
| Create a PLAN.md | gtd-plan-phase |
| Export planned tasks to GitHub issues | gtd-export-phase-issues |
| Work one exported task issue or finalize a completed phase with `--complete-phase <phase> --execute` | gtd-work-task-issue |
| Orchestrate multiple exported task issues through a bulk branch and comprehensive PR | gtd-orchestrate-tasks |
| Verify built features through UAT | gtd-verify-work |
| Add / insert / remove / edit a phase | gtd-phase |
| Advance to the next logical step | gtd-progress |
| Offload planning to the ultraplan cloud | gtd-ultraplan-phase |
| Cross-AI plan review convergence loop | gtd-plan-review-convergence |

Invoke the matched skill directly using the Skill tool.

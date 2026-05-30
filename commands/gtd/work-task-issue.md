---
name: gtd:work-task-issue
description: Work one exported GitHub task issue through an isolated task PR
argument-hint: "[issue-number|issue-url|task-id] [--phase <phase>] [--repo owner/name] [--read-only] [--complete-phase <phase> --execute]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
requires: [export-phase-issues]
---

<objective>
Resolve an exported GitHub task issue or select the next actionable task, run
exactly that task in an isolated task worktree, validate it, and open or update
the task PR.
</objective>

<execution_context>
@~/.claude/get-tasks-done/workflows/work-task-issue.md
</execution_context>

<context>
Arguments provided: "$ARGUMENTS"

Optional:
- Issue number, issue URL, or canonical exported task id such as `01-04-T02`.
- `--phase <phase>` to constrain the manifest scope.
- `--repo owner/name` to bind GitHub reads to a repository.
- `--read-only` to inspect workability without claiming, spawning, pushing, or
  opening a PR.
</context>

<process>
If `--complete-phase <phase> --execute` is present, run only the post-phase
finalization gates after reconciled summaries exist. If `--read-only` is
present, run the read-only selector and stop after reporting the selected task
or blocking state. Otherwise follow the execution workflow: state-sync labels,
claim one workable task, create or reuse the task worktree, spawn
`gtd-task-executor`, validate the result, push the task branch, and open or
update the task PR.
</process>

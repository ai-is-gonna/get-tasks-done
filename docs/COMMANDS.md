# Commands

This reference covers the public commands for the current GitHub-backed GTD
workflow. Use `/gtd-help` in an installed runtime for the complete local command
surface.

## Main Workflow

### `/gtd-discuss-phase`

Capture phase context before planning.

```bash
/gtd-discuss-phase <phase>
/gtd-discuss-phase <phase> --assumptions
/gtd-discuss-phase <phase> --all
```

### `/gtd-plan-phase`

Create or update task-ready plans for a phase.

```bash
/gtd-plan-phase <phase>
/gtd-plan-phase <phase> --ingest <path-or-glob>
```

The plan must define reviewable task blocks with scope, files, acceptance
criteria, and verification commands. New-project setup also writes an agent
instruction file such as `CLAUDE.md` or `AGENTS.md`, depending on the runtime.
Use `--ingest <path-or-glob>` when planning should incorporate existing local
decision records before task issues are exported.

### `/gtd-export-phase-issues`

Export planned work into GitHub parent plan issues and child task issues.

```bash
/gtd-export-phase-issues <phase> --dry-run
/gtd-export-phase-issues <phase>
/gtd-export-phase-issues <phase> --repo owner/repo
```

Run the dry run before writing issues.

### `/gtd-work-task-issue`

Work one exported child task issue, inspect task readiness, reconcile merged
task PRs, or complete the phase after reconciliation.

```bash
/gtd-work-task-issue --read-only --phase <phase>
/gtd-work-task-issue --phase <phase>
/gtd-work-task-issue <issue-number-or-task-id> --phase <phase>
/gtd-work-task-issue --complete-phase <phase> --execute
```

Task work is reviewed through PRs. Re-run the command after PRs merge so GTD can
reconcile completed task issues.

### `/gtd-orchestrate-tasks`

Batch related child task issues when they should be worked together.

```bash
/gtd-orchestrate-tasks <child-issue>... --dry-run
/gtd-orchestrate-tasks <child-issue>...
```

Use this for small, coherent batches. Keep unrelated task issues separate for
review clarity.

Phase, plan, remaining-task, task-id, and other natural-language selection is
resolved by the interactive layer before batch work starts. The
`orchestrate-tasks` utility itself only accepts exact child issue numbers, not
selectors, task IDs, issue URLs, or `--phase`.

Batch work starts with a mandatory Start Gate before creating branches, claims, comments, PRs, or executors.
The gate runs the helper with `--dry-run`. Passing `--dry-run` reports the Start Gate result and stops.
Mutating runs reuse the same issue list that passed the gate.

Human checkpoint tasks stay in scope as non-executable gates until the
checkpoint GitHub issue is closed. Comments are optional audit evidence and are not hard blockers.
Any recommended subset is only advisory; the full selected scope remains an
explicit operator choice.

### `/gtd-verify-work`

Run final phase verification after task PRs have been reconciled and the phase
has been completed.

```bash
/gtd-verify-work <phase>
```

## Supporting Commands

### `/gtd-progress`

Show current project status and the next recommended command.

```bash
/gtd-progress
/gtd-progress --next
/gtd-progress --forensic
```

### `/gtd-code-review`

Run structured review after task issue work and before final verification.

```bash
/gtd-code-review <phase>
/gtd-code-review <phase> --fix
```

### `/gtd-config`

View or update GTD configuration.

```bash
/gtd-config
/gtd-config --advanced
/gtd-config --integrations
```

### `/gtd-update`

Update installed GTD runtime files.

```bash
/gtd-update
```

### `/gtd-phase`

Inspect, edit, insert, or remove phase metadata.

```bash
/gtd-phase --edit <phase>
```

### `/gtd-workspace`

Create, list, inspect, or remove GTD workspaces.

```bash
/gtd-workspace --new --name <name>
/gtd-workspace --list
/gtd-workspace --status <name>
/gtd-workspace --remove <name>
```

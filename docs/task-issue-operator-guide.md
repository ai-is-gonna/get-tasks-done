# Task Issue Operator Guide

Use this guide after a phase has been discussed and planned. The current public
workflow is GitHub-backed: plans become task issues, implementation happens in
issue-scoped PRs, humans review and merge those PRs, then GTD reconciles and
verifies the phase.

## Workflow

```text
discuss -> plan -> export task issues -> work task PRs -> human review/merge -> reconcile -> complete phase -> verify
```

## 1. Discuss And Plan

```bash
/gtd-discuss-phase <phase>
/gtd-plan-phase <phase>
```

Discussion captures the phase context. Planning turns that context into
reviewable task blocks with scope, files, acceptance criteria, and verification
commands. Fix planning gaps before exporting.

## 2. Export Task Issues

Preview the GitHub issue graph first:

```bash
/gtd-export-phase-issues <phase> --dry-run
```

When the preview is correct, export the parent plan issues and child task issues:

```bash
/gtd-export-phase-issues <phase>
```

Use `--repo owner/repo` only when repository detection is missing or ambiguous.

## 3. Work Task Issues

Work the next ready task issue:

```bash
/gtd-work-task-issue --phase <phase>
```

Or select a specific child task issue, issue URL, or task id:

```bash
/gtd-work-task-issue 01-04-T02 --phase <phase>
```

For a small related batch, use the batch task issue command:

```bash
/gtd-orchestrate-tasks <child-issue>...
```

Each task should produce a focused PR. Humans review and merge task PRs before
phase reconciliation.

## 4. Reconcile

After task PRs are merged, run:

```bash
/gtd-work-task-issue --phase <phase>
```

GTD syncs GitHub issue state, detects completed child task issues, and reports
which parent plans are ready for reconciliation. Reconciliation creates or
updates the summary artifacts that prove the plan is complete.

## 5. Complete The Phase

Once every exported parent plan has been reconciled, run:

```bash
/gtd-work-task-issue --complete-phase <phase> --execute
```

This runs the post-phase gates and phase completion updates. It is not a
replacement for task PR review.

## 6. Verify Work

Run final phase verification:

```bash
/gtd-verify-work <phase>
```

If verification finds gaps, update or add plans, export the changed task issues,
work the new PRs, reconcile again, and re-run verification.

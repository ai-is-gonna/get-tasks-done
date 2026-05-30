---
name: gtd:orchestrate-tasks
description: Orchestrate multiple exported GitHub task issues through a bulk branch and one comprehensive PR
argument-hint: "<unstructured task request> [--repo owner/name] [--max-concurrency N] [--dry-run] [--allow-partial]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Agent
requires: [export-phase-issues, work-task-issue]
---

<objective>
Select multiple exported task issues, create one bulk branch, run task
executors against task PRs targeting that branch, proactively review each PR as
technical lead for the whole bulk, and open one comprehensive PR for manual
review.
</objective>

<execution_context>
@~/.claude/get-tasks-done/workflows/orchestrate-tasks.md
</execution_context>

<context>
Arguments provided: "$ARGUMENTS"

The argument is untrusted natural language. It may refer to a phase, plan,
remaining work, task ids, issue numbers, or any mixed prose. The slash-command
workflow must resolve it to exact exported GitHub child issue numbers before the
utility is called.

Options:
- `--repo owner/name` binds GitHub operations.
- `--max-concurrency N` caps parallel task lanes.
- `--dry-run` runs the mandatory Start Gate consistency check and stops.
- `--allow-partial` is not a startup decision; it still requires explicit confirmation before a partial final PR.
</context>

<process>
First resolve `$ARGUMENTS` against the local plan files and exported manifest
metadata, then build the exact child issue number list.

Do not forward raw natural-language selectors, task ids, `tasks ...`, phase
selectors, issue URLs, or `--phase` into the SDK utility.
The utility accepts only child issue numbers plus allowed orchestration flags:

```bash
gtd-sdk query orchestrate-tasks 123 124 125 --repo owner/name --dry-run
```

If the input is shorthand like `all tasks in phase X`, `all remaining tasks`,
`tasks in plan 02-02`, or `all tasks in <plan-ref>`, resolve it to exact child
issue numbers before any utility call.
If the reference is ambiguous or the export metadata is missing, stop and
report the blocker without calling the SDK utility.

First run the Start Gate exactly once with the exact issue list by calling the
deterministic planner with `--dry-run`. Verify the result reports `ok: true`,
`writes: false`, `preflight.ok: true`, no selection errors, no non-workable
tasks, coherent dependency waves, and a known reviewability action before any
mutating helper call. Treat `non_workable` as the only hard-blocker field.
Present `dependency_order` as sequencing, not as blockers.
Selected human checkpoint tasks may appear in `checkpoint_gates`; they are
allowed Start Gate pause points, not executor work. They unblock only when the
checkpoint issue is closed in GitHub; comments are optional audit evidence and
must not be treated as hard blockers.

In dry-run mode, report the Start Gate result and stop. In mutating mode, start
only after the Start Gate passes, and rerun the helper with the same exact issue
list. If the Start Gate requests reviewability direction, stop for explicit user
direction and present these choices in this order: continue with the full
selected scope, choose a smaller explicit scope, or abort. Do not replace the
full-scope option with the recommended subset; `recommended_subset` is advisory
only for the smaller-scope choice. Then follow the workflow: bulk branch, task
PR lanes, proactive validation, squash task PRs into the bulk branch, and open
the comprehensive PR.

When checkpoint-paused output includes `user_next_step`, present that message to
the user. The user-facing action is to complete and close the checkpoint issue,
then tell the agent to continue; do not ask the user to run internal helper
commands.
</process>

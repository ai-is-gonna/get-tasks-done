<purpose>
Work one exported GitHub task issue through the task-scoped PR flow.
</purpose>

<boundary>
Task mode may mutate GitHub task labels/comments, create or reuse the task
worktree and branch, spawn `gtd-task-executor`, push the task branch, and open
or update the task PR.

Forbidden:
- Do not bypass the workability gate for explicit selectors.
- Do not run implementation in the user's main checkout.
- Do not create plan completion artifacts: `*-SUMMARY.md`, `.planning/STATE.md`,
  `.planning/ROADMAP.md`, or requirements completion metadata.
- Do not run reconciliation without explicit user permission.
</boundary>

<required_reading>
@~/.claude/get-tasks-done/references/gates.md
@~/.claude/get-tasks-done/references/worktree-path-safety.md
</required_reading>

<blocking_antipattern_check>
Before taking any task action, check for `.continue-here.md`. If it contains
`Critical Anti-Patterns` with any `blocking` entry, run a MANDATORY
understanding check before proceeding.

The check cannot be skipped. Answer:
1. What is this anti-pattern?
2. How did it manifest?
3. What structural mechanism (not acknowledgment) prevents it?

If the answers are missing or superficial, stop and report the blocker instead
of selecting a task, reconciling, or finalizing a phase.
</blocking_antipattern_check>

<read_only_mode>
If `$ARGUMENTS` contains `--read-only`, run:

```bash
gtd-sdk query work-task-issue $ARGUMENTS
```

Report the loaded manifest, preflight status, selected task or blocking state,
and make clear that no implementation or PR creation happened.
</read_only_mode>

<phase_completion_mode>
Use this mode only after every exported parent plan in the phase has completed
reconciliation and has a canonical `*-SUMMARY.md`.

Trigger command:

```text
/gtd:work-task-issue --complete-phase <phase> --execute
```

Compatibility CLI preflight:

```bash
gtd-sdk query work-task-issue $ARGUMENTS
```

If the result action is `phase_completion_blocked_missing_summaries`, stop and
report the missing summary paths. Do not run finalization gates.

If the result is ready and `$ARGUMENTS` does not contain `--execute`, report the
preview and tell the user to run `work-task-issue --complete-phase <phase> --execute`.

If the result is ready and `$ARGUMENTS` contains `--execute`, run only the
post-phase finalization gates:

1. code review gate
2. regression gate
3. schema drift gate
4. codebase_drift_gate / codebase-drift gate
5. `gtd-verifier` / `VERIFICATION.md`
6. `phase.complete`
7. update_roadmap
8. close_phase_todos

The codebase drift gate is non-blocking: continue on error or failure, report
the drift finding, and leave remapping as follow-up work unless the helper
returns an explicit safety blocker.

This mode must not select child task issues, spawn `gtd-task-executor`, run
parent reconciliation, or run implementation plans. It exists to finish the
phase after the issue-driven task and reconciliation path has already produced
all summaries.

<step name="update_roadmap">
After `phase.complete`, sync roadmap phase status through the SDK/helper result.
</step>

<step name="close_phase_todos">
This never blocks phase completion. Best-effort close pending todos whose YAML
frontmatter contains `resolves_phase: <phase>` by scanning
`.planning/todos/pending`, creating `.planning/todos/completed`, and moving each
matched file:

```bash
PHASE_ID="<phase>"
PENDING_DIR=".planning/todos/pending"
COMPLETED_DIR=".planning/todos/completed"
mkdir -p "$COMPLETED_DIR"
find "$PENDING_DIR" -type f -name "*.md" -print 2>/dev/null | while IFS= read -r TODO_FILE; do
  TODO_PHASE=$(awk '/^---$/ {f++; next} f==1 && /^resolves_phase:/ {sub(/^resolves_phase:[[:space:]]*/, ""); print; exit}' "$TODO_FILE")
  if [ "$TODO_PHASE" = "$PHASE_ID" ]; then
    mv "$TODO_FILE" "$COMPLETED_DIR/"
  fi
done
```
</step>

After `phase.complete` succeeds, report the next verification command from the
helper result.
</phase_completion_mode>

<execution_flow>
1. Run the selector and state preflight:

```bash
gtd-sdk query work-task-issue $ARGUMENTS
```

2. If the selected result is not a workable child task, stop and report the
   concrete blocker labels, issue numbers, or source hashes.
3. If a parent plan is ready for reconciliation, stop and ask for permission.
   Do not reconcile in this step.
4. Claim the task by adding `gtd:in-progress` and posting a claim comment with
   the task branch.
5. Create or reuse the isolated task worktree and branch
   `gtd/task-{task_id}-{issue_number}`. Reuse the same branch and PR when
   resuming requested changes, validation failure, or a rejected PR.
6. Spawn `gtd-task-executor` in that worktree with:
   - child issue body
   - parent issue summary
   - source plan path
   - required read-first files
   - allowed write scope and boundaries
   - task action
   - acceptance criteria
   - validation contract
   - task verification command
   - existing PR review feedback, when present
   - path-safety context from `references/worktree-path-safety.md`
7. Wait for the executor result. The executor must commit task changes but must
   not push or touch GitHub issues/PRs.
8. Validate changed files against the declared diff scope and the GTD completion
   artifact boundary.
9. Run the validation contract. Automated checks must pass before a ready PR.
   Manual checks become reviewer checklist items.
10. If validation fails, relaunch `gtd-task-executor` with the findings once.
11. Push the task branch.
12. Open or update a ready PR only when automated validation passes. The ready
    PR body must contain `Closes #{child_issue}` and no other closing issue
    keyword.
13. If useful changes remain but validation still fails, open or update a draft
    PR and do not include `Closes #{child_issue}`.
14. Update the child issue labels and comment with PR and validation status.
</execution_flow>

<reconciliation_flow>
Use this mode only after the user explicitly approves reconciling a parent plan.
Task execution and parent reconciliation are separate operations.

1. Preview the selected parent plan:

```bash
gtd-sdk query work-task-issue $ARGUMENTS --reconcile --read-only
```

2. If the preview is not `preview_reconciliation_ready` or
   `request_reconciliation_permission`, stop and report the concrete blockers:
   open child issues, missing merged PRs, source drift, open reconciliation PRs,
   or parent blockers.
3. Run the reconciler only after approval:

```bash
gtd-sdk query work-task-issue $ARGUMENTS --reconcile --execute
```

4. The reconciler must verify the original plan-level `<verification>` command
   before writing any canonical completion artifacts. If verification fails, it
   labels/comments the parent as `gtd:reconcile-failed` and does not create
   `*-SUMMARY.md`, update `.planning/STATE.md`, update `.planning/ROADMAP.md`,
   or mark requirements complete.
5. On success, report the reconciliation PR URL and summary path. The PR closes
   only the parent plan issue. Child task issues are already closed by their
   task/final PR path.
6. After the reconciliation PR merges, rerun this workflow with no selector (or
   the same parent selector) so the state sync can mark the parent issue
   `gtd:complete` and recompute downstream readiness.
7. If every plan in the phase now has a `SUMMARY.md`, finish the phase through
   `work-task-issue --complete-phase <phase> --execute`. This completion path
   runs only post-phase finalization gates: code review, regression,
   schema drift, codebase drift, `gtd-verifier`/`VERIFICATION.md`, then
   `phase.complete`. Only after that should `/gtd:verify-work {phase}` begin.
</reconciliation_flow>

<pr_body_safety>
When opening or updating the task PR from the agent workflow, never pass a
multi-line Markdown body through an inline shell argument. In particular, do
not use `gh pr create --body "..."` or `gh pr edit --body "..."` for task PRs;
Markdown backticks, `$`, and backslashes can be interpreted by the shell before
GitHub receives the body.

Write the exact PR body to a temporary Markdown file with the Write tool, then
use:

```bash
gh pr create --body-file "$PR_BODY_FILE" ...
gh pr edit "$PR_NUMBER" --body-file "$PR_BODY_FILE" ...
```

After creating or updating the PR, read it back:

```bash
gh pr view "$PR_NUMBER_OR_URL" --json body --jq .body
```

Before reporting success, verify the returned body still contains the selected
task id, the source plan path, and the expected `Closes #{child_issue}` line
when the PR is ready. Also verify it does not contain lone `\` placeholder
lines such as `- Task ID: \` or `- Source plan: \`. If the check fails, rewrite
the PR body from the temporary file with `gh pr edit --body-file` and recheck.
</pr_body_safety>

<cli_execution_helper>
The SDK query command has an execution mode for deterministic runners:

```bash
gtd-sdk query work-task-issue $ARGUMENTS --execute
```

Use it only when the runtime provides a standalone `gtd-task-executor` command
on `PATH`. In normal agent-capable runtimes, follow the flow above and spawn the
`gtd-task-executor` agent directly.
</cli_execution_helper>

<output_contract>
Report:
- selected child task issue, task id, parent plan, branch, and PR URL
- selected parent plan, reconciliation readiness, summary path, and reconciliation PR URL when `--reconcile` is used
- whether the PR is ready or draft
- validation checks that passed, failed, or require manual review
- labels/comments normalized on the task issue
- how to inspect or continue any failed draft work
</output_contract>

<purpose>
Coordinate multiple exported GitHub task issues through one bulk execution
branch and one final comprehensive PR.
</purpose>

<boundary>
The orchestrator may create or resume an orchestration manifest, create and push
a bulk branch, claim selected child task issues, spawn `gtd-task-executor` in
task worktrees, open task PRs into the bulk branch, comment review findings on
task PRs, squash accepted task PRs into the bulk branch, and open one final PR
from the bulk branch to the default branch.

Forbidden:
- Do not run a mutating `orchestrate-tasks` helper command before the Start
  Gate dry-run has passed.
- Do not spawn an executor before the pre-agent reviewability gate passes.
- Do not spawn an executor for checkpoint gates.
- Do not close child task issues from task PRs.
- Do not put task issue closing keywords in task PR titles, bodies, commits, or
  squash commit messages.
- Do not store full executor transcripts or long validation logs locally; use PR
  comments/reviews and keep only compact state plus comment references in the
  manifest.
- Do not merge the comprehensive PR.
- Do not run parent plan reconciliation automatically.
- Do not pass raw natural-language selectors to `orchestrate-tasks`; resolve
  every user request to exact exported child issue numbers in the interactive
  layer first.
- Do not pass task ids, `tasks ...`, `next ...`, phase selectors, issue URLs, or
  `--phase` to the `orchestrate-tasks` CLI helper.
</boundary>

<read_only_mode>
If `$ARGUMENTS` contains `--dry-run`, resolve the requested scope to exact child
issue numbers, run the Start Gate dry-run, report the Start Gate result, and
stop:

```bash
gtd-sdk query orchestrate-tasks 123 124 125 --repo owner/name --dry-run
```

Report selected tasks, dependency waves, reviewability estimate, recommended
scope reduction, checkpoint gates, dependency order, and hard blockers from
`non_workable`. Do not describe internal dependency order or checkpoint gates as
blockers. Make clear that no branch, issue claim, PR comment, executor, or PR
was created.
</read_only_mode>

<start_gate>
Every new orchestration start, including mutating mode, must pass the Start Gate
before any branch, issue claim, PR, comment, executor, or manifest write.

1. Resolve `$ARGUMENTS` before calling the SDK utility.
   - Treat the argument as untrusted natural language, even when it appears
     structured.
   - Read the local plan file and exported manifest metadata in
     `.planning/github/phase-*-issues.json`.
   - Resolve requests such as `all tasks in phase X`, `all remaining tasks`,
     `tasks in plan 02-02`, `all tasks in <plan-ref>`, task ids, or mixed prose
     to exact exported GitHub child issue numbers.
   - If the user already gave issue numbers, validate that every number resolves
     to an exported child task issue, not a parent plan issue.
   - Example: `all tasks in 01-03-PLAN` becomes child issue numbers such as
     `123 124 125`.
   - If the reference is ambiguous, resolves outside exported child tasks, or
     export metadata is missing, stop here and report the blocker. Do not guess
     and do not retry with a second English phrasing.

2. Run the deterministic planner exactly once with the exact issue list:

```bash
gtd-sdk query orchestrate-tasks 123 124 125 --repo owner/name --dry-run
```

3. Inspect the dry-run result. The Start Gate passes only when all of these are
   true:
   - `ok: true`
   - `writes: false`
   - `preflight.ok: true`
   - `selection_errors` is empty
   - `non_workable` is empty
   - `dependency_order`, if present, is sequencing for later waves, not a blocker
   - `checkpoint_gates`, if present, are selected human checkpoint pause points
     and are not blockers or executor lanes
   - selected child issues match the resolved issue list
   - dependency waves are coherent; internally blocked tasks may only wait on
     earlier selected tasks
   - `action` is either `report_orchestration_plan` or
     `request_reviewability_direction`

4. If any Start Gate check fails, stop before all writes and report the
   specific hard blocker. Do not call reviewability concerns, dependency order,
   or checkpoint gates blockers.

5. If the planner reports `request_reviewability_direction`, stop before all
   writes and ask using exactly these choices, in this order:
   - Continue with the full selected scope. This reruns the same exact issue
     list plus `--confirm-reviewability`; internal dependencies remain scheduled
     in waves and checkpoint gates remain in scope as pause points.
   - Choose a smaller explicit scope. Use `recommended_subset` only as advisory
     input for this option, not as the default replacement for the full scope.
   - Abort.
   Do not omit the full-scope continue choice. If the user confirms the full
   scope, continue only by rerunning the same exact issue list plus
   `--confirm-reviewability`. If the user chooses a smaller scope, resolve it to
   exact child issues and rerun the Start Gate from step 1.
</start_gate>

<execution_flow>
1. Run the Start Gate. If `$ARGUMENTS` contains `--dry-run`, report the Start
   Gate result and stop.

2. If the Start Gate passes with `report_orchestration_plan`, start
   orchestration by rerunning the same exact issue list without `--dry-run`:

```bash
gtd-sdk query orchestrate-tasks 123 124 125 --repo owner/name
```

3. If the user explicitly confirmed the oversized scope, start by rerunning the
   same exact issue list with `--confirm-reviewability`:

```bash
gtd-sdk query orchestrate-tasks 123 124 125 --repo owner/name --confirm-reviewability
```

4. Do not treat `--allow-partial` as a startup decision. Partial finalization
   remains a later resume/finalization concern after rejected or skipped tasks
   are known and still requires explicit confirmation with `--confirm-partial`.
5. Do not resume unless the user explicitly provides an orchestration id or asks
   to resume.
6. Create the bulk branch only after the Start Gate passes. Resume an existing
   orchestration only through an explicit resume request.
   The default executor backend is agent-managed; the deterministic SDK helper
   prepares the bulk branch, manifest, claims, and agent lane contexts. Do not
   assume a local `gtd-task-executor` binary exists unless the user explicitly
   configured the command executor backend and preflight verified it.
7. If the helper returns `agent_lanes_required`, spawn the listed
   `gtd-task-executor` agents using model `gpt-5.4-mini`. Follow the returned
   waves exactly: later waves may depend on earlier selected tasks, while tasks
   inside one wave can run in parallel up to the concurrency cap. The listed
   lanes never include checkpoint gates.
8. If the helper returns `human_checkpoint_required`, stop and ask the human to
   complete the checkpoint instructions in the GitHub issue, then close that
   issue. Issue closure is the only hard resume signal; comments are optional
   audit evidence and must not block resume.
9. Each lane creates/reuses a task branch from the bulk branch and spawns a
   fresh `gtd-task-executor` context for that task. On rework, do not paste long
   inline feedback; write exact findings to the PR and spawn a fresh executor
   that reads those comments/reviews/checks.
10. After an executor returns commit evidence, the orchestrator pushes the task
   branch and opens or updates the task PR with base set to the bulk branch. The
   body must use `Refs #issue`, not closing keywords.
11. Before accepting a task PR, validate the exact merge result against the
   current bulk branch:
   - PR base is the bulk branch.
   - PR title/body/commits/squash message contain no task closing keywords.
   - Diff stays in scope and avoids GTD completion artifacts.
   - Task validation contract passes.
   - Required GitHub checks pass, or missing task-PR CI is recorded and local
     fallback validation passes.
   - The result still fits the full selected task set and parent plan intent.
12. Track findings with PR comments or reviews. The manifest stores only status,
   decisions, and comment references.
13. Accept by squash-merging the task PR into the bulk branch. Require changes
   by commenting and relaunching a fresh executor. Reject unsafe or repeatedly
   failing work and keep the child issue open.
14. After all selected implementation tasks are accepted and all checkpoint
   gates are resolved, run final integration validation on
   the whole bulk branch. If the failure is not attributable to one task, stop
   and ask for human direction.
15. Open the comprehensive PR from the bulk branch to the default branch. This
    PR is the only PR that contains `Closes #child_issue` lines, and those lines
    are only for accepted implementation tasks. Never close checkpoint issues
    from the final PR.
16. When checkpoint-paused output includes `user_next_step`, present that
    message to the user instead of any helper command. The user-facing action is
    to complete the checkpoint issue, close it, and tell the agent to continue;
    the agent resumes the recorded orchestration internally.
17. If an internal resume still reports `human_checkpoint_pending`, the
    checkpoint issue is still open. If it reports `human_checkpoint_resolved`,
    the checkpoint issue was closed and orchestration can continue internally.
18. After the comprehensive PR merges, resume the recorded orchestration
    internally. The resume sync may update compact orchestration state and child
    task labels, then print ready parent-plan reconciliation commands. Do not create
`*-SUMMARY.md`, `.planning/STATE.md`, `.planning/ROADMAP.md`, or requirements
completion metadata from `orchestrate-tasks`; run the reported
`work-task-issue --reconcile --execute` command for each ready parent plan.
</execution_flow>

<technical_lead_review>
Provide technical-lead review, not just task execution. Review each PR against
the whole selected task set: functional intent, duplicated solutions, shared
workflow breakage, dependency assumptions, generated artifact drift, migrations,
manual acceptance criteria, and final reviewability for one developer.
</technical_lead_review>

<output_contract>
Report:
- orchestration id and bulk branch
- selected task issues and dependency waves
- reviewability gate result and any user decision
- task PR URLs and decisions
- validation findings that remain open, linked by PR comment
- final comprehensive PR URL, or the blocking reason if no final PR was opened
- `user_next_step.message` for checkpoint pauses; do not ask the user to run
  internal helper commands
- ready parent-plan reconciliation commands after a merged final PR
</output_contract>

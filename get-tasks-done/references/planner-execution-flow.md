# Planner Execution Flow

This reference holds the operational runbook for `agents/gtd-planner.md`.
Load it after mode-specific context and before writing plans.

## Load Project State

Run `gtd-sdk query init.plan-phase "${PHASE}"` and resolve `@file:` output if
present. Extract `planner_model`, `researcher_model`, `checker_model`,
`commit_docs`, `research_enabled`, `phase_dir`, `phase_number`,
`has_research`, and `has_context`.

Also run `gtd-sdk query state.load`. If `STATE.md` is missing but `.planning/`
exists, offer to reconstruct or continue without it.

## Load Context

Read the active mode reference first:

- Gap closure: `get-tasks-done/references/planner-gap-closure.md`
- Revision: `get-tasks-done/references/planner-revision.md`
- Reviews: `get-tasks-done/references/planner-reviews.md`

Then gather planning context:

- `.planning/ROADMAP.md` and `.planning/phases/`
- Existing `PLAN.md` or `DISCOVERY.md` in the phase directory
- `$phase_dir/*-CONTEXT.md`, `$phase_dir/*-RESEARCH.md`, and `$phase_dir/*-DISCOVERY.md`
- Relevant `.planning/codebase/*.md` files by phase type
- `gtd-sdk query history-digest`, then full SUMMARY files for the top 2-4 relevant prior phases
- `.planning/RETROSPECTIVE.md` tail when present
- `gtd-sdk query learnings.query --tag <tag> --limit 5` when global learnings are enabled

If `.planning/graphs/graph.json` exists, use `gtd-tools.cjs graphify status`
and `graphify query "<phase-goal-keyword>" --budget 2000`; graphify is not
exposed through `gtd-sdk query` yet.

If `RESEARCH.md` has an `## Architectural Responsibility Map`, cross-reference
each task against it and correct tier misassignments before finalizing.

## Build Plans

Apply mandatory discovery rules, then decompose dependencies before sequence.
For each candidate task, record what it needs, what it creates, and whether it
requires a checkpoint. Apply TDD detection, user setup detection, file ownership
constraints, and vertical-slice preference.

Assign waves from explicit dependencies and file overlap. Same-wave plans must
have zero `files_modified` overlap. Group tasks into plans using these rules:

- Same-wave tasks with no file conflicts can be parallel plans.
- Shared files either stay in the same plan or force a later wave.
- Checkpoint tasks make the plan `autonomous: false`.
- Each plan has 2-3 tasks, one concern, and a roughly 50% context target.

Derive `must_haves` goal-backward: observable truths, required artifacts, and
critical links. Reachability-check each must-have before writing.

## Write And Validate

Create PLAN files with the exact name `{padded_phase}-{NN}-PLAN.md` under
`.planning/phases/{padded_phase}-{slug}/`. Include all required frontmatter.

Validate every file:

- `gtd-sdk query frontmatter.validate "$PLAN_PATH" --schema plan`
- `gtd-sdk query verify.plan-structure "$PLAN_PATH"`

Fix missing frontmatter, task contract errors, atomicity blockers, and
checkpoint/autonomous mismatches before returning.

Update `.planning/ROADMAP.md`: derive the phase goal only if it is still a
placeholder, update `**Plans:** {N} plans`, and replace the plan list with the
new PLAN filenames and brief objectives.

When `commit_docs` is enabled, commit plan docs with `gtd-sdk query commit`.

## Return

Return the compact structured result described in `agents/gtd-planner.md`.
Next steps must route planned implementation through task issues:

- Export: `/gtd:export-phase-issues {phase} --repo owner/name`
- Work: `/gtd:work-task-issue ...` or `/gtd:orchestrate-tasks ...`
- Finish: `/gtd:work-task-issue --complete-phase {phase} --execute`

---
name: gtd:health
description: Diagnose planning directory health and optionally repair issues
argument-hint: "[--repair] [--context]"
allowed-tools:
  - Read
  - Bash
  - Write
  - AskUserQuestion
requires: [thread]
---
<objective>
Validate `.planning/` directory integrity and report actionable issues. Checks for missing files, invalid configurations, inconsistent state, and orphaned plans.

`--context` runs an orthogonal check: the running session's context utilization. The workflow asks for the model's tokensUsed + contextWindow, calls `gtd-sdk query validate.context`, and renders one of three states:

| Utilization | State    | Action                                                |
|-------------|----------|-------------------------------------------------------|
| < 60%       | healthy  | no action — context is comfortable                    |
| 60% – 70%   | warning  | recommend `/gtd:thread` to start fresh                |
| ≥ 70%       | critical | reasoning quality may degrade past the fracture point |
</objective>

<execution_context>
@~/.claude/get-tasks-done/workflows/health.md
</execution_context>

<process>
Execute end-to-end.
Parse `--repair` and `--context` flags from arguments and pass to workflow.
</process>

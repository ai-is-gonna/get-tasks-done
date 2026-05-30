---
name: gtd:import
description: Ingest external plans with conflict detection against project decisions before writing anything.
argument-hint: "--from <filepath>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
---

<objective>
Import external plan files into the GTD planning system with conflict detection against PROJECT.md decisions.

- **--from**: Import an external plan file, detect conflicts, write as GTD PLAN.md, validate via gtd-plan-checker.
</objective>

<execution_context>
@~/.claude/get-tasks-done/workflows/import.md
@~/.claude/get-tasks-done/references/ui-brand.md
@~/.claude/get-tasks-done/references/gate-prompts.md
@~/.claude/get-tasks-done/references/doc-conflict-engine.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the import workflow end-to-end.
</process>

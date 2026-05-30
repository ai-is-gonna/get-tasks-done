---
name: gtd:explore
description: Socratic ideation and idea routing — think through ideas before committing to plans
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---
<objective>
Open-ended Socratic ideation session. Guides the developer through exploring an idea via
probing questions, optionally spawns research, then routes outputs to the appropriate GTD
artifacts (notes, todos, seeds, research questions, requirements, or new phases).

Accepts an optional topic argument: `/gtd:explore authentication strategy`
</objective>

<execution_context>
@~/.claude/get-tasks-done/workflows/explore.md
</execution_context>

<process>
Execute end-to-end.
</process>

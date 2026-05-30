<purpose>
One-page newcomer-oriented tour of GTD. Output ONLY the `<reference>` content below. No additions.
</purpose>

<reference>
# GTD — Get Tasks Done

Plan-driven development for solo agentic work with Claude Code. GTD turns a vague idea into a hierarchical plan, then executes it phase by phase with state tracking and atomic commits.

## Start here

```text
/gtd:new-project                         # Greenfield: questioning → requirements → roadmap
/gtd:plan-phase 1                        # Create a detailed phase plan
/gtd:export-phase-issues 1
/gtd:work-task-issue --phase 1           # Or orchestrate a small task batch
/gtd:work-task-issue --complete-phase 1 --execute
```

Existing codebase? Run `/gtd:map-codebase` first to ground GTD in your code.

## Common commands

| Command | Purpose |
|---|---|
| `/gtd:progress` | Where am I, what's next — also routes freeform intent with `--do "..."` |
| `/gtd:quick` | Small ad-hoc task with GTD guarantees (planning dir + atomic commit) |
| `/gtd:fast "<task>"` | Trivial inline change — no subagents, ≤3 file edits |
| `/gtd:discuss-phase <N>` | Capture vision and decisions before planning |
| `/gtd:work-task-issue --phase <N>` | Work the next exported task issue |
| `/gtd:debug "<symptom>"` | Persistent debug session, survives `/clear` |
| `/gtd:capture` | Save an idea, todo, note, seed, or backlog item |
| `/gtd:verify-work <N>` | Conversational UAT for a completed phase |
| `/gtd:help --full` | Complete reference (every command, every flag) |

## Want more?

```text
/gtd:help --brief         # 10-line refresher of top commands
/gtd:help --full          # complete reference
/gtd:help <topic>         # one section only — see topics below
/gtd:help --brief <topic> # compact scoped lookup — signature + one-line summary
```

Topics: `workflow` · `planning` · `execute` · `quick` · `debug` · `capture` · `pr` · `config` · `milestones` · `spike` · `sketch` · `review` · `audit` · `progress`

## Update GTD

```bash
npx @ai-is-gonna/get-tasks-done@latest
```
</reference>

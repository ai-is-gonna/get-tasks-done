---
name: gtd:config
description: Configure GTD settings — workflow toggles, advanced knobs, integrations, and model profile
argument-hint: "[--advanced | --integrations | --profile <name>]"
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
requires: [code-review, review, settings]
---

<objective>
Configure GTD settings interactively with a single consolidated command.

Mode routing:
- **default** (no flag): Common-case toggles (model, research, plan_check, verifier, branching) → settings workflow
- **--advanced**: Power-user knobs (planning tuning, timeouts, branch templates, cross-AI execution) → settings-advanced workflow
- **--integrations**: Third-party API keys, code-review CLI routing, agent-skill injection → settings-integrations workflow
- **--profile <name>**: Switch model profile (quality|balanced|budget|inherit) → set-profile (inline)
</objective>

<routing>

| Flag | Action | Workflow |
|------|--------|----------|
| (none) | Interactive 5-question common-case config prompt | settings |
| --advanced | Power-user knobs: planning, execution, discussion, cross-AI, git, runtime | settings-advanced |
| --integrations | API keys (Brave/Firecrawl/Exa), review CLI routing, agent skills | settings-integrations |
| --profile &lt;name&gt; | Switch model profile without interactive prompt | gtd-sdk config-set-model-profile |

</routing>

<execution_context>
@~/.claude/get-tasks-done/workflows/settings.md
@~/.claude/get-tasks-done/workflows/settings-advanced.md
@~/.claude/get-tasks-done/workflows/settings-integrations.md
</execution_context>

<context>
Arguments: $ARGUMENTS

Parse the first token of $ARGUMENTS:
- If it is `--advanced`: strip the flag, execute settings-advanced workflow
- If it is `--integrations`: strip the flag, execute settings-integrations workflow
- If it starts with `--profile`: extract the profile name (remainder after `--profile`), then:
  1. **Pre-flight check (#2439):** verify `gtd-sdk` is on PATH via `command -v gtd-sdk`.
     If absent, emit the install hint `Install GTD via 'npm i -g get-tasks-done'` and stop —
     do NOT invoke `gtd-sdk` directly (avoids the opaque `command not found: gtd-sdk` failure).
  2. Run: `gtd-sdk query config-set-model-profile <profile-name> --raw` and display the output verbatim.
- Otherwise: execute settings workflow (no argument needed)
</context>

<process>
1. Parse the leading flag (if any) from $ARGUMENTS.
2. Load and execute the appropriate workflow end-to-end, or run the inline SDK command for --profile.
3. Preserve all workflow gates from the target workflow.
</process>

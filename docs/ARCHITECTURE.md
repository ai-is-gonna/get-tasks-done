# Architecture

Get Tasks Done is a workflow layer for AI-assisted development. It coordinates
planning artifacts, runtime commands, agents, GitHub task issues, PR review, and
verification.

## Main Components

| Component | Role |
|---|---|
| Commands | User-facing `/gtd-*` entry points installed into supported runtimes. |
| Workflows | Markdown procedures that define how commands gather context and delegate work. |
| Agents | Specialized prompts for planning, implementation, review, research, and verification. |
| SDK | Typed programmatic surface used by commands and automation helpers. |
| Planning artifacts | `.planning/` files that record project state, phase plans, summaries, and verification evidence. |
| GitHub task issues | Reviewable work units exported from phase plans. |

## Current Workflow Shape

```text
discussion
  -> planning
  -> GitHub task issue export
  -> issue-scoped task PRs
  -> human review and merge
  -> reconciliation
  -> phase completion
  -> verification
```

The important boundary is human review. GTD can prepare issues, guide agents,
and reconcile merged work, but task PRs remain the checkpoint where maintainers
inspect and approve code changes.

## Data Flow

Planning produces task-ready plans. Export turns those plans into GitHub parent
plan issues and child task issues. Task work produces focused PRs. After humans
merge those PRs, GTD reconciles issue state back into summary artifacts and then
runs final verification.

## SDK Boundary

The SDK package is `@ai-is-gonna/gtd-sdk`. It exposes typed handlers for
automation and keeps command behavior testable outside a specific runtime. CLI
binaries remain:

```text
get-tasks-done
gtd-sdk
gtd-tools
```

New behavior should prefer SDK-backed handlers when a typed interface exists.

## Contributor Guidance

Keep user-facing workflow behavior documented in:

- [Task Issue Operator Guide](task-issue-operator-guide.md)
- [Commands](COMMANDS.md)
- [Configuration](CONFIGURATION.md)

Avoid adding historical implementation notes to public docs. If a decision is
only useful to maintainers, keep it close to the code or issue discussion rather
than expanding the public documentation surface.

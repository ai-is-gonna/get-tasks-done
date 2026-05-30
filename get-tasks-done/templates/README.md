# GTD Canonical Artifact Registry

This directory contains the template files for every artifact that GTD workflows officially produce. The table below is the authoritative index: **if a `.planning/` root file is not listed here, `gtd-health` will flag it as W019** (unrecognized artifact).

Agents should query this file before treating a `.planning/` file as authoritative. If the file name does not appear below, it is not a canonical GTD artifact.

---

## `.planning/` Root Artifacts

These files live directly at `.planning/` — not inside phase subdirectories.

| File | Template | Produced by | Purpose |
|------|----------|-------------|---------|
| `PROJECT.md` | `project.md` | `/gtd:new-project` | Project identity, goals, requirements summary |
| `ROADMAP.md` | `roadmap.md` | `/gtd:new-milestone`, `/gtd:new-project` | Phase plan with milestones and progress tracking |
| `STATE.md` | `state.md` | `/gtd:new-project`, `/gtd:health --repair` | Current session state, active phase, last activity |
| `REQUIREMENTS.md` | `requirements.md` | `/gtd:new-milestone` | Functional requirements with traceability |
| `MILESTONES.md` | `milestone.md` | `/gtd:complete-milestone` | Log of completed milestones with accomplishments |
| `BACKLOG.md` | *(inline)* | `/gtd-add-backlog` | Pending ideas and deferred work |
| `LEARNINGS.md` | *(inline)* | `/gtd:extract-learnings`, `/gtd:work-task-issue --phase` | Phase retrospective learnings for future plans |
| `THREADS.md` | *(inline)* | `/gtd:thread` | Persistent discussion threads |
| `config.json` | `config.json` | `/gtd:new-project`, `/gtd:health --repair` | Project-specific GTD configuration |
| `CLAUDE.md` | `claude-md.md` | `/gtd-profile` | Auto-assembled Claude Code context file |
| `RETROSPECTIVE.md` | *(inline)* | `/gtd:complete-milestone` | Living milestone retrospective updated at each milestone close |

### Version-stamped artifacts (pattern: `vX.Y-*.md`)

| Pattern | Produced by | Purpose |
|---------|-------------|---------|
| `vX.Y-MILESTONE-AUDIT.md` | `/gtd:audit-milestone` | Milestone audit report before archiving |

These files are archived to `.planning/milestones/` by `/gtd:complete-milestone`. Finding them at the `.planning/` root after completion indicates the archive step was skipped.

---

## Phase Subdirectory Artifacts (`.planning/phases/NN-name/`)

These files live inside a phase directory. They are NOT checked by W019 (which only inspects the `.planning/` root).

| File Pattern | Template | Produced by | Purpose |
|-------------|----------|-------------|---------|
| `NN-MM-PLAN.md` | `phase-prompt.md` | `/gtd:plan-phase` | Executable implementation plan |
| `NN-MM-SUMMARY.md` | `summary.md` | `/gtd:work-task-issue --phase` | Post-execution summary with learnings |
| `NN-CONTEXT.md` | `context.md` | `/gtd:discuss-phase` | Scoped discussion decisions for the phase |
| `NN-RESEARCH.md` | `research.md` | `/gtd:plan-phase`, `/gtd:plan-phase --research-phase <N>` | Technical research for the phase |
| `NN-VALIDATION.md` | `VALIDATION.md` | `/gtd:plan-phase` (Nyquist) | Validation architecture (Nyquist method) |
| `NN-UAT.md` | `UAT.md` | `/gtd:validate-phase` | User acceptance test results |
| `NN-PATTERNS.md` | *(inline)* | `/gtd:plan-phase` (pattern mapper) | Analog file mapping for the phase |
| `NN-UI-SPEC.md` | `UI-SPEC.md` | `/gtd:ui-phase` | UI design contract |
| `NN-SECURITY.md` | `SECURITY.md` | `/gtd:secure-phase` | Security threat model |
| `NN-AI-SPEC.md` | `AI-SPEC.md` | `/gtd:ai-integration-phase` | AI integration spec with eval strategy |
| `NN-DEBUG.md` | `DEBUG.md` | `/gtd:debug` | Debug session log |
| `NN-REVIEWS.md` | *(inline)* | `/gtd:review` | Cross-AI review feedback |

---

## Milestone Archive (`.planning/milestones/`)

Files archived by `/gtd:complete-milestone`. These are never checked by W019.

| File Pattern | Source |
|-------------|--------|
| `vX.Y-ROADMAP.md` | Snapshot of ROADMAP.md at milestone close |
| `vX.Y-REQUIREMENTS.md` | Snapshot of REQUIREMENTS.md at milestone close |
| `vX.Y-MILESTONE-AUDIT.md` | Moved from `.planning/` root |
| `vX.Y-phases/` | Archived phase directories (if `--archive-phases` used) |

---

## Adding a New Canonical Artifact

When a new workflow produces a `.planning/` root file:

1. Add the file name to `CANONICAL_EXACT` in `get-tasks-done/bin/lib/artifacts.cjs`
2. Add a row to the **`.planning/` Root Artifacts** table above
3. Add the template to `get-tasks-done/templates/` if one exists

<purpose>
Display the complete GTD command reference. Output ONLY the reference content. Do NOT add project-specific analysis, git status, next-step suggestions, or any commentary beyond the reference.
</purpose>

<reference>
# GTD Command Reference

**GTD** (Get Tasks Done) creates hierarchical project plans optimized for solo agentic development with Claude Code.

## Quick Start

1. `/gtd:new-project` - Initialize project (includes research, requirements, roadmap)
2. `/gtd:plan-phase 1` - Create detailed plan for first phase
3. `/gtd:export-phase-issues 1` - Export the planned task graph
4. `/gtd:work-task-issue --phase 1` or `/gtd:orchestrate-tasks 123 124 125` - Work exported tasks
5. `/gtd:work-task-issue --complete-phase 1 --execute` - Run post-phase finalization

## Staying Updated

GTD evolves fast. Update periodically:

```bash
npx @ai-is-gonna/get-tasks-done@latest
```

## Core Workflow

```text
/gtd:new-project → /gtd:plan-phase → /gtd:export-phase-issues → /gtd:work-task-issue or /gtd:orchestrate-tasks → /gtd:work-task-issue --complete-phase → repeat
```

### Project Initialization

**`/gtd:new-project`**
Initialize new project through unified flow.

One command takes you from idea to ready-for-planning:
- Deep questioning to understand what you're building
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with v1/v2/out-of-scope scoping
- Roadmap creation with phase breakdown and success criteria

Creates all `.planning/` artifacts:
- `PROJECT.md` — vision and requirements
- `config.json` — workflow mode (interactive/yolo)
- `research/` — domain research (if selected)
- `REQUIREMENTS.md` — scoped requirements with REQ-IDs
- `ROADMAP.md` — phases mapped to requirements
- `STATE.md` — project memory

Usage: `/gtd:new-project`

**`/gtd:map-codebase [--fast] [--focus <area>] [--query <term>]`**
Map an existing codebase for brownfield projects.

- `--fast` — rapid lightweight assessment (replaces the former `gtd-scan`)
- `--focus <area>` — scope the map to a specific area
- `--query <term>` — query the codebase intelligence index in `.planning/intel/` (replaces the former `gtd-intel`)

- Analyzes codebase with parallel Explore agents
- Creates `.planning/codebase/` with 7 focused documents
- Covers stack, architecture, structure, conventions, testing, integrations, concerns
- Use before `/gtd:new-project` on existing codebases

Usage: `/gtd:map-codebase`

### Phase Planning

**`/gtd:discuss-phase <number> [--chain | --analyze | --power | --assumptions] [--batch[=N]]`**
Help articulate your vision for a phase before planning.

- `--chain` — chained-prompt discuss flow
- `--analyze` — deep assumption analysis pass
- `--power` — power-user mode with extended question set
- `--assumptions` — surface Claude's implementation assumptions about the phase without an interactive session

- Captures how you imagine this phase working
- Creates CONTEXT.md with your vision, essentials, and boundaries
- Use when you have ideas about how something should look/feel
- Optional `--batch` asks 2-5 related questions at a time instead of one-by-one

Usage: `/gtd:discuss-phase 2`
Usage: `/gtd:discuss-phase 2 --batch`
Usage: `/gtd:discuss-phase 2 --batch=3`

**`/gtd:plan-phase <number> [--research] [--skip-research] [--research-phase <N>] [--view] [--gaps] [--skip-verify] [--prd <file>] [--ingest <path-or-glob>] [--ingest-format <auto|nygard|madr|narrative>] [--reviews] [--text] [--tdd] [--mvp]`**
Create detailed execution plan for a specific phase.

- `--skip-research` — bypass the research subagent
- `--research-phase <N>` — research-only mode. Spawns the research agent for phase `<N>`, writes `RESEARCH.md`, then exits before the planner runs. Useful for cross-phase research, doc review before committing to a planning approach, and correction-without-replanning loops. Replaces the deleted `gtd-research-phase` standalone command (#3042).
  - Modifiers: `--research` forces refresh (re-spawn researcher, no prompt). `--view` prints existing `RESEARCH.md` to stdout without spawning. With neither, prompts `update / view / skip` if `RESEARCH.md` already exists.
- `--gaps` — focus only on closing gaps from a prior plan-check
- `--skip-verify` — skip the post-plan verifier loop
- `--ingest <path-or-glob>` — pre-ingest external ADRs/PRDs/SPECs before planning (see *PRD Express Path* below)
- `--ingest-format <auto|nygard|madr|narrative>` — hint the ADR ingester's parser when `--ingest` is set; defaults to `auto`
- `--tdd` — plan in test-driven order (tests before code)
- `--mvp` — vertical-slice MVP planning mode (see also `/gtd:mvp-phase`)

- Generates `.planning/phases/XX-phase-name/XX-YY-PLAN.md`
- Breaks phase into concrete, actionable tasks
- Includes verification criteria and success measures
- Multiple plans per phase supported (XX-01, XX-02, etc.)

Usage: `/gtd:plan-phase 1`
Usage: `/gtd:plan-phase --research-phase 2` — research only on phase 2 (prompts if `RESEARCH.md` exists)
Usage: `/gtd:plan-phase --research-phase 2 --view` — print existing `RESEARCH.md`, no spawn
Usage: `/gtd:plan-phase --research-phase 2 --research` — force-refresh, no prompt
Result: Creates `.planning/phases/01-foundation/01-01-PLAN.md`

**PRD Express Path:** Pass `--prd path/to/requirements.md` to skip discuss-phase entirely. Your PRD becomes locked decisions in CONTEXT.md. Useful when you already have clear acceptance criteria.

### Execution

Default post-plan execution goes through exported GitHub task issues:

1. Export: `/gtd:export-phase-issues <phase>`
2. Work: `/gtd:work-task-issue --phase <phase>` or `/gtd:orchestrate-tasks <child-issue>...`
3. Finalize: `/gtd:work-task-issue --complete-phase <phase> --execute`

**`/gtd:export-phase-issues <phase-number-or-path> [--dry-run] [--repo owner/name]`**
Preview or export the GitHub issue hierarchy for a planned phase.

- Parses all phase PLAN.md files
- Derives parent plan issues, child task issues, canonical task IDs, labels, sub-issue links, blocked-by dependencies, source hashes, and manifest entries
- Reports GitHub checks that are unavailable in read-only dry-run mode
- In write mode, creates or updates labels, issues, native sub-issues, dependencies, and `.planning/github/phase-*-issues.json`
- Infers the target repository from the existing manifest or current git GitHub remote; use `--repo owner/name` to override ambiguous remotes
- Does not create branches, commits, PRs, or worktrees

Usage: `/gtd:export-phase-issues 5 --dry-run`
Usage: `/gtd:export-phase-issues 5`

**`/gtd:work-task-issue [issue-number|issue-url|task-id] [--phase <phase>] [--repo owner/name] [--read-only] [--complete-phase <phase> --execute]`**
Work one exported GitHub task issue through an isolated task PR.

- Resolves an explicit child task issue by issue number, issue URL, or canonical task ID
- Runs state sync preflight from live issue, dependency, linked PR, and review state
- Claims one workable task, creates or reuses `gtd/task-{task_id}-{issue}` worktree/branch, and spawns `gtd-task-executor`
- Validates the task diff and validation contract before opening a ready PR
- Opens draft PRs for useful failed work without `Closes #{child_issue}`
- Use `--read-only` to inspect workability without implementation or PR creation
- Use `--complete-phase <phase> --execute` after all summaries exist to run only post-phase finalization gates

Usage: `/gtd:work-task-issue`
Usage: `/gtd:work-task-issue 01-04-T02 --phase 1`
Usage: `/gtd:work-task-issue https://github.com/owner/repo/issues/124`
Usage: `/gtd:work-task-issue --read-only --phase 1`
Usage: `/gtd:work-task-issue --complete-phase <phase> --execute`

**`/gtd:orchestrate-tasks <issue-number>... [--repo owner/name] [--max-concurrency N] [--dry-run] [--allow-partial]`**
Orchestrate multiple exported GitHub task issues through a bulk branch and one comprehensive PR.

- Accepts exact exported GitHub child issue numbers; tasks that depend on earlier selected tasks stay in scope and run in later waves
- Phase, plan, remaining-task, task-id, and natural-language selection is resolved by the interactive layer before the utility call; `orchestrate-tasks` itself only accepts exact child issue numbers, not selectors, task IDs, issue URLs, or `--phase`
- Runs a mandatory Start Gate with `--dry-run` before creating branches, claims, comments, PRs, or executors; mutating runs reuse the same checked issue list
- `--dry-run` reports the Start Gate result and stops without writes
- When reviewability needs direction, keeps continuing with the full selected scope as an explicit option; recommended subsets are advisory only
- Treats selected human checkpoint tasks as non-executable gates that resume only after their GitHub issue is closed; comments are optional
- Checkpoint pauses ask the user to complete and close the checkpoint issue, then tell the agent to continue; internal helper commands are not user instructions
- Creates one bulk branch; task PRs target that branch and use `Refs #issue`
- Proactively validates each task PR against the whole selected task set before squash-merging into the bulk branch
- Opens one final PR to the default branch with `Closes #issue` lines for accepted implementation tasks only

Usage: `/gtd:orchestrate-tasks 123 124 125 --dry-run`
Usage: `/gtd:orchestrate-tasks 123 124 125 --max-concurrency 2`
Usage: `/gtd:orchestrate-tasks 123 124 125`

### Smart Router

**`/gtd:progress --do "<description>"`**
Route freeform text to the right GTD command automatically.

- Analyzes natural language input to find the best matching GTD command
- Acts as a dispatcher — never does the work itself
- Resolves ambiguity by asking you to pick between top matches
- Use when you know what you want but don't know which `/gtd-*` command to run

Usage: `/gtd:progress --do "fix the login button"`
Usage: `/gtd:progress --do "refactor the auth system"`
Usage: `/gtd:progress --do "I want to start a new milestone"`

### Quick Mode

**`/gtd:quick [--full] [--validate] [--discuss] [--research]`**
Execute small, ad-hoc tasks with GTD guarantees but skip optional agents.

Quick mode uses the same system with a shorter path:
- Spawns planner + executor (skips researcher, checker, verifier by default)
- Quick tasks live in `.planning/quick/` separate from planned phases
- Updates STATE.md tracking (not ROADMAP.md)

Flags enable additional quality steps:
- `--full` — Complete quality pipeline: discussion + research + plan-checking + verification
- `--validate` — Plan-checking (max 2 iterations) and post-execution verification only
- `--discuss` — Lightweight discussion to surface gray areas before planning
- `--research` — Focused research agent investigates approaches before planning

Granular flags are composable: `--discuss --research --validate` gives the same as `--full`.

Usage: `/gtd:quick`
Usage: `/gtd:quick --full`
Usage: `/gtd:quick --research --validate`
Result: Creates `.planning/quick/NNN-slug/PLAN.md`, `.planning/quick/NNN-slug/NNN-slug-SUMMARY.md`

---

**`/gtd:fast [description]`**
Execute a trivial task inline — no subagents, no planning files, no overhead.

For tasks too small to justify planning: typo fixes, config changes, forgotten commits, simple additions. Runs in the current context, makes the change, commits, and logs to STATE.md.

- No PLAN.md or SUMMARY.md created
- No subagent spawned (runs inline)
- ≤ 3 file edits — redirects to `/gtd:quick` if task is non-trivial
- Atomic commit with conventional message

Usage: `/gtd:fast "fix the typo in README"`
Usage: `/gtd:fast "add .env to gitignore"`

### Roadmap Management

**`/gtd:phase <description>`**
Add new phase to end of current milestone.

- Appends to ROADMAP.md
- Uses next sequential number
- Updates phase directory structure

Usage: `/gtd:phase "Add admin dashboard"`

**`/gtd:phase --insert <after> <description>`**
Insert urgent work as decimal phase between existing phases.

- Creates intermediate phase (e.g., 7.1 between 7 and 8)
- Useful for discovered work that must happen mid-milestone
- Maintains phase ordering

Usage: `/gtd:phase --insert 7 "Fix critical auth bug"`
Result: Creates Phase 7.1

**`/gtd:phase --remove <number>`**
Remove a future phase and renumber subsequent phases.

- Deletes phase directory and all references
- Renumbers all subsequent phases to close the gap
- Only works on future (unstarted) phases
- Git commit preserves historical record

Usage: `/gtd:phase --remove 17`
Result: Phase 17 deleted, phases 18-20 become 17-19

**`/gtd:phase --edit <number> [--force]`**
Edit any field of an existing roadmap phase in place, preserving number and position.

- Updates title, description, requirements, dependencies in `ROADMAP.md`
- `--force` allows editing already-started phases (use with caution)

### Milestone Management

**`/gtd:new-milestone <name>`**
Start a new milestone through unified flow.

- Deep questioning to understand what you're building next
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with scoping
- Roadmap creation with phase breakdown
- Optional `--reset-phase-numbers` flag restarts numbering at Phase 1 and archives old phase dirs first for safety

Mirrors `/gtd:new-project` flow for brownfield projects (existing PROJECT.md).

Usage: `/gtd:new-milestone "v2.0 Features"`
Usage: `/gtd:new-milestone --reset-phase-numbers "v2.0 Features"`

**`/gtd:complete-milestone <version>`**
Archive completed milestone and prepare for next version.

- Creates MILESTONES.md entry with stats
- Archives full details to milestones/ directory
- Creates git tag for the release
- Prepares workspace for next version

Usage: `/gtd:complete-milestone 1.0.0`

### Progress Tracking

**`/gtd:progress [--next | --forensic | --do "<description>"]`**
Check project status and intelligently route to next action.

- Shows visual progress bar and completion percentage
- Summarizes recent work from SUMMARY files
- Displays current position and what's next
- Lists key decisions and open issues
- Offers to execute next plan or create it if missing
- Detects 100% milestone completion

Modes:
- **default** — progress report + intelligent routing
- **`--next`** — auto-advance to the next logical step (use `--next --force` to bypass safety gates)
- **`--forensic`** — append a 6-check integrity audit after the progress report
- **`--do "<text>"`** — smart router: dispatch freeform intent to the matching `/gtd-*` command (see *Smart Router* above)

Usage: `/gtd:progress`
Usage: `/gtd:progress --next`
Usage: `/gtd:progress --forensic`

### Session Management

**`/gtd:resume-work`**
Resume work from previous session with full context restoration.

- Reads STATE.md for project context
- Shows current position and recent progress
- Offers next actions based on project state

Usage: `/gtd:resume-work`

**`/gtd:pause-work [--report]`**
Create context handoff when pausing work mid-phase.

- `--report` — generate a post-session summary in `.planning/reports/` capturing commits, file changes, and phase progress
- Creates .continue-here file with current state
- Updates STATE.md session continuity section
- Captures in-progress work context

Usage: `/gtd:pause-work`

### Debugging

**`/gtd:debug [issue description] [--diagnose]`**
Systematic debugging with persistent state across context resets.

- `--diagnose` — run a one-shot diagnostic pass without opening a persistent debug session

- Gathers symptoms through adaptive questioning
- Creates `.planning/debug/[slug].md` to track investigation
- Investigates using scientific method (evidence → hypothesis → test)
- Survives `/clear` — run `/gtd:debug` with no args to resume
- Archives resolved issues to `.planning/debug/resolved/`

Usage: `/gtd:debug "login button doesn't work"`
Usage: `/gtd:debug` (resume active session)

### Spiking & Sketching

**`/gtd:spike [idea] [--quick]`**
Rapidly spike an idea with throwaway experiments to validate feasibility.

- Decomposes idea into 2-5 focused experiments (risk-ordered)
- Each spike answers one specific Given/When/Then question
- Builds minimum code, runs it, captures verdict (VALIDATED/INVALIDATED/PARTIAL)
- Saves to `.planning/spikes/` with MANIFEST.md tracking
- Does not require `/gtd:new-project` — works in any repo
- `--quick` skips decomposition, builds immediately

Usage: `/gtd:spike "can we stream LLM output over WebSockets?"`
Usage: `/gtd:spike --quick "test if pdfjs extracts tables"`

**`/gtd:sketch [idea] [--quick]`**
Rapidly sketch UI/design ideas using throwaway HTML mockups with multi-variant exploration.

- Conversational mood/direction intake before building
- Each sketch produces 2-3 variants as tabbed HTML pages
- User compares variants, cherry-picks elements, iterates
- Shared CSS theme system compounds across sketches
- Saves to `.planning/sketches/` with MANIFEST.md tracking
- Does not require `/gtd:new-project` — works in any repo
- `--quick` skips mood intake, jumps to building

Usage: `/gtd:sketch "dashboard layout for the admin panel"`
Usage: `/gtd:sketch --quick "form card grouping"`

**`/gtd:spike --wrap-up`**
Package spike findings into a persistent project skill.

- Curates each spike one-at-a-time (include/exclude/partial/UAT)
- Groups findings by feature area
- Generates `./.claude/skills/spike-findings-[project]/` with references and sources
- Writes summary to `.planning/spikes/WRAP-UP-SUMMARY.md`
- Adds auto-load routing line to project CLAUDE.md

Usage: `/gtd:spike --wrap-up`

**`/gtd:sketch --wrap-up`**
Package sketch design findings into a persistent project skill.

- Curates each sketch one-at-a-time (include/exclude/partial/revisit)
- Groups findings by design area
- Generates `./.claude/skills/sketch-findings-[project]/` with design decisions, CSS patterns, HTML structures
- Writes summary to `.planning/sketches/WRAP-UP-SUMMARY.md`
- Adds auto-load routing line to project CLAUDE.md

Usage: `/gtd:sketch --wrap-up`

### Capturing Ideas, Notes, and Todos

**`/gtd:capture [description]`**
Capture an idea or task as a structured todo from current conversation.

- Extracts context from conversation (or uses provided description)
- Creates structured todo file in `.planning/todos/pending/`
- Infers area from file paths for grouping
- Checks for duplicates before creating
- Updates STATE.md todo count

Usage: `/gtd:capture` (infers from conversation)
Usage: `/gtd:capture Add auth token refresh`

**`/gtd:capture --note <text>`**
Zero-friction note capture — one command, instant save, no questions.

- Saves timestamped note to `.planning/notes/` (or `~/.claude/notes/` globally)
- Three subcommands: append (default), list, promote
- Promote converts a note into a structured todo
- Works without a project (falls back to global scope)

Usage: `/gtd:capture --note refactor the hook system`
Usage: `/gtd:capture --note list`
Usage: `/gtd:capture --note promote 3`
Usage: `/gtd:capture --note --global cross-project idea`

**`/gtd:capture --list [area]`**
List pending todos and select one to work on.

- Lists all pending todos with title, area, age
- Optional area filter (e.g., `/gtd:capture --list api`)
- Loads full context for selected todo
- Routes to appropriate action (work now, add to phase, brainstorm)
- Moves todo to done/ when work begins

Usage: `/gtd:capture --list`
Usage: `/gtd:capture --list api`

### User Acceptance Testing

**`/gtd:verify-work [phase]`**
Validate built features through conversational UAT.

- Extracts testable deliverables from SUMMARY.md files
- Presents tests one at a time (yes/no responses)
- Automatically diagnoses failures and creates fix plans
- Ready for re-execution if issues found

Usage: `/gtd:verify-work 3`

**`/gtd:review --phase N [--gemini] [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--all]`**
Cross-AI peer review — invoke external AI CLIs to independently review phase plans.

- Detects available CLIs (gemini, claude, codex, coderabbit)
- Each CLI reviews plans independently with the same structured prompt
- CodeRabbit reviews the current git diff (not a prompt) — may take up to 5 minutes
- Produces REVIEWS.md with per-reviewer feedback and consensus summary
- Feed reviews back into planning: `/gtd:plan-phase N --reviews`

Usage: `/gtd:review --phase 3 --all`

---

**`/gtd:pr-branch [target]`**
Create a clean branch for pull requests by filtering out .planning/ commits.

- Classifies commits: code-only (include), planning-only (exclude), mixed (include sans .planning/)
- Cherry-picks code commits onto a clean branch
- Reviewers see only code changes, no GTD artifacts

Usage: `/gtd:pr-branch` or `/gtd:pr-branch main`

---

**`/gtd:capture --seed [idea]`**
Capture a forward-looking idea with trigger conditions for automatic surfacing.

- Seeds preserve WHY, WHEN to surface, and breadcrumbs to related code
- Auto-surfaces during `/gtd:new-milestone` when trigger conditions match
- Better than deferred items — triggers are checked, not forgotten

Usage: `/gtd:capture --seed "add real-time notifications when we build the events system"`

**`/gtd:capture --backlog [description]`**
Add an idea to the backlog parking lot for future milestones.

- Creates a backlog item under 999.x numbering in ROADMAP.md
- Reserves ideas without committing to the current milestone
- Surface and promote later via `/gtd:review-backlog`

Usage: `/gtd:capture --backlog "real-time notifications when events ship"`

---

**`/gtd:audit-uat`**
Cross-phase audit of all outstanding UAT and verification items.
- Scans every phase for pending, skipped, blocked, and human_needed items
- Cross-references against codebase to detect stale documentation
- Produces prioritized human test plan grouped by testability
- Use before starting a new milestone to clear verification debt

Usage: `/gtd:audit-uat`

### Milestone Auditing

**`/gtd:audit-milestone [version]`**
Audit milestone completion against original intent.

- Reads all phase VERIFICATION.md files
- Checks requirements coverage
- Spawns integration checker for cross-phase wiring
- Creates MILESTONE-AUDIT.md with gaps and tech debt

Usage: `/gtd:audit-milestone`

### Configuration

**`/gtd:settings`**
Configure workflow toggles and model profile interactively.

- Toggle researcher, plan checker, verifier agents
- Select model profile (quality/balanced/budget/inherit)
- Updates `.planning/config.json`

Usage: `/gtd:settings`

**`/gtd:config [--profile <profile> | --advanced | --integrations]`**
Configure GTD beyond the basic settings: model profile, advanced tuning, and third-party integrations.

- `--profile <profile>` — quick switch model profile (`quality | balanced | budget | inherit`)
- `--advanced` — power-user tuning: plan bounce, timeouts, branch templates, cross-AI execution (replaces the former `gtd-settings-advanced`)
- `--integrations` — third-party API keys, code-review CLI routing, agent-skill injection (replaces the former `gtd-settings-integrations`)

- `quality` — Opus everywhere except verification
- `balanced` — Opus for planning, Sonnet for execution (default)
- `budget` — Sonnet for writing, Haiku for research/verification
- `inherit` — Use current session model for all agents (OpenCode `/model`)

Usage: `/gtd:config --profile budget`

**`/gtd:surface [list|status|profile <name>|disable <cluster>|enable <cluster>|reset]`**
Toggle which skills are surfaced — apply a profile, list, or disable a cluster without reinstall.

- `list` / `status` — Show enabled and disabled clusters and skills with token cost
- `profile <name>` — Switch to a named base profile (`core`, `issue-tasks`, `standard`, `full`)
- `disable <cluster>` — Remove a cluster from the active surface
- `enable <cluster>` — Add a cluster back to the active surface
- `reset` — Delete the surface delta and return to the install-time profile

Usage: `/gtd:surface list`
Usage: `/gtd:surface profile standard`
Usage: `/gtd:surface profile issue-tasks`
Usage: `/gtd:surface enable issue_task_loop`
Usage: `/gtd:surface disable utility`

### Utility Commands

**`/gtd:cleanup`**
Archive accumulated phase directories from completed milestones.

- Identifies phases from completed milestones still in `.planning/phases/`
- Shows dry-run summary before moving anything
- Moves phase dirs to `.planning/milestones/v{X.Y}-phases/`
- Use after multiple milestones to reduce `.planning/phases/` clutter

Usage: `/gtd:cleanup`

**`/gtd:help [--brief | --full | <topic> | --brief <topic>]`**
Show GTD command help at the tier you ask for.

- `--brief` — one-liner refresher of the top commands (~10 lines)
- *(no flag)* — one-page newcomer tour (default)
- `--full` — the complete reference you are reading now
- `<topic>` — emit only the matching section (e.g. `/gtd:help debug`, `/gtd:help workflow`)
- `--brief <topic>` — compact scoped lookup: signature + one-line summary of the matched section

Every topic output starts with a `**Topic:** \`<alias>\` → \`<heading>\` *(scope: full | compact)*` preamble so resolved routing is visible. See `get-tasks-done/workflows/help/modes/topic.md` for the full alias table. Unknown topics print the recognized list.

Usage: `/gtd:help`
Usage: `/gtd:help --brief`
Usage: `/gtd:help --full`
Usage: `/gtd:help debug`
Usage: `/gtd:help --brief debug`

**`/gtd:update [--sync] [--reapply]`**
Update GTD to latest version with changelog preview.

- `--sync` — sync managed GTD skills across runtime roots (replaces the former `gtd-sync-skills`)
- `--reapply` — reapply local modifications after an update (replaces the former `gtd-reapply-patches`)

- Shows installed vs latest version comparison
- Displays changelog entries for versions you've missed
- Highlights breaking changes
- Confirms before running install
- Better than raw `npx @ai-is-gonna/get-tasks-done@latest`

Usage: `/gtd:update`

## Additional Commands

The commands above cover the most common day-to-day flows. Every command listed here is also a live `/gtd-*` slash command and is grouped by purpose.

### Discovery & Specification

- **`/gtd:explore`** — Socratic ideation and idea routing. Think through ideas before committing to plans.
- **`/gtd:spec-phase <phase> [--auto] [--text]`** — Clarify WHAT a phase delivers with ambiguity scoring; produces a SPEC.md before discuss-phase.
- **`/gtd:ai-integration-phase [phase]`** — Generate an AI-SPEC.md design contract for phases that involve building AI systems.
- **`/gtd:ui-phase [phase]`** — Generate UI design contract (UI-SPEC.md) for frontend phases.
- **`/gtd:import --from <filepath>`** — Ingest external plans with conflict detection before writing GTD planning artifacts.
- **`/gtd:ingest-docs [path] [--mode new|merge] [--manifest <file>] [--resolve auto|interactive]`** — Bootstrap or merge a `.planning/` setup from existing ADRs, PRDs, SPECs, and docs in a repo.

### Planning & Execution

- **`/gtd:mvp-phase <phase-number>`** — Plan a phase as a vertical MVP slice (user story + SPIDR splitting) before handing off to plan-phase. Same end-state as `/gtd:plan-phase --mvp`, with a guided MVP-shaping intro.
- **`/gtd:ultraplan-phase [phase]`** — [BETA] Offload plan phase to Claude Code's ultraplan cloud; review in browser and import back.
- **`/gtd:plan-review-convergence <phase> [--codex] [--gemini] [--claude] [--opencode] [--ollama] [--lm-studio] [--llama-cpp] [--all] [--text] [--ws <name>] [--max-cycles N]`** — Cross-AI plan convergence loop — replan with review feedback until no HIGH concerns remain. Supports both cloud reviewers (Codex/Gemini/Claude/OpenCode) and local model runtimes (Ollama, LM Studio, llama.cpp).
- **`/gtd:autonomous [--from N] [--to N] [--only N] [--interactive]`** — Run all remaining phases autonomously: discuss → plan → execute per phase.

### Quality, Review & Verification

- **`/gtd:code-review <phase> [--depth=quick|standard|deep] [--files file1,file2,...] [--fix [--all] [--auto]]`** — Review source files changed during a phase for bugs, security issues, and code quality problems.
- **`/gtd:secure-phase [phase]`** — Retroactively verify threat mitigations for a completed phase.
- **`/gtd:validate-phase [phase]`** — Retroactively audit and fill Nyquist validation gaps for a completed phase.
- **`/gtd:ui-review [phase]`** — Retroactive 6-pillar visual audit of implemented frontend code.
- **`/gtd:eval-review [phase]`** — Audit an executed AI phase's evaluation coverage and produce an EVAL-REVIEW.md remediation plan.
- **`/gtd:audit-fix --source <audit-uat> [--severity medium|high|all] [--max N] [--dry-run]`** — Autonomous audit-to-fix pipeline: find issues, classify, fix, test, commit.
- **`/gtd:add-tests <phase> [additional instructions]`** — Generate tests for a completed phase based on UAT criteria and implementation.

### Diagnostics & Maintenance

- **`/gtd:health [--repair] [--context]`** — Diagnose planning directory health and optionally repair issues.
- **`/gtd:forensics [problem description]`** — Post-mortem investigation for failed GTD workflows; diagnoses what went wrong.
- **`/gtd:undo --last N | --phase NN | --plan NN-MM`** — Safe git revert. Roll back phase or plan commits using the phase manifest with dependency checks.
- **`/gtd:docs-update [--force] [--verify-only]`** — Generate or update project documentation verified against the codebase.
- **`/gtd:extract-learnings <phase>`** — Extract decisions, lessons, patterns, and surprises from completed phase artifacts.

### Knowledge & Context

- **`/gtd:graphify [build|query <term>|status|diff]`** — Build, query, and inspect the project knowledge graph in `.planning/graphs/`.
- **`/gtd:thread [list [--open|--resolved] | close <slug> | status <slug> | name | description]`** — Manage persistent context threads for cross-session work.
- **`/gtd:profile-user [--questionnaire] [--refresh]`** — Generate developer behavioral profile and create Claude-discoverable artifacts.
- **`/gtd:stats`** — Display project statistics: phases, plans, requirements, git metrics, and timeline.

### Workflow & Orchestration

- **`/gtd:manager [--analyze-deps]`** — Interactive command center for managing multiple phases from one terminal. `--analyze-deps` scans ROADMAP phases for dependency relationships before parallel execution.
- **`/gtd:workspace [--new | --list | --remove] [name]`** — Manage GTD workspaces: create, list, or remove isolated workspace environments.
- **`/gtd:workstreams`** — Manage parallel workstreams: list, create, switch, status, progress, complete, and resume.
- **`/gtd:review-backlog`** — Review and promote backlog items to active milestone.
- **`/gtd:milestone-summary [version]`** — Generate a comprehensive project summary from milestone artifacts for team onboarding and review.

### Repository Integration

- **`/gtd:inbox [--issues] [--prs] [--label] [--close-incomplete] [--repo owner/repo]`** — Triage and review open GitHub issues and PRs against project templates and contribution guidelines.

### Namespace Routers (model-facing meta-skills)

These six skills exist primarily for the model to perform two-stage hierarchical routing across 60+ skills. You can invoke them directly when you want to browse a category interactively.

- **`/gtd-context`** — Codebase intelligence routing (map, graphify, docs, learnings).
- **`/gtd-ideate`** — Exploration / capture routing (explore, sketch, spike, spec, capture).
- **`/gtd-manage`** — Configuration and workspace routing (workstreams, thread, update, inbox).
- **`/gtd-project`** — Project-lifecycle routing (milestones, audits, summary).
- **`/gtd-quality`** — Quality-gate routing (code review, debug, audit, security, eval, ui).
- **`/gtd-workflow`** — Phase-pipeline routing (discuss, plan, execute, verify, phase, progress).

## Files & Structure

```text
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── RETROSPECTIVE.md      # Living retrospective (updated per milestone)
├── config.json           # Workflow mode & gates
├── todos/                # Captured ideas and tasks
│   ├── pending/          # Todos waiting to be worked on
│   └── done/             # Completed todos
├── spikes/               # Spike experiments (/gtd:spike)
│   ├── MANIFEST.md       # Spike inventory and verdicts
│   └── NNN-name/         # Individual spike directories
├── sketches/             # Design sketches (/gtd:sketch)
│   ├── MANIFEST.md       # Sketch inventory and winners
│   ├── themes/           # Shared CSS theme files
│   └── NNN-name/         # Individual sketch directories (HTML + README)
├── debug/                # Active debug sessions
│   └── resolved/         # Archived resolved issues
├── milestones/
│   ├── v1.0-ROADMAP.md       # Archived roadmap snapshot
│   ├── v1.0-REQUIREMENTS.md  # Archived requirements
│   └── v1.0-phases/          # Archived phase dirs (via /gtd:cleanup or --archive-phases)
│       ├── 01-foundation/
│       └── 02-core-features/
├── codebase/             # Codebase map (brownfield projects)
│   ├── STACK.md          # Languages, frameworks, dependencies
│   ├── ARCHITECTURE.md   # Patterns, layers, data flow
│   ├── STRUCTURE.md      # Directory layout, key files
│   ├── CONVENTIONS.md    # Coding standards, naming
│   ├── TESTING.md        # Test setup, patterns
│   ├── INTEGRATIONS.md   # External services, APIs
│   └── CONCERNS.md       # Tech debt, known issues
└── phases/
    ├── 01-foundation/
    │   ├── 01-01-PLAN.md
    │   └── 01-01-SUMMARY.md
    └── 02-core-features/
        ├── 02-01-PLAN.md
        └── 02-01-SUMMARY.md
```

## Workflow Modes

Set during `/gtd:new-project`:

**Interactive Mode**

- Confirms each major decision
- Pauses at checkpoints for approval
- More guidance throughout

**YOLO Mode**

- Auto-approves most decisions
- Executes plans without confirmation
- Only stops for critical checkpoints

Change anytime by editing `.planning/config.json`

## Planning Configuration

Configure how planning artifacts are managed in `.planning/config.json`:

**`planning.commit_docs`** (default: `true`)
- `true`: Planning artifacts committed to git (standard workflow)
- `false`: Planning artifacts kept local-only, not committed

When `commit_docs: false`:
- Add `.planning/` to your `.gitignore`
- Useful for OSS contributions, client projects, or keeping planning private
- All planning files still work normally, just not tracked in git

**`planning.search_gitignored`** (default: `false`)
- `true`: Add `--no-ignore` to broad ripgrep searches
- Only needed when `.planning/` is gitignored and you want project-wide searches to include it

Example config:
```json
{
  "planning": {
    "commit_docs": false,
    "search_gitignored": true
  }
}
```

## Common Workflows

**Starting a new project:**

```text
/gtd:new-project        # Unified flow: questioning → research → requirements → roadmap
/clear
/gtd:plan-phase 1       # Create plans for first phase
/clear
/gtd:export-phase-issues 1
/gtd:work-task-issue --phase 1
/gtd:work-task-issue --complete-phase 1 --execute
```

**Resuming work after a break:**

```text
/gtd:progress  # See where you left off and continue
```

**Adding urgent mid-milestone work:**

```text
/gtd:phase --insert 5 "Critical security fix"
/gtd:plan-phase 5.1
/gtd:export-phase-issues 5.1
/gtd:work-task-issue --phase 5.1
```

**Completing a milestone:**

```text
/gtd:complete-milestone 1.0.0
/clear
/gtd:new-milestone  # Start next milestone (questioning → research → requirements → roadmap)
```

**Capturing ideas during work:**

```text
/gtd:capture                                  # Capture from conversation context
/gtd:capture Fix modal z-index                # Capture with explicit description
/gtd:capture --note refactor auth system      # Quick friction-free note
/gtd:capture --seed "real-time notifications" # Forward-looking idea with triggers
/gtd:capture --list                           # Review and work on todos
/gtd:capture --list api                       # Filter by area
```

**Debugging an issue:**

```text
/gtd:debug "form submission fails silently"  # Start debug session
# ... investigation happens, context fills up ...
/clear
/gtd:debug                                    # Resume from where you left off
```

## Getting Help

- Read `.planning/PROJECT.md` for project vision
- Read `.planning/STATE.md` for current context
- Check `.planning/ROADMAP.md` for phase status
- Run `/gtd:progress` to check where you're up to
</reference>

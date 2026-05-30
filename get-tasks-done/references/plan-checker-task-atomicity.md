# Plan Checker Task Atomicity

Use this reference when Dimension 13 requires manual judgment beyond the deterministic `verify.plan-structure` output.

## Scope

Task-level atomicity asks whether one executor in a fresh context window can complete the task without interpretation, degradation, hallucination, or scope creep.

## Checks

### 13a. Per-Task File Count

Count file paths in `<files>`.

| Files | Status | Severity |
|-------|--------|----------|
| 1-3 | OK | none |
| 4-5 | Borderline | WARNING |
| 6+ | Over-scoped | BLOCKER |

### 13b. Single Concern

Analyze `<action>` for unrelated operations:
- Distinct action verbs targeting different subsystems
- "and" or "also" connecting operations on different file groups
- Three or more imperative verbs across different domains

| Pattern | Severity |
|---------|----------|
| 1 concern | OK |
| 2 concerns, same subsystem | WARNING |
| 2+ concerns, different subsystems | BLOCKER |

### 13c. Boundaries Present

Every `auto` and `tdd` task must have non-empty `<boundaries>`.

| Status | Severity |
|--------|----------|
| Structured with Allowed/Forbidden/Out of scope or DO NOT modify clause | OK |
| Present but prose-only | WARNING |
| Placeholder (`No boundaries`, `none`, `N/A`) | BLOCKER |
| Empty or absent | BLOCKER |

### 13d. Independent Verifiability

`<verify>` must be executable without later tasks in the same plan:
- References file created by later task: BLOCKER
- References endpoint or route created by later task: BLOCKER
- Runs full test suite with no filter: WARNING

Dependencies on earlier tasks are acceptable because tasks execute sequentially.

### 13e. Atomic Done Criteria

`<done>` should be verifiable with one assertion:
- "and" joining distinct outcomes: BLOCKER
- Vague language such as "works correctly" or "complete": WARNING
- Multi-step verification: WARNING

### 13f. Per-Task Context Budget

Estimate context load:
- Each `<files>` path: about 3-5%
- Each `<read_first>` path: about 2-3%
- `<action>` longer than 500 characters suggests complexity
- New subsystem setup adds about 10%

| Estimated context | Severity |
|-------------------|----------|
| <25% | OK |
| 25-35% | WARNING |
| >35% | BLOCKER |

---
name: gtd-ideate
description: "exploration capture | explore sketch spike spec capture"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [capture, explore, sketch, spike, spec-phase]
---

Route to the appropriate exploration / capture skill based on the user's intent.
`gtd-note`, `gtd-add-todo`, `gtd-add-backlog`, and `gtd-plant-seed` were folded
into `gtd-capture` (with `--note`, default, `--backlog`, `--seed` modes) by
#2790. The capture target lists pending todos via `--list`.

| User wants | Invoke |
|---|---|
| Explore an idea or opportunity | gtd-explore |
| Sketch out a rough design or plan | gtd-sketch |
| Time-boxed technical spike | gtd-spike |
| Write a spec for a phase | gtd-spec-phase |
| Capture a thought (todo / note / backlog / seed) | gtd-capture |

Invoke the matched skill directly using the Skill tool.

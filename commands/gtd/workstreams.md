---
name: gtd:workstreams
description: Manage parallel workstreams — list, create, switch, status, progress, complete, and resume
allowed-tools:
  - Read
  - Bash
requires: [new-milestone, phase, progress, resume-work]
---

# /gtd:workstreams

Manage parallel workstreams for concurrent milestone work.

## Usage

`/gtd:workstreams [subcommand] [args]`

### Subcommands

| Command | Description |
|---------|-------------|
| `list` | List all workstreams with status |
| `create <name>` | Create a new workstream |
| `status <name>` | Detailed status for one workstream |
| `switch <name>` | Set active workstream |
| `progress` | Progress summary across all workstreams |
| `complete <name>` | Archive a completed workstream |
| `resume <name>` | Resume work in a workstream |

## Step 1: Parse Subcommand

Parse the user's input to determine which workstream operation to perform.
If no subcommand given, default to `list`.

## Step 2: Execute Operation

### list
Run: `gtd-sdk query workstream.list --raw --cwd "$CWD"`
Display the workstreams in a table format showing name, status, current phase, and progress.

### create
Run: `gtd-sdk query workstream.create <name> --raw --cwd "$CWD"`
After creation, display the new workstream path and suggest next steps:
- `/gtd:new-milestone --ws <name>` to set up the milestone

### status
Run: `gtd-sdk query workstream.status <name> --raw --cwd "$CWD"`
Display detailed phase breakdown and state information.

### switch
Run: `gtd-sdk query workstream.set <name> --raw --cwd "$CWD"`
Also set `GTD_WORKSTREAM` for the current session when the runtime supports it.
If the runtime exposes a session identifier, GTD also stores the active workstream
session-locally so concurrent sessions do not overwrite each other.

### progress
Run: `gtd-sdk query workstream.progress --raw --cwd "$CWD"`
Display a progress overview across all workstreams.

### complete
Run: `gtd-sdk query workstream.complete <name> --raw --cwd "$CWD"`
Archive the workstream to milestones/.

### resume
Set the workstream as active and suggest `/gtd:resume-work --ws <name>`.

## Step 3: Display Results

Format the JSON output from gtd-sdk query into a human-readable display.
Include the `${GTD_WS}` flag in any routing suggestions.

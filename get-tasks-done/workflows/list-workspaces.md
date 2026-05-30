<purpose>
List all GTD workspaces found in ~/gtd-workspaces/ with their status.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

## 1. Setup

```bash
INIT=$(gtd-sdk query init.list-workspaces)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `workspace_base`, `workspaces`, `workspace_count`.

## 2. Display

**If `workspace_count` is 0:**

```
No workspaces found in ~/gtd-workspaces/

Create one with:
  /gtd:workspace --new --name my-workspace --repos repo1,repo2
```

Done.

**If workspaces exist:**

Display a table:

```
GTD Workspaces (~/gtd-workspaces/)

| Name | Repos | Strategy | GTD Project |
|------|-------|----------|-------------|
| feature-a | 3 | worktree | Yes |
| feature-b | 2 | clone | No |

Manage:
  cd ~/gtd-workspaces/<name>     # Enter a workspace
  /gtd-remove-workspace <name>   # Remove a workspace
```

For each workspace, show:
- **Name** — directory name
- **Repos** — count from init data
- **Strategy** — from WORKSPACE.md
- **GTD Project** — whether `.planning/PROJECT.md` exists (Yes/No)

</process>

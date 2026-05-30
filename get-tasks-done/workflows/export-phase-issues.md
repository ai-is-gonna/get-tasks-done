<purpose>
Export a phase's PLAN.md files as deterministic GitHub issue operations.
</purpose>

<boundary>
Write mode mutates only GitHub Issues metadata and
the local export manifest.
Dry-run mode is read-only.

Always allowed:
- Read `.planning/phases/**` PLAN.md files.
- Read an existing `.planning/github/phase-*-issues.json` manifest if present.
- Print deterministic dry-run output when `--dry-run` is present.

Write mode additionally may:
- Create or update GitHub labels.
- Create or update exported parent plan and child task issues.
- Attach native sub-issues and issue dependencies.
- Write `.planning/github/phase-*-issues.json`.
- Mark a partial export in the manifest and with `gtd:export-partial` when a
  mutating run fails after writing.

Forbidden in all modes:
- Do not create branches, commits, PRs, or worktrees.
- Do not silently replace native sub-issues or dependencies with markdown-only
  links.
</boundary>

<process>
1. Parse `$ARGUMENTS`.
   - Require a phase number or phase directory path.
   - Preserve `--dry-run` when supplied.
   - Preserve `--repo owner/name` when supplied. Otherwise, resolve the target
     repo from the existing manifest or the current git GitHub remote.
2. Run the deterministic exporter:

```bash
gtd-sdk query export-phase-issues $ARGUMENTS
```

3. If the exporter reports source validation errors, stop and present the
   errors exactly enough for the user to repair the PLAN.md source.
4. If running dry-run, present the preview without applying mutations.
5. If running write mode, present the final export result or the partial export
   failure, including the manifest path and safe rerun command.
</process>

<dry_run_output_contract>
The dry-run output must include:
- Required labels that write mode would ensure.
- Parent plan issues that write mode would create or update.
- Child task issues that write mode would create or update.
- Native sub-issue relationships that write mode would attach.
- Blocked-by dependencies that write mode would ensure.
- Manifest entries that write mode would add, keep, update, or mark for drift handling.
- Operations unavailable in dry-run because live GitHub state was not queried.

Output must be deterministic for the same phase input: plans are sorted by plan
id, tasks are sorted by source order, task ids use `{plan_id}-T{two_digit_index}`,
and no timestamps are included.
</dry_run_output_contract>

<write_output_contract>
Write-mode output must include:
- The target repository.
- The manifest path and final status.
- Exported parent and child issue numbers.
- Completed operation keys.
- Post-export consistency check status.

When a write run fails after mutation begins, the manifest must remain in
`partial` state and the error must include the failed operation and safe rerun
command.
</write_output_contract>

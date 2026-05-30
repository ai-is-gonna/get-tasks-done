// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Do not copy this pattern.

/**
 * Worktree commit safety hardening tests (#1977)
 *
 * Checks:
 * 1. work-task-issue.md keeps task implementation out of the main checkout.
 * 2. gtd-task-executor.md task_commit_protocol includes post-commit deletion verification
 *    (using --diff-filter=D to catch accidental file deletions per task)
 * 3. work-task-issue.md does not preserve the retired direct merge path.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'work-task-issue.md');
const EXECUTOR_AGENT_PATH = path.join(__dirname, '..', 'agents', 'gtd-task-executor.md');

describe('worktree commit safety hardening (#1977)', () => {
  test('work-task-issue keeps implementation out of the main checkout', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');

    assert.ok(
      content.includes('task worktree'),
      'work-task-issue.md must create or reuse an isolated task worktree'
    );
    assert.ok(
      content.includes("Do not run implementation in the user's main checkout"),
      'work-task-issue.md must forbid implementation in the main checkout'
    );
  });

  test('gtd-task-executor.md task_commit_protocol includes post-commit deletion verification', () => {
    const content = fs.readFileSync(EXECUTOR_AGENT_PATH, 'utf-8');

    // Must contain --diff-filter=D deletion check
    assert.ok(
      content.includes('--diff-filter=D'),
      'gtd-task-executor.md must include --diff-filter=D deletion verification after each task commit'
    );

    // Must include a WARNING or notice about deletions
    assert.ok(
      content.includes('WARNING') || content.includes('DELETIONS'),
      'gtd-task-executor.md must warn when a commit includes file deletions'
    );
  });

  test('work-task-issue.md delegates task branch safety instead of merging directly', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');

    assert.ok(
      content.includes('Validate changed files against the declared diff scope'),
      'work-task-issue.md must validate task output before PR creation'
    );
    assert.ok(
      !content.includes('git merge'),
      'work-task-issue.md must not merge task work directly'
    );
  });
});

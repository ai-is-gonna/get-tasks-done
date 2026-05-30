// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

/**
 * Regression test for #2015: quick worktree executor creates branch from master
 * instead of the current feature branch HEAD.
 *
 * The worktree_branch_check in quick.md used
 * `git reset --soft {EXPECTED_BASE}` as the recovery action when the
 * worktree was created from the wrong base. `reset --soft` moves the HEAD
 * pointer but leaves the working tree files from main/master unchanged —
 * the executor then works against stale code and its commits contain an
 * enormous diff (the entire feature branch) as deletions.
 *
 * Fix: use `git reset --hard {EXPECTED_BASE}` in the worktree_branch_check.
 * In a fresh worktree with no user changes, --hard is safe and correct.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_PATH = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'quick.md');

describe('worktree_branch_check must use reset --hard not reset --soft (#2015)', () => {
  test('quick.md worktree_branch_check does not use reset --soft', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const blockMatch = content.match(/<worktree_branch_check>([\s\S]*?)<\/worktree_branch_check>/);
    assert.ok(blockMatch, 'quick.md must contain a <worktree_branch_check> block');

    const block = blockMatch[1];
    assert.ok(
      !block.includes('reset --soft'),
      'quick.md worktree_branch_check must not use reset --soft. Use reset --hard instead.'
    );
  });

  test('quick.md worktree_branch_check uses reset --hard for base correction', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const blockMatch = content.match(/<worktree_branch_check>([\s\S]*?)<\/worktree_branch_check>/);
    assert.ok(blockMatch, 'quick.md must contain a <worktree_branch_check> block');

    const block = blockMatch[1];
    assert.ok(
      block.includes('reset --hard'),
      'quick.md worktree_branch_check must use reset --hard to correctly reset both HEAD and working tree'
    );
  });
});

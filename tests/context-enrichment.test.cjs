// allow-test-rule: source-text-is-the-product

'use strict';

/**
 * Task workflow context enrichment.
 *
 * The task flow should pass enough context to `gtd-task-executor` without
 * reviving whole-phase worker prompts.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('work-task-issue.md task executor context', () => {
  const WORKFLOW_PATH = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'work-task-issue.md');

  test('executor prompt includes task, parent, and read-first context', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const spawnIdx = content.indexOf('Spawn `gtd-task-executor`');
    assert.ok(spawnIdx > -1, 'workflow should spawn gtd-task-executor for child tasks');

    const block = content.slice(spawnIdx, spawnIdx + 1200);
    assert.ok(block.includes('child issue body'));
    assert.ok(block.includes('parent issue summary'));
    assert.ok(block.includes('source plan path'));
    assert.ok(block.includes('required read-first files'));
    assert.ok(block.includes('allowed write scope'));
    assert.ok(block.includes('validation contract'));
  });

  test('path safety context is supplied to the task executor', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('references/worktree-path-safety.md'));
    assert.ok(content.includes('path-safety context'));
  });
});

describe('plan-phase.md context enrichment', () => {
  const PLAN_WORKFLOW_PATH = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'plan-phase.md');

  test('contains CONTEXT_WINDOW conditional for prior CONTEXT.md', () => {
    const content = fs.readFileSync(PLAN_WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('CONTEXT_WINDOW'));
    assert.ok(content.includes('config-get context_window'));
    assert.ok(content.includes('CONTEXT_WINDOW >= 500000'));
    assert.ok(content.includes('CONTEXT.md'));
  });

  test('default CONTEXT_WINDOW fallback is 200000', () => {
    const content = fs.readFileSync(PLAN_WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('|| echo "200000"'));
  });
});

'use strict';

/**
 * Regression guard for the post-plan next step: after task reconciliation and
 * phase finalization, the workflow should point to verification, not to a
 * phase-level execution path.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(
  __dirname, '..', 'get-tasks-done', 'workflows', 'work-task-issue.md'
);

describe('work-task-issue finalization next step', () => {
  test('phase completion mode emits verify-work as the next command', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    const block = content.slice(
      content.indexOf('<phase_completion_mode>'),
      content.indexOf('</phase_completion_mode>')
    );

    assert.ok(block.includes('--complete-phase <phase> --execute'));
    assert.ok(/verify-work|verification command/i.test(block));
    assert.ok(!/phase-level execution/.test(block));
  });
});

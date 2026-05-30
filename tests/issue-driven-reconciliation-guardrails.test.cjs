// allow-test-rule: source-text-is-the-product — workflow markdown is the runtime contract.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function workflow(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'get-tasks-done', 'workflows', `${name}.md`),
    'utf8',
  );
}

describe('issue-driven reconciliation guardrails', () => {
  test('verify-work blocks UAT before ready parent plans are reconciled', () => {
    const text = workflow('verify-work');
    assert.match(text, /ISSUE_TASK_RECONCILIATION_REQUIRED/);
    assert.match(text, /work-task-issue --phase "\$\{phase_number\}" --read-only/);
    assert.match(text, /\*-SUMMARY\.md/);
  });

  test('progress routes ready issue-driven plans to reconciliation before verify', () => {
    const text = workflow('progress');
    assert.match(text, /issue_driven_reconciliation_route/);
    assert.match(text, /request_reconciliation_permission/);
    assert.match(text, /Do not recommend `\/gtd:verify-work`/);
  });

  test('work-task-issue finalization does not bypass active task manifests', () => {
    const text = workflow('work-task-issue');
    assert.match(text, /--complete-phase/);
    assert.match(text, /must not select child task issues/);
    assert.match(text, /must not[\s\S]*run implementation plans/);
  });

});

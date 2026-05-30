// allow-test-rule: source-text-is-the-product
// Public docs are the operator contract for the task issue workflow.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assertInOrder(content, patterns, sourceName) {
  let offset = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(content.slice(offset));
    assert.ok(match, `${sourceName} should contain ${pattern} after offset ${offset}`);
    offset += match.index + match[0].length;
  }
}

function retiredNativeLines(content) {
  return content
    .split('\n')
    .filter((line) => /native\s+fallback|native\s+execution|force-native|bypass.*task issues/i.test(line));
}

describe('Slice 8 docs cleanup: task issue workflow is the public default', () => {
  test('operator guide documents the complete default workflow in order', () => {
    const guide = read('docs/task-issue-operator-guide.md');

    assertInOrder(
      guide,
      [
        /\/gtd-plan-phase <phase>/,
        /\/gtd-export-phase-issues <phase>/,
        /\/gtd-work-task-issue --phase <phase>/,
        /reconciliation/i,
        /\/gtd-work-task-issue --complete-phase <phase> --execute/,
        /\/gtd-verify-work <phase>/,
      ],
      'Task Issue Operator Guide'
    );
    assert.deepEqual(retiredNativeLines(guide), []);
  });

  test('public indexes point operators to the task issue guide', () => {
    const docsReadme = read('docs/README.md');

    assert.match(docsReadme, /Task Issue Operator Guide/);
  });

  test('public workflow docs do not advertise retired fallback execution', () => {
    const publicDocs = [
      'docs/COMMANDS.md',
      'docs/task-issue-operator-guide.md',
      'get-tasks-done/workflows/help/modes/full.md',
    ];

    for (const rel of publicDocs) {
      assert.deepEqual(retiredNativeLines(read(rel)), [], `${rel} has retired fallback language`);
    }
  });

  test('public help describes task finalization as complete-phase execute mode', () => {
    const help = read('get-tasks-done/workflows/help/modes/full.md');

    assert.match(
      help,
      /\/gtd:work-task-issue --complete-phase <phase> --execute/,
      'full help should present complete-phase execute as the finalization signature'
    );
  });
});

// allow-test-rule: source-text-is-the-product
// These markdown/CJS surfaces are the shipped routing contract users and agents
// read at runtime.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assertTaskIssueRoute(content, name) {
  assert.match(content, /export-phase-issues/, `${name} should route through export-phase-issues`);
  assert.match(content, /work-task-issue/, `${name} should route through work-task-issue`);
  assert.match(content, /complete-phase/, `${name} should document phase finalization`);
}

function assertNoNativeRoute(content, name) {
  assert.doesNotMatch(content, /Native\s+fallback/i, `${name} must not mention the retired fallback path`);
  assert.doesNotMatch(content, /native\s+execution/i, `${name} must not mention retired execution`);
  assert.doesNotMatch(content, /force-native/i, `${name} must not mention the retired force flag`);
}

describe('Slice 6 default routing: post-plan path uses task issues', () => {
  test('planner and plan checker route planned work through task issues only', () => {
    const planner = read('agents/gtd-planner.md');
    const checker = read('agents/gtd-plan-checker.md');

    assertTaskIssueRoute(planner, 'planner');
    assertTaskIssueRoute(checker, 'plan checker');

    assertNoNativeRoute(planner, 'planner');
    assertNoNativeRoute(checker, 'plan checker');
  });

  test('help surfaces describe the task issue route with no retired fallback path', () => {
    const helpDefault = read('get-tasks-done/workflows/help/modes/default.md');
    const helpBrief = read('get-tasks-done/workflows/help/modes/brief.md');
    const helpFull = read('get-tasks-done/workflows/help/modes/full.md');
    const combined = [helpDefault, helpBrief, helpFull].join('\n');

    assertTaskIssueRoute(combined, 'help');
    assertNoNativeRoute(combined, 'help');

    assert.doesNotMatch(helpDefault, /\/gtd:work-task-issue --phase 1\s+# Execute all plans in the phase/);
    assert.doesNotMatch(helpFull, /\/gtd:new-project → \/gtd:plan-phase → \/gtd:work-task-issue --phase → repeat/);
    assert.doesNotMatch(helpBrief, /\/gtd:work-task-issue --phase <N>\s+Execute a phase/);
  });

  test('progress and plan-phase route planned work through task issues', () => {
    const progress = read('get-tasks-done/workflows/progress.md');
    const planPhase = read('get-tasks-done/workflows/plan-phase.md');

    assertTaskIssueRoute(progress, 'progress');
    assertTaskIssueRoute(planPhase, 'plan-phase');
    assertNoNativeRoute(progress, 'progress');
    assertNoNativeRoute(planPhase, 'plan-phase');

    assert.doesNotMatch(progress, /Smart routing: \/gtd:work-task-issue --phase if plans exist/);
    assert.doesNotMatch(planPhase, /Skill\(skill="gtd-work-task-issue"/);
    assert.doesNotMatch(planPhase, /proceed directly to `\/gtd:work-task-issue --phase`/);
    assert.match(progress, /\/gtd:work-task-issue --complete-phase \{phase\} --execute/);
    assert.match(planPhase, /\/gtd:work-task-issue --complete-phase \{X\} --execute/);
  });

  test('namespace and profile routing expose the task issue workflow', () => {
    const namespace = read('commands/gtd/ns-workflow.md');
    const profileOutput = read('get-tasks-done/bin/lib/profile-output.cjs');

    assertTaskIssueRoute(namespace, 'workflow namespace');
    assertTaskIssueRoute(profileOutput, 'profile output');
    assertNoNativeRoute(namespace, 'workflow namespace');
    assertNoNativeRoute(profileOutput, 'profile output');

    assert.doesNotMatch(namespace, /\| Execute plans in a phase \| gtd-work-task-issue \|/);
  });

  test('public command docs expose only task issue execution and finalization', () => {
    const command = read('commands/gtd/work-task-issue.md');
    const commandsDoc = read('docs/COMMANDS.md');
    const readme = read('README.md');
    const operatorGuide = read('docs/task-issue-operator-guide.md');
    const combined = [command, commandsDoc, operatorGuide, readme].join('\n');

    assertTaskIssueRoute(combined, 'public docs');
    assertNoNativeRoute(combined, 'public docs');
    assert.match(combined, /--complete-phase/);
    assert.doesNotMatch(commandsDoc, /Phase needs execution → runs `\/gtd-work-task-issue`/);
    assert.doesNotMatch(commandsDoc, /\/gtd-work-task-issue 1\s+# Execute phase 1/);
  });
});

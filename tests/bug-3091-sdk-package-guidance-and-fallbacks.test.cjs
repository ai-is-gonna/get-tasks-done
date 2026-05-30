'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('bug #3091: sdk install guidance and agent fallbacks use query-capable CLI', () => {
  test('quick workflow install hint references @ai-is-gonna/get-tasks-done (not @ai-is-gonna/gtd-sdk)', () => {
    const content = read('get-tasks-done/workflows/quick.md');
    assert.ok(content.includes('npm install -g @ai-is-gonna/get-tasks-done'));
    assert.ok(!content.includes('npm install -g @ai-is-gonna/gtd-sdk'));
  });

  test('agent docs no longer reference node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query fallback', () => {
    const files = [
      'agents/gtd-planner.md',
      'agents/gtd-task-executor.md',
      'agents/gtd-plan-checker.md',
      'agents/gtd-roadmapper.md',
    ];

    const offenders = files.filter((f) => read(f).includes('@ai-is-gonna/gtd-sdk/dist/cli.js query'));
    assert.deepStrictEqual(offenders, [], `stale @ai-is-gonna/gtd-sdk query fallback references: ${offenders.join(', ')}`);
  });
});

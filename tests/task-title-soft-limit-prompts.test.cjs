'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLANNER_PATH = path.join(ROOT, 'agents', 'gtd-planner.md');
const CHECKER_PATH = path.join(ROOT, 'agents', 'gtd-plan-checker.md');

describe('task title soft limit prompt guidance', () => {
  test('planner instructs task names to stay under 64 chars excluding task id', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf8');
    assert.match(
      content,
      /Soft limit: keep task names under 64 characters, excluding the task id/i,
      'gtd-planner must tell the planner to keep task names under 64 chars excluding the task id prefix'
    );
  });

  test('plan checker treats >64-char task names as a warning', () => {
    const content = fs.readFileSync(CHECKER_PATH, 'utf8');
    assert.match(
      content,
      /Task name length:\s*>64 characters is WARNING/i,
      'gtd-plan-checker must treat long task names as a warning'
    );
    assert.match(
      content,
      /exported GitHub issue titles prepend `\[GTD \{task_id\}\] ` later/i,
      'gtd-plan-checker must explain why long task names are warned on'
    );
  });
});

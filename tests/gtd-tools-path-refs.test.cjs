/**
 * Regression guard for #1766: $GTD_TOOLS env var undefined
 *
 * All command files must use the resolved path to gtd-tools.cjs
 * ($HOME/.claude/get-tasks-done/bin/gtd-tools.cjs), not the undefined
 * $GTD_TOOLS variable. This test catches any command file that
 * references the undefined variable.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gtd');

describe('command files: gtd-tools path references (#1766)', () => {
  test('no command file references undefined $GTD_TOOLS variable', () => {
    const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    const violations = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
      // Match $GTD_TOOLS or "$GTD_TOOLS" or ${GTD_TOOLS} used as a path
      // (not as a documentation reference)
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\$GTD_TOOLS\b/.test(line) && /node\s/.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.strictEqual(violations.length, 0,
      'Command files must not reference undefined $GTD_TOOLS. ' +
      'Use $HOME/.claude/get-tasks-done/bin/gtd-tools.cjs instead.\n' +
      'Violations:\n' + violations.join('\n'));
  });

  test('workstreams.md documents gtd-sdk query or legacy gtd-tools.cjs', () => {
    const content = fs.readFileSync(
      path.join(COMMANDS_DIR, 'workstreams.md'), 'utf-8'
    );

    assert.ok(
      /gtd-sdk\s+query/.test(content) || /gtd-tools\.cjs/.test(content),
      'workstreams.md should document gtd-sdk query or gtd-tools.cjs'
    );

    const lines = content.split('\n');
    for (const line of lines) {
      if (/node\s/.test(line)) {
        assert.ok(
          line.includes('gtd-tools.cjs'),
          'Each node invocation must reference gtd-tools.cjs, got: ' + line.trim()
        );
      }
    }
  });
});

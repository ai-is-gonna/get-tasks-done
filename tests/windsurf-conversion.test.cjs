/**
 * Windsurf conversion regression tests.
 *
 * Ensures Windsurf frontmatter names are emitted as plain identifiers
 * (without surrounding quotes), so Windsurf does not treat quotes as
 * literal parts of skill/subagent names.
 */

process.env.GTD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeCommandToWindsurfSkill,
  convertClaudeAgentToWindsurfAgent,
  convertClaudeToWindsurfMarkdown,
} = require('../bin/install.js');

describe('convertClaudeCommandToWindsurfSkill', () => {
  test('writes unquoted Windsurf skill name in frontmatter', () => {
    const input = `---
name: quick
description: Execute a quick task
---

<objective>
Test body
</objective>
`;

    const result = convertClaudeCommandToWindsurfSkill(input, 'gtd-quick');
    const nameMatch = result.match(/^name:\s*(.+)$/m);

    assert.ok(nameMatch, 'frontmatter contains name field');
    assert.strictEqual(nameMatch[1], 'gtd-quick', 'skill name is plain scalar');
    assert.ok(!result.includes('name: "gtd-quick"'), 'quoted skill name is not emitted');
  });

  test('preserves slash for slash commands in markdown body', () => {
    const input = `---
name: gtd:plan-phase
description: Plan a phase
---

Next:
/gtd:work-task-issue --phase 17
/gtd-help
gtd:progress
`;

    const result = convertClaudeCommandToWindsurfSkill(input, 'gtd-plan-phase');
    // Slash commands: /gtd:work-task-issue --phase -> /gtd-work-task-issue
    assert.ok(result.includes('/gtd-work-task-issue --phase 17'), 'slash command gtd: -> gtd-');
    assert.ok(result.includes('/gtd-help'), '/gtd-help preserved');
    assert.ok(result.includes('gtd-progress'), 'bare gtd: -> gtd-');
  });

  test('includes windsurf_skill_adapter block', () => {
    const input = `---
name: test
description: A test skill
---

Body content.
`;

    const result = convertClaudeCommandToWindsurfSkill(input, 'gtd-test');
    assert.ok(result.includes('<windsurf_skill_adapter>'), 'adapter header present');
    assert.ok(result.includes('</windsurf_skill_adapter>'), 'adapter footer present');
    assert.ok(result.includes('Shell'), 'Shell tool mentioned');
    assert.ok(result.includes('StrReplace'), 'StrReplace tool mentioned');
  });
});

describe('convertClaudeAgentToWindsurfAgent', () => {
  test('converts agent frontmatter with unquoted name', () => {
    const input = `---
name: gtd-bugfix
description: "Fix bugs automatically"
color: blue
skills:
  - debug
  - test
---

Agent body content.
`;

    const result = convertClaudeAgentToWindsurfAgent(input);
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'name field present');
    assert.strictEqual(nameMatch[1], 'gtd-bugfix', 'agent name is plain scalar');
    // Should strip unsupported fields
    assert.ok(!result.includes('color:'), 'color field stripped');
    assert.ok(!result.includes('skills:'), 'skills field stripped');
  });
});

describe('convertClaudeToWindsurfMarkdown', () => {
  test('replaces Claude Code brand with Windsurf', () => {
    const input = 'Claude Code is a great tool for development.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(result.includes('Windsurf'), 'brand replaced');
    assert.ok(!result.includes('Claude Code'), 'original brand removed');
  });

  test('replaces CLAUDE.md with .windsurf/rules (no trailing slash)', () => {
    const input = 'See `CLAUDE.md` for configuration. Also check ./CLAUDE.md file.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(result.includes('.windsurf/rules'), 'CLAUDE.md replaced');
    assert.ok(!result.includes('.windsurf/rules/'), 'no trailing slash (Node v25 compat)');
  });

  test('replaces .claude/skills/ with .windsurf/skills/', () => {
    const input = 'Skills are stored in .claude/skills/ directory.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(result.includes('.windsurf/skills/'), 'skills path replaced');
  });

  test('replaces Bash( with Shell( and Edit( with StrReplace(', () => {
    const input = 'Use Bash(command) and Edit(file) tools.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(result.includes('Shell('), 'Bash -> Shell');
    assert.ok(result.includes('StrReplace('), 'Edit -> StrReplace');
  });

  test('replaces $ARGUMENTS with {{GTD_ARGS}}', () => {
    const input = 'Pass $ARGUMENTS to the command.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(result.includes('{{GTD_ARGS}}'), '$ARGUMENTS replaced');
  });

  test('removes classifyHandoffIfNeeded workarounds', () => {
    const input = '**Known Claude Code bug (classifyHandoffIfNeeded):** Some workaround text here\nNext line.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(!result.includes('classifyHandoffIfNeeded'), 'workaround removed');
  });
});

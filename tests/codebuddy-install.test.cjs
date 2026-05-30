// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

process.env.GTD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  getDirName,
  getGlobalDir,
  getConfigDirFromHome,
  convertClaudeToCodebuddyMarkdown,
  convertClaudeCommandToCodebuddySkill,
  convertClaudeAgentToCodebuddyAgent,
  copyCommandsAsCodebuddySkills,
  install,
  uninstall,
  writeManifest,
} = require('../bin/install.js');

describe('CodeBuddy runtime directory mapping', () => {
  test('maps CodeBuddy to .codebuddy for local installs', () => {
    assert.strictEqual(getDirName('codebuddy'), '.codebuddy');
  });

  test('maps CodeBuddy to ~/.codebuddy for global installs', () => {
    assert.strictEqual(getGlobalDir('codebuddy'), path.join(os.homedir(), '.codebuddy'));
  });

  test('returns .codebuddy config fragments for local and global installs', () => {
    assert.strictEqual(getConfigDirFromHome('codebuddy', false), "'.codebuddy'");
    assert.strictEqual(getConfigDirFromHome('codebuddy', true), "'.codebuddy'");
  });
});

describe('getGlobalDir (CodeBuddy)', () => {
  let originalCodebuddyConfigDir;

  beforeEach(() => {
    originalCodebuddyConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalCodebuddyConfigDir !== undefined) {
      process.env.CODEBUDDY_CONFIG_DIR = originalCodebuddyConfigDir;
    } else {
      delete process.env.CODEBUDDY_CONFIG_DIR;
    }
  });

  test('returns ~/.codebuddy with no env var or explicit dir', () => {
    delete process.env.CODEBUDDY_CONFIG_DIR;
    const result = getGlobalDir('codebuddy');
    assert.strictEqual(result, path.join(os.homedir(), '.codebuddy'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalDir('codebuddy', '/custom/codebuddy-path');
    assert.strictEqual(result, '/custom/codebuddy-path');
  });

  test('respects CODEBUDDY_CONFIG_DIR env var', () => {
    process.env.CODEBUDDY_CONFIG_DIR = '~/custom-codebuddy';
    const result = getGlobalDir('codebuddy');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-codebuddy'));
  });

  test('explicit dir takes priority over CODEBUDDY_CONFIG_DIR', () => {
    process.env.CODEBUDDY_CONFIG_DIR = '~/from-env';
    const result = getGlobalDir('codebuddy', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('CodeBuddy markdown conversion', () => {
  test('converts Claude-specific references to CodeBuddy equivalents', () => {
    const input = [
      'Claude Code reads CLAUDE.md before using .claude/skills/.',
      'Run /gtd:plan-phase with $ARGUMENTS.',
      'Use Bash(command) and Edit(file).',
    ].join('\n');

    const result = convertClaudeToCodebuddyMarkdown(input);

    assert.ok(result.includes('CodeBuddy reads CODEBUDDY.md before using .codebuddy/skills/.'), result);
    assert.ok(result.includes('/gtd-plan-phase'), result);
    assert.ok(result.includes('{{GTD_ARGS}}'), result);
    // CodeBuddy uses the same tool names as Claude Code — no conversion needed
    assert.ok(result.includes('Bash('), result);
    assert.ok(result.includes('Edit('), result);
  });

  test('converts commands and agents to CodeBuddy frontmatter', () => {
    const command = `---
name: gtd:new-project
description: Initialize a project
---

Use .claude/skills/ and /gtd:help.
`;
    const agent = `---
name: gtd-planner
description: Planner agent
tools: Read, Write
color: blue
---

Read CLAUDE.md before acting.
`;

    const convertedCommand = convertClaudeCommandToCodebuddySkill(command, 'gtd-new-project');
    const convertedAgent = convertClaudeAgentToCodebuddyAgent(agent);

    assert.ok(convertedCommand.includes('name: gtd-new-project'), convertedCommand);
    assert.ok(convertedCommand.includes('.codebuddy/skills/'), convertedCommand);
    assert.ok(convertedCommand.includes('/gtd-help'), convertedCommand);

    assert.ok(convertedAgent.includes('name: gtd-planner'), convertedAgent);
    assert.ok(!convertedAgent.includes('color:'), convertedAgent);
    assert.ok(convertedAgent.includes('CODEBUDDY.md'), convertedAgent);
  });
});

describe('copyCommandsAsCodebuddySkills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-codebuddy-copy-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates one skill directory per GTD command', () => {
    const srcDir = path.join(__dirname, '..', 'commands', 'gtd');
    const skillsDir = path.join(tmpDir, '.codebuddy', 'skills');

    copyCommandsAsCodebuddySkills(srcDir, skillsDir, 'gtd', '$HOME/.codebuddy/', 'codebuddy');

    const generated = path.join(skillsDir, 'gtd-help', 'SKILL.md');
    assert.ok(fs.existsSync(generated), generated);

    const content = fs.readFileSync(generated, 'utf8');
    assert.ok(content.includes('name: gtd-help'), content);
  });
});

describe('CodeBuddy local install/uninstall', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-codebuddy-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GTD into ./.codebuddy and removes it cleanly', () => {
    const result = install(false, 'codebuddy');
    const targetDir = path.join(tmpDir, '.codebuddy');

    // CodeBuddy supports settings.json hooks (Claude Code compatible)
    assert.strictEqual(result.runtime, 'codebuddy');
    assert.ok(result.settingsPath, 'should have settingsPath (CodeBuddy supports hooks)');

    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gtd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'get-tasks-done', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'codebuddy');
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('skills/gtd-help/')), JSON.stringify(manifest));

    uninstall(false, 'codebuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gtd-help')), 'CodeBuddy skill directory removed');
    assert.ok(!fs.existsSync(path.join(targetDir, 'get-tasks-done')), 'get-tasks-done removed');
  });
});

describe('E2E: CodeBuddy uninstall skills cleanup', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-codebuddy-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes all gtd-* skill directories on --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    const skillsDir = path.join(targetDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills dir exists after install');

    const installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gtd-'));
    assert.ok(installedSkills.length > 0, `found ${installedSkills.length} gtd-* skill dirs before uninstall`);

    uninstall(false, 'codebuddy');

    if (fs.existsSync(skillsDir)) {
      const remainingGtd = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gtd-'));
      assert.strictEqual(remainingGtd.length, 0,
        `Expected 0 gtd-* skill dirs after uninstall, found: ${remainingGtd.map(e => e.name).join(', ')}`);
    }
  });

  test('preserves non-GTD skill directories during --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    const customSkillDir = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')), 'custom skill exists before uninstall');

    uninstall(false, 'codebuddy');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')),
      'Non-GTD skill directory should be preserved after CodeBuddy uninstall');
  });

  test('removes engine directory on --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    assert.ok(fs.existsSync(path.join(targetDir, 'get-tasks-done', 'VERSION')),
      'engine exists before uninstall');

    uninstall(false, 'codebuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'get-tasks-done')),
      'get-tasks-done engine should be removed after CodeBuddy uninstall');
  });
});

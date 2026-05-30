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
  convertClaudeToTraeMarkdown,
  convertClaudeCommandToTraeSkill,
  convertClaudeAgentToTraeAgent,
  copyCommandsAsTraeSkills,
  install,
  uninstall,
  writeManifest,
} = require('../bin/install.js');

describe('Trae runtime directory mapping', () => {
  test('maps Trae to .trae for local installs', () => {
    assert.strictEqual(getDirName('trae'), '.trae');
  });

  test('maps Trae to ~/.trae for global installs', () => {
    assert.strictEqual(getGlobalDir('trae'), path.join(os.homedir(), '.trae'));
  });

  test('returns .trae config fragments for local and global installs', () => {
    assert.strictEqual(getConfigDirFromHome('trae', false), "'.trae'");
    assert.strictEqual(getConfigDirFromHome('trae', true), "'.trae'");
  });
});

describe('getGlobalDir (Trae)', () => {
  let originalTraeConfigDir;

  beforeEach(() => {
    originalTraeConfigDir = process.env.TRAE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalTraeConfigDir !== undefined) {
      process.env.TRAE_CONFIG_DIR = originalTraeConfigDir;
    } else {
      delete process.env.TRAE_CONFIG_DIR;
    }
  });

  test('returns ~/.trae with no env var or explicit dir', () => {
    delete process.env.TRAE_CONFIG_DIR;
    const result = getGlobalDir('trae');
    assert.strictEqual(result, path.join(os.homedir(), '.trae'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalDir('trae', '/custom/trae-path');
    assert.strictEqual(result, '/custom/trae-path');
  });

  test('respects TRAE_CONFIG_DIR env var', () => {
    process.env.TRAE_CONFIG_DIR = '~/custom-trae';
    const result = getGlobalDir('trae');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-trae'));
  });

  test('explicit dir takes priority over TRAE_CONFIG_DIR', () => {
    process.env.TRAE_CONFIG_DIR = '~/from-env';
    const result = getGlobalDir('trae', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('Trae markdown conversion', () => {
  test('converts Claude-specific references to Trae equivalents', () => {
    const input = [
      'Claude Code reads CLAUDE.md before using .claude/skills/.',
      'Run /gtd:plan-phase with $ARGUMENTS.',
      'Use Bash(command) and Edit(file).',
    ].join('\n');

    const result = convertClaudeToTraeMarkdown(input);

    assert.ok(result.includes('Trae reads .trae/rules/ before using .trae/skills/.'), result);
    assert.ok(result.includes('/gtd-plan-phase'), result);
    assert.ok(result.includes('{{GTD_ARGS}}'), result);
    assert.ok(result.includes('Shell('), result);
    assert.ok(result.includes('StrReplace('), result);
  });

  test('converts commands and agents to Trae frontmatter', () => {
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

    const convertedCommand = convertClaudeCommandToTraeSkill(command, 'gtd-new-project');
    const convertedAgent = convertClaudeAgentToTraeAgent(agent);

    assert.ok(convertedCommand.includes('name: gtd-new-project'), convertedCommand);
    assert.ok(!convertedCommand.includes('<trae_skill_adapter>'), convertedCommand);
    assert.ok(convertedCommand.includes('.trae/skills/'), convertedCommand);
    assert.ok(convertedCommand.includes('/gtd-help'), convertedCommand);

    assert.ok(convertedAgent.includes('name: gtd-planner'), convertedAgent);
    assert.ok(!convertedAgent.includes('color:'), convertedAgent);
    assert.ok(convertedAgent.includes('.trae/rules/'), convertedAgent);
  });
});

describe('copyCommandsAsTraeSkills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-trae-copy-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates one skill directory per GTD command', () => {
    const srcDir = path.join(__dirname, '..', 'commands', 'gtd');
    const skillsDir = path.join(tmpDir, '.trae', 'skills');

    copyCommandsAsTraeSkills(srcDir, skillsDir, 'gtd', '$HOME/.trae/', 'trae');

    const generated = path.join(skillsDir, 'gtd-help', 'SKILL.md');
    assert.ok(fs.existsSync(generated), generated);

    const content = fs.readFileSync(generated, 'utf8');
    assert.ok(!content.includes('<trae_skill_adapter>'), content);
    assert.ok(content.includes('name: gtd-help'), content);
  });
});

describe('Trae local install/uninstall', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-trae-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GTD into ./.trae and removes it cleanly', () => {
    const result = install(false, 'trae');
    const targetDir = path.join(tmpDir, '.trae');

    assert.deepStrictEqual(result, {
      settingsPath: null,
      settings: null,
      statuslineCommand: null,
      updateBannerCommand: null,
      runtime: 'trae',
      configDir: fs.realpathSync(targetDir),
    });

    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gtd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'get-tasks-done', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'trae');
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('skills/gtd-help/')), manifest);

    uninstall(false, 'trae');

    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gtd-help')), 'Trae skill directory removed');
    assert.ok(!fs.existsSync(path.join(targetDir, 'get-tasks-done')), 'get-tasks-done removed');
  });
});

describe('E2E: Trae uninstall skills cleanup', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-trae-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes all gtd-* skill directories on --trae --uninstall', () => {
    const targetDir = path.join(tmpDir, '.trae');
    install(false, 'trae');

    const skillsDir = path.join(targetDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills dir exists after install');

    const installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gtd-'));
    assert.ok(installedSkills.length > 0, `found ${installedSkills.length} gtd-* skill dirs before uninstall`);

    uninstall(false, 'trae');

    if (fs.existsSync(skillsDir)) {
      const remainingGtd = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gtd-'));
      assert.strictEqual(remainingGtd.length, 0,
        `Expected 0 gtd-* skill dirs after uninstall, found: ${remainingGtd.map(e => e.name).join(', ')}`);
    }
  });

  test('preserves non-GTD skill directories during --trae --uninstall', () => {
    const targetDir = path.join(tmpDir, '.trae');
    install(false, 'trae');

    const customSkillDir = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')), 'custom skill exists before uninstall');

    uninstall(false, 'trae');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')),
      'Non-GTD skill directory should be preserved after Trae uninstall');
  });

  test('removes engine directory on --trae --uninstall', () => {
    const targetDir = path.join(tmpDir, '.trae');
    install(false, 'trae');

    assert.ok(fs.existsSync(path.join(targetDir, 'get-tasks-done', 'VERSION')),
      'engine exists before uninstall');

    uninstall(false, 'trae');

    assert.ok(!fs.existsSync(path.join(targetDir, 'get-tasks-done')),
      'get-tasks-done engine should be removed after Trae uninstall');
  });
});

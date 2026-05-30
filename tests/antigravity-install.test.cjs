// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GTD Tools Tests - Antigravity Install Plumbing
 *
 * Tests for Antigravity runtime directory resolution, config paths,
 * content conversion functions, and integration with the multi-runtime installer.
 */

process.env.GTD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

const {
  getDirName,
  getGlobalDir,
  getConfigDirFromHome,
  convertClaudeToAntigravityContent,
  convertClaudeCommandToAntigravitySkill,
  convertClaudeAgentToAntigravityAgent,
  copyCommandsAsAntigravitySkills,
  writeManifest,
} = require('../bin/install.js');

// ─── getDirName ─────────────────────────────────────────────────────────────────

describe('getDirName (Antigravity)', () => {
  test('returns .agent for antigravity', () => {
    assert.strictEqual(getDirName('antigravity'), '.agent');
  });

  test('does not break existing runtimes', () => {
    assert.strictEqual(getDirName('claude'), '.claude');
    assert.strictEqual(getDirName('opencode'), '.opencode');
    assert.strictEqual(getDirName('gemini'), '.gemini');
    assert.strictEqual(getDirName('kilo'), '.kilo');
    assert.strictEqual(getDirName('codex'), '.codex');
    assert.strictEqual(getDirName('copilot'), '.github');
  });
});

// ─── getGlobalDir ───────────────────────────────────────────────────────────────

describe('getGlobalDir (Antigravity)', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.ANTIGRAVITY_CONFIG_DIR = savedEnv;
    } else {
      delete process.env.ANTIGRAVITY_CONFIG_DIR;
    }
  });

  test('returns ~/.gemini/antigravity by default', () => {
    const result = getGlobalDir('antigravity');
    assert.strictEqual(result, path.join(os.homedir(), '.gemini', 'antigravity'));
  });

  test('respects ANTIGRAVITY_CONFIG_DIR env var', () => {
    const customDir = path.join(os.homedir(), 'custom-ag');
    process.env.ANTIGRAVITY_CONFIG_DIR = customDir;
    const result = getGlobalDir('antigravity');
    assert.strictEqual(result, customDir);
  });

  test('explicit config-dir overrides env var', () => {
    process.env.ANTIGRAVITY_CONFIG_DIR = path.join(os.homedir(), 'from-env');
    const explicit = path.join(os.homedir(), 'explicit-ag');
    const result = getGlobalDir('antigravity', explicit);
    assert.strictEqual(result, explicit);
  });

  test('does not change Claude Code global dir', () => {
    assert.strictEqual(getGlobalDir('claude'), path.join(os.homedir(), '.claude'));
  });
});

// ─── getConfigDirFromHome ───────────────────────────────────────────────────────

describe('getConfigDirFromHome (Antigravity)', () => {
  test('returns .agent for local installs', () => {
    assert.strictEqual(getConfigDirFromHome('antigravity', false), "'.agent'");
  });

  test('returns .gemini, antigravity for global installs', () => {
    assert.strictEqual(getConfigDirFromHome('antigravity', true), "'.gemini', 'antigravity'");
  });

  test('does not change other runtimes', () => {
    assert.strictEqual(getConfigDirFromHome('claude', true), "'.claude'");
    assert.strictEqual(getConfigDirFromHome('gemini', true), "'.gemini'");
    assert.strictEqual(getConfigDirFromHome('kilo', true), "'.config', 'kilo'");
    assert.strictEqual(getConfigDirFromHome('copilot', true), "'.copilot'");
  });
});

// ─── convertClaudeToAntigravityContent ─────────────────────────────────────────

describe('convertClaudeToAntigravityContent', () => {
  describe('global install path replacements', () => {
    test('replaces ~/. claude/ with ~/.gemini/antigravity/', () => {
      const input = 'See ~/.claude/get-tasks-done/workflows/';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(result.includes('~/.gemini/antigravity/get-tasks-done/workflows/'), result);
      assert.ok(!result.includes('~/.claude/'), result);
    });

    test('replaces $HOME/.claude/ with $HOME/.gemini/antigravity/', () => {
      const input = 'path.join($HOME/.claude/get-tasks-done)';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(result.includes('$HOME/.gemini/antigravity/'), result);
      assert.ok(!result.includes('$HOME/.claude/'), result);
    });
  });

  describe('local install path replacements', () => {
    test('replaces ~/.claude/ with .agent/ for local installs', () => {
      const input = 'See ~/.claude/get-tasks-done/';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(result.includes('.agent/get-tasks-done/'), result);
      assert.ok(!result.includes('~/.claude/'), result);
    });

    test('replaces ./.claude/ with ./.agent/', () => {
      const input = 'path ./.claude/hooks/gtd-check-update.js';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(result.includes('./.agent/hooks/'), result);
      assert.ok(!result.includes('./.claude/'), result);
    });

    test('replaces .claude/ with .agent/', () => {
      const input = 'node .claude/hooks/gtd-statusline.js';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(result.includes('.agent/hooks/gtd-statusline.js'), result);
      assert.ok(!result.includes('.claude/'), result);
    });
  });

  describe('command name conversion', () => {
    test('converts /gtd:command to /gtd-command', () => {
      const input = 'Run /gtd:new-project to start';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(result.includes('/gtd-new-project'), result);
      assert.ok(!result.includes('gtd:'), result);
    });

    test('converts all gtd: references', () => {
      const input = '/gtd:plan-phase and /gtd:work-task-issue --phase';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(result.includes('/gtd-plan-phase'), result);
      assert.ok(result.includes('/gtd-work-task-issue'), result);
    });
  });

  test('does not modify unrelated content', () => {
    const input = 'This is a plain text description with no paths.';
    const result = convertClaudeToAntigravityContent(input, false);
    assert.strictEqual(result, input);
  });
});

// ─── convertClaudeCommandToAntigravitySkill ─────────────────────────────────────

describe('convertClaudeCommandToAntigravitySkill', () => {
  const claudeCommand = `---
name: gtd:new-project
description: Initialize a new GTD project with requirements and roadmap
argument-hint: "[project-name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Agent
---

Initialize new project at ~/.claude/get-tasks-done/workflows/new-project.md
`;

  test('produces name and description only in frontmatter', () => {
    const result = convertClaudeCommandToAntigravitySkill(claudeCommand, 'gtd-new-project', false);
    const fm = parseFrontmatter(result);
    assert.equal(fm.name, 'gtd-new-project', result);
    assert.equal(fm.description, 'Initialize a new GTD project with requirements and roadmap', result);
    assert.ok(!('allowed-tools' in fm), 'no allowed-tools field');
    assert.ok(!('argument-hint' in fm), 'no argument-hint field');
  });

  test('applies path replacement in body', () => {
    const result = convertClaudeCommandToAntigravitySkill(claudeCommand, 'gtd-new-project', false);
    assert.ok(result.includes('.agent/get-tasks-done/'), result);
    assert.ok(!result.includes('~/.claude/'), result);
  });

  test('uses provided skillName for name field', () => {
    const result = convertClaudeCommandToAntigravitySkill(claudeCommand, 'gtd-custom-name', false);
    assert.ok(result.includes('name: gtd-custom-name'), result);
  });

  test('converts gtd: command references in body', () => {
    const content = `---
name: test
description: test skill
---
Run /gtd:new-project to get started.
`;
    const result = convertClaudeCommandToAntigravitySkill(content, 'gtd-test', false);
    assert.ok(result.includes('/gtd-new-project'), result);
    assert.ok(!result.includes('gtd:'), result);
  });

  test('returns unchanged content when no frontmatter', () => {
    const noFm = 'Just some text without frontmatter.';
    const result = convertClaudeCommandToAntigravitySkill(noFm, 'gtd-test', false);
    // Path replacements still apply, but no frontmatter transformation
    assert.ok(!result.startsWith('---'), result);
  });
});

// ─── convertClaudeAgentToAntigravityAgent ──────────────────────────────────────

describe('convertClaudeAgentToAntigravityAgent', () => {
  const claudeAgent = `---
name: gtd-task-executor
description: Executes GTD plans with atomic commits
tools: Read, Write, Edit, Bash, Glob, Grep, Task
color: blue
---

Execute plans from ~/.claude/get-tasks-done/workflows/work-task-issue.md
`;

  test('preserves name and description', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, false);
    const fm = parseFrontmatter(result);
    assert.equal(fm.name, 'gtd-task-executor', result);
    assert.equal(fm.description, 'Executes GTD plans with atomic commits', result);
  });

  test('maps Claude tools to Gemini tool names', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, false);
    // Read → read_file, Bash → run_shell_command
    assert.ok(result.includes('read_file'), result);
    assert.ok(result.includes('run_shell_command'), result);
    // Original Claude names should not appear in tools line
    const fmEnd = result.indexOf('---', 3);
    const frontmatter = result.slice(0, fmEnd);
    assert.ok(!frontmatter.includes('tools: Read,'), frontmatter);
  });

  test('preserves color field', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, false);
    assert.ok(result.includes('color: blue'), result);
  });

  test('applies path replacement in body', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, false);
    assert.ok(result.includes('.agent/get-tasks-done/'), result);
    assert.ok(!result.includes('~/.claude/'), result);
  });

  test('uses global path for global installs', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, true);
    assert.ok(result.includes('~/.gemini/antigravity/get-tasks-done/'), result);
  });

  test('excludes Task tool (filtered by convertGeminiToolName)', () => {
    const result = convertClaudeAgentToAntigravityAgent(claudeAgent, false);
    // Task is excluded by convertGeminiToolName (returns null for Task)
    const fmEnd = result.indexOf('---', 3);
    const frontmatter = result.slice(0, fmEnd);
    assert.ok(!frontmatter.includes('Task'), frontmatter);
  });
});

// ─── copyCommandsAsAntigravitySkills ───────────────────────────────────────────

describe('copyCommandsAsAntigravitySkills', () => {
  let tmpDir;
  let srcDir;
  let skillsDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-ag-test-');
    srcDir = path.join(tmpDir, 'commands', 'gtd');
    skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(srcDir, { recursive: true });

    // Create a sample command file
    fs.writeFileSync(path.join(srcDir, 'new-project.md'), `---
name: gtd:new-project
description: Initialize a new project
allowed-tools:
  - Read
  - Write
---
Run /gtd:new-project to start.
`);

    // Create a subdirectory command
    const subDir = path.join(srcDir, 'subdir');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'sub-command.md'), `---
name: gtd:sub-command
description: A sub-command
allowed-tools:
  - Read
---
Body text.
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates skills directory', () => {
    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);
    assert.ok(fs.existsSync(skillsDir));
  });

  test('creates one skill directory per command with SKILL.md', () => {
    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);
    const skillDir = path.join(skillsDir, 'gtd-new-project');
    assert.ok(fs.existsSync(skillDir), 'skill dir should exist');
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'SKILL.md should exist');
  });

  test('handles subdirectory commands with prefixed names', () => {
    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);
    const subSkillDir = path.join(skillsDir, 'gtd-subdir-sub-command');
    assert.ok(fs.existsSync(subSkillDir), 'subdirectory skill dir should exist');
  });

  test('SKILL.md has minimal frontmatter (name + description only)', () => {
    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);
    const content = fs.readFileSync(path.join(skillsDir, 'gtd-new-project', 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(content);
    assert.equal(fm.name, 'gtd-new-project', content);
    assert.equal(fm.description, 'Initialize a new project', content);
    assert.ok(!('allowed-tools' in fm), 'no allowed-tools field');
  });

  test('SKILL.md body has paths converted for local install', () => {
    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);
    const content = fs.readFileSync(path.join(skillsDir, 'gtd-new-project', 'SKILL.md'), 'utf8');
    // gtd: → gtd- conversion
    assert.ok(!content.includes('gtd:'), content);
  });

  test('removes old gtd-* skill dirs before reinstalling', () => {
    // Create a stale skill dir
    const staleDir = path.join(skillsDir, 'gtd-old-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '---\nname: old\n---\n');

    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);

    assert.ok(!fs.existsSync(staleDir), 'stale skill dir should be removed');
  });

  test('does not remove non-gtd skill dirs', () => {
    // Create a non-GTD skill dir
    const otherDir = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(otherDir, { recursive: true });

    copyCommandsAsAntigravitySkills(srcDir, skillsDir, 'gtd', false);

    assert.ok(fs.existsSync(otherDir), 'non-GTD skill dir should be preserved');
  });
});

// ─── writeManifest (Antigravity) ───────────────────────────────────────────────

describe('writeManifest (Antigravity)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-manifest-ag-');
    // Create minimal structure
    const skillsDir = path.join(tmpDir, 'skills', 'gtd-help');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '---\nname: gtd-help\ndescription: Help\n---\n');
    const gtdDir = path.join(tmpDir, 'get-tasks-done');
    fs.mkdirSync(gtdDir, { recursive: true });
    fs.writeFileSync(path.join(gtdDir, 'VERSION'), '1.0.0');
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gtd-task-executor.md'), '---\nname: gtd-task-executor\n---\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes manifest JSON file', () => {
    writeManifest(tmpDir, 'antigravity');
    const manifestPath = path.join(tmpDir, 'gtd-file-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest file should exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.version, 'should have version');
    assert.ok(manifest.files, 'should have files');
  });

  test('manifest includes skills in skills/ directory', () => {
    writeManifest(tmpDir, 'antigravity');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gtd-file-manifest.json'), 'utf8'));
    const skillFiles = Object.keys(manifest.files).filter(f => f.startsWith('skills/'));
    assert.ok(skillFiles.length > 0, 'should have skill files in manifest');
  });

  test('manifest includes agent files', () => {
    writeManifest(tmpDir, 'antigravity');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gtd-file-manifest.json'), 'utf8'));
    const agentFiles = Object.keys(manifest.files).filter(f => f.startsWith('agents/'));
    assert.ok(agentFiles.length > 0, 'should have agent files in manifest');
  });
});

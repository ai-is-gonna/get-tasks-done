'use strict';

process.env.GTD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { install, uninstall, parseTomlToObject } = require('../bin/install.js');
const { createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
}

function extractSessionStartCommandsFromHooksJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const table = (value.hooks && typeof value.hooks === 'object' && !Array.isArray(value.hooks))
    ? value.hooks
    : value;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) => {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.map((h) => h && h.command).filter((cmd) => typeof cmd === 'string');
  });
}

describe('#3427 + #3433 — Codex installer avoids duplicate skills and mixed hook representation', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gtd-3427-3433-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('regenerates managed gtd-* skill copies and preserves unrelated user skills (#3562 reverses prior #3427/#3433 behaviour)', () => {
    // Stale legacy body — fresh install must overwrite this so Codex sees the
    // current SKILL.md, not whatever was last on disk.
    const legacySkillBody = '# old managed\n';
    fs.mkdirSync(path.join(codexHome, 'skills', 'gtd-help'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'gtd-help', 'SKILL.md'), legacySkillBody);
    const legacyHash = crypto.createHash('sha256').update(legacySkillBody).digest('hex');
    fs.writeFileSync(path.join(codexHome, 'gtd-file-manifest.json'), JSON.stringify({
      version: 1,
      files: {
        'skills/gtd-help/SKILL.md': legacyHash,
      },
    }, null, 2));

    fs.mkdirSync(path.join(codexHome, 'skills', 'custom-user-skill'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md'), '# user skill\n');

    withCodexHome(codexHome, () => install(true, 'codex'));

    const skillsDir = path.join(codexHome, 'skills');
    const entries = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];

    // #3562: $gtd-* commands are discoverable only when skills/gtd-*/SKILL.md
    // exists. The installer must regenerate (not remove) the managed gtd-*
    // directories.
    assert.equal(entries.includes('gtd-help'), true);
    const refreshedBody = fs.readFileSync(path.join(skillsDir, 'gtd-help', 'SKILL.md'), 'utf8');
    assert.notEqual(refreshedBody, legacySkillBody, 'stale legacy body must be overwritten');
    const frontmatter = parseFrontmatter(refreshedBody);
    assert.equal(frontmatter.name, 'gtd-help', 'refreshed SKILL.md frontmatter must declare name: gtd-help');

    // Unrelated user skills are preserved — the regen scope is `gtd-*` only.
    assert.equal(entries.includes('custom-user-skill'), true);
  });

  test('stores managed SessionStart update hook in hooks.json and removes inline gtd hook from config.toml', () => {
    const configToml = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /tmp/legacy/.codex/hooks/gtd-check-update.js"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml);

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => install(true, 'codex'));

    const parsedToml = parseTomlToObject(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    const tomlSessionStart = parsedToml.hooks?.SessionStart ?? [];
    const tomlCommands = tomlSessionStart.flatMap((entry) =>
      (Array.isArray(entry?.hooks) ? entry.hooks : []).map((hook) => hook.command).filter((cmd) => typeof cmd === 'string')
    );
    assert.equal(tomlCommands.some((cmd) => cmd.includes('gtd-check-update.js')), false);

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    const gtdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gtd-check-update.js'));

    assert.equal(gtdCommands.length, 1);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });

  test('uninstall removes managed SessionStart hook from hooks.json but preserves user hooks', () => {
    const hooksDir = path.join(codexHome, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gtd-check-update.js'), '// managed hook\n');
    const managedHookPath = path.join(codexHome, 'hooks', 'gtd-check-update.js').replace(/\\/g, '/');

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: `node "${managedHookPath}"` },
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => uninstall(true, 'codex'));

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    const gtdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gtd-check-update.js'));

    assert.equal(gtdCommands.length, 0);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });
});

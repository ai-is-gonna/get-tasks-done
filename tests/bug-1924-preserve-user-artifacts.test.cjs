// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

/**
 * Regression tests for bug #1924: gtd-update silently deletes user-generated files
 *
 * Running the installer (gtd-update / re-install) must not delete:
 *   - get-tasks-done/USER-PROFILE.md  (created by /gtd-profile-user)
 *   - commands/gtd/dev-preferences.md  (created by /gtd-profile-user)
 *
 * Root cause:
 *   1. copyWithPathReplacement() calls fs.rmSync(destDir, {recursive:true}) before
 *      copying — no preserve allowlist. This wipes USER-PROFILE.md.
 *   2. ~line 5211 explicitly rmSync's commands/gtd/ during global install legacy
 *      cleanup — no preserve. This wipes dev-preferences.md.
 *
 * Fix requirement:
 *   - install() must preserve USER-PROFILE.md across the get-tasks-done/ wipe
 *   - install() must preserve dev-preferences.md across the commands/gtd/ wipe
 *
 * Closes: #1924
 */

'use strict';

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

// ─── Ensure hooks/dist/ is populated before any install test ─────────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer with CLAUDE_CONFIG_DIR redirected to a temp directory.
 * Explicitly removes GTD_TEST_MODE so the subprocess actually runs the installer
 * (not just the export block). Uses --yes to suppress interactive prompts.
 */
function runInstaller(configDir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GTD_TEST_MODE;
  // --no-sdk: this test covers user-artifact preservation only; skip SDK
  // build (covered by install-smoke.yml) to keep the test deterministic.
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });
}

// ─── Test 1: USER-PROFILE.md is preserved across re-install ─────────────────

describe('#1924: USER-PROFILE.md preserved across re-install (global Claude)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-1924-userprofile-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('USER-PROFILE.md exists after initial install + user creation', () => {
    runInstaller(tmpDir);

    // Simulate /gtd-profile-user creating USER-PROFILE.md inside get-tasks-done/
    const profilePath = path.join(tmpDir, 'get-tasks-done', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# My Profile\n\nCustom user content.\n');

    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md should exist after being created by /gtd-profile-user'
    );
  });

  test('USER-PROFILE.md is preserved after re-install', () => {
    // First install
    runInstaller(tmpDir);

    // User runs /gtd-profile-user, creating USER-PROFILE.md
    const profilePath = path.join(tmpDir, 'get-tasks-done', 'USER-PROFILE.md');
    const originalContent = '# My Profile\n\nThis is my custom user profile content.\n';
    fs.writeFileSync(profilePath, originalContent);

    // Re-run installer (simulating gtd-update)
    runInstaller(tmpDir);

    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md must survive re-install — gtd-update must not delete user-generated profiles'
    );

    const afterContent = fs.readFileSync(profilePath, 'utf8');
    assert.strictEqual(
      afterContent,
      originalContent,
      'USER-PROFILE.md content must be identical after re-install'
    );
  });

  test('USER-PROFILE.md is preserved even when get-tasks-done/ is wiped and recreated', () => {
    runInstaller(tmpDir);

    const gtdDir = path.join(tmpDir, 'get-tasks-done');
    const profilePath = path.join(gtdDir, 'USER-PROFILE.md');

    // Confirm get-tasks-done/ was created by install
    assert.ok(fs.existsSync(gtdDir), 'get-tasks-done/ must exist after install');

    // Write profile
    fs.writeFileSync(profilePath, '# Profile\n\nMy coding style preferences.\n');

    // Re-install
    runInstaller(tmpDir);

    // get-tasks-done/ must still exist AND profile must be intact
    assert.ok(fs.existsSync(gtdDir), 'get-tasks-done/ must still exist after re-install');
    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md must still exist after get-tasks-done/ was wiped and recreated'
    );
  });
});

// ─── Test 2: dev-preferences.md is preserved across re-install ───────────────

describe('#1924: dev-preferences.md preserved across re-install (global Claude)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-1924-devprefs-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('dev-preferences.md is preserved when commands/gtd/ is cleaned up during re-install', () => {
    // First install (creates skills/ structure for global Claude)
    runInstaller(tmpDir);

    // User runs /gtd-profile-user — it creates dev-preferences.md in commands/gtd/
    const commandsGtdDir = path.join(tmpDir, 'commands', 'gtd');
    fs.mkdirSync(commandsGtdDir, { recursive: true });
    const devPrefsPath = path.join(commandsGtdDir, 'dev-preferences.md');
    const originalContent = '# Dev Preferences\n\nI prefer TDD. I like short functions.\n';
    fs.writeFileSync(devPrefsPath, originalContent);

    // Re-run installer (simulating gtd-update)
    // Bug: this triggers legacy cleanup that rmSync's commands/gtd/ entirely,
    // deleting dev-preferences.md
    runInstaller(tmpDir);

    assert.ok(
      fs.existsSync(devPrefsPath),
      'dev-preferences.md must survive re-install — gtd-update legacy cleanup must not delete user-generated files'
    );

    const afterContent = fs.readFileSync(devPrefsPath, 'utf8');
    assert.strictEqual(
      afterContent,
      originalContent,
      'dev-preferences.md content must be identical after re-install'
    );
  });

  test('legacy non-user GTD commands are still cleaned up during re-install', () => {
    // First install
    runInstaller(tmpDir);

    // Simulate a legacy GTD command file being left in commands/gtd/
    const commandsGtdDir = path.join(tmpDir, 'commands', 'gtd');
    fs.mkdirSync(commandsGtdDir, { recursive: true });
    const legacyFile = path.join(commandsGtdDir, 'next.md');
    fs.writeFileSync(legacyFile, '---\nname: gtd:next\n---\n\nLegacy content.');

    // But dev-preferences.md is also there (user-generated)
    const devPrefsPath = path.join(commandsGtdDir, 'dev-preferences.md');
    fs.writeFileSync(devPrefsPath, '# Dev Preferences\n\nMy preferences.\n');

    // Re-install
    runInstaller(tmpDir);

    // dev-preferences.md must be preserved
    assert.ok(
      fs.existsSync(devPrefsPath),
      'dev-preferences.md must be preserved while legacy commands/gtd/ is cleaned up'
    );

    // The legacy GTD command (next.md) is NOT user-generated, should be removed
    // (it would exist only as a skill now in skills/gtd-next/SKILL.md)
    assert.ok(
      !fs.existsSync(legacyFile),
      'legacy GTD command next.md in commands/gtd/ must be removed during cleanup'
    );
  });
});

// ─── Test 3: profile-user.md backup path is outside get-tasks-done/ ───────────

describe('#1924: profile-user.md backup path must be outside get-tasks-done/', () => {
  test('profile-user.md backup uses ~/.claude/USER-PROFILE.backup.md not ~/.claude/get-tasks-done/USER-PROFILE.backup.md', () => {
    const workflowPath = path.join(
      __dirname, '..', 'get-tasks-done', 'workflows', 'profile-user.md'
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    // The backup must NOT be inside get-tasks-done/ because that directory is wiped on update
    assert.ok(
      !content.includes('get-tasks-done/USER-PROFILE.backup.md'),
      'backup path must NOT be inside get-tasks-done/ — that directory is wiped on gtd-update'
    );

    // The backup should be at ~/.claude/USER-PROFILE.backup.md (outside get-tasks-done/)
    assert.ok(
      content.includes('USER-PROFILE.backup.md') &&
      !content.includes('/get-tasks-done/USER-PROFILE.backup.md'),
      'backup path must be outside get-tasks-done/ (e.g. ~/.claude/USER-PROFILE.backup.md)'
    );
  });
});

// ─── Test 4: preserveUserArtifacts helper exported from install.js ────────────

describe('#1924: preserveUserArtifacts helper exists in install.js', () => {
  test('install.js exports preserveUserArtifacts function', () => {
    // Set GTD_TEST_MODE so require() reaches the module.exports block
    const origMode = process.env.GTD_TEST_MODE;
    process.env.GTD_TEST_MODE = '1';
    let mod;
    try {
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) {
        delete process.env.GTD_TEST_MODE;
      } else {
        process.env.GTD_TEST_MODE = origMode;
      }
    }

    assert.strictEqual(
      typeof mod.preserveUserArtifacts,
      'function',
      'install.js must export preserveUserArtifacts helper for testability'
    );
  });
});

/**
 * Regression test for #3610: fresh `npx get-tasks-done@latest --codex`
 * hard-aborts when the target ~/.codex/hooks/ contains the bundled GTD
 * hook files (`gtd-check-update-worker.js`, `gtd-prompt-guard.js`, …)
 * left over from a previous version. The installer-migration report
 * classifies them as "GTD-looking file is not proven manifest-managed
 * and needs explicit user choice" and `assertInstallerMigrationsUnblocked`
 * throws.
 *
 * The files in question are NOT user-owned — they are the GTD bundled
 * hooks shipped under `hooks/gtd-*` in the npm package. The fix adds a
 * `bundled-gtd-hook` classification to `classifyPromptUserAction` so the
 * resolver removes them (the installer then writes the fresh bundled
 * versions in their place).
 *
 * Because this classification is unambiguous (these are not user files),
 * it must apply regardless of whether stdin is a TTY — the reporter's
 * `npx ... --codex` run was interactive and the existing non-TTY
 * resolver gate at install.js:8069 skipped the safe-default pass.
 */

'use strict';

process.env.GTD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  runInstallerMigrations,
} = require('../get-tasks-done/bin/lib/installer-migrations.cjs');
const {
  assertInstallerMigrationsUnblocked,
  resolveInstallerMigrationPromptsForNonTty,
  classifyPromptUserAction,
} = require('../get-tasks-done/bin/lib/installer-migration-report.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gtd-file-manifest.json'),
    JSON.stringify(
      {
        version: '1.41.2',
        timestamp: '2026-05-10T00:00:00.000Z',
        mode: 'full',
        files,
      },
      null,
      2,
    ),
    'utf8',
  );
}

// Reporter's exact list of blocked files from the v1.42.2 → v1.42.0 upgrade
// abort. Each is a real `hooks/gtd-*` file shipped under hooks/ in the npm
// package (verified by `ls hooks/`).
const BUNDLED_HOOK_RELPATHS = [
  'hooks/gtd-check-update-worker.js',
  'hooks/gtd-check-update.js',
  'hooks/gtd-context-monitor.js',
  'hooks/gtd-phase-boundary.sh',
  'hooks/gtd-prompt-guard.js',
  'hooks/gtd-read-guard.js',
  'hooks/gtd-read-injection-scanner.js',
  'hooks/gtd-session-state.sh',
  'hooks/gtd-statusline.js',
  'hooks/gtd-update-banner.js',
  'hooks/gtd-validate-commit.sh',
  'hooks/gtd-workflow-guard.js',
];

describe('bug #3610: classifyPromptUserAction recognizes bundled GTD hooks', () => {
  test('classifies hooks/gtd-*.js as bundled-gtd-hook → remove', () => {
    const result = classifyPromptUserAction({
      relPath: 'hooks/gtd-prompt-guard.js',
    });
    assert.ok(result, 'classifier returned null for a bundled GTD hook (.js)');
    assert.strictEqual(result.category, 'bundled-gtd-hook');
    assert.strictEqual(
      result.choice,
      'remove',
      'bundled hook must default to remove so the installer can write the fresh bundled version',
    );
  });

  test('classifies hooks/gtd-*.sh as bundled-gtd-hook → remove', () => {
    const result = classifyPromptUserAction({
      relPath: 'hooks/gtd-validate-commit.sh',
    });
    assert.ok(result);
    assert.strictEqual(result.category, 'bundled-gtd-hook');
    assert.strictEqual(result.choice, 'remove');
  });

  test('does NOT classify non-gtd hooks (preserves user-owned hook files)', () => {
    // A user's custom hook that happens to live under hooks/ must NOT be
    // auto-classified as bundled — the existing block-then-choose flow
    // continues to apply, preserving the user's control over their files.
    const result = classifyPromptUserAction({
      relPath: 'hooks/my-custom-hook.js',
    });
    assert.strictEqual(
      result,
      null,
      'non-gtd-prefixed hook must NOT auto-classify (would clobber user files)',
    );
  });

  test('does NOT classify deeper paths under hooks/gtd-* (e.g. hooks/lib/) as bundled-gtd-hook', () => {
    // The bundled GTD distribution has hooks/lib/ (helper modules). Those
    // are managed differently — verify the classifier limits itself to
    // top-level hooks/gtd-<name>.<ext> files, not nested directories.
    const result = classifyPromptUserAction({
      relPath: 'hooks/gtd-helpers/index.js',
    });
    assert.strictEqual(result, null);
  });
});

describe('bug #3610: fresh upgrade with leftover bundled hooks does not throw', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gtd-3610-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('end-to-end: 12 leftover bundled hooks + empty manifest → resolver clears all blockers', () => {
    // Recreate the reporter's environment: 12 bundled `gtd-*` hook files
    // present at target, but the manifest has not yet seeded their baseline
    // entries (first-time-baseline scan).
    for (const rel of BUNDLED_HOOK_RELPATHS) {
      writeFile(configDir, rel, '#!/usr/bin/env node\n// stale 1.42.0 hook\n');
    }
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'codex',
      scope: 'global',
      baselineScan: true,
    });

    // Precondition: all 12 leftover hooks classify as prompt-user blockers.
    const blockedPaths = (result.blocked || []).map((a) => a.relPath).sort();
    assert.deepStrictEqual(
      blockedPaths,
      [...BUNDLED_HOOK_RELPATHS].sort(),
      'precondition: every leftover hooks/gtd-* should be a prompt-user blocker',
    );

    // Resolve through the safe-default classifier (passing isTty=false to
    // exercise the same code path the bundled-hook classification will hit
    // regardless of TTY once the fix removes the gate).
    const resolved = resolveInstallerMigrationPromptsForNonTty(result, { isTty: false });

    assert.strictEqual(
      resolved.resolutions.length,
      BUNDLED_HOOK_RELPATHS.length,
      'every bundled hook should produce a safe-default resolution entry',
    );

    for (const entry of resolved.resolutions) {
      assert.strictEqual(entry.category, 'bundled-gtd-hook');
      assert.strictEqual(entry.choice, 'remove');
      assert.strictEqual(entry.resolvedActionType, 'backup-and-remove');
    }

    assert.strictEqual(
      (resolved.result.blocked || []).length,
      0,
      'no blockers should remain after bundled-hook classification fires',
    );
    assert.doesNotThrow(() => assertInstallerMigrationsUnblocked(resolved.result));
  });
});

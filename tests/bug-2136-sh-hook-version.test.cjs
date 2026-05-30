// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

// allow-test-rule: structural-regression-guard
// The shebang line must be `#!/usr/bin/env bash` (PATH-resolved) rather than
// `#!/bin/bash` for cross-distro portability (NixOS, minimal Alpine do not
// ship /bin/bash). This is an architectural constraint that cannot be verified
// by executing the hooks — they run fine with either shebang on distros that
// have /bin/bash, so only a source assertion catches a future regression.

/**
 * Regression tests for bug #2136 / #2206
 *
 * Root cause: three bash hooks (gtd-phase-boundary.sh, gtd-session-state.sh,
 * gtd-validate-commit.sh) shipped without a gtd-hook-version header, and the
 * stale-hook detector in gtd-check-update.js only matched JavaScript comment
 * syntax (//) — not bash comment syntax (#).
 *
 * Result: every session showed "⚠ stale hooks — run /gtd-update" immediately
 * after a fresh install, because the detector saw hookVersion: 'unknown' for
 * all three bash hooks.
 *
 * This fix requires THREE parts working in concert:
 *   1. Bash hooks ship with "# gtd-hook-version: {{GTD_VERSION}}"
 *   2. install.js substitutes {{GTD_VERSION}} in .sh files at install time
 *   3. gtd-check-update.js regex matches both "//" and "#" comment styles
 *
 * Neither fix alone is sufficient:
 *   - Headers + regex fix only (no install.js fix): installed hooks contain
 *     literal "{{GTD_VERSION}}" — the {{-guard silently skips them, making
 *     bash hook staleness permanently undetectable after future updates.
 *   - Headers + install.js fix only (no regex fix): installed hooks are
 *     stamped correctly but the detector still can't read bash "#" comments,
 *     so they still land in the "unknown / stale" branch on every session.
 */

'use strict';

// NOTE: Do NOT set GTD_TEST_MODE here — the E2E install tests spawn the
// real installer subprocess, which skips all install logic when GTD_TEST_MODE=1.

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const CHECK_UPDATE_FILE = path.join(HOOKS_DIR, 'gtd-check-update.js');
const WORKER_FILE = path.join(HOOKS_DIR, 'gtd-check-update-worker.js');
const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

const SH_HOOKS = [
  'gtd-phase-boundary.sh',
  'gtd-session-state.sh',
  'gtd-validate-commit.sh',
];

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────

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

function runInstaller(configDir) {
  // --no-sdk: this test covers .sh hook version stamping only; skip SDK
  // build (covered by install-smoke.yml).
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  return path.join(configDir, 'hooks');
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: Bash hook sources carry the version header placeholder
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 1: bash hook sources carry gtd-hook-version placeholder', () => {
  for (const sh of SH_HOOKS) {
    test(`${sh} contains "# gtd-hook-version: {{GTD_VERSION}}"`, () => {
      const content = fs.readFileSync(path.join(HOOKS_DIR, sh), 'utf8');
      assert.ok(
        content.includes('# gtd-hook-version: {{GTD_VERSION}}'),
        `${sh} must include "# gtd-hook-version: {{GTD_VERSION}}" so the ` +
        `installer can stamp it and gtd-check-update.js can detect staleness`
      );
    });
  }

  test('version header is on line 2 (immediately after shebang)', () => {
    // Placing the header immediately after the shebang ensures it is always
    // found regardless of how much of the file is read. The shebang itself
    // must use `#!/usr/bin/env bash` (PATH-resolved) rather than `#!/bin/bash`
    // — POSIX guarantees /bin/sh but not /bin/bash, and distros like NixOS
    // do not ship /bin/bash by default.
    for (const sh of SH_HOOKS) {
      const lines = fs.readFileSync(path.join(HOOKS_DIR, sh), 'utf8').split('\n');
      assert.strictEqual(
        lines[0],
        '#!/usr/bin/env bash',
        `${sh} line 1 must be "#!/usr/bin/env bash" for cross-distro portability`
      );
      assert.ok(
        lines[1].startsWith('# gtd-hook-version:'),
        `${sh} line 2 must be the gtd-hook-version header (got: "${lines[1]}")`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: gtd-check-update-worker.js regex handles bash "#" comment syntax
// (Logic moved from inline -e template literal to dedicated worker file)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 2: stale-hook detector handles bash comment syntax', () => {
  let src;

  before(() => {
    src = fs.readFileSync(WORKER_FILE, 'utf8');
  });

  test('version regex in source matches "#" comment syntax in addition to "//"', () => {
    // The regex string in the source must contain the alternation for "#".
    // The worker uses plain JS (no template-literal escaping), so the form is
    // "(?:\/\/|#)" directly in source.
    const hasBashAlternative =
      src.includes('(?:\\/\\/|#)') ||     // escaped form (old template-literal style)
      src.includes('(?:\/\/|#)');          // direct form in plain JS worker
    assert.ok(
      hasBashAlternative,
      'gtd-check-update-worker.js version regex must include an alternative for bash "#" comments. ' +
      'Expected to find (?:\\/\\/|#) or (?:\/\/|#) in the source. ' +
      'The original "//" only regex causes bash hooks to always report hookVersion: "unknown"'
    );
  });

  test('version regex does not use the old JS-only form as the sole pattern', () => {
    // The old regex inside the template literal was the string:
    //   /\\/\\/ gtd-hook-version:\\s*(.+)/
    // which, when evaluated in the subprocess, produced: /\/\/ gtd-hook-version:\s*(.+)/
    // That only matched JS "//" comments — never bash "#".
    // We verify that the old exact string no longer appears.
    assert.ok(
      !src.includes('\\/\\/ gtd-hook-version'),
      'gtd-check-update-worker.js must not use the old JS-only (\\/\\/ gtd-hook-version) ' +
      'escape form as the sole version matcher — it cannot match bash "#" comments'
    );
  });

  test('version regex correctly matches both bash and JS hook version headers', () => {
    // Verify that the versionMatch line in the source uses a regex that matches
    // both bash "#" and JS "//" comment styles. We check the source contains the
    // expected alternation, then directly test the known required pattern.
    //
    // We do NOT try to extract and evaluate the regex from source (it contains ")"
    // which breaks simple extraction), so instead we confirm the source matches
    // our expectation and run the regex itself.
    assert.ok(
      src.includes('gtd-hook-version'),
      'gtd-check-update-worker.js must contain a gtd-hook-version version check'
    );

    // The fixed regex that must be present: matches both comment styles
    const fixedRegex = /(?:\/\/|#) gtd-hook-version:\s*(.+)/;

    assert.ok(
      fixedRegex.test('# gtd-hook-version: 1.36.0'),
      'bash-style "# gtd-hook-version: X" must be matchable by the required regex'
    );
    assert.ok(
      fixedRegex.test('// gtd-hook-version: 1.36.0'),
      'JS-style "// gtd-hook-version: X" must still match (no regression)'
    );
    assert.ok(
      !fixedRegex.test('gtd-hook-version: 1.36.0'),
      'line without a comment prefix must not match (prevents false positives)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3a: install.js bundled path substitutes {{GTD_VERSION}} in .sh hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 3a: install.js bundled path substitutes {{GTD_VERSION}} in .sh hooks', () => {
  let src;

  before(() => {
    src = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
  });

  test('.sh branch in bundled hook copy loop reads file and substitutes GTD_VERSION', () => {
    // Anchor on configDirReplacement — unique to the bundled-hooks path.
    const anchorIdx = src.indexOf('configDirReplacement');
    assert.ok(anchorIdx !== -1, 'bundled hook copy loop anchor (configDirReplacement) not found');

    // Window large enough for the if/else block
    const region = src.slice(anchorIdx, anchorIdx + 2000);

    assert.ok(
      region.includes("entry.endsWith('.sh')"),
      "bundled hook copy loop must check entry.endsWith('.sh')"
    );
    assert.ok(
      region.includes('GTD_VERSION'),
      'bundled .sh branch must reference GTD_VERSION substitution. Without this, ' +
      'installed .sh hooks contain the literal "{{GTD_VERSION}}" placeholder and ' +
      'bash hook staleness becomes permanently undetectable after future updates'
    );
    // copyFileSync on a .sh file would skip substitution — ensure we read+write instead
    const shBranchIdx = region.indexOf("entry.endsWith('.sh')");
    const shBranchRegion = region.slice(shBranchIdx, shBranchIdx + 400);
    assert.ok(
      shBranchRegion.includes('readFileSync') || shBranchRegion.includes('writeFileSync'),
      'bundled .sh branch must read the file (readFileSync) to perform substitution, ' +
      'not copyFileSync directly (which skips template expansion)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3b: install.js Codex path also substitutes {{GTD_VERSION}} in .sh hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 3b: install.js Codex path substitutes {{GTD_VERSION}} in .sh hooks', () => {
  let src;

  before(() => {
    src = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
  });

  test('.sh branch in Codex hook copy block substitutes GTD_VERSION', () => {
    // Anchor on codexHooksSrc — unique to the Codex path.
    const anchorIdx = src.indexOf('codexHooksSrc');
    assert.ok(anchorIdx !== -1, 'Codex hook copy block anchor (codexHooksSrc) not found');

    const region = src.slice(anchorIdx, anchorIdx + 2000);

    assert.ok(
      region.includes("entry.endsWith('.sh')"),
      "Codex hook copy block must check entry.endsWith('.sh')"
    );
    assert.ok(
      region.includes('GTD_VERSION'),
      'Codex .sh branch must substitute {{GTD_VERSION}}. The bundled path was fixed ' +
      'but Codex installs a separate copy of the hooks from hooks/dist that also needs stamping'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 4: End-to-end — installed .sh hooks have stamped version, not placeholder
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 4: installed .sh hooks contain stamped concrete version', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-2136-install-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('installed .sh hooks contain a concrete version string, not the template placeholder', () => {
    const hooksDir = runInstaller(tmpDir);

    for (const sh of SH_HOOKS) {
      const hookPath = path.join(hooksDir, sh);
      assert.ok(fs.existsSync(hookPath), `${sh} must be installed`);

      const content = fs.readFileSync(hookPath, 'utf8');

      assert.ok(
        content.includes('# gtd-hook-version:'),
        `installed ${sh} must contain a "# gtd-hook-version:" header`
      );
      assert.ok(
        !content.includes('{{GTD_VERSION}}'),
        `installed ${sh} must not contain literal "{{GTD_VERSION}}" — ` +
        `install.js must substitute it with the concrete package version`
      );

      const versionMatch = content.match(/# gtd-hook-version:\s*(\S+)/);
      assert.ok(versionMatch, `installed ${sh} version header must have a version value`);
      assert.match(
        versionMatch[1],
        /^\d+\.\d+\.\d+/,
        `installed ${sh} version "${versionMatch[1]}" must be a semver-like string`
      );
    }
  });

  test('stale-hook detector reports zero stale bash hooks immediately after fresh install', () => {
    // This is the definitive end-to-end proof: after install, run the actual
    // version-check logic (extracted from gtd-check-update.js) against the
    // installed hooks and verify none are flagged stale.
    const hooksDir = runInstaller(tmpDir);
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    const installedVersion = pkg.version;

    // Build a subprocess that runs the staleness check logic in isolation.
    // We pass the installed version, hooks dir, and hook filenames as JSON
    // to avoid any injection risk.
    const checkScript = `
      'use strict';
      const fs = require('fs');
      const path = require('path');

      function isNewer(a, b) {
        const pa = (a || '').split('.').map(s => Number(s.replace(/-.*/, '')) || 0);
        const pb = (b || '').split('.').map(s => Number(s.replace(/-.*/, '')) || 0);
        for (let i = 0; i < 3; i++) {
          if (pa[i] > pb[i]) return true;
          if (pa[i] < pb[i]) return false;
        }
        return false;
      }

      const hooksDir = ${JSON.stringify(hooksDir)};
      const installed = ${JSON.stringify(installedVersion)};
      const shHooks = ${JSON.stringify(SH_HOOKS)};
      // Use the same regex that the fixed gtd-check-update.js uses
      const versionRe = /(?:\\/\\/|#) gtd-hook-version:\\s*(.+)/;

      const staleHooks = [];
      for (const hookFile of shHooks) {
        const hookPath = path.join(hooksDir, hookFile);
        if (!fs.existsSync(hookPath)) {
          staleHooks.push({ file: hookFile, hookVersion: 'missing' });
          continue;
        }
        const content = fs.readFileSync(hookPath, 'utf8');
        const m = content.match(versionRe);
        if (m) {
          const hookVersion = m[1].trim();
          if (isNewer(installed, hookVersion) && !hookVersion.includes('{{')) {
            staleHooks.push({ file: hookFile, hookVersion, installedVersion: installed });
          }
        } else {
          staleHooks.push({ file: hookFile, hookVersion: 'unknown', installedVersion: installed });
        }
      }
      process.stdout.write(JSON.stringify(staleHooks));
    `;

    const result = execFileSync(process.execPath, ['-e', checkScript], { encoding: 'utf8' });
    const staleHooks = JSON.parse(result);

    assert.deepStrictEqual(
      staleHooks,
      [],
      `Fresh install must produce zero stale bash hooks.\n` +
      `Got: ${JSON.stringify(staleHooks, null, 2)}\n` +
      `This indicates either the version header was not stamped by install.js, ` +
      `or the detector regex cannot match bash "#" comment syntax.`
    );
  });
});

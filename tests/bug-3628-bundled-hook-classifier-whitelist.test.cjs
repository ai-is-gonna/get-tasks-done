// allow-test-rule: architectural-invariant
// classifyPromptUserAction returns a typed result object; this test asserts
// on that typed surface (category + choice fields) for both the positive
// (shipped) and negative (user-owned / retired) cases. There is no rendered
// text or stdout under test — the classifier's structured return value IS
// the contract.

/**
 * Bug #3628: `bundled-gtd-hook` classifier (added in #3610) uses a shape
 * regex (`/^hooks\/gtd-[^/]+\.(?:js|sh|cjs|mjs)$/`) that matches ANY file
 * named `hooks/gtd-<name>.{js,sh,cjs,mjs}`, not only the 13 hook files
 * actually shipped in the npm distribution. The permissive shape regex
 * silently auto-classifies — and on first-time-baseline scan auto-removes:
 *
 *   - User-authored custom hooks (e.g. `hooks/gtd-personal-experiment.js`)
 *   - Retired bundled hooks from prior GTD versions
 *
 * Fix: the classifier must whitelist the explicit set of shipped hook
 * filenames sourced from a single point of truth (`BUNDLED_GTD_HOOK_FILES`
 * exported from the classifier module). Any `hooks/gtd-<name>` file NOT in
 * that set must fall through to the existing block-or-prompt flow so the
 * user retains control.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPromptUserAction,
  BUNDLED_GTD_HOOK_FILES,
} = require('../get-tasks-done/bin/lib/installer-migration-report.cjs');
const path = require('node:path');
const fs = require('node:fs');

describe('bug #3628: BUNDLED_GTD_HOOK_FILES is an explicit whitelist', () => {
  test('exports a Set of shipped hook filenames', () => {
    assert.ok(
      BUNDLED_GTD_HOOK_FILES instanceof Set,
      'BUNDLED_GTD_HOOK_FILES must be exported as a Set so callers can probe membership',
    );
    assert.ok(
      BUNDLED_GTD_HOOK_FILES.size > 0,
      'BUNDLED_GTD_HOOK_FILES must enumerate at least one shipped hook',
    );
  });

  test('every entry is a hooks/-prefixed posix path', () => {
    for (const relPath of BUNDLED_GTD_HOOK_FILES) {
      assert.ok(
        relPath.startsWith('hooks/'),
        `entry ${JSON.stringify(relPath)} must be prefixed with "hooks/"`,
      );
      assert.ok(
        !relPath.includes('\\'),
        `entry ${JSON.stringify(relPath)} must use POSIX slashes`,
      );
      assert.ok(
        relPath.includes('gtd-'),
        `entry ${JSON.stringify(relPath)} must contain the "gtd-" prefix`,
      );
    }
  });

  test('every BUNDLED_GTD_HOOK_FILES entry corresponds to a real file in hooks/', () => {
    // Sourcing the whitelist from a frozen constant is only durable if the
    // constant stays aligned with the on-disk distribution. This guard
    // fails the day someone removes a hook file but forgets to update the
    // whitelist (or vice-versa).
    const hooksDir = path.join(__dirname, '..', 'hooks');
    for (const relPath of BUNDLED_GTD_HOOK_FILES) {
      const fullPath = path.join(hooksDir, relPath.slice('hooks/'.length));
      assert.ok(
        fs.existsSync(fullPath),
        `whitelisted ${relPath} is missing from hooks/ on disk — whitelist drifted`,
      );
    }
  });

  test('every gtd-*.{js,sh,cjs,mjs} file in hooks/ is in BUNDLED_GTD_HOOK_FILES (no shipping drift)', () => {
    const hooksDir = path.join(__dirname, '..', 'hooks');
    const onDisk = fs
      .readdirSync(hooksDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^gtd-[^/]+\.(?:js|sh|cjs|mjs)$/.test(e.name))
      .map((e) => `hooks/${e.name}`);
    for (const relPath of onDisk) {
      assert.ok(
        BUNDLED_GTD_HOOK_FILES.has(relPath),
        `${relPath} ships in hooks/ but is missing from BUNDLED_GTD_HOOK_FILES — whitelist drifted`,
      );
    }
  });
});

describe('bug #3628: classifyPromptUserAction whitelists shipped bundled hooks', () => {
  test('classifies every entry in BUNDLED_GTD_HOOK_FILES as bundled-gtd-hook → remove', () => {
    for (const relPath of BUNDLED_GTD_HOOK_FILES) {
      const result = classifyPromptUserAction({ relPath });
      assert.deepStrictEqual(
        result,
        { category: 'bundled-gtd-hook', choice: 'remove' },
        `${relPath} should classify as bundled-gtd-hook`,
      );
    }
  });

  const USER_OWNED_OR_RETIRED = [
    'hooks/gtd-personal-experiment.js',
    'hooks/gtd-my-custom-guard.sh',
    'hooks/gtd-team-policy.cjs',
    'hooks/gtd-retired-hook.js',
    'hooks/gtd-old-statusline.js',
    'hooks/gtd-experimental.mjs',
  ];

  for (const relPath of USER_OWNED_OR_RETIRED) {
    test(`does NOT classify ${relPath} (user-owned / retired)`, () => {
      assert.strictEqual(
        classifyPromptUserAction({ relPath }),
        null,
        `${relPath} must NOT auto-classify — falls through to block-or-prompt`,
      );
    });
  }

  test('still does NOT classify nested gtd-* directories (existing #3610 boundary preserved)', () => {
    assert.strictEqual(
      classifyPromptUserAction({ relPath: 'hooks/gtd-helpers/index.js' }),
      null,
    );
  });

  test('still does NOT classify non-gtd hooks (existing boundary preserved)', () => {
    assert.strictEqual(
      classifyPromptUserAction({ relPath: 'hooks/my-custom-hook.js' }),
      null,
    );
  });
});

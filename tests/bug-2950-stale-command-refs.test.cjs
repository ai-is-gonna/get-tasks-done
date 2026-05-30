/**
 * Bug #2950: Stale deleted command references in workflow files
 *
 * Multiple workflow files referenced command names removed in #2790
 * (gtd-add-phase, gtd-insert-phase, gtd-remove-phase, gtd-add-todo,
 * gtd-set-profile, gtd-settings-integrations, gtd-settings-advanced,
 * gtd-spike-wrap-up, gtd-sketch-wrap-up, gtd-code-review-fix).
 *
 * Fix: Update every occurrence to the new consolidated forms:
 *   /gtd:phase (no flag | --insert | --remove)
 *   /gtd:capture
 *   /gtd:config (--profile | --integrations | --advanced)
 *   /gtd:spike --wrap-up
 *   /gtd:sketch --wrap-up
 *   /gtd:code-review --fix
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-tasks-done', 'workflows');

function read(filename) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf-8');
}

// Deleted command names that must not appear anywhere in the fixed files.
const DELETED_COMMANDS = [
  '/gtd-add-phase',
  '/gtd-insert-phase',
  '/gtd-remove-phase',
  '/gtd-add-todo',
  '/gtd-set-profile',
  '/gtd-settings-integrations',
  '/gtd-settings-advanced',
  '/gtd-spike-wrap-up',
  '/gtd-sketch-wrap-up',
  '/gtd-code-review-fix',
];

// Per-file assertions: [file, deletedCmd, newForm]
const FILE_ASSERTIONS = [
  // help.md → moved to help/modes/full.md in #3039 tiered-help refactor
  ['help/modes/full.md', '/gtd-add-phase', '/gtd:phase "Add admin dashboard"'],
  ['help/modes/full.md', '/gtd-insert-phase', '/gtd:phase --insert 7 "Fix critical auth bug"'],
  ['help/modes/full.md', '/gtd-remove-phase', '/gtd:phase --remove 17'],
  ['help/modes/full.md', '/gtd-spike-wrap-up', '/gtd:spike --wrap-up'],
  ['help/modes/full.md', '/gtd-sketch-wrap-up', '/gtd:sketch --wrap-up'],
  ['help/modes/full.md', '/gtd-add-todo', '/gtd:capture'],
  ['help/modes/full.md', '/gtd-set-profile', '/gtd:config --profile budget'],

  // do.md
  ['do.md', '/gtd-spike-wrap-up', '/gtd:spike --wrap-up'],
  ['do.md', '/gtd-sketch-wrap-up', '/gtd:sketch --wrap-up'],
  ['do.md', '/gtd-add-phase', '/gtd:phase'],
  ['do.md', '/gtd-add-todo', '/gtd:capture'],

  // settings.md
  ['settings.md', '/gtd-code-review-fix', '/gtd:code-review --fix'],
  ['settings.md', '/gtd-settings-integrations', '/gtd:config --integrations'],
  ['settings.md', '/gtd-set-profile', '/gtd:config --profile'],
  ['settings.md', '/gtd-settings-advanced', '/gtd:config --advanced'],

  // discuss-phase.md
  ['discuss-phase.md', '/gtd-spike-wrap-up', '/gtd:spike --wrap-up'],
  ['discuss-phase.md', '/gtd-sketch-wrap-up', '/gtd:sketch --wrap-up'],

  // new-project.md
  ['new-project.md', '/gtd-spike-wrap-up', '/gtd:spike --wrap-up'],
  ['new-project.md', '/gtd-sketch-wrap-up', '/gtd:sketch --wrap-up'],

  // plan-phase.md
  ['plan-phase.md', '/gtd-insert-phase', '/gtd:phase --insert'],

  // spike.md
  ['spike.md', '/gtd-spike-wrap-up', '/gtd:spike --wrap-up'],

  // sketch.md
  ['sketch.md', '/gtd-sketch-wrap-up', '/gtd:sketch --wrap-up'],
];

describe('bug #2950: stale deleted-command references removed from workflow files', () => {
  // Build a map of file → content to avoid re-reading
  const files = [...new Set(FILE_ASSERTIONS.map(([f]) => f))];
  const contentMap = {};
  for (const f of files) {
    contentMap[f] = read(f);
  }

  // For each (file, deletedCmd) pair, assert the old name is absent
  for (const [file, deletedCmd] of FILE_ASSERTIONS) {
    test(`${file}: does not contain deleted command "${deletedCmd}"`, () => {
      const content = contentMap[file];
      assert.ok(
        !content.includes(deletedCmd),
        `${file} still contains deleted command "${deletedCmd}" — update to new form`
      );
    });
  }

  // For each (file, deletedCmd, newForm) triple, assert the new form is present
  for (const [file, , newForm] of FILE_ASSERTIONS) {
    test(`${file}: contains new form "${newForm}"`, () => {
      const content = contentMap[file];
      assert.ok(
        content.includes(newForm),
        `${file} is missing expected new form "${newForm}"`
      );
    });
  }

  // Blanket check: no affected workflow file contains any of the deleted command names
  // (catches any we might have missed in per-file assertions above)
  const affectedFiles = [
    'help.md',
    'help/modes/full.md',
    'help/modes/default.md',
    'help/modes/brief.md',
    'help/modes/topic.md',
    'do.md',
    'settings.md',
    'discuss-phase.md',
    'new-project.md',
    'plan-phase.md',
    'spike.md',
    'sketch.md',
  ];

  for (const file of affectedFiles) {
    const content = read(file);
    for (const deleted of DELETED_COMMANDS) {
      test(`${file}: blanket check — "${deleted}" not present`, () => {
        assert.ok(
          !content.includes(deleted),
          `${file} contains deleted command "${deleted}"`
        );
      });
    }
  }
});

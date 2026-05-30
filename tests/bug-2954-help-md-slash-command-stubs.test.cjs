'use strict';

// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

process.env.GTD_TEST_MODE = '1';

/**
 * Bug #2954: keep `help.md` and the live `commands/gtd/*` slash surface
 * in lockstep. Two regression tests:
 *
 *   1. help.md must not advertise any /gtd[-:]<name> that has no shipped
 *      slash command. (Caught the original #2954 regression: #2824 deleted
 *      31 stubs without updating help.md.)
 *
 *   2. Every shipped /gtd[-:]<name> command must appear in help.md. (Caught
 *      the inverse: a command lands without docs, so users never discover it.)
 *
 * The shipped slash name is parsed from frontmatter `name:` (which can be
 * either `gtd:foo` or `gtd-foo` — Claude Code surfaces both as `/gtd-foo`),
 * NOT from the filename, because some files (e.g. `ns-context.md`) ship a
 * different slash name (`gtd-context`) than their filename suggests.
 *
 * Also covers `do.md`, the dispatcher invoked at runtime by
 * `/gtd:progress --do`: any `/gtd[-:]<name>` token in its routing table must
 * resolve to a live command, otherwise the dispatcher emits "Unknown command".
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gtd');
// After #3039, the canonical command reference is the `--full` mode file.
// `workflows/help.md` is now a small dispatcher; the bidirectional parity
// invariant lives with the comprehensive reference body.
const HELP_MD = path.join(ROOT, 'get-tasks-done', 'workflows', 'help', 'modes', 'full.md');
const DO_MD = path.join(ROOT, 'get-tasks-done', 'workflows', 'do.md');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const value = fieldMatch[2].trim().replace(/^["']|["']$/g, '');
    fields[fieldMatch[1]] = value;
  }
  return fields;
}

/**
 * Returns the set of slash-base-names actually shipped under commands/gtd/.
 * A "slash-base-name" is the part after `/gtd-` — e.g. for frontmatter
 * `name: gtd:foo` or `name: gtd-foo`, the slash-base-name is `foo`.
 */
function listShippedSlashBaseNames() {
  const names = new Set();
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(COMMANDS_DIR, entry.name), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name) continue;
    const fmName = fm.name;
    let base = null;
    if (fmName.startsWith('gtd:')) base = fmName.slice(4);
    else if (fmName.startsWith('gtd-')) base = fmName.slice(4);
    if (base && /^[a-z][a-z0-9-]*$/.test(base)) names.add(base);
  }
  return names;
}

function extractSlashReferences(contents) {
  const names = new Set();
  const tokenRe = /\/gtd[:-]([a-z][a-z0-9-]*)/g;
  let match;
  while ((match = tokenRe.exec(contents)) !== null) {
    names.add(match[1]);
  }
  return names;
}

/**
 * For every shipped command with an `argument-hint:` frontmatter entry,
 * collect the `--flag` tokens it advertises. Returns a Map<slashBaseName,
 * Set<flagName>>. Flags are recorded without their leading `--`.
 */
function listShippedFlagsByCommand() {
  const out = new Map();
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(COMMANDS_DIR, entry.name), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name || !fm['argument-hint']) continue;
    const fmName = fm.name;
    let base = null;
    if (fmName.startsWith('gtd:')) base = fmName.slice(4);
    else if (fmName.startsWith('gtd-')) base = fmName.slice(4);
    if (!base || !/^[a-z][a-z0-9-]*$/.test(base)) continue;
    const flags = new Set();
    for (const m of fm['argument-hint'].matchAll(/--([a-z][a-z0-9-]*)/g)) {
      flags.add(m[1]);
    }
    if (flags.size) out.set(base, flags);
  }
  return out;
}

describe('Bug #2954: help.md ↔ commands/gtd/ bidirectional parity', () => {
  test('every /gtd[-:]<name> referenced in help.md is a shipped command', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const referenced = extractSlashReferences(helpContents);
    const shipped = listShippedSlashBaseNames();
    const dangling = [...referenced].filter((n) => !shipped.has(n)).sort();
    assert.deepEqual(
      dangling,
      [],
      `help.md advertises /gtd[-:]<name> commands that are not shipped: ${dangling.join(', ')}`,
    );
  });

  test('every shipped /gtd[-:]<name> command is documented in help.md', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const referenced = extractSlashReferences(helpContents);
    const shipped = listShippedSlashBaseNames();
    const undocumented = [...shipped].filter((n) => !referenced.has(n)).sort();
    assert.deepEqual(
      undocumented,
      [],
      `commands shipped under commands/gtd/ with no /gtd[-:]<name> reference in help.md: ${undocumented.join(', ')}`,
    );
  });

  test('every /gtd[-:]<name> in do.md (live dispatcher) is a shipped command', () => {
    const doContents = fs.readFileSync(DO_MD, 'utf8');
    const referenced = extractSlashReferences(doContents);
    const shipped = listShippedSlashBaseNames();
    const dangling = [...referenced].filter((n) => !shipped.has(n)).sort();
    assert.deepEqual(
      dangling,
      [],
      `do.md routing table references /gtd[-:]<name> that is not shipped: ${dangling.join(', ')}`,
    );
  });

  test('every --flag in a command\'s argument-hint appears in help.md', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const flagsByCommand = listShippedFlagsByCommand();
    const gaps = [];
    for (const [command, flags] of flagsByCommand) {
      for (const flag of flags) {
        // Accept `/gtd-<command> --<flag>` (precise) OR a bare `--<flag>` token
        // anywhere in help.md (good enough for shared flags like `--force` that
        // appear under multiple commands' descriptions).
        const preciseDash = `/gtd-${command} --${flag}`;
        const preciseColon = `/gtd:${command} --${flag}`;
        const flagToken = `--${flag}`;
        if (
          !helpContents.includes(preciseDash) &&
          !helpContents.includes(preciseColon) &&
          !helpContents.includes(flagToken)
        ) {
          gaps.push(`/gtd:${command} --${flag}`);
        }
      }
    }
    assert.deepEqual(
      gaps.sort(),
      [],
      `commands ship --flag(s) in argument-hint that are absent from help.md: ${gaps.join(', ')}`,
    );
  });
});

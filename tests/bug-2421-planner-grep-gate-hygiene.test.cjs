// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

/**
 * Bug #2421: gtd-planner emits grep-count acceptance gates that count comment text
 *
 * The planner must instruct agents to use comment-aware grep patterns in
 * <automated> verify blocks. Without this, descriptive comments in file
 * headers count against the gate and force authors to reword them — the
 * "self-invalidating grep gate" anti-pattern.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLANNER_PATH = path.join(__dirname, '..', 'agents', 'gtd-planner.md');

describe('gtd-planner grep gate hygiene (#2421)', () => {
  test('gtd-planner.md exists in agents source dir', () => {
    assert.ok(fs.existsSync(PLANNER_PATH), 'agents/gtd-planner.md must exist');
  });

  test('gtd-planner.md contains Grep gate hygiene rule', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('Grep gate hygiene') || content.includes('grep gate hygiene'),
      'gtd-planner.md must contain a "Grep gate hygiene" rule to prevent self-invalidating grep gates'
    );
  });

  test('gtd-planner.md explains self-invalidating grep gate anti-pattern', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('self-invalidating'),
      'gtd-planner.md must describe the "self-invalidating" grep gate anti-pattern'
    );
  });

  test('gtd-planner.md provides comment-stripping grep example', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    // Must show a pattern that excludes comment lines (grep -v or grep -vE)
    assert.ok(
      content.includes('grep -v') || content.includes('grep -vE') || content.includes('-v '),
      'gtd-planner.md must provide a comment-stripping grep example (grep -v or grep -vE)'
    );
  });

  test('gtd-planner.md warns against bare zero-count grep gates on whole files', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('== 0') || content.includes('zero-count') || content.includes('zero count'),
      'gtd-planner.md must warn against bare zero-count grep gates without comment exclusion'
    );
  });

  test('gtd-planner.md grep gate hygiene rule appears after Nyquist Rule', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    const nyquistIdx = content.indexOf('Nyquist Rule');
    const grepGateIdx = content.indexOf('grep gate hygiene') !== -1
      ? content.indexOf('grep gate hygiene')
      : content.indexOf('Grep gate hygiene');

    assert.ok(nyquistIdx !== -1, 'Nyquist Rule must be present in gtd-planner.md');
    assert.ok(grepGateIdx !== -1, 'Grep gate hygiene must be present in gtd-planner.md');
    assert.ok(
      grepGateIdx > nyquistIdx,
      `Grep gate hygiene rule (at ${grepGateIdx}) must appear after Nyquist Rule (at ${nyquistIdx})`
    );
  });
});

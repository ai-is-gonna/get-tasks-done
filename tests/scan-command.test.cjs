// allow-test-rule: pending-migration-to-typed-ir [#2974]
// Tracked in #2974 for migration to typed-IR assertions per CONTRIBUTING.md
// "Prohibited: Raw Text Matching on Test Outputs". Per-file review may
// reclassify some entries as source-text-is-the-product during migration.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// #2790: scan.md was consolidated into map-codebase.md as the --fast flag.
// The underlying workflow (workflows/scan.md) remains functional.
describe('scan command', () => {
  test('scan is now a --fast flag on map-codebase.md (#2790)', () => {
    const p = path.join(__dirname, '..', 'commands', 'gtd', 'map-codebase.md');
    assert.ok(fs.existsSync(p), 'commands/gtd/map-codebase.md should exist');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('--fast'), 'map-codebase.md must document --fast flag (absorbed scan)');
    assert.ok(content.includes('description:'), 'Command must have description frontmatter');
  });

  test('workflow file exists', () => {
    const p = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'scan.md');
    assert.ok(fs.existsSync(p), 'get-tasks-done/workflows/scan.md should exist');
  });

  test('workflow has focus-to-document mapping table', () => {
    const p = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'scan.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('Focus-to-Document Mapping') || content.includes('Focus | Documents'),
      'Workflow should contain a focus-to-document mapping table');
  });

  test('all 5 focus areas are documented', () => {
    const p = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'scan.md');
    const content = fs.readFileSync(p, 'utf-8');
    const focusAreas = ['tech', 'arch', 'quality', 'concerns', 'tech+arch'];
    for (const area of focusAreas) {
      assert.ok(content.includes(`\`${area}\``),
        `Workflow should document the "${area}" focus area`);
    }
  });

  test('overwrite prompt is mentioned', () => {
    const p = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'scan.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('Overwrite') || content.includes('overwrite'),
      'Workflow should mention overwrite prompt for existing documents');
  });

  test('workflow references gtd-codebase-mapper', () => {
    const p = path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'scan.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('gtd-codebase-mapper'),
      'Workflow should reference the gtd-codebase-mapper agent');
  });
});

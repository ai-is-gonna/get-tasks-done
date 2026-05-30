/**
 * Regression test for bug #1818, updated for #3019.
 *
 * Original #1818 invariant: gtd-tools must NOT silently ignore --help/-h
 * and proceed with a destructive command — that turned AI-agent
 * hallucinations into accidental data loss (e.g. `phases clear --help`
 * deleting phase dirs because the flag was dropped).
 *
 * #3019 update: the same destructive-protection invariant still holds,
 * but the response shape changed. Previously --help → non-zero error
 * exit. Now --help → render top-level usage and exit 0 WITHOUT running
 * the command. Both shapes satisfy the original invariant ("the
 * destructive command did not execute"); the new shape also restores
 * subcommand discoverability for `gtd-sdk query <subcommand> --help`.
 *
 * The tests therefore assert two things:
 *   1. The destructive command did NOT run (anti-hallucination invariant).
 *   2. The output contains the top-level usage (#3019 discoverability).
 *
 * --version remains rejected — it's never a valid gtd-tools flag and has
 * no discovery use-case.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGtdTools, createTempProject, cleanup, isUsageOutput } = require('./helpers.cjs');

describe('unknown flag guard (bug #1818, updated for #3019)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── --help renders usage and does NOT run the destructive command ────────

  test('phases clear --help renders usage and does NOT clear phase dirs', () => {
    // Create a sentinel phase dir so we can assert it survives.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'phase-99');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), 'sentinel');

    const result = runGtdTools(['phases', 'clear', '--help'], tmpDir);
    assert.strictEqual(result.success, true, 'help renders, no error exit');
    assert.ok(isUsageOutput(result.output), `expected top-level usage, got: ${result.output}`);
    // Anti-hallucination invariant: the destructive command did NOT run.
    assert.ok(fs.existsSync(phaseDir), 'phase dir must survive — clear must not have executed');
    assert.ok(fs.existsSync(path.join(phaseDir, 'PLAN.md')));
  });

  test('generate-slug hello --help renders usage and does NOT emit a slug', () => {
    const ok = runGtdTools(['generate-slug', 'hello'], tmpDir);
    assert.strictEqual(ok.success, true, 'control: generate-slug works without --help');
    // The control output is just the slug; the help output is the usage.
    const slugOut = ok.output;
    assert.ok(slugOut && !isUsageOutput(slugOut), `control should not be usage: ${slugOut}`);

    const result = runGtdTools(['generate-slug', 'hello', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output), 'help renders top-level usage');
    assert.notEqual(result.output, slugOut, 'help output must differ from the slug — generate-slug must not have run');
  });

  test('phase complete --help renders usage and does NOT mark a phase complete', () => {
    const result = runGtdTools(['phase', 'complete', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
    // success:true + isUsageOutput is sufficient: if the destructive path
    // had executed it would have emitted a phase-resolution error to stderr
    // (success:false), not the usage to stdout (success:true).
  });

  test('state load --help renders usage', () => {
    const result = runGtdTools(['state', 'load', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  // ── -h shorthand: same shape ─────────────────────────────────────────────

  test('phases clear -h renders usage and does NOT clear phase dirs', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'phase-42');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = runGtdTools(['phases', 'clear', '-h'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
    assert.ok(fs.existsSync(phaseDir), 'phase dir must survive');
  });

  test('generate-slug hello -h renders usage', () => {
    const result = runGtdTools(['generate-slug', 'hello', '-h'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  // ── --version is still rejected — no discovery use-case ──────────────────

  test('generate-slug hello --version is rejected', () => {
    const result = runGtdTools(['generate-slug', 'hello', '--version'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /--version/);
  });

  // ── current-timestamp --help: same as the others ─────────────────────────

  test('current-timestamp --help renders usage', () => {
    const result = runGtdTools(['current-timestamp', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });
});

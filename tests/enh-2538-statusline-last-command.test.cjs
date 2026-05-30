'use strict';

/**
 * Enhancement #2538 — statusline `last: /cmd` suffix.
 *
 * Asserts that:
 *   - default (flag absent) output does NOT include "last:" text
 *   - with statusline.show_last_command=true AND a transcript containing
 *     <command-name>/gtd-plan-phase</command-name>, output includes "last: /gtd-plan-phase"
 *   - a missing transcript_path does not throw and produces no "last:" suffix
 *   - an existing transcript with no slash commands produces no "last:" suffix
 *   - the config key is registered in the schema so /gtd-settings can surface it
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const statusline = require('../hooks/gtd-statusline.js');
const { VALID_CONFIG_KEYS } = require('../get-tasks-done/bin/lib/config-schema.cjs');

function makeProject({ flag, transcript }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-2538-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (flag !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ statusline: { show_last_command: flag } }),
    );
  }
  let transcriptPath = null;
  if (transcript !== undefined) {
    transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcript);
  }
  return { dir, transcriptPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function buildInput(dir, transcriptPath) {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: dir },
    session_id: 'test-session',
    transcript_path: transcriptPath,
  };
}

test('config schema registers statusline.show_last_command', () => {
  assert.ok(
    VALID_CONFIG_KEYS.has('statusline.show_last_command'),
    'statusline.show_last_command must be in VALID_CONFIG_KEYS',
  );
});

test('default (flag absent) output has no "last:" suffix', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gtd-plan-phase</command-name>' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(!out.includes('last:'), `expected no "last:" in output; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with recorded command yields "last: /<cmd>"', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gtd-plan-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(out.includes('last: /gtd-plan-phase'), `expected "last: /gtd-plan-phase" in output; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true picks the MOST RECENT command when multiple are present', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gtd-discuss-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gtd-plan-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gtd-work-task-issue</command-name>' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(out.includes('last: /gtd-work-task-issue'), `expected most-recent "gtd-work-task-issue"; got: ${out}`);
    assert.ok(!out.includes('last: /gtd-discuss-phase'), `should not show stale command; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with missing transcript_path does not throw and omits suffix', () => {
  const { dir, cleanup } = makeProject({ flag: true });
  try {
    let out;
    assert.doesNotThrow(() => {
      out = statusline.renderStatusline(buildInput(dir, undefined));
    });
    assert.ok(!out.includes('last:'), `expected no "last:" suffix when transcript missing; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with transcript lacking command tags omits suffix', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: 'just a plain prompt' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(!out.includes('last:'), `expected no "last:" suffix with no commands; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('readLastSlashCommand returns null for nonexistent paths', () => {
  assert.strictEqual(statusline.readLastSlashCommand('/nonexistent/path.jsonl'), null);
  assert.strictEqual(statusline.readLastSlashCommand(null), null);
  assert.strictEqual(statusline.readLastSlashCommand(undefined), null);
});

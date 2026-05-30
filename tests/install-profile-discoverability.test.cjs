// allow-test-rule: source-text-is-the-product
// Installer help and surface markdown are shipped user-facing contracts.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROFILES } = require('../get-tasks-done/bin/lib/install-profiles.cjs');
const { CLUSTERS } = require('../get-tasks-done/bin/lib/clusters.cjs');

const ROOT = path.join(__dirname, '..');
const PUBLIC_PROFILE_SURFACES = [
  'bin/install.js',
  'get-tasks-done/bin/lib/install-profiles.cjs',
  'commands/gtd/surface.md',
  'get-tasks-done/workflows/help/modes/full.md',
  'docs/COMMANDS.md',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function installHelp() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--help'], {
    cwd: ROOT,
    env: { ...process.env, GTD_TEST_MODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });

  assert.equal(
    result.status,
    0,
    `install --help should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return stripAnsi(result.stdout);
}

function profileFlagValues(text) {
  return [...text.matchAll(/--profile=([a-z0-9,_-]+)/g)].map((match) => match[1]);
}

function assertProfileFlagsUseRealProfiles(text, sourceName) {
  const valid = new Set(Object.keys(PROFILES));
  const invalid = [];

  for (const value of profileFlagValues(text)) {
    for (const profile of value.split(',')) {
      if (!valid.has(profile)) invalid.push(`${sourceName}: --profile=${value} references ${profile}`);
    }
  }

  assert.deepEqual(invalid, [], `profile examples must use real PROFILES keys:\n${invalid.join('\n')}`);
}

describe('Slice 7 install/profile/surface discoverability', () => {
  test('install help mentions issue-tasks and uses real profile examples', () => {
    const help = installHelp();
    const invalidExample = ['core', 'audit'].join(',');

    assert.match(help, /issue-tasks/, 'install help should list the issue-tasks profile');
    assert.match(help, /--profile=issue-tasks/, 'install help should include an issue-tasks example');
    assert.match(help, /--profile=core,issue-tasks/, 'install help should include a real composed profile');
    assert.doesNotMatch(help, new RegExp(invalidExample), 'install help must not advertise the old invalid composed profile');
    assertProfileFlagsUseRealProfiles(help, 'install --help');
  });

  test('public profile examples use real profile names and no old invalid example remains', () => {
    const invalidExample = ['core', 'audit'].join(',');

    for (const rel of PUBLIC_PROFILE_SURFACES) {
      const content = read(rel);
      assert.doesNotMatch(content, new RegExp(invalidExample), `${rel} must not mention ${invalidExample}`);
      assertProfileFlagsUseRealProfiles(content, rel);
    }
  });

  test('surface docs expose issue-tasks and the issue_task_loop cluster', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(PROFILES, 'issue-tasks'));
    assert.ok(Object.prototype.hasOwnProperty.call(CLUSTERS, 'issue_task_loop'));

    const surfaceCommand = read('commands/gtd/surface.md');
    const helpFull = read('get-tasks-done/workflows/help/modes/full.md');
    const commandsDoc = read('docs/COMMANDS.md');
    const combined = [surfaceCommand, helpFull, commandsDoc].join('\n');

    assert.match(combined, /profile issue-tasks/, 'surface examples should show the issue-tasks profile');
    assert.match(combined, /issue_task_loop/, 'surface examples should show the issue task loop cluster');
    assert.match(combined, /issue task loop|issue-task execution loop/i);
  });
});

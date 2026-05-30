'use strict';

process.env.GTD_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { migrateLegacyHomeConfig } = require('../bin/install.js');
const { cleanup, createTempDir } = require('./helpers.cjs');

const LEGACY_HOME_DIR = `.${String.fromCharCode(103, 115, 100)}`;

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

test('moves known legacy home config entries to .gtd when safe', (t) => {
  const home = createTempDir('gtd-legacy-home-config-');
  t.after(() => cleanup(home));

  writeFile(home, path.join(LEGACY_HOME_DIR, 'defaults.json'), '{"runtime":"codex"}\n');
  writeFile(home, path.join(LEGACY_HOME_DIR, 'brave_api_key'), 'legacy-key\n');

  const result = migrateLegacyHomeConfig(home);

  assert.deepEqual(result.moved.sort(), ['brave_api_key', 'defaults.json']);
  assert.equal(fs.existsSync(path.join(home, LEGACY_HOME_DIR, 'defaults.json')), false);
  assert.equal(fs.readFileSync(path.join(home, '.gtd/defaults.json'), 'utf8'), '{"runtime":"codex"}\n');
  assert.equal(fs.readFileSync(path.join(home, '.gtd/brave_api_key'), 'utf8'), 'legacy-key\n');
});

test('preserves legacy home config when target .gtd entry differs', (t) => {
  const home = createTempDir('gtd-legacy-home-conflict-');
  t.after(() => cleanup(home));

  writeFile(home, path.join(LEGACY_HOME_DIR, 'defaults.json'), '{"runtime":"claude"}\n');
  writeFile(home, '.gtd/defaults.json', '{"runtime":"codex"}\n');

  const result = migrateLegacyHomeConfig(home);

  assert.deepEqual(result.preservedConflicts, ['defaults.json']);
  assert.equal(fs.readFileSync(path.join(home, LEGACY_HOME_DIR, 'defaults.json'), 'utf8'), '{"runtime":"claude"}\n');
  assert.equal(fs.readFileSync(path.join(home, '.gtd/defaults.json'), 'utf8'), '{"runtime":"codex"}\n');
});

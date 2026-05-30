/**
 * Regression test for #3571: configuration.generated.cjs used the source
 * checkout sdk/shared path only, which breaks installed gtd-tools.cjs because
 * runtime installs copy get-tasks-done/ but not sdk/.
 */

'use strict';

process.env.GTD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIGURATION_CJS = path.join(REPO_ROOT, 'get-tasks-done', 'bin', 'lib', 'configuration.generated.cjs');
const SDK_SHARED_DIR = path.join(REPO_ROOT, 'sdk', 'shared');

const { install } = require('../bin/install.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-3571-'));
}

function silenceConsole(fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

describe('bug #3571: configuration generated manifests resolve in install layout', () => {
  let tmpRoot;
  let savedHome;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    savedHome = process.env.HOME;
    savedExplicitConfigDir = process.env.GTD_EXPLICIT_CONFIG_DIR;
    delete process.env.GTD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedExplicitConfigDir === undefined) {
      delete process.env.GTD_EXPLICIT_CONFIG_DIR;
    } else {
      process.env.GTD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('co-located bin/shared manifests let configuration.generated.cjs load without sdk/shared', () => {
    const gtdBinDir = path.join(tmpRoot, '.codex', 'get-tasks-done', 'bin');
    const gtdLibDir = path.join(gtdBinDir, 'lib');
    const gtdSharedDir = path.join(gtdBinDir, 'shared');
    fs.mkdirSync(gtdLibDir, { recursive: true });
    fs.mkdirSync(gtdSharedDir, { recursive: true });

    const installedCjs = path.join(gtdLibDir, 'configuration.generated.cjs');
    fs.copyFileSync(CONFIGURATION_CJS, installedCjs);
    fs.copyFileSync(
      path.join(SDK_SHARED_DIR, 'config-defaults.manifest.json'),
      path.join(gtdSharedDir, 'config-defaults.manifest.json')
    );
    fs.copyFileSync(
      path.join(SDK_SHARED_DIR, 'config-schema.manifest.json'),
      path.join(gtdSharedDir, 'config-schema.manifest.json')
    );

    delete require.cache[installedCjs];
    let mod;
    assert.doesNotThrow(() => {
      mod = require(installedCjs);
    }, 'installed configuration.generated.cjs must not require ~/.codex/sdk/shared');

    assert.ok(mod.VALID_CONFIG_KEYS.has('workflow.plan_review_convergence'));
  });

  test('post-install: install() copies configuration manifests to co-located bin/shared', () => {
    process.env.HOME = tmpRoot;

    silenceConsole(() => {
      install(true, 'codex');
    });

    const sharedDir = path.join(tmpRoot, '.codex', 'get-tasks-done', 'bin', 'shared');
    for (const fileName of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
      const installedManifest = path.join(sharedDir, fileName);
      assert.ok(fs.existsSync(installedManifest), `${fileName} must be copied to ${sharedDir}`);
      assert.doesNotThrow(() => {
        JSON.parse(fs.readFileSync(installedManifest, 'utf8'));
      }, `${fileName} must be valid JSON`);
    }

    const installedCjs = path.join(
      tmpRoot,
      '.codex',
      'get-tasks-done',
      'bin',
      'lib',
      'configuration.generated.cjs'
    );

    delete require.cache[installedCjs];
    assert.doesNotThrow(() => {
      require(installedCjs);
    }, 'post-install configuration.generated.cjs must load from co-located manifests');
  });
});

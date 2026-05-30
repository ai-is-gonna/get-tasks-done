'use strict';

/**
 * Regression test for bug #3227 — config-set rejects model_overrides.<agent-id>.
 *
 * `gtd-sdk query config-set model_overrides.gtd-plan-checker opus` was
 * rejected with "Unknown config key" because `model_overrides.<agent-id>` was
 * missing from DYNAMIC_KEY_PATTERNS in both the CJS schema and the SDK schema.
 *
 * The override mechanism itself worked correctly (resolve-model returned the
 * override after a direct file edit). Only the write path was gated wrong.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGtdTools } = require('./helpers.cjs');
const { DYNAMIC_KEY_PATTERNS, isValidConfigKey } = require('../get-tasks-done/bin/lib/config-schema.cjs');

describe('#3227 — config-set accepts model_overrides.<agent-id>', () => {
  test('isValidConfigKey accepts model_overrides.gtd-plan-checker', () => {
    assert.ok(
      isValidConfigKey('model_overrides.gtd-plan-checker'),
      'model_overrides.gtd-plan-checker must be accepted by isValidConfigKey'
    );
  });

  test('isValidConfigKey accepts model_overrides with various agent-id formats', () => {
    const validKeys = [
      'model_overrides.gtd-task-executor',
      'model_overrides.gtd-planner',
      'model_overrides.gtd-codebase-mapper',
      'model_overrides.my_custom_agent',
      'model_overrides.agent123',
    ];
    for (const key of validKeys) {
      assert.ok(isValidConfigKey(key), `isValidConfigKey must accept ${key}`);
    }
  });

  test('isValidConfigKey rejects bare model_overrides (no agent-id)', () => {
    assert.ok(
      !isValidConfigKey('model_overrides'),
      'bare model_overrides must be rejected (use model_overrides.<agent-id>)'
    );
  });

  test('DYNAMIC_KEY_PATTERNS includes an entry for model_overrides', () => {
    const hasPattern = DYNAMIC_KEY_PATTERNS.some(
      (p) => p.description && p.description.includes('model_overrides')
    );
    assert.ok(hasPattern, 'DYNAMIC_KEY_PATTERNS must have an entry covering model_overrides.<agent-id>');
  });

  test('config-set model_overrides.gtd-plan-checker opus succeeds via gtd-tools.cjs', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGtdTools(
      ['config-set', 'model_overrides.gtd-plan-checker', 'opus'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set model_overrides.gtd-plan-checker opus should succeed,',
        'got:',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set model_overrides.gtd-plan-checker opus writes to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGtdTools(['config-set', 'model_overrides.gtd-plan-checker', 'opus'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.model_overrides !== undefined &&
        config.model_overrides['gtd-plan-checker'] === 'opus',
      [
        'Expected model_overrides["gtd-plan-checker"]: "opus" in config.json,',
        'got: ' + JSON.stringify(config),
      ].join('\n')
    );
  });

  test('config-get model_overrides.gtd-plan-checker returns opus after config-set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGtdTools(['config-set', 'model_overrides.gtd-plan-checker', 'opus'], tmpDir);

    const getResult = runGtdTools(
      ['config-get', 'model_overrides.gtd-plan-checker'],
      tmpDir
    );
    assert.ok(
      getResult.success,
      [
        'config-get model_overrides.gtd-plan-checker should succeed,',
        'got:',
        'stdout: ' + getResult.output,
        'stderr: ' + getResult.error,
      ].join('\n')
    );
    assert.ok(
      getResult.output.includes('opus'),
      'config-get output should contain "opus", got: ' + getResult.output
    );
  });
});

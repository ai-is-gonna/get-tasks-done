'use strict';
/**
 * Tests for readActiveProfile / writeActiveProfile marker persistence.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  readActiveProfile,
  writeActiveProfile,
} = require('../get-tasks-done/bin/lib/install-profiles.cjs');

describe('readActiveProfile / writeActiveProfile', () => {
  test('write then read round-trips the profile name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      writeActiveProfile(dir, 'standard');
      assert.strictEqual(readActiveProfile(dir), 'standard');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips "core" profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      writeActiveProfile(dir, 'core');
      assert.strictEqual(readActiveProfile(dir), 'core');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips composed profiles "core,issue-tasks"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      writeActiveProfile(dir, 'core,issue-tasks');
      assert.strictEqual(readActiveProfile(dir), 'core,issue-tasks');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips "full"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      writeActiveProfile(dir, 'full');
      assert.strictEqual(readActiveProfile(dir), 'full');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing marker file returns null (not throws)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-existent directory returns null (not throws)', () => {
    const ghost = path.join(os.tmpdir(), 'gtd-marker-no-exist-' + Date.now());
    const result = readActiveProfile(ghost);
    assert.strictEqual(result, null);
  });

  test('corrupt marker content (invalid chars) returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      fs.writeFileSync(path.join(dir, '.gtd-profile'), 'profile with spaces and !!!\n');
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty marker file returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      fs.writeFileSync(path.join(dir, '.gtd-profile'), '');
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeActiveProfile creates the directory if it does not exist', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-base-'));
    const nested = path.join(base, 'skills', '.claude');
    try {
      writeActiveProfile(nested, 'standard');
      assert.ok(fs.existsSync(nested), 'directory should be created');
      assert.strictEqual(readActiveProfile(nested), 'standard');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('overwrites a previously written profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-marker-'));
    try {
      writeActiveProfile(dir, 'core');
      writeActiveProfile(dir, 'full');
      assert.strictEqual(readActiveProfile(dir), 'full');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

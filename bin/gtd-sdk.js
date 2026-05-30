#!/usr/bin/env node
/**
 * bin/gtd-sdk.js — back-compat shim for external callers of `gtd-sdk`.
 *
 * When the parent package is installed globally (`npm install -g @ai-is-gonna/get-tasks-done`)
 * npm creates a `gtd-sdk` symlink in the global bin directory pointing at this
 * file. npm correctly chmods bin entries from a tarball, so the execute-bit
 * problem that afflicted the sub-install approach (issue #2453) cannot occur here.
 *
 * NOTE (#2775): `npx @ai-is-gonna/get-tasks-done` does NOT link this shim — npx only
 * exposes the package's primary bin (`get-tasks-done`). For npx-based usage,
 * the installer (`bin/install.js#installSdkIfNeeded`) self-symlinks `gtd-sdk`
 * into `~/.local/bin` when needed and verifies PATH callability before
 * reporting `✓ GTD SDK ready`.
 *
 * This shim resolves sdk/dist/cli.js relative to its own location and delegates
 * to it via `node`, so `gtd-sdk <args>` behaves identically to
 * `node <packageDir>/sdk/dist/cli.js <args>`.
 *
 * Call sites (slash commands, agent prompts, hook scripts) continue to work without
 * changes because `gtd-sdk` still resolves on PATH — it just comes from this shim
 * in the parent package rather than from a separately installed @ai-is-gonna/gtd-sdk.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.resolve(__dirname, '..', 'sdk', 'dist', 'cli.js');

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);

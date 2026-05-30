/**
 * Regression tests for bug #3584
 *
 * Runtime/user-facing strings emitted by get-tasks-done/bin/lib/*.cjs hardcoded
 * the deprecated `/gtd:<cmd>` colon form (16 files, ~50 occurrences). After
 * #2808 unified GTD installs to register skills under the hyphen form
 * (`name: gtd-work-task-issue`), pasting the emitted `/gtd:work-task-issue --phase` into
 * Claude Code yields `Unknown command: /gtd:work-task-issue --phase. Did you mean
 * /gtd-work-task-issue?`. Codex installs require `$gtd-<cmd>` (shell-var) form.
 *
 * Fix: a runtime-aware slash formatter (`runtime-slash.cjs`) is now the single
 * source of truth for emitting `/gtd-<cmd>` (hyphen) for skills-based runtimes
 * and `$gtd-<cmd>` for Codex. Tests assert on the formatter's typed output and
 * — for the integration tests in `bug-3584-runtime-slash-emitters.test.cjs` —
 * on the structured `--json` payloads from the runtime command handlers.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { formatGtdSlash, resolveRuntime } = require(
  path.join(ROOT, 'get-tasks-done', 'bin', 'lib', 'runtime-slash.cjs'),
);

describe('formatGtdSlash — runtime-aware slash command formatter', () => {
  describe('hyphen-form runtimes (claude, cursor, opencode, kilo, etc.)', () => {
    test('emits /gtd-<cmd> for claude', () => {
      assert.strictEqual(formatGtdSlash('work-task-issue', 'claude'), '/gtd-work-task-issue');
    });

    test('emits /gtd-<cmd> for cursor', () => {
      assert.strictEqual(formatGtdSlash('plan-phase', 'cursor'), '/gtd-plan-phase');
    });

    test('emits /gtd-<cmd> for opencode', () => {
      assert.strictEqual(formatGtdSlash('discuss-phase', 'opencode'), '/gtd-discuss-phase');
    });

    test('emits /gtd-<cmd> for kilo', () => {
      assert.strictEqual(formatGtdSlash('health', 'kilo'), '/gtd-health');
    });

    test('unknown runtime defaults to hyphen form', () => {
      assert.strictEqual(
        formatGtdSlash('new-project', 'some-future-runtime'),
        '/gtd-new-project',
      );
    });

    test('null/undefined runtime defaults to hyphen form (claude)', () => {
      assert.strictEqual(formatGtdSlash('new-milestone', null), '/gtd-new-milestone');
      assert.strictEqual(formatGtdSlash('new-milestone', undefined), '/gtd-new-milestone');
    });
  });

  describe('codex shell-var form', () => {
    test('emits $gtd-<cmd> for codex', () => {
      assert.strictEqual(formatGtdSlash('work-task-issue', 'codex'), '$gtd-work-task-issue');
    });

    test('codex output is lowercased', () => {
      assert.strictEqual(
        formatGtdSlash('Work-Task-Issue', 'codex'),
        '$gtd-work-task-issue',
      );
    });
  });

  describe('input normalization', () => {
    test('strips existing /gtd: colon prefix', () => {
      assert.strictEqual(
        formatGtdSlash('/gtd:work-task-issue --phase', 'claude'),
        '/gtd-work-task-issue --phase',
      );
    });

    test('strips existing /gtd- hyphen prefix (idempotent)', () => {
      assert.strictEqual(
        formatGtdSlash('/gtd-plan-phase', 'claude'),
        '/gtd-plan-phase',
      );
    });

    test('strips bare gtd: prefix without leading slash', () => {
      assert.strictEqual(
        formatGtdSlash('gtd:new-project', 'claude'),
        '/gtd-new-project',
      );
    });

    test('strips existing $gtd- shell prefix (codex idempotent)', () => {
      assert.strictEqual(
        formatGtdSlash('$gtd-work-task-issue', 'codex'),
        '$gtd-work-task-issue',
      );
    });

    test('runtime swap: /gtd:work-task-issue --phase + codex → $gtd-work-task-issue', () => {
      assert.strictEqual(
        formatGtdSlash('/gtd:work-task-issue --phase', 'codex'),
        '$gtd-work-task-issue --phase',
      );
    });

    test('case-insensitive prefix stripping', () => {
      assert.strictEqual(
        formatGtdSlash('GTD:work-task-issue', 'claude'),
        '/gtd-work-task-issue',
      );
    });
  });

  describe('defensive returns for unsafe inputs', () => {
    test('non-string commandName returns input unchanged', () => {
      assert.strictEqual(formatGtdSlash(null, 'claude'), null);
      assert.strictEqual(formatGtdSlash(undefined, 'claude'), undefined);
      assert.strictEqual(formatGtdSlash(42, 'claude'), 42);
    });

    test('empty string returns empty string', () => {
      assert.strictEqual(formatGtdSlash('', 'claude'), '');
    });

    test('whitespace-only string returns empty string (no spurious /gtd- emission)', () => {
      assert.strictEqual(formatGtdSlash('   ', 'claude'), '');
      assert.strictEqual(formatGtdSlash('\t\n', 'codex'), '');
    });

    test('degenerate prefix-only input returns empty (does NOT re-emit colon form)', () => {
      // Regression guard for the CodeRabbit finding on the original PR:
      // a previous fallback returned `commandName` unchanged when the bare
      // tail was empty, which re-introduced the deprecated `/gtd:` shape for
      // inputs like `/gtd:`, `gtd:`, or `gtd-`. The formatter must never
      // emit the colon form — return empty so callers detect "no command"
      // instead of receiving an unroutable string.
      assert.strictEqual(formatGtdSlash('/gtd:', 'claude'), '');
      assert.strictEqual(formatGtdSlash('gtd:', 'claude'), '');
      assert.strictEqual(formatGtdSlash('gtd-', 'claude'), '');
      assert.strictEqual(formatGtdSlash('/gtd-', 'codex'), '');
      assert.strictEqual(formatGtdSlash('$gtd-', 'codex'), '');
    });

    test('commands with arguments preserve the argument tail', () => {
      // `work-task-issue 03` is a valid call shape — the formatter only
      // rewrites the command token; everything after the first whitespace
      // belongs to the caller.
      assert.strictEqual(
        formatGtdSlash('work-task-issue 03', 'claude'),
        '/gtd-work-task-issue 03',
      );
      assert.strictEqual(
        formatGtdSlash('/gtd:work-task-issue --phase 03', 'claude'),
        '/gtd-work-task-issue --phase 03',
      );
    });

    test('codex form lowercases only the command token, not the argument tail', () => {
      // Regression for codex review finding: a previous implementation
      // lowercased the full input including arguments, which would corrupt
      // Windows paths and case-sensitive flag values passed as args.
      assert.strictEqual(
        formatGtdSlash('Map-Codebase --paths C:\\Users\\Me\\Project', 'codex'),
        '$gtd-map-codebase --paths C:\\Users\\Me\\Project',
      );
      assert.strictEqual(
        formatGtdSlash('work-task-issue 03 --Name FooBar', 'codex'),
        '$gtd-work-task-issue 03 --Name FooBar',
      );
    });

    test('hyphen form preserves token case (it does not get lowercased)', () => {
      // Symmetry with codex: only codex lowercases the token. Hyphen-form
      // runtimes preserve whatever case the caller supplied for the token.
      assert.strictEqual(
        formatGtdSlash('Plan-Phase 03', 'claude'),
        '/gtd-Plan-Phase 03',
      );
    });
  });
});

describe('resolveRuntime — env > config > default', () => {
  test('process.env.GTD_RUNTIME wins over everything', () => {
    const saved = process.env.GTD_RUNTIME;
    try {
      process.env.GTD_RUNTIME = 'codex';
      assert.strictEqual(resolveRuntime(null), 'codex');
      assert.strictEqual(resolveRuntime('/nonexistent'), 'codex');
    } finally {
      if (saved === undefined) delete process.env.GTD_RUNTIME;
      else process.env.GTD_RUNTIME = saved;
    }
  });

  test('defaults to claude when env is unset and projectDir missing', () => {
    const saved = process.env.GTD_RUNTIME;
    try {
      delete process.env.GTD_RUNTIME;
      assert.strictEqual(resolveRuntime(null), 'claude');
      assert.strictEqual(resolveRuntime(undefined), 'claude');
    } finally {
      if (saved !== undefined) process.env.GTD_RUNTIME = saved;
    }
  });

  test('reads config.runtime when env is unset and projectDir has a config', (t) => {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-3584-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'codex' }),
    );

    const saved = process.env.GTD_RUNTIME;
    try {
      delete process.env.GTD_RUNTIME;
      assert.strictEqual(resolveRuntime(tmp), 'codex');
    } finally {
      if (saved !== undefined) process.env.GTD_RUNTIME = saved;
    }
  });

  test('lowercases the resolved runtime', () => {
    const saved = process.env.GTD_RUNTIME;
    try {
      process.env.GTD_RUNTIME = 'CLAUDE';
      assert.strictEqual(resolveRuntime(null), 'claude');
    } finally {
      if (saved === undefined) delete process.env.GTD_RUNTIME;
      else process.env.GTD_RUNTIME = saved;
    }
  });
});

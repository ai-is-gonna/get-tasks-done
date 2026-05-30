// allow-test-rule: source-text-is-the-product — verify-work.md is a runtime workflow contract.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #3381: verify-work forwards workstream context', () => {
  test('workflow forwards ${GTD_WS} to workstream-sensitive SDK queries', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'verify-work.md'),
      'utf8',
    );

    assert.match(workflow, /GTD_WS=""/, 'verify-work must initialize GTD_WS');
    assert.match(
      workflow,
      /grep -qE -- '--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+'/,
      'verify-work must detect --ws in $ARGUMENTS',
    );
    assert.match(
      workflow,
      /grep -oE -- '--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+'/,
      'verify-work must extract the --ws flag pair from $ARGUMENTS',
    );
    assert.match(
      workflow,
      /PHASE_ARG=\$\(echo "\$ARGUMENTS" \| sed -E 's\/--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+\/\/g' \| xargs\)/,
      'verify-work must derive PHASE_ARG after removing --ws',
    );
    assert.match(
      workflow,
      /gtd-sdk query init\.verify-work "\$\{PHASE_ARG\}" \$\{GTD_WS\}/,
      'init.verify-work must receive GTD_WS so phase_dir resolves in workstreams',
    );
    assert.match(
      workflow,
      /gtd-sdk query phase\.mvp-mode "\$\{phase_number\}" \$\{GTD_WS\} --pick active/,
      'phase.mvp-mode must receive GTD_WS so roadmap mode is workstream-scoped',
    );
    assert.match(
      workflow,
      /gtd-sdk query roadmap\.get-phase "\$\{phase_number\}" \$\{GTD_WS\} --pick goal/,
      'roadmap.get-phase must receive GTD_WS so goals are workstream-scoped',
    );
  });
});

'use strict';

/**
 * Step 1 task-issue exporter tests.
 *
 * These tests exercise the read-only dry-run contract through gtd-tools and
 * assert on parsed JSON structure rather than prose.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempProject, runGtdTools } = require('./helpers.cjs');

function writePlan(tmpDir, phaseDir, filename, body) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), body, 'utf8');
}

function git(tmpDir, args) {
  childProcess.execFileSync('git', args, {
    cwd: tmpDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function samplePlan({
  plan,
  wave,
  dependsOn,
  file,
  taskName,
  boundaries = `Only touch ${file}. Do not edit package.json.`,
  done = `${file} contains the exported implementation and npm test -- ${plan} passes.`,
  acceptanceCriteria = `- ${file} contains the exported implementation`,
}) {
  return `---
phase: 01-foundation
plan: ${plan}
type: execute
wave: ${wave}
depends_on: [${dependsOn}]
files_modified: [${file}]
autonomous: true
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build plan ${plan}.
</objective>

<tasks>
<task type="auto">
  <name>${taskName}</name>
  <files>${file}</files>
  <read_first>src/index.ts</read_first>
  <boundaries>${boundaries}</boundaries>
  <action>Create the implementation for ${taskName}.</action>
  <verify>npm test -- ${plan}</verify>
  <done>${done}</done>
  <acceptance_criteria>
    ${acceptanceCriteria}
  </acceptance_criteria>
</task>
</tasks>

<verification>
- [ ] npm test
</verification>

<success_criteria>
- Plan ${plan} works.
</success_criteria>
`;
}

describe('export-phase-issues dry-run', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gtd-export-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('produces deterministic operation output and does not write a manifest', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      file: 'src/auth.ts',
      taskName: 'Create auth module',
    }));
    writePlan(tmpDir, '01-foundation', '01-02-PLAN.md', samplePlan({
      plan: '02',
      wave: '2',
      dependsOn: '01',
      file: 'src/session.ts',
      taskName: 'Create session module',
    }));

    const first = runGtdTools(['export-phase-issues', '01', '--dry-run', '--repo', 'owner/repo'], tmpDir);
    const second = runGtdTools(['export-phase-issues', '01', '--dry-run', '--repo', 'owner/repo'], tmpDir);

    assert.equal(first.success, true, first.error);
    assert.equal(second.success, true, second.error);
    assert.equal(first.output, second.output);

    const result = JSON.parse(first.output);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.writes, false);
    assert.equal(result.repo, 'owner/repo');
    assert.equal(result.phase.phase_slug, '01-foundation');
    assert.equal(result.manifest.would_write, false);

    assert.deepEqual(result.plans.map((plan) => plan.id), ['01-01', '01-02']);
    assert.deepEqual(result.plans[0].tasks.map((task) => task.id), ['01-01-T01']);
    assert.match(result.plans[0].tasks[0].done, /src\/auth\.ts contains the exported implementation/);
    assert.deepEqual(result.plans[1].depends_on, ['01-01']);
    assert.deepEqual(result.plans[1].tasks[0].blocked_by, ['01-01']);

    const labels = new Set(result.labels);
    assert.equal(labels.has('gtd:plan'), true);
    assert.equal(labels.has('gtd:task'), true);
    assert.equal(labels.has('phase:01-foundation'), true);
    assert.equal(labels.has('type:plan'), true);
    assert.equal(labels.has('type:task'), true);

    const githubOps = result.operations.github;
    assert.equal(githubOps.some((op) => op.op === 'create_or_update_issue' && op.issue_kind === 'parent_plan'), true);
    assert.equal(githubOps.some((op) => op.op === 'create_or_update_issue' && op.issue_kind === 'child_task'), true);
    assert.equal(githubOps.some((op) => op.op === 'attach_sub_issue'), true);
    assert.equal(githubOps.some((op) => op.op === 'ensure_blocked_by_dependency' && op.blocked_by_plan_id === '01-01'), true);

    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github')), false);
  });

  test('fails executable task contract validation before producing an export plan', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', `---
phase: 01-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: true
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Invalid task contract.
</objective>

<tasks>
<task type="auto">
  <name>Incomplete executable task</name>
</task>
</tasks>

<verification>
- [ ] npm test
</verification>
`);

    const result = runGtdTools(['--json-errors', 'export-phase-issues', '01', '--dry-run'], tmpDir);

    assert.equal(result.success, false);
    const err = JSON.parse(result.error);
    assert.equal(err.ok, false);
    assert.equal(err.reason, 'usage');
    assert.match(err.message, /Invalid export source/);
    assert.match(err.message, /missing non-empty <files>/);
    assert.match(err.message, /missing non-empty <action>/);
    assert.match(err.message, /missing non-empty <verify>/);
    assert.match(err.message, /missing non-empty <done>/);
    assert.match(err.message, /missing non-empty <boundaries>/);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github')), false);
  });

  test('dry-run infers the repository from origin when --repo is omitted', () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'origin', 'git@github.com:davide-troiani/my-project.git']);
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      file: 'src/auth.ts',
      taskName: 'Create auth module',
    }));

    const result = runGtdTools(['export-phase-issues', '01', '--dry-run'], tmpDir);

    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.repo, 'davide-troiani/my-project');
    assert.equal(
      parsed.operations.unavailable.some((op) => op.op === 'target_repository_resolution'),
      false,
    );
  });

  test('exports checkpoint tasks as blocked human-in-the-loop issues and keeps later task blocked', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', `---
phase: 01-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/feature.ts]
autonomous: false
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build with a human checkpoint.
</objective>

<tasks>
<task type="checkpoint:decision">
  <decision>Choose the public API shape before implementation.</decision>
</task>
<task type="auto">
  <name>Implement selected API</name>
  <files>src/feature.ts</files>
  <read_first>src/index.ts</read_first>
  <boundaries>
    Only touch src/feature.ts.
    Forbidden paths: package.json, src/generated/*
  </boundaries>
  <action>Create the selected API implementation.</action>
  <verify>npm test -- feature</verify>
  <done>src/feature.ts implements the selected API and npm test -- feature passes.</done>
</task>
</tasks>

<verification>
- [ ] npm test
</verification>
`);

    const result = runGtdTools(['export-phase-issues', '01', '--dry-run', '--repo', 'owner/repo'], tmpDir);

    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    const tasks = parsed.plans[0].tasks;
    const checkpoint = tasks[0];
    const implementation = tasks[1];

    assert.equal(checkpoint.type, 'checkpoint:decision');
    assert.equal(checkpoint.labels.includes('gtd:task'), true);
    assert.equal(checkpoint.labels.includes('gtd:checkpoint'), true);
    assert.equal(checkpoint.labels.includes('gtd:human-in-the-loop'), true);
    assert.equal(checkpoint.labels.includes('gtd:blocked-human'), true);
    assert.equal(checkpoint.labels.includes('gtd:blocked'), true);
    assert.equal(checkpoint.labels.includes('phase:01-foundation'), true);
    assert.equal(checkpoint.labels.includes('type:checkpoint'), true);
    assert.equal(checkpoint.labels.includes('gtd:ready'), false);

    assert.deepEqual(implementation.blocked_by, ['01-01-T01']);
    assert.deepEqual(implementation.forbidden_paths, ['package.json', 'src/generated']);
    assert.equal(implementation.done, 'src/feature.ts implements the selected API and npm test -- feature passes.');

    const manual = implementation.validation_contract.checks.find((check) => check.type === 'manual');
    assert.equal(manual.description, implementation.done);

    const scope = implementation.validation_contract.checks.find((check) => check.type === 'diff-scope');
    assert.deepEqual(scope.paths.forbidden, ['package.json', 'src/generated']);

    const checkpointOp = parsed.operations.github.find((op) => op.task_id === '01-01-T01' && op.op === 'create_or_update_issue');
    assert.equal(checkpointOp.labels.includes('type:checkpoint'), true);
    assert.match(checkpointOp.body, /## Checkpoint Type\n`checkpoint:decision`/);
    assert.match(checkpointOp.body, /## Decision\nChoose the public API shape before implementation\./);
    assert.match(checkpointOp.body, /## Human Checkpoint Resolution/);
    assert.match(checkpointOp.body, /Record the human decision or result in this GitHub issue, then close the issue/);
    assert.match(checkpointOp.body, /Orchestration waits until this checkpoint issue is closed/);
    assert.match(checkpointOp.body, /Do not implement or edit code for this checkpoint task/);
    assert.doesNotMatch(checkpointOp.body, /No action block declared/);
    assert.doesNotMatch(checkpointOp.body, /No done criteria declared/);
    assert.doesNotMatch(checkpointOp.body, /## Write Scope/);
    assert.doesNotMatch(checkpointOp.body, /## Validation Contract/);
    assert.doesNotMatch(checkpointOp.body, /```bash\n\n```/);

    const dependencyOp = parsed.operations.github.find((op) =>
      op.op === 'ensure_blocked_by_dependency' &&
      op.task_id === '01-01-T02' &&
      op.blocked_by_task_id === '01-01-T01'
    );
    assert.ok(dependencyOp);
  });

  test('checkpoint issue body preserves complete human setup instructions', () => {
    const codeFence = '```';
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', [
      '---',
      'phase: 01-foundation',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [supabase/schema.sql]',
      'autonomous: false',
      'requirements: [REQ-001]',
      'must_haves:',
      '  truths: []',
      '  artifacts: []',
      '  key_links: []',
      '---',
      '',
      '<objective>',
      'Prepare Supabase setup.',
      '</objective>',
      '',
      '<tasks>',
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Task 2.5: Supabase project setup and schema deployment</name>',
      '  <what-built>Tasks 1-2 set up the Expo scaffold and Supabase schema with seed data.</what-built>',
      '  <how-to-verify>',
      '    1. Create a Supabase project at https://supabase.com/dashboard if needed',
      '    2. Copy the project URL and anon key from Supabase Dashboard -> Project Settings -> API',
      '    3. Create `stanzy/.env` from `.env.example` and fill in both values:',
      `       ${codeFence}`,
      '       EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co',
      '       EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here',
      `       ${codeFence}`,
      '    4. In Supabase Dashboard -> SQL Editor, paste the contents of `supabase/schema.sql` and click Run',
      '    5. Verify the listings table has seed data: run `SELECT id, title, price FROM listings LIMIT 3;`',
      '    6. In Supabase Dashboard -> Authentication -> Providers -> Email: set Confirm email to OFF',
      '  </how-to-verify>',
      '  <resume-signal>Type "approved" once Supabase is configured and schema is deployed, or report the error.</resume-signal>',
      '</task>',
      '</tasks>',
      '',
      '<verification>',
      '- [ ] Supabase setup is complete',
      '</verification>',
    ].join('\n'));

    const result = runGtdTools(['export-phase-issues', '01', '--dry-run', '--repo', 'owner/repo'], tmpDir);

    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    const checkpoint = parsed.plans[0].tasks[0];
    const checkpointOp = parsed.operations.github.find((op) => op.task_id === '01-01-T01' && op.op === 'create_or_update_issue');

    assert.equal(checkpoint.checkpoint_details.what_built, 'Tasks 1-2 set up the Expo scaffold and Supabase schema with seed data.');
    assert.match(checkpoint.checkpoint_details.how_to_verify, /Create a Supabase project/);
    assert.match(checkpointOp.body, /## What Is Ready For Human Review/);
    assert.match(checkpointOp.body, /Tasks 1-2 set up the Expo scaffold and Supabase schema with seed data\./);
    assert.match(checkpointOp.body, /## Human Instructions/);
    assert.match(checkpointOp.body, /Create `stanzy\/\.env` from `\.env\.example`/);
    assert.match(checkpointOp.body, /```[\s\S]*EXPO_PUBLIC_SUPABASE_URL=https:\/\/your-project\.supabase\.co[\s\S]*```/);
    assert.match(checkpointOp.body, /SQL Editor, paste the contents of `supabase\/schema\.sql` and click Run/);
    assert.match(checkpointOp.body, /SELECT id, title, price FROM listings LIMIT 3;/);
    assert.match(checkpointOp.body, /Confirm email to OFF/);
    assert.match(checkpointOp.body, /## Resume Signal\nType "approved" once Supabase is configured/);
    assert.doesNotMatch(checkpointOp.body, /No action block declared/);
    assert.doesNotMatch(checkpointOp.body, /No done criteria declared/);
    assert.doesNotMatch(checkpointOp.body, /No explicit files declared/);
    assert.doesNotMatch(checkpointOp.body, /## Validation Contract/);
    assert.doesNotMatch(checkpointOp.body, /## Verification\n```bash/);
  });

  test('fails source validation before producing an export plan', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', `---
phase: 01-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: true
requirements: [REQ-001]
---

<objective>
No tasks.
</objective>
`);

    const result = runGtdTools(['--json-errors', 'export-phase-issues', '01', '--dry-run'], tmpDir);

    assert.equal(result.success, false);
    const err = JSON.parse(result.error);
    assert.equal(err.ok, false);
    assert.equal(err.reason, 'usage');
    assert.match(err.message, /no <task> blocks found/);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github')), false);
  });
});

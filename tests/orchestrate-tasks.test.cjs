'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('./helpers/cli-negative.cjs');

const { buildWriteMode } = require('../get-tasks-done/bin/lib/export-phase-issues.cjs');
const {
  buildDryRun,
  buildExecution,
  buildResume,
  closingKeywordFindings,
  finalPrBody,
  parseArgs,
  proactiveValidateTaskPr,
  taskPrBody,
  validateOrchestratedPrBody,
} = require('../get-tasks-done/bin/lib/orchestrate-tasks.cjs');
const { cleanup, createTempGitProject, createTempProject } = require('./helpers.cjs');

function writePlan(tmpDir, phaseDir, filename, body) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), body, 'utf8');
}

function samplePlan({ plan, file, taskName }) {
  return `---
phase: 01-foundation
plan: ${plan}
type: execute
wave: 1
depends_on: []
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
  <boundaries>Only touch ${file}.</boundaries>
  <action>Create the implementation for ${taskName}.</action>
  <verify>npm test -- ${plan}</verify>
  <done>${file} contains the exported implementation.</done>
  <acceptance_criteria>
    - ${file} contains the exported implementation
  </acceptance_criteria>
</task>
</tasks>

<verification>
npm test
</verification>

<success_criteria>
- Plan ${plan} works.
</success_criteria>
`;
}

function sequentialPlan() {
  return `---
phase: 01-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/first.ts, src/second.ts]
autonomous: true
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build a two-task sequence.
</objective>

<tasks>
<task type="auto">
  <name>Create first module</name>
  <files>src/first.ts</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only touch src/first.ts.</boundaries>
  <action>Create the first implementation.</action>
  <verify>npm test -- first</verify>
  <done>src/first.ts contains the exported implementation.</done>
  <acceptance_criteria>
    - src/first.ts contains the exported implementation
  </acceptance_criteria>
</task>
<task type="auto">
  <name>Create second module</name>
  <files>src/second.ts</files>
  <read_first>src/first.ts</read_first>
  <boundaries>Only touch src/second.ts.</boundaries>
  <action>Create the second implementation.</action>
  <verify>npm test -- second</verify>
  <done>src/second.ts contains the exported implementation.</done>
  <acceptance_criteria>
    - src/second.ts contains the exported implementation
  </acceptance_criteria>
</task>
</tasks>

<verification>
npm test
</verification>

<success_criteria>
- Both modules work.
</success_criteria>
`;
}

function checkpointPlan() {
  return `---
phase: 01-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/first.ts, src/second.ts]
autonomous: false
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build a sequence with a human checkpoint.
</objective>

<tasks>
<task type="auto">
  <name>Create first module</name>
  <files>src/first.ts</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only touch src/first.ts.</boundaries>
  <action>Create the first implementation.</action>
  <verify>npm test -- first</verify>
  <done>src/first.ts contains the exported implementation.</done>
  <acceptance_criteria>
    - src/first.ts contains the exported implementation
  </acceptance_criteria>
</task>
<task type="auto">
  <name>Create second module</name>
  <files>src/second.ts</files>
  <read_first>src/first.ts</read_first>
  <boundaries>Only touch src/second.ts.</boundaries>
  <action>Create the second implementation.</action>
  <verify>npm test -- second</verify>
  <done>src/second.ts contains the exported implementation.</done>
  <acceptance_criteria>
    - src/second.ts contains the exported implementation
  </acceptance_criteria>
</task>
<task type="checkpoint:human-verify" gate="blocking">
  <name>Verify external setup</name>
  <what-built>The implementation tasks created the artifacts needed by the human.</what-built>
  <how-to-verify>Complete the external setup, then close this issue.</how-to-verify>
  <resume-signal>Close the GitHub issue when complete.</resume-signal>
</task>
</tasks>

<verification>
npm test
</verification>

<success_criteria>
- Both modules work after the checkpoint is resolved.
</success_criteria>
`;
}

function cloneIssue(issue) {
  return JSON.parse(JSON.stringify(issue));
}

class FakeGitHubAdapter {
  constructor() {
    this.labels = new Map();
    this.issues = new Map();
    this.subIssues = new Map();
    this.blockedBy = new Map();
    this.prs = new Map();
    this.comments = new Map();
    this.nextIssueNumber = 10;
    this.nextIssueId = 1000;
    this.nextPrNumber = 200;
  }

  getLabel(name) {
    const label = this.labels.get(name);
    return label ? { ...label } : null;
  }

  ensureLabel(name) {
    const existing = this.getLabel(name);
    if (existing) return { action: 'kept', label: existing };
    const label = { name, color: '000000', description: '' };
    this.labels.set(name, label);
    return { action: 'created', label: { ...label } };
  }

  getIssue(number) {
    const issue = this.issues.get(Number(number));
    return issue ? cloneIssue(issue) : null;
  }

  searchIssuesContaining(identity) {
    return [...this.issues.values()]
      .filter((issue) => String(issue.body || '').includes(identity))
      .map(cloneIssue)
      .sort((a, b) => a.number - b.number);
  }

  createIssue({ title, body, labels }) {
    const number = this.nextIssueNumber++;
    const issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels: labels.map((name) => ({ name })),
    };
    this.issues.set(number, issue);
    return cloneIssue(issue);
  }

  updateIssue(number, { title, body, labels }) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    issue.title = title;
    issue.body = body;
    issue.labels = labels.map((name) => ({ name }));
    return cloneIssue(issue);
  }

  setIssueLabels(number, labels) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    issue.labels = labels.map((name) => ({ name }));
    return cloneIssue(issue);
  }

  updateIssueState(number, state) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    issue.state = state;
    return cloneIssue(issue);
  }

  commentIssue(number, body) {
    const comments = this.comments.get(Number(number)) || [];
    const comment = {
      body,
      url: `https://github.com/owner/repo/issues/${number}#issuecomment-${comments.length + 1}`,
    };
    comments.push(comment);
    this.comments.set(Number(number), comments);
    return comment;
  }

  listSubIssues(parentNumber) {
    const ids = this.subIssues.get(Number(parentNumber)) || new Set();
    return [...this.issues.values()].filter((issue) => ids.has(issue.id)).map(cloneIssue);
  }

  addSubIssue(parentNumber, childIssueId) {
    const ids = this.subIssues.get(Number(parentNumber)) || new Set();
    ids.add(childIssueId);
    this.subIssues.set(Number(parentNumber), ids);
    return {};
  }

  listBlockedBy(issueNumber) {
    const ids = this.blockedBy.get(Number(issueNumber)) || new Set();
    return [...this.issues.values()].filter((issue) => ids.has(issue.id)).map(cloneIssue);
  }

  addBlockedBy(issueNumber, blockingIssueId) {
    const ids = this.blockedBy.get(Number(issueNumber)) || new Set();
    ids.add(blockingIssueId);
    this.blockedBy.set(Number(issueNumber), ids);
    return {};
  }

  listPullRequestsForIssue(issueNumber, branchName) {
    return [...this.prs.values()].filter((pr) => {
      const body = String(pr.body || '');
      return pr.headRefName === branchName || body.includes(`#${issueNumber}`);
    }).map((pr) => ({ ...pr }));
  }

  createPullRequest({ title, body, head, base, draft }) {
    const number = this.nextPrNumber++;
    const pr = {
      number,
      title,
      body,
      state: 'OPEN',
      isDraft: Boolean(draft),
      headRefName: head,
      baseRefName: base,
      url: `https://github.com/owner/repo/pull/${number}`,
    };
    this.prs.set(number, pr);
    this.lastCreatedPr = pr;
    return { ...pr };
  }

  mergePullRequest(number, { method, subject, body }) {
    const pr = this.prs.get(Number(number));
    assert.ok(pr, `missing PR #${number}`);
    pr.state = 'MERGED';
    pr.merged = true;
    pr.merge = { method, subject, body };
    return { ...pr };
  }

  viewPullRequest(number) {
    const pr = this.prs.get(Number(number));
    return pr ? { ...pr } : null;
  }
}

function exportPlans(tmpDir, adapter, count) {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    const plan = String(i).padStart(2, '0');
    const file = `src/module-${i}.ts`;
    fs.writeFileSync(path.join(tmpDir, file), `${Array.from({ length: 220 }, (_, n) => `line ${n}`).join('\n')}\n`, 'utf8');
    writePlan(tmpDir, '01-foundation', `01-${plan}-PLAN.md`, samplePlan({
      plan,
      file,
      taskName: `Create module ${i}`,
    }));
  }
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return result;
}

function exportSequentialPlan(tmpDir, adapter) {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'first.ts'), 'export const first = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'second.ts'), 'export const second = 2;\n', 'utf8');
  writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', sequentialPlan());
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return result;
}

function exportCheckpointPlan(tmpDir, adapter) {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'first.ts'), 'export const first = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'src', 'second.ts'), 'export const second = 2;\n', 'utf8');
  writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', checkpointPlan());
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return result;
}

function issueNumbersFromExport(exported) {
  return exported.plans.flatMap((plan) => plan.tasks.map((task) => task.issue));
}

function issueOpts(exported, extra = {}) {
  return {
    issueNumbers: issueNumbersFromExport(exported),
    repo: 'owner/repo',
    ...extra,
  };
}

function commitAll(tmpDir, message) {
  execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: tmpDir, stdio: 'pipe' });
}

function gitStatus(tmpDir) {
  return execSync('git status --short', { cwd: tmpDir, encoding: 'utf8' }).trim();
}

function runOrchestrateCli(args, cwd) {
  return runCli(['orchestrate-tasks', ...args], { cwd });
}

function assertSafeCheckpointNextStep(result, kind) {
  assert.equal(result.user_next_step.kind, kind);
  assert.equal(Array.isArray(result.user_next_step.checkpoint_issues), true);
  assert.notEqual(result.user_next_step.checkpoint_issues.length, 0);
  assert.match(result.user_next_step.message, /checkpoint issue #\d+/i);
  assert.match(result.user_next_step.message, /tell me to continue|continue the orchestration/i);
  assert.doesNotMatch(result.user_next_step.message, /\bnode\b/i);
  assert.doesNotMatch(result.user_next_step.message, /gtd-tools/i);
  assert.doesNotMatch(result.user_next_step.message, /--resume/i);
}

function validExecutorEvidence(commit = 'abcdef1234567890abcdef1234567890abcdef12') {
  return {
    ok: true,
    executor_success: true,
    blockers: [],
    commit,
    reachable_commit: true,
    branch_contains_commit: true,
    committed_diff: true,
    clean_worktree: true,
    reasons: [],
  };
}

describe('orchestrate-tasks planning and gates', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gtd-orchestrate-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('dry-run computes reviewability before any orchestration writes', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 6);

    const result = buildDryRun(tmpDir, issueOpts(exported, {
      dryRun: true,
      maxConcurrency: 3,
    }), adapter);

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.writes, false);
    assert.equal(result.selected_tasks.length, 6);
    assert.equal(result.reviewability.requires_confirmation, true);
    assert.equal(result.reviewability.triggered.includes('task_count'), true);
    assert.ok(result.reviewability.estimate.expected_changed_loc > 0);
    assert.ok(result.reviewability.recommended_subset.length > 0);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github', 'orchestrations')), false);
  });

  test('dry-run can use a repo inferred during export without requiring --repo', () => {
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git remote add origin git@github.com:davide-troiani/my-project.git', { cwd: tmpDir, stdio: 'pipe' });
    const adapter = new FakeGitHubAdapter();
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      file: 'src/auth.ts',
      taskName: 'Create auth module',
    }));
    const exported = buildWriteMode(tmpDir, { phase: '01', repo: null, dryRun: false }, adapter);
    assert.equal(exported.repo, 'davide-troiani/my-project');

    const result = buildDryRun(tmpDir, {
      issueNumbers: issueNumbersFromExport(exported),
      repo: null,
      dryRun: true,
      maxConcurrency: 3,
    }, adapter);

    assert.equal(result.ok, true);
    assert.equal(result.scope[0].repo, 'davide-troiani/my-project');
    assert.deepEqual(result.selected_tasks.map((task) => task.task_id), ['01-01-T01']);
  });

  test('argument parser accepts only issue-number lists', () => {
    assert.deepEqual(parseArgs(['orchestrate-tasks', '123', '#124', '--repo', 'owner/repo']).issueNumbers, [123, 124]);
    for (const invalid of [
      ['orchestrate-tasks', 'tasks', '123', '124'],
      ['orchestrate-tasks', 'next', '3', 'tasks'],
      ['orchestrate-tasks', 'phase', '1', 'tasks'],
      ['orchestrate-tasks', '--phase', '1', '123'],
      ['orchestrate-tasks', '01-01-T01'],
      ['orchestrate-tasks', 'https://github.com/owner/repo/issues/123'],
    ]) {
      const result = runOrchestrateCli(invalid.slice(1), tmpDir);
      assert.notEqual(result.status, 0, `expected ${invalid.join(' ')} to fail`);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'usage');
      assert.equal(result.hasStackTrace, false);
      assert.equal(typeof result.message, 'string');
      assert.notEqual(result.message, '');
    }
  });

  test('issue-number selection rejects parent plan issues', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);

    const result = buildDryRun(tmpDir, {
      issueNumbers: [exported.plans[0].issue],
      repo: 'owner/repo',
      dryRun: true,
    }, adapter);

    assert.equal(result.ok, true);
    assert.equal(result.preflight.ok, false);
    assert.equal(result.selected_tasks.length, 0);
    assert.equal(result.selection_errors[0].code, 'selector_resolved_parent_plan');
  });

  test('issue-number selection keeps internally blocked tasks and schedules them sequentially', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportSequentialPlan(tmpDir, adapter);

    const result = buildDryRun(tmpDir, issueOpts(exported, {
      dryRun: true,
      maxConcurrency: 2,
    }), adapter);

    assert.equal(result.ok, true);
    assert.equal(result.preflight.ok, true);
    assert.deepEqual(result.selected_tasks.map((task) => task.task_id), ['01-01-T01', '01-01-T02']);
    assert.deepEqual(result.waves.map((wave) => wave.parallel_tasks), [['01-01-T01'], ['01-01-T02']]);
    assert.deepEqual(result.non_workable, []);
    assert.deepEqual(result.internal_blocked, [{
      task_id: '01-01-T02',
      issue: result.selected_tasks[1].issue,
      blocked_by: [{
        task_id: '01-01-T01',
        issue: result.selected_tasks[0].issue,
      }],
    }]);
    assert.deepEqual(result.dependency_order, [{
      task_id: '01-01-T02',
      issue: result.selected_tasks[1].issue,
      depends_on: [{
        task_id: '01-01-T01',
        issue: result.selected_tasks[0].issue,
      }],
    }]);
    assert.equal(result.presentation_guidance.dependency_order_is_not_a_blocker, true);
  });

  test('dry-run treats selected human checkpoints as non-executable gates', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportCheckpointPlan(tmpDir, adapter);

    const result = buildDryRun(tmpDir, issueOpts(exported, {
      dryRun: true,
      maxConcurrency: 2,
    }), adapter);

    assert.equal(result.preflight.ok, true);
    assert.deepEqual(result.non_workable, []);
    assert.deepEqual(result.selected_tasks.map((task) => task.task_id), ['01-01-T01', '01-01-T02', '01-01-T03']);
    assert.deepEqual(result.waves.map((wave) => wave.parallel_tasks), [['01-01-T01'], ['01-01-T02'], ['01-01-T03']]);
    assert.deepEqual(result.checkpoint_gates, [{
      task_id: '01-01-T03',
      issue: result.selected_tasks[2].issue,
      status: 'waiting_dependencies',
      depends_on: [{
        task_id: '01-01-T02',
        issue: result.selected_tasks[1].issue,
      }],
      blocked_by: [{
        task_id: '01-01-T02',
        issue: result.selected_tasks[1].issue,
      }],
      hard_signal: 'issue_closed',
    }]);
    assert.deepEqual(result.internal_blocked, [
      {
        task_id: '01-01-T02',
        issue: result.selected_tasks[1].issue,
        blocked_by: [{
          task_id: '01-01-T01',
          issue: result.selected_tasks[0].issue,
        }],
      },
      {
        task_id: '01-01-T03',
        issue: result.selected_tasks[2].issue,
        blocked_by: [{
          task_id: '01-01-T02',
          issue: result.selected_tasks[1].issue,
        }],
      },
    ]);
    assert.equal(result.presentation_guidance.checkpoint_gates_are_not_blockers, true);
  });

  test('dry-run keeps selected checkpoints blocked by external open issues non-workable', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportCheckpointPlan(tmpDir, adapter);
    const checkpointIssue = issueNumbersFromExport(exported)[2];
    const external = adapter.createIssue({
      title: 'External dependency',
      body: 'Resolve outside this orchestration.',
      labels: ['gtd:task'],
    });
    adapter.addBlockedBy(checkpointIssue, external.id);

    const result = buildDryRun(tmpDir, issueOpts(exported, {
      dryRun: true,
      maxConcurrency: 2,
    }), adapter);

    assert.equal(result.preflight.ok, false);
    assert.equal(result.non_workable.length, 1);
    assert.equal(result.non_workable[0].task_id, '01-01-T03');
    assert.equal(result.non_workable[0].reasons[0].code, 'open_task_blockers');
    assert.deepEqual(result.non_workable[0].reasons[0].blockers, [external.number]);
  });

  test('default execution prepares agent lanes instead of requiring a local task-executor binary', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportSequentialPlan(tmpDir, adapter);
    let branchCreated = false;

    const result = buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 2,
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-agent',
      ensureBulkBranch: () => {
        branchCreated = true;
        return {
          branch: 'gtd/orchestrate-20260518-agent',
          default_branch: 'main',
          default_ref: 'origin/main',
          pushed: true,
        };
      },
    });

    assert.equal(branchCreated, true);
    assert.equal(result.action, 'agent_lanes_required');
    assert.equal(result.executor.backend, 'agent');
    assert.equal(result.implementation, false);
    assert.equal(result.pr_creation, false);
    assert.deepEqual(result.agent_lanes.map((lane) => lane.parallel_tasks.map((task) => task.task_id)), [['01-01-T01'], ['01-01-T02']]);
    assert.equal(result.agent_lanes[0].parallel_tasks[0].agent.model, 'gpt-5.4-mini');
  });

  test('explicit command executor backend fails before branch creation when the command is unavailable', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    let branchCreated = false;

    const result = buildExecution(tmpDir, issueOpts(exported, {
      executorBackend: 'command',
      executorCommand: 'missing-gtd-task-executor',
      confirmReviewability: true,
    }), adapter, {
      commandExists: () => false,
      ensureBulkBranch: () => {
        branchCreated = true;
        throw new Error('should not create a branch when executor command is unavailable');
      },
    });

    assert.equal(result.action, 'executor_unavailable');
    assert.equal(result.executor.code, 'executor_command_unavailable');
    assert.equal(result.writes, false);
    assert.equal(branchCreated, false);
  });

  test('mutating execution stops before branch creation when final PR is projected too large', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 6);
    let branchCreated = false;

    const result = buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 3,
    }), adapter, {
      ensureBulkBranch: () => {
        branchCreated = true;
        throw new Error('should not create a branch before reviewability confirmation');
      },
    });

    assert.equal(result.action, 'request_reviewability_direction');
    assert.deepEqual(result.reviewability.decision_options.map((option) => option.id), [
      'continue_full_scope',
      'choose_smaller_scope',
      'abort',
    ]);
    assert.equal(result.writes, false);
    assert.equal(branchCreated, false);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github', 'orchestrations')), false);
  });

  test('confirmed execution opens one final PR that closes accepted tasks only', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 2);

    const result = buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 2,
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-test',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-test',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: record.issue_number + 100,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-test',
        },
        validation: { ok: true, findings: [], comment_ref: `https://github.com/owner/repo/pull/${record.issue_number + 100}#issuecomment-1` },
        manual_checks: record.task.acceptance_criteria,
      }),
    });

    assert.equal(result.action, 'final_pr_opened');
    assert.equal(result.final_pr.baseRefName, 'main');
    assert.equal(result.final_pr.headRefName, 'gtd/orchestrate-20260518-test');
    assert.match(result.final_pr.body, /Closes #\d+/);
    assert.doesNotMatch(result.task_results[0].pr.body, /Closes #/);
    assert.equal(result.orchestration.status, 'final_pr_open');
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'github', 'orchestrations', '20260518-test.json')), true);
  });

  test('execution pauses at a pending human checkpoint after prior tasks are accepted', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportCheckpointPlan(tmpDir, adapter);

    const result = buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 2,
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-checkpoint',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-checkpoint',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: record.issue_number + 100,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-checkpoint',
        },
        validation: { ok: true, findings: [] },
        manual_checks: record.task.acceptance_criteria,
      }),
    });

    assert.equal(result.action, 'human_checkpoint_required');
    assert.equal(result.pr_creation, true);
    assert.equal(result.final_pr, undefined);
    assert.equal(result.orchestration.status, 'waiting_for_human_checkpoint');
    assert.equal(result.orchestration.tasks['01-01-T01'].status, 'accepted');
    assert.equal(result.orchestration.tasks['01-01-T02'].status, 'accepted');
    assert.equal(result.orchestration.tasks['01-01-T03'].status, 'checkpoint_waiting_human');
    assert.equal(result.checkpoint_gates[0].status, 'pending');
    assert.deepEqual(result.task_results.map((task) => task.task_id), ['01-01-T01', '01-01-T02']);
    assertSafeCheckpointNextStep(result, 'human_checkpoint_required');
    assert.deepEqual(result.user_next_step.checkpoint_issues, [{
      task_id: '01-01-T03',
      issue: issueNumbersFromExport(exported)[2],
      status: 'pending',
    }]);
  });

  test('resume stays blocked while a human checkpoint issue is open', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportCheckpointPlan(tmpDir, adapter);

    buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 2,
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-checkpoint-open',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-checkpoint-open',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: { number: record.issue_number + 100, body: `Refs #${record.issue_number}` },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });

    const resumed = buildResume(tmpDir, {
      resume: '20260518-checkpoint-open',
      repo: 'owner/repo',
    }, adapter, {
      executeTaskLane: () => {
        throw new Error('open checkpoint must not resume task execution');
      },
    });

    assert.equal(resumed.action, 'human_checkpoint_pending');
    assert.equal(resumed.pr_creation, false);
    assert.equal(resumed.final_pr, null);
    assert.equal(resumed.checkpoint_sync.pending.length, 1);
    assertSafeCheckpointNextStep(resumed, 'human_checkpoint_pending');
    assert.deepEqual(resumed.user_next_step.checkpoint_issues, [{
      task_id: '01-01-T03',
      issue: issueNumbersFromExport(exported)[2],
      status: 'pending',
    }]);
  });

  test('resume after checkpoint closure opens final PR without closing checkpoint issues', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportCheckpointPlan(tmpDir, adapter);
    const checkpointIssue = issueNumbersFromExport(exported)[2];

    buildExecution(tmpDir, issueOpts(exported, {
      maxConcurrency: 2,
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-checkpoint-closed',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-checkpoint-closed',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: record.issue_number + 100,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-checkpoint-closed',
        },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });
    adapter.updateIssueState(checkpointIssue, 'closed');

    const resumed = buildResume(tmpDir, {
      resume: '20260518-checkpoint-closed',
      repo: 'owner/repo',
    }, adapter, {
      executeTaskLane: () => {
        throw new Error('no implementation tasks remain after checkpoint closure');
      },
    });

    assert.equal(resumed.action, 'final_pr_opened');
    assert.equal(resumed.orchestration.status, 'final_pr_open');
    assert.equal(resumed.orchestration.tasks['01-01-T03'].status, 'checkpoint_resolved');
    assert.equal(resumed.checkpoint_gates[0].status, 'resolved');
    assert.match(resumed.final_pr.body, new RegExp(`Closes #${issueNumbersFromExport(exported)[0]}`));
    assert.match(resumed.final_pr.body, new RegExp(`Closes #${issueNumbersFromExport(exported)[1]}`));
    assert.doesNotMatch(resumed.final_pr.body, new RegExp(`Closes #${checkpointIssue}`));
  });

  test('command backend opens a ready task PR only with valid executor commit evidence', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);

    const result = buildExecution(tmpDir, issueOpts(exported, {
      executorBackend: 'command',
    }), adapter, {
      id: '20260518-command-ready',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-command-ready',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      ensureTaskWorktree: ({ record, bulkBranch, bulkId }) => ({
        path: tmpDir,
        branch: `gtd/task-${record.task_id}-${bulkId}`,
        base_ref: bulkBranch,
      }),
      runTaskExecutor: () => ({
        ok: true,
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        notes: 'Implemented.',
      }),
      listChangedFiles: () => ['src/module-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: ({ executorResult }) => validExecutorEvidence(executorResult.commit),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      simulateMerge: () => ({ ok: true, worktree: tmpDir, changed_files: ['src/module-1.ts'] }),
    });

    const taskPr = [...adapter.prs.values()].find((pr) => pr.body.includes('gtd-orchestrate-tasks:task-pr'));
    assert.equal(result.action, 'final_pr_opened');
    assert.ok(taskPr, 'task PR should be opened before final PR');
    assert.equal(taskPr.isDraft, false);
    assert.doesNotMatch(taskPr.body, /Closes #/);
    assert.equal(result.task_results[0].status, 'accepted');
  });

  test('command backend allows short executor commit after evidence normalizes it to full SHA', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    const fullCommit = 'abcdef1234567890abcdef1234567890abcdef12';
    const shortCommit = fullCommit.slice(0, 12);

    const result = buildExecution(tmpDir, issueOpts(exported, {
      executorBackend: 'command',
    }), adapter, {
      id: '20260518-command-short-sha',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-command-short-sha',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      ensureTaskWorktree: ({ record, bulkBranch, bulkId }) => ({
        path: tmpDir,
        branch: `gtd/task-${record.task_id}-${bulkId}`,
        base_ref: bulkBranch,
      }),
      runTaskExecutor: () => ({
        ok: true,
        commit: shortCommit,
        notes: 'Implemented.',
      }),
      listChangedFiles: () => ['src/module-1.ts'],
      listPullRequestCommits: () => [{
        oid: fullCommit,
        messageHeadline: 'Implement task',
        messageBody: '',
      }],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: () => validExecutorEvidence(fullCommit),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      simulateMerge: () => ({ ok: true, worktree: tmpDir, changed_files: ['src/module-1.ts'] }),
    });

    assert.equal(result.action, 'final_pr_opened');
    assert.equal(result.task_results[0].status, 'accepted');
    assert.equal(result.task_results[0].validation.ok, true);
  });

  test('command backend opens a draft task PR when validation fails but commit evidence is valid', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);

    const result = buildExecution(tmpDir, issueOpts(exported, {
      executorBackend: 'command',
    }), adapter, {
      id: '20260518-command-draft',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-command-draft',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      ensureTaskWorktree: ({ record, bulkBranch, bulkId }) => ({
        path: tmpDir,
        branch: `gtd/task-${record.task_id}-${bulkId}`,
        base_ref: bulkBranch,
      }),
      runTaskExecutor: () => ({
        ok: true,
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        notes: 'Partial implementation.',
      }),
      listChangedFiles: () => ['src/module-1.ts'],
      runCommand: () => ({ status: 1, stdout: '', stderr: 'failed' }),
      validateExecutorEvidence: ({ executorResult }) => validExecutorEvidence(executorResult.commit),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      simulateMerge: () => ({ ok: true, worktree: tmpDir, changed_files: ['src/module-1.ts'] }),
    });

    assert.equal(result.action, 'changes_requested');
    assert.equal(result.pr_creation, true);
    assert.equal(result.task_results[0].pr.isDraft, true);
    assert.equal(result.task_results[0].validation.ok, false);
  });

  test('command backend opens no task PR when executor commit evidence is invalid', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    let pushed = false;

    const result = buildExecution(tmpDir, issueOpts(exported, {
      executorBackend: 'command',
    }), adapter, {
      id: '20260518-command-evidence-failed',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-command-evidence-failed',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      ensureTaskWorktree: ({ record, bulkBranch, bulkId }) => ({
        path: tmpDir,
        branch: `gtd/task-${record.task_id}-${bulkId}`,
        base_ref: bulkBranch,
      }),
      runTaskExecutor: () => ({
        ok: true,
        blockers: ['Waiting for credentials'],
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
      }),
      listChangedFiles: () => ['src/module-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: ({ executorResult }) => ({
        ...validExecutorEvidence(executorResult.commit),
        ok: false,
        blockers: executorResult.blockers,
        reasons: [{
          code: 'executor_blockers',
          message: 'Executor reported blocker(s): Waiting for credentials',
        }],
      }),
      pushBranch: () => {
        pushed = true;
        throw new Error('invalid evidence must not push');
      },
    });

    assert.equal(result.action, 'changes_requested');
    assert.equal(result.pr_creation, false);
    assert.equal(result.task_results[0].pr, null);
    assert.equal(result.task_results[0].validation.findings[0].code, 'executor_blockers');
    assert.equal(pushed, false);
    assert.equal(adapter.lastCreatedPr, undefined);
  });

  test('confirmed execution commits the orchestration manifest and leaves no git status leftover', () => {
    cleanup(tmpDir);
    tmpDir = createTempGitProject('gtd-orchestrate-git-');
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    commitAll(tmpDir, 'fixture: export task issues');

    const result = buildExecution(tmpDir, issueOpts(exported, {
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-clean',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-clean',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: 300,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-clean',
        },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });

    assert.equal(result.action, 'final_pr_opened');
    assert.equal(result.manifest_commit.committed, true);
    assert.equal(result.manifest_commit.path, '.planning/github/orchestrations/20260518-clean.json');
    assert.equal(gitStatus(tmpDir), '');
  });

  test('commit_docs false with ignored planning keeps local manifest out of git status', () => {
    cleanup(tmpDir);
    tmpDir = createTempGitProject('gtd-orchestrate-local-docs-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), `${JSON.stringify({ commit_docs: false }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/\n', 'utf8');

    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    execSync('git add .gitignore src', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "fixture: ignore planning docs"', { cwd: tmpDir, stdio: 'pipe' });

    const result = buildExecution(tmpDir, issueOpts(exported, {
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-local',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-local',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: 301,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-local',
        },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });

    assert.equal(result.action, 'final_pr_opened');
    assert.equal(result.manifest_commit.committed, false);
    assert.equal(result.manifest_commit.reason, 'skipped_commit_docs_false');
    assert.equal(gitStatus(tmpDir), '');
  });

  test('resume syncs a merged final PR back into the orchestration manifest', () => {
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);

    const created = buildExecution(tmpDir, issueOpts(exported, {
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-resume',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-resume',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: 300,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-resume',
        },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });

    const finalPr = adapter.prs.get(created.final_pr.number);
    finalPr.merged = true;
    finalPr.state = 'MERGED';

    const resumed = buildResume(tmpDir, {
      resume: '20260518-resume',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(resumed.action, 'final_pr_merged_synced');
    assert.equal(resumed.writes, true);
    assert.equal(resumed.orchestration.status, 'final_pr_merged');
    assert.equal(resumed.issue_sync.length, 1);
    assert.equal(resumed.reconciliation.ok, true);
    assert.equal(resumed.reconciliation.plans.length, 1);
    assert.match(resumed.reconciliation.plans[0].command, /work-task-issue \d+ --repo owner\/repo --phase 01-foundation --reconcile --execute/);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'github', 'orchestrations', '20260518-resume.json'), 'utf8'));
    assert.equal(manifest.status, 'final_pr_merged');
    assert.equal(manifest.tasks['01-01-T01'].status, 'final_pr_merged');
  });

  test('resume commits the merged final PR manifest update and leaves no git status leftover', () => {
    cleanup(tmpDir);
    tmpDir = createTempGitProject('gtd-orchestrate-resume-git-');
    const adapter = new FakeGitHubAdapter();
    const exported = exportPlans(tmpDir, adapter, 1);
    commitAll(tmpDir, 'fixture: export task issues');

    const created = buildExecution(tmpDir, issueOpts(exported, {
      confirmReviewability: true,
    }), adapter, {
      id: '20260518-resume-clean',
      ensureBulkBranch: () => ({
        branch: 'gtd/orchestrate-20260518-resume-clean',
        default_branch: 'main',
        default_ref: 'origin/main',
        pushed: true,
      }),
      executeTaskLane: ({ record }) => ({
        status: 'accepted',
        decision: 'accepted',
        pr: {
          number: 302,
          title: `[GTD ${record.task_id}] ${record.task.name}`,
          body: `Refs #${record.issue_number}`,
          headRefName: `gtd/task-${record.task_id}`,
          baseRefName: 'gtd/orchestrate-20260518-resume-clean',
        },
        validation: { ok: true, findings: [] },
        manual_checks: [],
      }),
    });
    assert.equal(created.manifest_commit.committed, true);
    assert.equal(gitStatus(tmpDir), '');

    const finalPr = adapter.prs.get(created.final_pr.number);
    finalPr.merged = true;
    finalPr.state = 'MERGED';

    const resumed = buildResume(tmpDir, {
      resume: '20260518-resume-clean',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(resumed.action, 'final_pr_merged_synced');
    assert.equal(resumed.manifest_commit.committed, true);
    assert.equal(gitStatus(tmpDir), '');
  });
});

describe('orchestrate-tasks PR body formatting contracts', () => {
  test('validates canonical task and final PR body shapes', () => {
    const record = {
      task_id: '01-01-T01',
      issue_number: 10,
      task: {
        name: 'Create module',
        acceptance_criteria: ['Review task output.'],
      },
      plan: { source_path: '.planning/phases/01-foundation/01-01-PLAN.md' },
    };

    const taskBody = taskPrBody(record, {
      ok: true,
      checks: [{ id: 'scope', type: 'diff-scope', passed: true }],
      manual: [],
    }, { notes: 'Implemented deterministically.' }, '20260606-body');
    assert.equal(validateOrchestratedPrBody('task', taskBody).ok, true);
    assert.match(taskBody, /^<!-- gtd-orchestrate-tasks:task-pr -->\n## Task/);
    assert.match(taskBody, /\n## Implementation Notes\nImplemented deterministically\./);
    assert.match(taskBody, /\n## Validation\nAutomated validation passed\./);
    assert.match(taskBody, /\n## Manual Review\n- \[ \] Review task output\./);
    assert.match(taskBody, /\nRefs #10$/);

    const finalBody = finalPrBody({
      id: '20260606-body',
      bulk_branch: 'gtd/orchestrate-20260606-body',
    }, [{
      task_id: '01-01-T01',
      issue: 10,
      pr: 123,
      decision: 'accepted',
      validation: { status: 'passed' },
      manual_checks: ['Review task output.'],
    }], { ok: true });
    assert.equal(validateOrchestratedPrBody('final', finalBody).ok, true);
    assert.match(finalBody, /^<!-- gtd-orchestrate-tasks:final-pr -->\n## GTD Bulk Orchestration/);
    assert.match(finalBody, /\n\| Task \| Issue \| Task PR \| Decision \| Validation \|\n\|---\|---:\|---:\|---\|---\|/);
    assert.match(finalBody, /\n## Integration Validation\n/);
    assert.match(finalBody, /\n## Manual Review Checklist\n/);
    assert.match(finalBody, /\nCloses #10$/);
  });

  test('rejects malformed orchestrated PR bodies', () => {
    const malformedTask = [
      '<!-- gtd-orchestrate-tasks:task-pr -->',
      '## Task',
      '',
      '- Issue: #10',
      '',
      '## Validation',
      'Automated validation passed.',
      '',
      'Refs #10',
    ].join('\n');
    const taskValidation = validateOrchestratedPrBody('task', malformedTask);
    assert.equal(taskValidation.ok, false);
    assert.ok(taskValidation.findings.some((finding) => finding.code === 'missing_heading'));

    const malformedFinal = [
      '<!-- gtd-orchestrate-tasks:final-pr -->',
      '## GTD Bulk Orchestration',
      '',
      '## Tasks',
      '',
      '| Task | Issue | Task PR | Decision | Validation |',
      '|---|---:|---:|---|---|',
      '',
      '## Integration Validation',
      'Final integration checks passed.',
      '',
      '## Manual Review Checklist',
      '- [ ] Review.',
    ].join('\n');
    const finalValidation = validateOrchestratedPrBody('final', malformedFinal);
    assert.equal(finalValidation.ok, false);
    assert.ok(finalValidation.findings.some((finding) => finding.code === 'missing_task_rows'));
    assert.ok(finalValidation.findings.some((finding) => finding.code === 'missing_closing_reference'));
  });

  test('sanitizes executor notes that try to inject structural headings or markers', () => {
    const record = {
      task_id: '01-01-T01',
      issue_number: 10,
      task: { name: 'Create module', acceptance_criteria: [] },
      plan: { source_path: '.planning/phases/01-foundation/01-01-PLAN.md' },
    };
    const body = taskPrBody(record, { ok: true, checks: [], manual: [] }, {
      notes: [
        'Implemented with `$VALUE` and a literal backslash \\.',
        '## Validation',
        '<!-- gtd-orchestrate-tasks:final-pr -->',
        'Inline `code` remains markdown.',
      ].join('\n'),
    }, '20260606-injection');
    const lines = body.split('\n');

    assert.equal(validateOrchestratedPrBody('task', body).ok, true);
    assert.equal(lines.filter((line) => line === '## Validation').length, 1);
    assert.equal(lines.filter((line) => line === '<!-- gtd-orchestrate-tasks:final-pr -->').length, 0);
    assert.ok(body.includes('> ## Validation'));
    assert.ok(body.includes('> <!-- gtd-orchestrate-tasks:final-pr -->'));
    assert.ok(body.includes('`$VALUE`'));
  });

  test('execution rejects invalid task PR bodies before createPullRequest is called', () => {
    const tmpDir = createTempProject('gtd-orchestrate-body-');
    try {
      const adapter = new FakeGitHubAdapter();
      const exported = exportPlans(tmpDir, adapter, 1);
      let createPullRequestCalls = 0;
      adapter.createPullRequest = () => {
        createPullRequestCalls += 1;
        throw new Error('createPullRequest must not be called for invalid bodies');
      };

      assert.throws(() => buildExecution(tmpDir, issueOpts(exported, {
        executorBackend: 'command',
      }), adapter, {
        id: '20260606-invalid-body',
        ensureBulkBranch: () => ({
          branch: 'gtd/orchestrate-20260606-invalid-body',
          default_branch: 'main',
          default_ref: 'origin/main',
          pushed: true,
        }),
        ensureTaskWorktree: ({ record, bulkBranch, bulkId }) => ({
          path: tmpDir,
          branch: `gtd/task-${record.task_id}-${bulkId}`,
          base_ref: bulkBranch,
        }),
        runTaskExecutor: () => ({
          ok: true,
          commit: 'abcdef1234567890abcdef1234567890abcdef12',
          notes: 'Closes #10',
        }),
        listChangedFiles: () => ['src/module-1.ts'],
        runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
        validateExecutorEvidence: ({ executorResult }) => validExecutorEvidence(executorResult.commit),
        pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      }), /Invalid task PR body formatting/);
      assert.equal(createPullRequestCalls, 0);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('orchestrate-tasks imports the shared GitHub CLI PR adapter', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'get-tasks-done', 'bin', 'lib', 'orchestrate-tasks.cjs'), 'utf8');
    assert.match(source, /GhCliTaskIssueAdapter/);
    assert.match(source, /new GhCliTaskIssueAdapter\(\{ cwd, repo \}\)/);
  });
});

describe('orchestrate-tasks proactive validation', () => {
  let validationTmpDir;

  beforeEach(() => {
    validationTmpDir = createTempProject('gtd-orchestrate-validation-');
    fs.mkdirSync(path.join(validationTmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(validationTmpDir, 'src', 'module.ts'), 'export const value = 1;\n', 'utf8');
  });

  afterEach(() => {
    cleanup(validationTmpDir);
  });

  test('closing keyword scan covers title, body, commits, and squash message', () => {
    const findings = closingKeywordFindings(
      { title: 'Fixes #10', body: 'Refs #10' },
      [{ oid: 'abc', messageHeadline: 'Implement task', messageBody: 'Closes #10' }],
      { subject: 'Task', body: 'Resolves #10' },
    );

    assert.deepEqual(findings.map((finding) => finding.surface).sort(), [
      'commit_message',
      'pr_title',
      'squash_body',
    ]);
  });

  test('proactive validation reports missing CI, closing keywords, and unknown commits', () => {
    const adapter = new FakeGitHubAdapter();
    const record = {
      task_id: '01-01-T01',
      issue_number: 10,
      task: {
        name: 'Create module',
        files: ['src/module.ts'],
        validation_contract: {
          checks: [{
            id: 'scope',
            type: 'diff-scope',
            paths: { allowed: ['src/module.ts'], forbidden: [] },
          }],
        },
        acceptance_criteria: [],
      },
      plan: { source_path: '.planning/phases/01-foundation/01-01-PLAN.md' },
    };
    const pr = {
      number: 200,
      title: 'Fixes #10',
      body: 'Refs #10',
      headRefName: 'gtd/task-01-01-T01',
      baseRefName: 'gtd/orchestrate-test',
    };

    const result = proactiveValidateTaskPr(validationTmpDir, record, pr, 'gtd/orchestrate-test', adapter, {
      listPullRequestCommits: () => [{ oid: 'unknown', messageHeadline: 'Implement task', messageBody: '' }],
      listPullRequestChecks: () => [],
      requiredChecks: ['ci'],
      allowedCommitShas: ['known'],
      simulateMerge: () => ({
        ok: true,
        worktree: validationTmpDir,
        changed_files: ['src/module.ts'],
      }),
    });

    assert.equal(result.ok, false);
    const codes = result.findings.map((finding) => finding.code).sort();
    assert.deepEqual(codes, ['closing_keyword', 'github_checks_missing', 'unknown_task_branch_commit']);
    assert.match(adapter.comments.get(200)[0].body, /GTD orchestration validation failed/);
  });
});

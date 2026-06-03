// allow-test-rule: source-text-is-the-product — workflow markdown is the runtime contract.
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { buildWriteMode } = require('../get-tasks-done/bin/lib/export-phase-issues.cjs');
const {
  buildExecution,
  buildReadOnly,
  executorContext,
  GhCliTaskIssueAdapter,
  loadExecutionState,
  validateExecutorEvidence,
} = require('../get-tasks-done/bin/lib/work-task-issue.cjs');
const { cleanup, createTempGitProject, createTempProject } = require('./helpers.cjs');

function writePlan(tmpDir, phaseDir, filename, body) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), body, 'utf8');
}

function samplePlan({ plan = '01', taskNames = ['Create auth module'], verification = 'npm test' } = {}) {
  const tasks = taskNames.map((taskName, index) => {
    const file = `src/task-${index + 1}.ts`;
    return `<task type="auto">
  <name>${taskName}</name>
  <files>${file}</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only touch ${file}.</boundaries>
  <action>Create the implementation for ${taskName}.</action>
  <verify>npm test -- ${plan}-${index + 1}</verify>
  <done>${file} contains the exported implementation.</done>
  <acceptance_criteria>
    - ${file} contains the exported implementation
  </acceptance_criteria>
</task>`;
  }).join('\n');

  return `---
phase: 01-foundation
plan: ${plan}
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
Build plan ${plan}.
</objective>

<tasks>
${tasks}
</tasks>

<verification>
${verification}
</verification>

<success_criteria>
- Plan ${plan} works.
</success_criteria>
`;
}

function sampleCheckpointPlan({ plan = '01' } = {}) {
  return `---
phase: 01-foundation
plan: ${plan}
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: false
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build plan ${plan} with a human checkpoint.
</objective>

<tasks>
<task type="checkpoint:human-verify" gate="blocking">
  <name>Approve API behavior</name>
  <done>Human approval is recorded on the checkpoint issue.</done>
  <acceptance_criteria>
    - Human approval is recorded on the checkpoint issue
  </acceptance_criteria>
</task>
<task type="auto">
  <name>Create implementation after approval</name>
  <files>src/approved.ts</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only touch src/approved.ts.</boundaries>
  <action>Create the approved implementation.</action>
  <verify>npm test -- ${plan}-approved</verify>
  <done>src/approved.ts contains the approved implementation.</done>
  <acceptance_criteria>
    - src/approved.ts contains the approved implementation
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

function sampleCheckpointOnlyPlan({ plan = '01' } = {}) {
  return `---
phase: 01-foundation
plan: ${plan}
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: false
requirements: [REQ-001]
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Block execution until a human approves the dependency set.
</objective>

<tasks>
<task type="checkpoint:human-verify" gate="blocking">
  <name>Approve package set</name>
  <how-to-verify>Review the proposed package list, record the decision in GitHub, then close this issue.</how-to-verify>
  <done>Human approval is recorded on the checkpoint issue.</done>
  <acceptance_criteria>
    - Human approval is recorded on the checkpoint issue
  </acceptance_criteria>
</task>
</tasks>

<verification>
The checkpoint issue is closed with an approved package list before any executor starts ${plan}-02.
</verification>

<success_criteria>
- The package gate is closed with a vetted dependency set.
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
    this.prsByIssue = new Map();
    this.nextIssueNumber = 10;
    this.nextIssueId = 1000;
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

  addLabels(number, labels) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    const current = new Set(issue.labels.map((label) => label.name));
    for (const label of labels) current.add(label);
    issue.labels = [...current].sort().map((name) => ({ name }));
    return cloneIssue(issue);
  }

  commentIssue(number, body) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    issue.comments = [...(issue.comments || []), body];
    return { body };
  }

  listSubIssues(parentNumber) {
    const ids = this.subIssues.get(Number(parentNumber)) || new Set();
    return [...this.issues.values()]
      .filter((issue) => ids.has(issue.id))
      .map(cloneIssue);
  }

  addSubIssue(parentNumber, childIssueId) {
    const ids = this.subIssues.get(Number(parentNumber)) || new Set();
    ids.add(childIssueId);
    this.subIssues.set(Number(parentNumber), ids);
    return {};
  }

  listBlockedBy(issueNumber) {
    const ids = this.blockedBy.get(Number(issueNumber)) || new Set();
    return [...this.issues.values()]
      .filter((issue) => ids.has(issue.id))
      .map(cloneIssue);
  }

  addBlockedBy(issueNumber, blockingIssueId) {
    const ids = this.blockedBy.get(Number(issueNumber)) || new Set();
    ids.add(blockingIssueId);
    this.blockedBy.set(Number(issueNumber), ids);
    return {};
  }

  closeIssue(number) {
    const issue = this.issues.get(Number(number));
    assert.ok(issue, `missing issue #${number}`);
    issue.state = 'closed';
  }

  addPullRequest(issueNumber, pr) {
    const prs = this.prsByIssue.get(Number(issueNumber)) || [];
    prs.push(pr);
    this.prsByIssue.set(Number(issueNumber), prs);
  }

  listPullRequestsForIssue(issueNumber) {
    return [...(this.prsByIssue.get(Number(issueNumber)) || [])];
  }

  listPullRequestFeedback(prNumber) {
    return this.feedbackByPr?.get(Number(prNumber)) || [];
  }

  addPullRequestFeedback(prNumber, feedback) {
    if (!this.feedbackByPr) this.feedbackByPr = new Map();
    this.feedbackByPr.set(Number(prNumber), feedback);
  }

  createPullRequest({ title, body, head, base, draft, labels }) {
    const number = this.nextPrNumber || 100;
    this.nextPrNumber = number + 1;
    const pr = {
      number,
      title,
      body,
      state: 'OPEN',
      isDraft: Boolean(draft),
      headRefName: head,
      baseRefName: base,
      url: `https://github.com/owner/repo/pull/${number}`,
      labels: labels || [],
    };
    const issueMatch = body.match(/#(\d+)/) || title.match(/#(\d+)/);
    if (issueMatch) this.addPullRequest(Number(issueMatch[1]), pr);
    this.lastCreatedPr = pr;
    return { ...pr };
  }

  updatePullRequest(number, patch) {
    for (const [issue, prs] of this.prsByIssue.entries()) {
      const index = prs.findIndex((pr) => Number(pr.number) === Number(number));
      if (index !== -1) {
        prs[index] = {
          ...prs[index],
          title: patch.title,
          body: patch.body,
          isDraft: Boolean(patch.draft),
          labels: patch.labels || [],
          state: 'OPEN',
        };
        this.prsByIssue.set(issue, prs);
        this.lastUpdatedPr = prs[index];
        return { ...prs[index] };
      }
    }
    throw new Error(`missing PR #${number}`);
  }

  reopenPullRequest(number) {
    for (const prs of this.prsByIssue.values()) {
      const pr = prs.find((candidate) => Number(candidate.number) === Number(number));
      if (pr) {
        pr.state = 'OPEN';
        return { ...pr };
      }
    }
    throw new Error(`missing PR #${number}`);
  }
}

function exportSample(tmpDir, adapter, taskNames = ['Create auth module'], planOptions = {}) {
  writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({ taskNames, ...planOptions }));
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json'), 'utf8'));
}

function markSampleTaskMerged(adapter, manifest) {
  const parentIssue = manifest.plans['01-01'].issue;
  const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
  adapter.closeIssue(childIssue);
  adapter.addPullRequest(childIssue, {
    number: 94,
    title: 'Merged task PR',
    state: 'CLOSED',
    mergedAt: '2026-05-17T10:00:00Z',
    headRefName: `gtd/task-01-01-T01-${childIssue}`,
    url: 'https://github.com/owner/repo/pull/94',
  });
  return { parentIssue, childIssue };
}

function executeSampleReconciliation(tmpDir, adapter, parentIssue, deps = {}) {
  return buildExecution(tmpDir, {
    selector: String(parentIssue),
    phase: '01',
    repo: 'owner/repo',
    mode: 'execute',
    reconcile: true,
  }, adapter, {
    ensureReconciliationWorktree: ({ record }) => ({
      path: tmpDir,
      branch: record.branch_name,
      base_ref: 'origin/main',
      reused: false,
    }),
    runGtdSdkQuery: () => ({ ok: true, status: 0, command: 'query', stdout: '{}', stderr: '' }),
    commitReconciliationArtifacts: (worktree, record, summary) => ({
      committed: true,
      pushed: true,
      files: [summary.path, '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'],
      message: `Reconcile GTD plan ${record.plan_id}`,
    }),
    now: () => new Date('2026-05-17T12:00:00Z'),
    ...deps,
  });
}

function exportCheckpointSample(tmpDir, adapter) {
  writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', sampleCheckpointPlan());
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json'), 'utf8'));
}

function exportCheckpointOnlySample(tmpDir, adapter) {
  writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', sampleCheckpointOnlyPlan());
  const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
  assert.equal(result.ok, true);
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json'), 'utf8'));
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

describe('work-task-issue read-only mode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gtd-work-task-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('explains that an explicit canonical task id is workable without creating implementation work', () => {
    const adapter = new FakeGitHubAdapter();
    exportSample(tmpDir, adapter);

    const result = buildReadOnly(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'read-only');
    assert.equal(result.writes, false);
    assert.equal(result.implementation, false);
    assert.equal(result.pr_creation, false);
    assert.equal(result.action, 'report_workable_task');
    assert.equal(result.selected.task_id, '01-01-T01');
    assert.equal(result.selected.workability.workable, true);
  });

  test('infers repo from git config for legacy manifests without repo metadata', () => {
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/davide-troiani/my-project.git', { cwd: tmpDir, stdio: 'pipe' });
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    delete manifest.repo;
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const result = buildReadOnly(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: null,
    }, adapter);

    assert.equal(result.ok, true);
    assert.equal(result.scope[0].repo, 'davide-troiani/my-project');
    assert.equal(result.action, 'report_workable_task');
  });

  test('automatic mode selects the next ready task after read-only state sync sees a closed blocker', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create first module', 'Create second module']);
    const firstTaskIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const secondTaskIssue = manifest.plans['01-01'].tasks['01-01-T02'].issue;
    adapter.closeIssue(firstTaskIssue);

    const result = buildReadOnly(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.action, 'report_next_actionable_task');
    assert.equal(result.selected.issue, secondTaskIssue);
    assert.equal(result.selected.task_id, '01-01-T02');
    assert.equal(result.selected.workability.workable, true);

    const labelAction = result.preflight.label_actions.find((action) => action.issue === secondTaskIssue);
    assert.ok(labelAction, 'expected read-only label normalization report for second task');
    assert.deepEqual(labelAction.add, ['gtd:ready']);
    assert.deepEqual(labelAction.remove, ['gtd:blocked']);
  });

  test('open checkpoint issue is not selected and keeps dependent implementation tasks blocked', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportCheckpointSample(tmpDir, adapter);
    const checkpointIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const implementationIssue = manifest.plans['01-01'].tasks['01-01-T02'].issue;

    const result = buildReadOnly(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.action, 'report_blocking_state');
    assert.equal(result.selected, null);
    const checkpoint = result.blocking_state.non_workable_tasks.find((task) => task.task_id === '01-01-T01');
    const implementation = result.blocking_state.non_workable_tasks.find((task) => task.task_id === '01-01-T02');
    assert.equal(checkpoint.issue, checkpointIssue);
    assert.equal(
      checkpoint.reasons.some((reason) => reason.code === 'checkpoint_human_resolution'),
      true,
    );
    assert.equal(implementation.issue, implementationIssue);
    assert.deepEqual(implementation.blockers.task, [checkpointIssue]);
    assert.equal(
      implementation.reasons.some((reason) => reason.code === 'open_task_blockers'),
      true,
    );
  });

  test('explicit checkpoint selector reports a human-resolution blocker and never executes', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportCheckpointSample(tmpDir, adapter);
    const checkpointIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: () => {
        throw new Error('checkpoint tasks must not create task worktrees');
      },
    });

    assert.equal(result.action, 'report_unworkable_task');
    assert.equal(result.implementation, false);
    assert.equal(result.selected.issue, checkpointIssue);
    assert.equal(result.selected.workability.workable, false);
    assert.equal(
      result.selected.workability.reasons.some((reason) => reason.code === 'checkpoint_human_resolution'),
      true,
    );
  });

  test('closed checkpoint issue syncs labels and manifest checkpointStatus to checkpoint_resolved', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportCheckpointSample(tmpDir, adapter);
    const checkpointIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.closeIssue(checkpointIssue);

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter);

    assert.equal(result.action, 'report_unworkable_task');
    assert.equal(result.selected.checkpoint_resolved, true);
    assert.equal(result.selected.manifest_export_status, 'complete');
    assert.equal(result.selected.checkpoint_status, 'checkpoint_resolved');
    const syncOp = result.preflight.label_sync.find((op) => op.op === 'sync_checkpoint_manifest_status' && op.task_id === '01-01-T01');
    assert.ok(syncOp);
    assert.equal(syncOp.checkpointStatus, 'checkpoint_resolved');

    const labels = adapter.getIssue(checkpointIssue).labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:checkpoint-resolved'), true);
    assert.equal(labels.includes('gtd:blocked'), false);
    assert.equal(labels.includes('gtd:blocked-human'), false);

    const synced = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json'), 'utf8'));
    assert.equal(synced.plans['01-01'].tasks['01-01-T01'].exportStatus, 'complete');
    assert.equal(synced.plans['01-01'].tasks['01-01-T01'].checkpointStatus, 'checkpoint_resolved');
    assert.equal(Object.prototype.hasOwnProperty.call(synced.plans['01-01'].tasks['01-01-T01'], 'status'), false);
  });

  test('automatic mode stops at a reconciliation permission request when all child PRs merged', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 42,
      title: 'Implement task',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/42',
      reviewDecision: 'APPROVED',
    });

    const result = buildReadOnly(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.action, 'request_reconciliation_permission');
    assert.equal(result.selected.kind, 'parent_plan');
    assert.equal(result.selected.reconciliation.ready, true);
    assert.equal(result.selected.reconciliation.permission_required, true);
    assert.equal(result.selected.reconciliation.child_tasks[0].merged_prs[0].number, 42);
    assert.equal(result.selected.reconciliation.proposed_branch, 'gtd/reconcile-01-01-10');
  });

  test('explicit issue mode reports open dependency blockers', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create first module', 'Create second module']);
    const secondTaskIssue = manifest.plans['01-01'].tasks['01-01-T02'].issue;

    const result = buildReadOnly(tmpDir, {
      selector: String(secondTaskIssue),
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.action, 'report_unworkable_task');
    assert.equal(result.selected.issue, secondTaskIssue);
    assert.equal(result.selected.workability.workable, false);
    assert.equal(
      result.selected.workability.reasons.some((reason) => reason.code === 'open_task_blockers'),
      true,
    );
  });

  test('execution mode claims a ready task, validates it, and opens a ready PR that closes only the child issue', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    let executorContext = null;

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runTaskExecutor: (context) => {
        executorContext = context;
        return { ok: true, notes: 'Implemented the task.' };
      },
      listChangedFiles: () => ['src/task-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: () => validExecutorEvidence(),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      now: () => new Date('2026-05-17T12:00:00Z'),
    });

    assert.equal(result.action, 'ready_pr_opened_or_updated');
    assert.equal(result.implementation, true);
    assert.equal(result.pr_creation, true);
    assert.equal(result.execution.executor_evidence.ok, true);
    assert.equal(result.execution.validation.ok, true);
    assert.equal(result.execution.pr.isDraft, false);
    assert.match(result.execution.pr.body, new RegExp(`Closes #${childIssue}`));
    assert.doesNotMatch(result.execution.pr.body, /Closes #\d+.*Closes #\d+/s);
    assert.equal(executorContext.task_id, '01-01-T01');
    assert.equal(executorContext.issue.number, childIssue);
    assert.deepEqual(executorContext.write_scope.allowed, ['src/task-1.ts']);

    const issue = adapter.getIssue(childIssue);
    const labels = issue.labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:pr-open'), true);
    assert.equal(labels.includes('gtd:in-progress'), false);
    assert.equal(labels.includes('gtd:validation-failed'), false);
    assert.equal(issue.comments.some((comment) => comment.includes('GTD task execution claim at 2026-05-17T12:00:00.000Z')), true);
  });

  test('execution mode opens a draft PR without a closing keyword when useful work still fails validation', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runTaskExecutor: () => ({ ok: true, notes: 'Partial implementation.' }),
      listChangedFiles: () => ['src/task-1.ts'],
      runCommand: () => ({ status: 1, stdout: '', stderr: 'failed' }),
      validateExecutorEvidence: () => validExecutorEvidence(),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
      retryBudget: 0,
    });

    assert.equal(result.action, 'draft_pr_opened_or_updated');
    assert.equal(result.execution.executor_evidence.ok, true);
    assert.equal(result.execution.validation.ok, false);
    assert.equal(result.execution.pr.isDraft, true);
    assert.doesNotMatch(result.execution.pr.body, /Closes #/);
    const labels = adapter.getIssue(childIssue).labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:validation-failed'), true);
    assert.equal(labels.includes('gtd:pr-open'), true);
  });

  test('execution mode opens no PR when executor commit evidence is invalid even if validation passes', () => {
    const adapter = new FakeGitHubAdapter();
    exportSample(tmpDir, adapter);
    let pushed = false;

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runTaskExecutor: () => ({ ok: true, notes: 'Implemented without commit evidence.' }),
      listChangedFiles: () => ['src/task-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: () => ({
        ...validExecutorEvidence(null),
        ok: false,
        commit: null,
        reachable_commit: false,
        committed_diff: false,
        reasons: [{
          code: 'missing_executor_commit',
          message: 'Executor did not return a commit hash.',
        }],
      }),
      pushBranch: () => {
        pushed = true;
        throw new Error('invalid evidence must not push');
      },
    });

    assert.equal(result.action, 'validation_failed_no_pr');
    assert.equal(result.pr_creation, false);
    assert.equal(result.execution.pr, null);
    assert.equal(result.execution.executor_evidence.ok, false);
    assert.equal(result.execution.executor_evidence.reasons[0].code, 'missing_executor_commit');
    assert.equal(pushed, false);
    assert.equal(adapter.lastCreatedPr, undefined);
  });

  test('execution mode treats executor blockers as invalid evidence and opens no PR', () => {
    const adapter = new FakeGitHubAdapter();
    exportSample(tmpDir, adapter);

    const result = buildExecution(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runTaskExecutor: () => ({
        ok: true,
        blockers: ['Waiting for API credentials'],
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
      }),
      listChangedFiles: () => ['src/task-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: ({ executorResult }) => ({
        ...validExecutorEvidence(executorResult.commit),
        ok: false,
        blockers: executorResult.blockers,
        reasons: [{
          code: 'executor_blockers',
          message: 'Executor reported blocker(s): Waiting for API credentials',
          blockers: executorResult.blockers,
        }],
      }),
      pushBranch: () => {
        throw new Error('blocked evidence must not push');
      },
    });

    assert.equal(result.action, 'validation_failed_no_pr');
    assert.equal(result.execution.pr, null);
    assert.equal(result.execution.executor_evidence.ok, false);
    assert.equal(result.execution.executor_evidence.reasons[0].code, 'executor_blockers');
    assert.equal(adapter.lastCreatedPr, undefined);
  });

  test('executor evidence validator verifies reachable commit diff and clean worktree', () => {
    const gitDir = createTempGitProject('gtd-task-evidence-');
    try {
      fs.mkdirSync(path.join(gitDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'src', 'evidence.ts'), 'export const evidence = true;\n', 'utf8');
      execSync('git add src/evidence.ts', { cwd: gitDir, stdio: 'pipe' });
      execSync('git commit -m "test: executor evidence"', { cwd: gitDir, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', { cwd: gitDir, encoding: 'utf8' }).trim();

      const evidence = validateExecutorEvidence(
        { path: gitDir, branch: 'gtd/task-test', base_ref: 'HEAD~1' },
        { ok: true, commit },
      );

      assert.equal(evidence.ok, true);
      assert.equal(evidence.reachable_commit, true);
      assert.equal(evidence.committed_diff, true);
      assert.equal(evidence.clean_worktree, true);

      fs.writeFileSync(path.join(gitDir, 'src', 'leftover.ts'), 'export const leftover = true;\n', 'utf8');
      const dirty = validateExecutorEvidence(
        { path: gitDir, branch: 'gtd/task-test', base_ref: 'HEAD~1' },
        { ok: true, commit },
      );

      assert.equal(dirty.ok, false);
      assert.equal(
        dirty.reasons.some((reason) => reason.code === 'dirty_task_worktree_after_executor'),
        true,
      );
    } finally {
      cleanup(gitDir);
    }
  });

  test('execution mode resumes a PR with requested changes on the same branch and includes review feedback', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.addPullRequest(childIssue, {
      number: 77,
      title: 'Existing task PR',
      state: 'OPEN',
      isDraft: false,
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/77',
      reviewDecision: 'CHANGES_REQUESTED',
      body: `Closes #${childIssue}`,
    });
    adapter.addPullRequestFeedback(77, [{
      kind: 'review_comment',
      author: 'reviewer',
      body: 'Please cover the edge case.',
      path: 'src/task-1.ts',
      line: 10,
    }]);
    let feedbackSeen = null;

    const result = buildExecution(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: true,
      }),
      runTaskExecutor: (context) => {
        feedbackSeen = context.review_feedback;
        return { ok: true, notes: 'Addressed feedback.' };
      },
      listChangedFiles: () => ['src/task-1.ts'],
      runCommand: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      validateExecutorEvidence: () => validExecutorEvidence(),
      pushBranch: (worktree) => ({ pushed: true, branch: worktree.branch }),
    });

    assert.equal(result.action, 'ready_pr_opened_or_updated');
    assert.equal(adapter.lastUpdatedPr.number, 77);
    assert.equal(adapter.lastCreatedPr, undefined);
    assert.equal(feedbackSeen[0].body, 'Please cover the edge case.');
    const labels = adapter.getIssue(childIssue).labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:needs-rework'), false);
    assert.equal(labels.includes('gtd:pr-open'), true);
  });

  test('execution mode syncs merged task PR state back to the child issue before selecting new work', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.addPullRequest(childIssue, {
      number: 88,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/88',
      reviewDecision: 'APPROVED',
      body: `Closes #${childIssue}`,
    });

    const result = buildExecution(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: () => {
        throw new Error('should not create a worktree for merged work');
      },
    });

    assert.equal(result.implementation, false);
    const issue = adapter.getIssue(childIssue);
    assert.equal(issue.state, 'closed');
    const labels = issue.labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:merged'), true);
    assert.equal(labels.includes('gtd:pr-open'), false);
    assert.equal(result.preflight.label_sync.some((op) => op.op === 'close_merged_task_issue'), true);
  });

  test('read-only reconciliation preview resolves parent plan selectors', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const parentIssue = manifest.plans['01-01'].issue;
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 91,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/91',
    });

    const byPlanId = buildReadOnly(tmpDir, {
      selector: '01-01',
      phase: '01',
      repo: 'owner/repo',
      reconcile: true,
    }, adapter);
    const byParentIssue = buildReadOnly(tmpDir, {
      selector: String(parentIssue),
      phase: '01',
      repo: 'owner/repo',
      reconcile: true,
    }, adapter);

    assert.equal(byPlanId.action, 'preview_reconciliation_ready');
    assert.equal(byPlanId.selected.kind, 'parent_plan');
    assert.equal(byPlanId.selected.issue, parentIssue);
    assert.equal(byPlanId.selected.reconciliation.ready, true);
    assert.equal(byParentIssue.selected.plan_id, '01-01');
  });

  test('parent reconciliation treats closed checkpoint issues as resolved without merged task PRs', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportCheckpointSample(tmpDir, adapter);
    const checkpointIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const implementationIssue = manifest.plans['01-01'].tasks['01-01-T02'].issue;
    adapter.closeIssue(checkpointIssue);
    adapter.closeIssue(implementationIssue);
    adapter.addPullRequest(implementationIssue, {
      number: 96,
      title: 'Merged implementation PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T02-${implementationIssue}`,
      url: 'https://github.com/owner/repo/pull/96',
    });

    const result = buildReadOnly(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
    }, adapter);

    assert.equal(result.action, 'request_reconciliation_permission');
    assert.equal(result.selected.kind, 'parent_plan');
    assert.equal(result.selected.reconciliation.ready, true);
    assert.equal(
      result.selected.reconciliation.reasons.some((reason) => reason.code === 'child_pr_not_merged'),
      false,
    );
    const checkpoint = result.selected.reconciliation.child_tasks.find((task) => task.task_id === '01-01-T01');
    assert.equal(checkpoint.checkpoint_resolved, true);
    assert.deepEqual(checkpoint.merged_prs, []);
  });

  test('task executor context marks checkpoint tasks as non-editable human checkpoints', () => {
    const adapter = new FakeGitHubAdapter();
    exportCheckpointSample(tmpDir, adapter);
    const state = loadExecutionState(tmpDir, {
      selector: '01-01-T01',
      phase: '01',
      repo: 'owner/repo',
    }, adapter);
    const checkpointRecord = state.records.tasks.find((task) => task.task_id === '01-01-T01');

    const context = executorContext(checkpointRecord, {
      path: tmpDir,
      branch: checkpointRecord.branch_name,
      base_ref: 'origin/main',
      reused: false,
    });

    assert.equal(context.is_checkpoint, true);
    assert.equal(context.task_type, 'checkpoint:human-verify');
    assert.match(context.prompt, /Stop without editing files/);
    assert.match(context.prompt, /requires human resolution/);
  });

  test('reconciliation blocks on parent source drift before writing canonical artifacts', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 92,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/92',
    });
    fs.appendFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-PLAN.md'), '\n<!-- drift -->\n');

    const result = buildReadOnly(tmpDir, {
      selector: '01-01',
      phase: '01',
      repo: 'owner/repo',
      reconcile: true,
    }, adapter);

    assert.equal(result.action, 'report_unworkable_reconciliation');
    assert.equal(result.selected.reconciliation.ready, false);
    assert.equal(
      result.selected.reconciliation.reasons.some((reason) => reason.code === 'parent_source_drift'),
      true,
    );
  });

  test('successful reconciliation writes summary, runs canonical state commands, and opens parent PR', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const parentIssue = manifest.plans['01-01'].issue;
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const sdkCalls = [];
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 93,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/93',
    });

    const result = buildExecution(tmpDir, {
      selector: '01-01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
      reconcile: true,
    }, adapter, {
      ensureReconciliationWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runPlanVerification: () => ({
        ok: true,
        skipped: false,
        command: 'npm test',
        status: 0,
        stdout: 'ok',
        stderr: '',
      }),
      runGtdSdkQuery: (args) => {
        sdkCalls.push(args);
        return { ok: true, status: 0, command: args.join(' '), stdout: '{}', stderr: '' };
      },
      commitReconciliationArtifacts: (worktree, record, summary) => ({
        committed: true,
        pushed: true,
        files: [summary.path, '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'],
        message: `Reconcile GTD plan ${record.plan_id}`,
      }),
      now: () => new Date('2026-05-17T12:00:00Z'),
    });

    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md');
    const summary = fs.readFileSync(summaryPath, 'utf8');
    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.equal(result.execution.summary.path, '.planning/phases/01-foundation/01-01-SUMMARY.md');
    assert.match(summary, /requirements-completed: \[REQ-001\]/);
    assert.match(summary, /Task issue #\d+|task issue #\d+/i);
    assert.equal(sdkCalls.some((args) => args[0] === 'state.advance-plan'), true);
    assert.equal(sdkCalls.some((args) => args[0] === 'roadmap.update-plan-progress'), true);
    assert.equal(sdkCalls.some((args) => args[0] === 'requirements.mark-complete' && args.includes('REQ-001')), true);
    assert.equal(adapter.lastCreatedPr.title, '[GTD 01-01] Reconcile completed task issues');
    assert.match(adapter.lastCreatedPr.body, new RegExp(`Closes #${parentIssue}`));
    assert.doesNotMatch(adapter.lastCreatedPr.body, new RegExp(`Closes #${childIssue}`));
    const parentLabels = adapter.getIssue(parentIssue).labels.map((label) => label.name);
    assert.equal(parentLabels.includes('gtd:reconcile-pr-open'), true);
  });

  test('checkpoint-only reconciliation treats closed checkpoint issue as plan verification evidence', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportCheckpointOnlySample(tmpDir, adapter);
    const parentIssue = manifest.plans['01-01'].issue;
    const checkpointIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const sdkCalls = [];
    let shellInvoked = false;

    adapter.closeIssue(checkpointIssue);

    const result = buildExecution(tmpDir, {
      selector: '01-01',
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
      reconcile: true,
    }, adapter, {
      ensureReconciliationWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runCommand: () => {
        shellInvoked = true;
        throw new Error('checkpoint-only plan verification prose must not run as a shell command');
      },
      runGtdSdkQuery: (args) => {
        sdkCalls.push(args);
        return { ok: true, status: 0, command: args.join(' '), stdout: '{}', stderr: '' };
      },
      commitReconciliationArtifacts: (worktree, record, summary) => ({
        committed: true,
        pushed: true,
        files: [summary.path, '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'],
        message: `Reconcile GTD plan ${record.plan_id}`,
      }),
      now: () => new Date('2026-05-17T12:00:00Z'),
    });

    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md');
    const summary = fs.readFileSync(summaryPath, 'utf8');
    const labels = adapter.getIssue(parentIssue).labels.map((label) => label.name);

    assert.equal(shellInvoked, false);
    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.equal(result.execution.verification.ok, true);
    assert.equal(result.execution.verification.skipped, true);
    assert.equal(result.execution.verification.skip_reason, 'resolved_human_checkpoint_only_plan');
    assert.equal(result.execution.verification.command, '');
    assert.match(result.execution.verification.declared_verification, /checkpoint issue is closed/);
    assert.equal(fs.existsSync(summaryPath), true);
    assert.match(summary, /Command: not run \(resolved human checkpoint-only plan\)/);
    assert.match(summary, /Declared verification: The checkpoint issue is closed/);
    assert.match(summary, /resolved checkpoint issue closure satisfied plan verification/);
    assert.match(adapter.lastCreatedPr.body, /Command: not run \(resolved human checkpoint-only plan\)/);
    assert.equal(sdkCalls.some((args) => args[0] === 'state.advance-plan'), true);
    assert.equal(labels.includes('gtd:reconcile-failed'), false);
    assert.equal(labels.includes('gtd:reconcile-pr-open'), true);
  });

  test('parent reconciliation skips prose plan verification without executing inline snippets', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create auth module'], {
      verification: 'Run `npx tsc --noEmit --pretty false` after the scaffold task. Plan 02 creates all Wave 0 test files before implementation begins.',
    });
    const { parentIssue } = markSampleTaskMerged(adapter, manifest);
    let shellInvoked = false;

    const result = executeSampleReconciliation(tmpDir, adapter, parentIssue, {
      runCommand: () => {
        shellInvoked = true;
        throw new Error('prose plan verification must not run as a shell command');
      },
    });

    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md');
    const summary = fs.readFileSync(summaryPath, 'utf8');
    const labels = adapter.getIssue(parentIssue).labels.map((label) => label.name);

    assert.equal(shellInvoked, false);
    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.equal(result.execution.verification.ok, true);
    assert.equal(result.execution.verification.skipped, true);
    assert.equal(result.execution.verification.skip_reason, 'non_executable_plan_verification');
    assert.equal(result.execution.verification.command, '');
    assert.match(result.execution.verification.declared_verification, /npx tsc --noEmit --pretty false/);
    assert.match(summary, /Command: not run \(non-executable declared verification\)/);
    assert.match(summary, /Declared verification: Run `npx tsc --noEmit --pretty false` after the scaffold task/);
    assert.match(summary, /declared plan verification was not an executable command and was skipped/);
    assert.match(adapter.lastCreatedPr.body, /Command: not run \(non-executable declared verification\)/);
    assert.equal(labels.includes('gtd:reconcile-failed'), false);
    assert.equal(labels.includes('gtd:reconcile-pr-open'), true);
  });

  test('parent reconciliation executes automated plan verification blocks', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create auth module'], {
      verification: '<automated>npx tsc --noEmit --pretty false</automated>',
    });
    const { parentIssue } = markSampleTaskMerged(adapter, manifest);
    const commands = [];

    const result = executeSampleReconciliation(tmpDir, adapter, parentIssue, {
      runCommand: (command) => {
        commands.push(command);
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.deepEqual(commands, ['npx tsc --noEmit --pretty false']);
    assert.equal(result.execution.verification.skipped, false);
    assert.equal(result.execution.verification.command, 'npx tsc --noEmit --pretty false');
    assert.match(result.execution.verification.declared_verification, /<automated>/);
  });

  test('parent reconciliation executes fenced shell plan verification blocks', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create auth module'], {
      verification: '```bash\nnpx tsc --noEmit --pretty false\n```',
    });
    const { parentIssue } = markSampleTaskMerged(adapter, manifest);
    const commands = [];

    const result = executeSampleReconciliation(tmpDir, adapter, parentIssue, {
      runCommand: (command) => {
        commands.push(command);
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.deepEqual(commands, ['npx tsc --noEmit --pretty false']);
    assert.equal(result.execution.verification.skipped, false);
    assert.equal(result.execution.verification.command, 'npx tsc --noEmit --pretty false');
    assert.match(result.execution.verification.declared_verification, /```bash/);
  });

  test('parent reconciliation preserves legacy bare plan verification commands', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter, ['Create auth module'], {
      verification: 'npm test',
    });
    const { parentIssue } = markSampleTaskMerged(adapter, manifest);
    const commands = [];

    const result = executeSampleReconciliation(tmpDir, adapter, parentIssue, {
      runCommand: (command) => {
        commands.push(command);
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.action, 'reconciliation_pr_opened');
    assert.deepEqual(commands, ['npm test']);
    assert.equal(result.execution.verification.skipped, false);
    assert.equal(result.execution.verification.command, 'npm test');
    assert.equal(result.execution.verification.declared_verification, 'npm test');
  });

  test('failed plan verification marks reconciliation failed without canonical writes', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const parentIssue = manifest.plans['01-01'].issue;
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    const sdkCalls = [];
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 94,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/94',
    });

    const result = buildExecution(tmpDir, {
      selector: String(parentIssue),
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
      reconcile: true,
    }, adapter, {
      ensureReconciliationWorktree: ({ record }) => ({
        path: tmpDir,
        branch: record.branch_name,
        base_ref: 'origin/main',
        reused: false,
      }),
      runPlanVerification: () => ({
        ok: false,
        skipped: false,
        command: 'npm test',
        status: 1,
        stdout: '',
        stderr: 'boom',
      }),
      runGtdSdkQuery: (args) => {
        sdkCalls.push(args);
        return { ok: true, status: 0, command: args.join(' '), stdout: '{}', stderr: '' };
      },
    });

    assert.equal(result.action, 'reconciliation_verification_failed');
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md')), false);
    assert.deepEqual(sdkCalls, []);
    assert.equal(adapter.lastCreatedPr, undefined);
    const issue = adapter.getIssue(parentIssue);
    const labels = issue.labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:reconcile-failed'), true);
    assert.equal(issue.comments.some((comment) => comment.includes('Canonical GTD state was not updated')), true);
  });

  test('execution mode syncs merged reconciliation PR state back to the parent issue', () => {
    const adapter = new FakeGitHubAdapter();
    const manifest = exportSample(tmpDir, adapter);
    const parentIssue = manifest.plans['01-01'].issue;
    const childIssue = manifest.plans['01-01'].tasks['01-01-T01'].issue;
    adapter.closeIssue(childIssue);
    adapter.addPullRequest(childIssue, {
      number: 95,
      title: 'Merged task PR',
      state: 'CLOSED',
      mergedAt: '2026-05-17T10:00:00Z',
      headRefName: `gtd/task-01-01-T01-${childIssue}`,
      url: 'https://github.com/owner/repo/pull/95',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    adapter.addPullRequest(parentIssue, {
      number: 196,
      title: '[GTD 01-01] Reconcile completed task issues',
      state: 'CLOSED',
      mergedAt: '2026-05-17T11:00:00Z',
      headRefName: `gtd/reconcile-01-01-${parentIssue}`,
      url: 'https://github.com/owner/repo/pull/196',
      body: `Closes #${parentIssue}`,
    });

    const result = buildExecution(tmpDir, {
      selector: null,
      phase: '01',
      repo: 'owner/repo',
      mode: 'execute',
    }, adapter, {
      ensureTaskWorktree: () => {
        throw new Error('should not create task worktree after reconciliation merge');
      },
    });

    assert.equal(result.preflight.label_sync.some((op) => op.op === 'close_reconciled_parent_issue'), true);
    const parent = adapter.getIssue(parentIssue);
    assert.equal(parent.state, 'closed');
    const labels = parent.labels.map((label) => label.name);
    assert.equal(labels.includes('gtd:complete'), true);
    assert.equal(labels.includes('gtd:ready-for-reconcile'), false);
  });

  test('complete-phase helper blocks until every exported plan has a summary', () => {
    const adapter = new FakeGitHubAdapter();
    exportSample(tmpDir, adapter);

    const blocked = buildReadOnly(tmpDir, {
      selector: null,
      phase: null,
      repo: 'owner/repo',
      completePhase: '01',
    }, adapter);

    assert.equal(blocked.action, 'phase_completion_blocked_missing_summaries');
    assert.equal(blocked.phase_completion.ready, false);
    assert.deepEqual(blocked.phase_completion.missing_summaries.map((plan) => plan.plan_id), ['01-01']);

    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md'), '# Summary\n');
    const ready = buildReadOnly(tmpDir, {
      selector: null,
      phase: null,
      repo: 'owner/repo',
      completePhase: '01',
    }, adapter);

    assert.equal(ready.action, 'preview_phase_completion_finalization');
    assert.equal(ready.phase_completion.ready, true);
    assert.equal(ready.phase_completion.required_gates.includes('gtd-verifier'), true);
    assert.equal(ready.phase_completion.finalization_scope, 'post_phase_gates_only');
    assert.match(ready.phase_completion.finalization_command, /work-task-issue --complete-phase 01 --execute/);
    assert.match(ready.phase_completion.next_verify_work_command, /gtd-verify-work 01$/);
  });

  test('complete-phase execute mode runs only finalization after summaries exist', () => {
    const adapter = new FakeGitHubAdapter();
    exportSample(tmpDir, adapter);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md'), '# Summary\n');

    let implementationSelectionInvoked = false;
    let finalizationStatus = null;
    const result = buildExecution(tmpDir, {
      selector: null,
      phase: null,
      repo: 'owner/repo',
      mode: 'execute',
      completePhase: '01',
    }, () => {
      implementationSelectionInvoked = true;
      throw new Error('complete-phase must not load implementation selection state');
    }, {
      runPhaseFinalization: (cwd, status) => {
        finalizationStatus = { cwd, status };
        return {
          writes: true,
          action: 'phase_completion_finalization_executed',
          gates_run: status.required_gates,
        };
      },
      ensureTaskWorktree: () => {
        throw new Error('complete-phase must not create task worktrees');
      },
      runTaskExecutor: () => {
        throw new Error('complete-phase must not invoke task executor');
      },
    });

    assert.equal(result.action, 'phase_completion_finalization_executed');
    assert.equal(result.writes, true);
    assert.equal(result.implementation, false);
    assert.equal(result.pr_creation, false);
    assert.equal(implementationSelectionInvoked, false);
    assert.equal(finalizationStatus.cwd, tmpDir);
    assert.equal(finalizationStatus.status.finalization_scope, 'post_phase_gates_only');
    assert.deepEqual(finalizationStatus.status.required_gates, [
      'code-review',
      'regression',
      'schema-drift',
      'codebase-drift',
      'gtd-verifier',
      'phase.complete',
    ]);
  });
});

describe('work-task-issue PR body safety', () => {
  test('workflow requires body-file PR writes and body readback sanity check', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'work-task-issue.md'),
      'utf8'
    );

    assert.ok(workflow.includes('gh pr create --body-file "$PR_BODY_FILE"'));
    assert.ok(workflow.includes('gh pr edit "$PR_NUMBER" --body-file "$PR_BODY_FILE"'));
    assert.match(workflow, /do\s+not use `gh pr create --body "\.\.\."`/);
    assert.ok(workflow.includes('gh pr view "$PR_NUMBER_OR_URL" --json body --jq .body'));
    assert.ok(workflow.includes('lone `\\` placeholder'));
  });

  test('GitHub CLI adapter writes PR markdown through --body-file', () => {
    class RecordingAdapter extends GhCliTaskIssueAdapter {
      constructor() {
        super({ cwd: process.cwd(), repo: 'owner/repo' });
        this.calls = [];
        this.capturedBodies = [];
      }

      runGh(args) {
        this.calls.push(args);
        assert.equal(args.includes('--body'), false, `inline --body is unsafe: ${args.join(' ')}`);
        const bodyFileIdx = args.indexOf('--body-file');
        if (bodyFileIdx !== -1) {
          this.capturedBodies.push(fs.readFileSync(args[bodyFileIdx + 1], 'utf8'));
        }
        return 'https://github.com/owner/repo/pull/123';
      }

      viewPullRequest(ref) {
        return {
          number: 123,
          title: 'Task PR',
          body: this.capturedBodies[this.capturedBodies.length - 1],
          state: 'OPEN',
          isDraft: false,
          url: String(ref).startsWith('http') ? ref : `https://github.com/owner/repo/pull/${ref}`,
        };
      }
    }

    const adapter = new RecordingAdapter();
    const body = [
      '## Task',
      '- Task ID: `01-01-T01`',
      '- Source plan: `.planning/phases/01/01-01-PLAN.md`',
      '- Literal shell chars: `$VALUE` and \\ stay intact',
    ].join('\n');

    adapter.createPullRequest({
      title: 'Task PR',
      body,
      head: 'gtd/task-01-01-T01-18',
      base: 'main',
      draft: false,
      labels: [],
    });
    adapter.updatePullRequest(123, {
      title: 'Task PR',
      body,
      draft: false,
      labels: [],
    });

    assert.equal(adapter.capturedBodies.length, 2);
    assert.deepEqual(adapter.capturedBodies, [body, body]);
    assert.ok(adapter.calls.some((args) => args[0] === 'pr' && args[1] === 'create' && args.includes('--body-file')));
    assert.ok(adapter.calls.some((args) => args[0] === 'pr' && args[1] === 'edit' && args.includes('--body-file')));
  });
});

describe('work-task-issue complete-phase public contract', () => {
  test('workflow and help route completion through work-task-issue complete-phase execute mode', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'work-task-issue.md'),
      'utf8'
    );
    const help = fs.readFileSync(
      path.join(__dirname, '..', 'get-tasks-done', 'workflows', 'help', 'modes', 'full.md'),
      'utf8'
    );
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const commands = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMMANDS.md'), 'utf8');
    const taskIssueOperatorGuide = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'task-issue-operator-guide.md'),
      'utf8'
    );
    const surfaces = {
      workflow,
      help,
      readme,
      commands,
      taskIssueOperatorGuide,
    };
    const combined = Object.values(surfaces).join('\n');

    for (const [name, content] of Object.entries(surfaces)) {
      assert.match(
        content,
        /work-task-issue --complete-phase <phase> --execute/,
        `${name} should mention work-task-issue --complete-phase <phase> --execute`,
      );
    }
    assert.doesNotMatch(combined, /Run the gtd-work-task-issue end-of-phase tail/);
    assert.doesNotMatch(workflow, /run the end-of-phase tail\s+from `gtd-work-task-issue`/i);
    assert.match(workflow, /must not[\s\S]*run implementation plans/i);
  });
});

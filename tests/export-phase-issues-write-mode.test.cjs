'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { buildWriteMode, GitHubExportError } = require('../get-tasks-done/bin/lib/export-phase-issues.cjs');
const { cleanup, createTempProject } = require('./helpers.cjs');

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

function samplePlan({ plan, wave, dependsOn, files, taskNames }) {
  const tasks = taskNames.map((taskName, index) => {
    const file = files[index];
    return `<task type="auto">
  <name>${taskName}</name>
  <files>${file}</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only touch ${file}. Do not edit package.json.</boundaries>
  <action>Create the implementation for ${taskName}.</action>
  <verify>npm test -- ${plan}-${index + 1}</verify>
  <done>${file} contains the exported implementation and npm test -- ${plan}-${index + 1} passes.</done>
  <acceptance_criteria>
    - ${file} contains the exported implementation
  </acceptance_criteria>
</task>`;
  }).join('\n');

  return `---
phase: 01-foundation
plan: ${plan}
type: execute
wave: ${wave}
depends_on: [${dependsOn}]
files_modified: [${files.join(', ')}]
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
- [ ] npm test
</verification>

<success_criteria>
- Plan ${plan} works.
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
    this.nextIssueNumber = 10;
    this.nextIssueId = 1000;
    this.failNextSubIssue = false;
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
    if (this.failNextSubIssue) {
      this.failNextSubIssue = false;
      throw new GitHubExportError('simulated sub-issue failure', `add_sub_issue:${parentNumber}:${childIssueId}`);
    }
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
}

describe('export-phase-issues write mode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gtd-export-write-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('exports a phase, writes a complete manifest, and reruns without duplicates', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      files: ['src/auth.ts', 'src/session.ts'],
      taskNames: ['Create auth module', 'Create session module'],
    }));
    writePlan(tmpDir, '01-foundation', '01-02-PLAN.md', samplePlan({
      plan: '02',
      wave: '2',
      dependsOn: '01',
      files: ['src/profile.ts'],
      taskNames: ['Create profile module'],
    }));

    const adapter = new FakeGitHubAdapter();
    const first = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
    const issueCountAfterFirst = adapter.issues.size;
    const second = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(adapter.issues.size, issueCountAfterFirst);

    const manifestPath = path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.repo, 'owner/repo');
    assert.equal(manifest.plans['01-01'].issue, 10);
    assert.equal(manifest.plans['01-01'].tasks['01-01-T01'].issue, 12);
    assert.equal(manifest.plans['01-01'].tasks['01-01-T02'].issue, 13);
    assert.equal(manifest.plans['01-02'].tasks['01-02-T01'].issue, 14);
    assert.equal(manifest.plans['01-01'].tasks['01-01-T01'].exportStatus, 'complete');
    assert.equal(Object.prototype.hasOwnProperty.call(manifest.plans['01-01'].tasks['01-01-T01'], 'status'), false);

    const parent = adapter.getIssue(manifest.plans['01-01'].issue);
    assert.match(parent.body, /#12 01-01-T01/);
    assert.match(parent.body, /#13 01-01-T02/);

    const plan2 = adapter.getIssue(manifest.plans['01-02'].issue);
    const plan2Blockers = adapter.listBlockedBy(plan2.number).map((issue) => issue.number);
    assert.deepEqual(plan2Blockers, [10]);

    const secondTaskBlockers = adapter
      .listBlockedBy(manifest.plans['01-01'].tasks['01-01-T02'].issue)
      .map((issue) => issue.number);
    assert.deepEqual(secondTaskBlockers, [12]);
  });

  test('infers the target repository from origin when --repo is omitted', () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'origin', 'https://github.com/davide-troiani/my-project.git']);
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      files: ['src/auth.ts'],
      taskNames: ['Create auth module'],
    }));

    const adapter = new FakeGitHubAdapter();
    const result = buildWriteMode(tmpDir, { phase: '01', repo: null, dryRun: false }, adapter);

    assert.equal(result.ok, true);
    assert.equal(result.repo, 'davide-troiani/my-project');

    const manifestPath = path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.repo, 'davide-troiani/my-project');
  });

  test('migrates legacy task status to exportStatus on rerun', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      files: ['src/auth.ts'],
      taskNames: ['Create auth module'],
    }));

    const adapter = new FakeGitHubAdapter();
    buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);

    const manifestPath = path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json');
    const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    legacy.plans['01-01'].tasks['01-01-T01'].status = 'complete';
    delete legacy.plans['01-01'].tasks['01-01-T01'].exportStatus;
    fs.writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);

    const migrated = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(migrated.plans['01-01'].tasks['01-01-T01'].exportStatus, 'complete');
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.plans['01-01'].tasks['01-01-T01'], 'status'), false);
  });

  test('writes checkpoint child issues with human labels, done data, and strict dependency order', () => {
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
    DO NOT modify: package.json, src/generated/*
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

    const adapter = new FakeGitHubAdapter();
    const result = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);

    assert.equal(result.ok, true);
    assert.equal(adapter.labels.has('gtd:checkpoint'), true);
    assert.equal(adapter.labels.has('gtd:human-in-the-loop'), true);
    assert.equal(adapter.labels.has('gtd:checkpoint-resolved'), true);
    assert.equal(adapter.labels.has('type:checkpoint'), true);

    const manifestPath = path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const checkpointEntry = manifest.plans['01-01'].tasks['01-01-T01'];
    const implementationEntry = manifest.plans['01-01'].tasks['01-01-T02'];
    assert.equal(checkpointEntry.type, 'checkpoint:decision');
    assert.equal(checkpointEntry.done, null);
    assert.equal(checkpointEntry.checkpoint_details.decision, 'Choose the public API shape before implementation.');
    assert.equal(checkpointEntry.exportStatus, 'complete');
    assert.equal(Object.prototype.hasOwnProperty.call(checkpointEntry, 'status'), false);
    assert.equal(implementationEntry.type, 'auto');
    assert.equal(implementationEntry.done, 'src/feature.ts implements the selected API and npm test -- feature passes.');
    assert.equal(implementationEntry.exportStatus, 'complete');
    assert.equal(Object.prototype.hasOwnProperty.call(implementationEntry, 'status'), false);

    const checkpoint = adapter.getIssue(checkpointEntry.issue);
    const checkpointLabels = checkpoint.labels.map((label) => label.name);
    assert.equal(checkpointLabels.includes('gtd:task'), true);
    assert.equal(checkpointLabels.includes('gtd:checkpoint'), true);
    assert.equal(checkpointLabels.includes('gtd:human-in-the-loop'), true);
    assert.equal(checkpointLabels.includes('gtd:blocked-human'), true);
    assert.equal(checkpointLabels.includes('gtd:blocked'), true);
    assert.equal(checkpointLabels.includes('phase:01-foundation'), true);
    assert.equal(checkpointLabels.includes('type:checkpoint'), true);
    assert.equal(checkpointLabels.includes('gtd:ready'), false);
    assert.match(checkpoint.body, /## Checkpoint Type\n`checkpoint:decision`/);
    assert.match(checkpoint.body, /## Decision\nChoose the public API shape before implementation\./);
    assert.match(checkpoint.body, /## Human Checkpoint Resolution/);
    assert.match(checkpoint.body, /Record the human decision or result in this GitHub issue, then close the issue/);
    assert.match(checkpoint.body, /Orchestration waits until this checkpoint issue is closed/);
    assert.match(checkpoint.body, /Do not implement or edit code for this checkpoint task/);
    assert.doesNotMatch(checkpoint.body, /No action block declared/);
    assert.doesNotMatch(checkpoint.body, /No done criteria declared/);
    assert.doesNotMatch(checkpoint.body, /## Write Scope/);
    assert.doesNotMatch(checkpoint.body, /## Validation Contract/);
    assert.doesNotMatch(checkpoint.body, /```bash\n\n```/);

    const implementation = adapter.getIssue(implementationEntry.issue);
    assert.match(implementation.body, /## Done\nsrc\/feature\.ts implements the selected API/);
    assert.match(implementation.body, /forbidden:\n        - package\.json\n        - src\/generated/);
    assert.match(implementation.body, /type: manual\n    description: "src\/feature\.ts implements the selected API and npm test -- feature passes\."/);

    const implementationBlockers = adapter
      .listBlockedBy(implementationEntry.issue)
      .map((issue) => issue.number);
    assert.deepEqual(implementationBlockers, [checkpointEntry.issue]);
  });

  test('records partial export state and reruns to completion', () => {
    writePlan(tmpDir, '01-foundation', '01-01-PLAN.md', samplePlan({
      plan: '01',
      wave: '1',
      dependsOn: '',
      files: ['src/auth.ts'],
      taskNames: ['Create auth module'],
    }));

    const adapter = new FakeGitHubAdapter();
    adapter.failNextSubIssue = true;

    assert.throws(
      () => buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter),
      /simulated sub-issue failure/,
    );

    const manifestPath = path.join(tmpDir, '.planning', 'github', 'phase-01-foundation-issues.json');
    const partial = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.operation_state.failed.operation, 'add_sub_issue:10:1001');

    const parentBefore = adapter.getIssue(partial.plans['01-01'].issue);
    assert.equal(parentBefore.labels.some((label) => label.name === 'gtd:export-partial'), true);
    const issueCountAfterPartial = adapter.issues.size;

    const completed = buildWriteMode(tmpDir, { phase: '01', repo: 'owner/repo', dryRun: false }, adapter);
    const complete = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const parentAfter = adapter.getIssue(complete.plans['01-01'].issue);

    assert.equal(completed.ok, true);
    assert.equal(complete.status, 'complete');
    assert.equal(adapter.issues.size, issueCountAfterPartial);
    assert.equal(parentAfter.labels.some((label) => label.name === 'gtd:export-partial'), false);
  });
});

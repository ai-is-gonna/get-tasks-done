'use strict';

/**
 * Task issue workflow selector and executor.
 *
 * Read-only mode reports the state-sync labels and next action without
 * mutating GitHub or git. Execution mode applies the same preflight, claims one
 * workable task, runs it in an isolated task worktree through the standalone
 * gtd-task-executor contract, validates the result, and opens or updates the
 * task PR.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  ERROR_REASON,
  error,
  output,
  toPosixPath,
} = require('./core.cjs');
const { planningDir } = require('./planning-workspace.cjs');
const { loadExportSource } = require('./export-phase-issues.cjs');
const { parseWorktreePorcelain } = require('./worktree-safety.cjs');
const { formatGtdSlashFor } = require('./runtime-slash.cjs');
const {
  normalizeGitHubRepo,
  resolveGitHubRepoFromGit,
} = require('./github-repo.cjs');
const {
  CHECKPOINT_RESOLVED_STATUS,
  PLAN_ID_RE,
  TASK_EXPORT_STATUSES,
  TASK_ID_RE,
  isCheckpointTaskType,
  isIssueOpen,
  issueLabels,
  mergeLabelSet,
  normalizeRepoPath,
  normalizeTaskType,
} = require('./task-issue-shared.cjs');
const {
  api: ghApi,
  repoEndpoint: ghRepoEndpoint,
  runGhCommand,
} = require('./github-api-client.cjs');

const ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

const TASK_STATE_LABELS = Object.freeze([
  'gtd:ready',
  'gtd:blocked',
  'gtd:in-progress',
  'gtd:pr-open',
  'gtd:needs-rework',
  'gtd:validation-failed',
  'gtd:merged',
  'gtd:rejected',
  'gtd:blocked-human',
  'gtd:checkpoint-resolved',
  'gtd:source-drift',
]);

const PARENT_STATE_LABELS = Object.freeze([
  'gtd:ready',
  'gtd:blocked',
  'gtd:ready-for-reconcile',
  'gtd:reconcile-pr-open',
  'gtd:reconcile-failed',
  'gtd:source-drift',
  'gtd:complete',
]);

const BLOCKING_TASK_LABELS = Object.freeze([
  'gtd:blocked-human',
  'gtd:source-drift',
  'gtd:merged',
]);

const REWORK_LABELS = Object.freeze([
  'gtd:needs-rework',
  'gtd:rejected',
  'gtd:validation-failed',
]);

const DEFAULT_EXECUTOR_RETRY_BUDGET = 1;
const TASK_EXECUTOR_COMMAND = 'gtd-task-executor';
const GTD_COMPLETION_ARTIFACTS = Object.freeze([
  '.planning/STATE.md',
  '.planning/ROADMAP.md',
  '.planning/REQUIREMENTS.md',
]);

const SUMMARY_ARTIFACT_RE = /^\.planning\/phases\/.+\/.+-SUMMARY\.md$/;

class GitHubTaskIssueError extends Error {
  constructor(message, operation = null) {
    super(message);
    this.name = 'GitHubTaskIssueError';
    this.operation = operation;
  }
}

class TaskExecutionError extends Error {
  constructor(message, code = 'task_execution_failed', details = null) {
    super(message);
    this.name = 'TaskExecutionError';
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return 'Usage: gtd-tools work-task-issue [issue-number|issue-url|task-id|plan-id] [--phase <phase>] [--repo owner/name] [--read-only|--execute] [--reconcile] [--complete-phase <phase> --execute]';
}

function parseArgs(args) {
  const opts = {
    selector: null,
    phase: null,
    repo: null,
    mode: 'read-only',
    explicitMode: false,
    reconcile: false,
    completePhase: null,
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--phase') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.phase = value;
      i += 1;
    } else if (arg === '--repo') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.repo = normalizeRepo(value);
      i += 1;
    } else if (arg === '--read-only') {
      if (opts.explicitMode && opts.mode !== 'read-only') error('Use either --read-only or --execute, not both.', ERROR_REASON.USAGE);
      opts.mode = 'read-only';
      opts.explicitMode = true;
    } else if (arg === '--execute') {
      if (opts.explicitMode && opts.mode !== 'execute') error('Use either --read-only or --execute, not both.', ERROR_REASON.USAGE);
      opts.mode = 'execute';
      opts.explicitMode = true;
    } else if (arg === '--reconcile') {
      opts.reconcile = true;
    } else if (arg === '--complete-phase') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.completePhase = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      error(`Unknown work-task-issue flag: ${arg}`, ERROR_REASON.USAGE);
    } else if (!opts.selector) {
      opts.selector = arg;
    } else {
      error(usage(), ERROR_REASON.USAGE);
    }
  }

  delete opts.explicitMode;
  return opts;
}

function normalizeRepo(repo) {
  const value = normalizeGitHubRepo(repo);
  if (!value) {
    error(`Invalid GitHub repository "${repo}". Expected owner/name.`, ERROR_REASON.USAGE);
  }
  return value;
}

function parseSelector(raw) {
  if (!raw) return { mode: 'automatic', raw: null };
  const text = String(raw).trim();
  const url = text.match(ISSUE_URL_RE);
  if (url) {
    return {
      mode: 'explicit',
      type: 'issue',
      raw: text,
      issue: Number(url[3]),
      repo: normalizeRepo(`${url[1]}/${url[2]}`),
    };
  }
  if (/^#?\d+$/.test(text)) {
    return {
      mode: 'explicit',
      type: 'issue',
      raw: text,
      issue: Number(text.replace(/^#/, '')),
      repo: null,
    };
  }
  if (TASK_ID_RE.test(text)) {
    return {
      mode: 'explicit',
      type: 'task_id',
      raw: text,
      task_id: text.toUpperCase(),
      repo: null,
    };
  }
  if (PLAN_ID_RE.test(text)) {
    return {
      mode: 'explicit',
      type: 'plan_id',
      raw: text,
      plan_id: text.toUpperCase(),
      repo: null,
    };
  }
  error(`Invalid task selector "${raw}". Expected issue number, issue URL, task id like 01-04-T02, or plan id like 01-04.`, ERROR_REASON.USAGE);
}

function parseExportMarker(body) {
  const match = String(body || '').match(
    /<!--\s*gtd-export:v1\s+phase=([^\s]+)\s+plan=([^\s]+)(?:\s+task=([^\s]+))?\s+source_hash=([a-f0-9]+)\s*-->/i,
  );
  if (!match) return null;
  return {
    phase: match[1],
    plan: match[2],
    task: match[3] || null,
    source_hash: match[4],
  };
}

function readManifestFile(cwd, absPath) {
  try {
    return {
      absPath,
      path: toPosixPath(path.relative(cwd, absPath)),
      exists: true,
      data: JSON.parse(fs.readFileSync(absPath, 'utf8')),
    };
  } catch (err) {
    error(`Could not parse export manifest ${toPosixPath(path.relative(cwd, absPath))}: ${err.message}`, ERROR_REASON.USAGE);
  }
}

function discoverManifestFiles(cwd) {
  const githubDir = path.join(planningDir(cwd), 'github');
  if (!fs.existsSync(githubDir)) return [];
  return fs
    .readdirSync(githubDir)
    .filter((name) => /^phase-.+-issues\.json$/.test(name))
    .map((name) => path.join(githubDir, name))
    .sort();
}

function phaseArgFromManifestData(data) {
  return data?.directory || data?.phase_number || data?.phase || null;
}

function makeScope(cwd, source, manifest, opts, selectorRepo) {
  const manifestRepo = manifest.data?.repo || null;
  if (opts.repo && manifestRepo && opts.repo !== manifestRepo) {
    error(`Export manifest ${manifest.path} targets ${manifestRepo}; refusing to read ${opts.repo}.`, ERROR_REASON.USAGE);
  }
  if (selectorRepo && manifestRepo && selectorRepo !== manifestRepo) {
    error(`Selector targets ${selectorRepo}; export manifest ${manifest.path} targets ${manifestRepo}.`, ERROR_REASON.USAGE);
  }
  if (selectorRepo && opts.repo && selectorRepo !== opts.repo) {
    error(`Selector targets ${selectorRepo}; --repo targets ${opts.repo}.`, ERROR_REASON.USAGE);
  }

  let repo = opts.repo || selectorRepo || manifestRepo;
  if (!repo) {
    const inferred = resolveGitHubRepoFromGit(cwd);
    if (!inferred.ok) {
      error(`Export manifest ${manifest.path} has no repo and no GitHub repository could be inferred from current git config (${inferred.message}). Re-run export-phase-issues with --repo owner/name.`, ERROR_REASON.USAGE);
    }
    repo = inferred.repo;
  }
  repo = normalizeRepo(repo);

  if (manifest.data?.status !== 'complete') {
    error(`Export manifest ${manifest.path} is ${manifest.data?.status || 'missing status'}; rerun export-phase-issues before selecting task work.`, ERROR_REASON.USAGE);
  }

  return {
    repo,
    manifest,
    phase: source.phase,
    plans: source.plans,
    planMap: new Map(source.plans.map((plan) => [plan.id, plan])),
  };
}

function loadScopes(cwd, opts, selector) {
  if (opts.phase) {
    const source = loadExportSource(cwd, { phase: opts.phase });
    if (!source.manifest.exists) {
      error(`No export manifest found for phase ${opts.phase}. Run export-phase-issues write mode first.`, ERROR_REASON.USAGE);
    }
    return [makeScope(cwd, source, source.manifest, opts, selector.repo)];
  }

  const manifestFiles = discoverManifestFiles(cwd);
  if (manifestFiles.length === 0) {
    error('No GitHub issue export manifests found. Run export-phase-issues write mode first.', ERROR_REASON.USAGE);
  }

  const scopes = [];
  const requestedRepo = selector.repo || opts.repo || null;
  for (const file of manifestFiles) {
    const manifest = readManifestFile(cwd, file);
    if (requestedRepo && manifest.data?.repo && manifest.data.repo !== requestedRepo) continue;
    const phaseArg = phaseArgFromManifestData(manifest.data);
    if (!phaseArg) {
      error(`Export manifest ${manifest.path} has no phase directory or phase id.`, ERROR_REASON.USAGE);
    }
    const source = loadExportSource(cwd, { phase: phaseArg });
    scopes.push(makeScope(cwd, source, source.manifest, opts, selector.repo));
  }
  if (scopes.length === 0) {
    error(`No GitHub issue export manifests matched ${requestedRepo}.`, ERROR_REASON.USAGE);
  }
  return scopes;
}

function manifestPlanEntry(scope, planId) {
  return scope.manifest.data?.plans?.[planId] || null;
}

function manifestTaskEntry(scope, planId, taskId) {
  return scope.manifest.data?.plans?.[planId]?.tasks?.[taskId] || null;
}

function manifestTaskExportStatus(entry) {
  if (!entry) return null;
  if (entry.exportStatus) return entry.exportStatus;
  return TASK_EXPORT_STATUSES.has(entry.status) ? entry.status : null;
}

function manifestTaskCheckpointStatus(entry) {
  if (!entry) return null;
  if (entry.checkpointStatus) return entry.checkpointStatus;
  return entry.status === CHECKPOINT_RESOLVED_STATUS ? CHECKPOINT_RESOLVED_STATUS : null;
}

function normalizeTaskManifestEntryForWrite(entry) {
  if (!entry) return;
  const exportStatus = manifestTaskExportStatus(entry);
  if (exportStatus && !entry.exportStatus) entry.exportStatus = exportStatus;
  const checkpointStatus = manifestTaskCheckpointStatus(entry);
  if (checkpointStatus && !entry.checkpointStatus) entry.checkpointStatus = checkpointStatus;
  delete entry.status;
}

function taskBranchName(taskId, issueNumber) {
  return `gtd/task-${taskId}-${issueNumber}`;
}

function reconciliationBranchName(planId, issueNumber) {
  return `gtd/reconcile-${planId}-${issueNumber}`;
}

function callRead(operation, fallback, fn, errors) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    errors.push({
      operation,
      message: err.message || String(err),
    });
    return fallback;
  }
}

function listBlockedBy(adapter, issueNumber, errors, operation) {
  if (!adapter || typeof adapter.listBlockedBy !== 'function') {
    errors.push({
      operation,
      message: 'GitHub issue dependency reads are unavailable.',
    });
    return [];
  }
  const blockers = callRead(operation, [], () => adapter.listBlockedBy(issueNumber), errors);
  return Array.isArray(blockers) ? blockers : [];
}

function listPullRequestsForIssue(adapter, issueNumber, branchName, errors) {
  if (!adapter || typeof adapter.listPullRequestsForIssue !== 'function') return [];
  const prs = callRead(
    `list_pull_requests_for_issue:${issueNumber}`,
    [],
    () => adapter.listPullRequestsForIssue(issueNumber, branchName),
    errors,
  );
  return Array.isArray(prs) ? dedupePrs(prs) : [];
}

function dedupePrs(prs) {
  const seen = new Set();
  const result = [];
  for (const pr of prs || []) {
    const key = pr.url || pr.number;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(pr);
  }
  return result.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
}

function normalizePr(pr) {
  const state = String(pr.state || '').toUpperCase();
  const merged = Boolean(pr.mergedAt || pr.merged || state === 'MERGED');
  const open = state === 'OPEN' || state === 'open';
  const closed = state === 'CLOSED' || state === 'closed';
  const changesRequested =
    pr.changesRequested === true ||
    String(pr.reviewDecision || '').toUpperCase() === 'CHANGES_REQUESTED' ||
    Number(pr.unresolvedComments || 0) > 0 ||
    Number(pr.actionableComments || 0) > 0;

  return {
    number: pr.number,
    title: pr.title || '',
    state: state || (merged ? 'MERGED' : ''),
    url: pr.url || null,
    headRefName: pr.headRefName || pr.head || null,
    baseRefName: pr.baseRefName || pr.base || null,
    isDraft: Boolean(pr.isDraft),
    mergedAt: pr.mergedAt || null,
    reviewDecision: pr.reviewDecision || null,
    open,
    merged,
    closedUnmerged: closed && !merged,
    changesRequested,
  };
}

function prState(prs) {
  const normalized = prs.map(normalizePr);
  const open = normalized.filter((pr) => pr.open);
  const merged = normalized.filter((pr) => pr.merged);
  const closedUnmerged = normalized.filter((pr) => pr.closedUnmerged);
  const openNeedsRework = open.filter((pr) => pr.changesRequested);
  return {
    all: normalized,
    open,
    merged,
    closedUnmerged,
    openNeedsRework,
  };
}

function latestPr(prs) {
  return [...(prs || [])].sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0] || null;
}

function callWrite(operation, fn) {
  try {
    return fn();
  } catch (err) {
    throw new TaskExecutionError(`${operation}: ${err.message || String(err)}`, 'github_write_failed', { operation });
  }
}

function setIssueLabels(adapter, issueNumber, labels) {
  if (!adapter || typeof adapter.setIssueLabels !== 'function') {
    throw new TaskExecutionError('GitHub issue label writes are unavailable.', 'github_write_unavailable');
  }
  return callWrite(`set_issue_labels:${issueNumber}`, () => adapter.setIssueLabels(issueNumber, labels));
}

function commentIssue(adapter, issueNumber, body) {
  if (!adapter || typeof adapter.commentIssue !== 'function') {
    throw new TaskExecutionError('GitHub issue comments are unavailable.', 'github_write_unavailable');
  }
  return callWrite(`comment_issue:${issueNumber}`, () => adapter.commentIssue(issueNumber, body));
}

function updateIssueState(adapter, issueNumber, state) {
  if (!adapter || typeof adapter.updateIssueState !== 'function') return null;
  return callWrite(`update_issue_state:${issueNumber}:${state}`, () => adapter.updateIssueState(issueNumber, state));
}

function applyLabelActions(adapter, record) {
  const actions = record.labels.actions;
  if (!actions || (actions.add.length === 0 && actions.remove.length === 0)) return null;
  const labels = mergeLabelSet(record.labels.current, actions.add, actions.remove);
  setIssueLabels(adapter, record.issue_number, labels);
  record.labels.current = labels;
  record.labels.virtual = labels;
  record.labels.actions = { add: [], remove: [] };
  return {
    issue: record.issue_number,
    kind: record.kind,
    plan_id: record.plan_id,
    task_id: record.task_id || null,
    labels,
  };
}

function writeManifestData(manifest) {
  manifest.data.updated_at = new Date().toISOString();
  fs.writeFileSync(manifest.absPath, `${JSON.stringify(manifest.data, null, 2)}\n`, 'utf8');
}

function syncCheckpointManifestStatus(record) {
  if (!isResolvedCheckpointTask(record)) return null;
  const entry = manifestTaskEntry(record.scope, record.plan_id, record.task_id);
  if (!entry) return null;
  const alreadyResolved = manifestTaskCheckpointStatus(entry) === CHECKPOINT_RESOLVED_STATUS;
  const needsSchemaWrite = Object.prototype.hasOwnProperty.call(entry, 'status') ||
    (alreadyResolved && entry.checkpointStatus !== CHECKPOINT_RESOLVED_STATUS);
  if (alreadyResolved && !needsSchemaWrite) return null;
  normalizeTaskManifestEntryForWrite(entry);
  entry.checkpointStatus = CHECKPOINT_RESOLVED_STATUS;
  writeManifestData(record.scope.manifest);
  return {
    op: 'sync_checkpoint_manifest_status',
    issue: record.issue_number,
    task_id: record.task_id,
    checkpointStatus: CHECKPOINT_RESOLVED_STATUS,
    manifest: record.scope.manifest.path,
  };
}

function summaryPathForPlan(plan) {
  const sourcePath = sourcePathForPlan(plan);
  const dir = sourcePath ? path.dirname(sourcePath) : null;
  return dir ? toPosixPath(path.join(dir, `${plan.id}-SUMMARY.md`)) : `${plan.id}-SUMMARY.md`;
}

function reconciliationArtifactsLanded(cwd, parent) {
  if (!cwd) return { ok: false, missing: ['project cwd unavailable'] };
  const required = [
    summaryPathForPlan(parent.plan),
    '.planning/STATE.md',
    '.planning/ROADMAP.md',
  ];
  const missing = required.filter((relPath) => !fs.existsSync(path.join(cwd, relPath)));
  return {
    ok: missing.length === 0,
    missing,
  };
}

function applyStateSync(records, adapterForRepo, cwd = null) {
  const operations = [];
  for (const task of records.tasks) {
    const adapter = adapterForRepo(task.scope.repo);
    if (task.linked_prs.merged.length > 0 && task.issue && isIssueOpen(task.issue)) {
      updateIssueState(adapter, task.issue_number, 'closed');
      operations.push({
        op: 'close_merged_task_issue',
        issue: task.issue_number,
        task_id: task.task_id,
      });
    }
    if (task.linked_prs.closedUnmerged.length > 0 && task.issue && !isIssueOpen(task.issue)) {
      updateIssueState(adapter, task.issue_number, 'open');
      operations.push({
        op: 'reopen_rejected_task_issue',
        issue: task.issue_number,
        task_id: task.task_id,
      });
    }
  }

  for (const parent of records.parents) {
    const adapter = adapterForRepo(parent.scope.repo);
    if (parent.linked_prs?.merged?.length > 0) {
      const artifacts = reconciliationArtifactsLanded(adapter?.cwd || cwd, parent);
      if (!artifacts.ok) {
        operations.push({
          op: 'merged_reconciliation_pending_pull',
          issue: parent.issue_number,
          plan_id: parent.plan_id,
          missing: artifacts.missing,
        });
      } else {
        if (parent.issue && isIssueOpen(parent.issue)) {
          updateIssueState(adapter, parent.issue_number, 'closed');
          operations.push({
            op: 'close_reconciled_parent_issue',
            issue: parent.issue_number,
            plan_id: parent.plan_id,
          });
        }
        const labels = mergeLabelSet(parent.labels.virtual, ['gtd:complete'], [
          'gtd:ready',
          'gtd:blocked',
          'gtd:ready-for-reconcile',
          'gtd:reconcile-pr-open',
          'gtd:reconcile-failed',
          'gtd:source-drift',
        ]);
        parent.labels.virtual = labels;
        parent.labels.actions = labelActions(parent.labels.current, labels, PARENT_STATE_LABELS);
      }
    }
  }

  for (const record of [...records.parents, ...records.tasks]) {
    const adapter = adapterForRepo(record.scope.repo);
    const applied = applyLabelActions(adapter, record);
    if (applied) operations.push({ op: 'sync_labels', ...applied });
    if (record.kind === 'task') {
      const manifestSync = syncCheckpointManifestStatus(record);
      if (manifestSync) operations.push(manifestSync);
    }
  }
  return operations;
}

function isoTimestamp(deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  return now.toISOString();
}

function claimTaskIssue(adapter, record, deps = {}) {
  const timestamp = isoTimestamp(deps);
  const labels = mergeLabelSet(record.labels.virtual, ['gtd:in-progress'], ['gtd:ready', 'gtd:blocked']);
  setIssueLabels(adapter, record.issue_number, labels);
  const body = [
    `GTD task execution claim at ${timestamp}.`,
    '',
    `Branch: \`${record.branch_name}\``,
    `Task: \`${record.task_id}\``,
  ].join('\n');
  commentIssue(adapter, record.issue_number, body);
  return {
    issue: record.issue_number,
    branch: record.branch_name,
    claimed_at: timestamp,
    labels,
  };
}

function pathMatchesScope(filePath, scopePath) {
  const file = normalizeRepoPath(filePath);
  const scope = normalizeRepoPath(scopePath);
  if (!scope) return false;
  if (scope === '.') return true;
  if (file === scope) return true;
  return file.startsWith(`${scope}/`);
}

function forbiddenCompletionArtifact(filePath) {
  const file = normalizeRepoPath(filePath);
  return GTD_COMPLETION_ARTIFACTS.includes(file) || SUMMARY_ARTIFACT_RE.test(file);
}

function validateDiffScope(changedFiles, check) {
  const allowed = (check.paths?.allowed || []).map(normalizeRepoPath).filter(Boolean);
  const forbidden = (check.paths?.forbidden || []).map(normalizeRepoPath).filter(Boolean);
  const files = [...new Set((changedFiles || []).map(normalizeRepoPath).filter(Boolean))].sort();
  const outOfScope = files.filter((file) => allowed.length > 0 && !allowed.some((scope) => pathMatchesScope(file, scope)));
  const forbiddenHits = files.filter((file) =>
    forbidden.some((scope) => pathMatchesScope(file, scope)) ||
    forbiddenCompletionArtifact(file),
  );

  return {
    id: check.id,
    type: check.type,
    passed: outOfScope.length === 0 && forbiddenHits.length === 0,
    changed_files: files,
    allowed,
    forbidden,
    out_of_scope: outOfScope,
    forbidden_hits: forbiddenHits,
  };
}

function runShellCommand(command, cwd, deps = {}) {
  if (deps.runCommand) return deps.runCommand(command, cwd);
  const result = childProcess.spawnSync(command, [], {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? result.error.message : null,
  };
}

function validateCommandCheck(worktreePath, check, deps = {}) {
  const result = runShellCommand(check.run || check.command || '', worktreePath, deps);
  return {
    id: check.id,
    type: check.type,
    run: check.run || check.command || '',
    passed: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error || '').trim(),
  };
}

function validateFileExistsCheck(worktreePath, check) {
  const relPath = normalizeRepoPath(check.path || check.file || '');
  return {
    id: check.id,
    type: check.type,
    path: relPath,
    passed: Boolean(relPath) && fs.existsSync(path.join(worktreePath, relPath)),
  };
}

function validateContentMatchCheck(worktreePath, check) {
  const relPath = normalizeRepoPath(check.path || check.file || '');
  const file = relPath ? path.join(worktreePath, relPath) : null;
  const expected = check.text || check.pattern || check.match || '';
  let content = '';
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    content = fs.readFileSync(file, 'utf8');
  }
  return {
    id: check.id,
    type: check.type,
    path: relPath,
    expected,
    passed: Boolean(file && expected) && content.includes(expected),
  };
}

function validateTask(worktreePath, record, changedFiles, deps = {}) {
  const checks = record.task.validation_contract?.checks || [];
  const results = [];
  for (const check of checks) {
    if (check.type === 'diff-scope') {
      results.push(validateDiffScope(changedFiles, check));
    } else if (check.type === 'command' || check.type === 'test-selector') {
      results.push(validateCommandCheck(worktreePath, check, deps));
    } else if (check.type === 'file-exists') {
      results.push(validateFileExistsCheck(worktreePath, check));
    } else if (check.type === 'content-match') {
      results.push(validateContentMatchCheck(worktreePath, check));
    } else if (check.type === 'manual') {
      results.push({
        id: check.id,
        type: check.type,
        passed: null,
        description: check.description || '',
      });
    } else {
      results.push({
        id: check.id,
        type: check.type || 'unknown',
        passed: false,
        error: `Unsupported validation check type: ${check.type || 'unknown'}`,
      });
    }
  }

  const automated = results.filter((result) => result.passed !== null);
  const manual = results.filter((result) => result.passed === null);
  const failed = automated.filter((result) => result.passed === false);
  return {
    ok: failed.length === 0,
    automated_ok: failed.length === 0,
    checks: results,
    failed,
    manual,
    acceptance_criteria: record.task.acceptance_criteria.map((criterion) => ({
      criterion,
      mechanical: false,
      passed: null,
    })),
  };
}

function validationMarkdown(validation) {
  const lines = [
    '## GTD Task Validation',
    '',
    validation.ok ? 'Automated validation passed.' : 'Automated validation failed.',
    '',
    '### Checks',
  ];
  for (const check of validation.checks) {
    const status = check.passed === null ? 'manual' : (check.passed ? 'pass' : 'fail');
    lines.push(`- ${check.id || check.type}: ${status}`);
    if (check.run) lines.push(`  - run: \`${check.run}\``);
    if (check.out_of_scope?.length) lines.push(`  - out of scope: ${check.out_of_scope.map((file) => `\`${file}\``).join(', ')}`);
    if (check.forbidden_hits?.length) lines.push(`  - forbidden: ${check.forbidden_hits.map((file) => `\`${file}\``).join(', ')}`);
  }
  if (validation.manual.length > 0 || validation.acceptance_criteria.length > 0) {
    lines.push('', '### Reviewer Validation');
    for (const item of validation.acceptance_criteria) lines.push(`- [ ] ${item.criterion}`);
    for (const check of validation.manual) {
      if (check.description && validation.acceptance_criteria.length === 0) lines.push(`- [ ] ${check.description}`);
    }
  }
  return lines.join('\n');
}

function executorPrompt(record, reviewFeedback = []) {
  if (isCheckpointTask(record)) {
    return [
      `You are gtd-task-executor for ${record.task_id}.`,
      '',
      'This issue is a human-in-the-loop checkpoint, not executable implementation work.',
      'Stop without editing files. Report that the checkpoint requires human resolution in GitHub and must be closed before dependent tasks can run.',
    ].join('\n');
  }

  const readFirst = (record.task.read_first || []).map((entry) => `- ${entry}`).join('\n') || '- None declared';
  const allowed = (record.task.files || []).map((entry) => `- ${entry}`).join('\n') || '- No explicit files declared';
  const acceptance = (record.task.acceptance_criteria || []).map((entry) => `- ${entry}`).join('\n') || '- No acceptance criteria declared';
  const feedback = reviewFeedback.length
    ? reviewFeedback.map((item) => `- ${item.kind || 'feedback'}${item.author ? ` by ${item.author}` : ''}: ${item.body || item.state || ''}`).join('\n')
    : '- No PR review feedback supplied';

  return [
    `You are gtd-task-executor for ${record.task_id}.`,
    '',
    'Implement exactly one exported child task issue. Stay inside the declared write scope and commit the task changes before returning.',
    '',
    '## Issue',
    `#${record.issue_number}: ${record.issue?.title || record.task.name}`,
    '',
    '## Source Plan',
    sourcePathForPlan(record.plan) || '',
    '',
    '## Required Read First',
    readFirst,
    '',
    '## Write Scope',
    'Allowed:',
    allowed,
    '',
    'Boundaries:',
    record.task.boundaries || 'No boundaries declared',
    '',
    '## Action',
    record.task.action || 'No action block declared',
    '',
    '## Acceptance Criteria',
    acceptance,
    '',
    '## Verification',
    record.task.verify || 'No task verification command declared',
    '',
    '## Review Feedback',
    feedback,
    '',
    '## Non-Responsibilities',
    '- Do not open or update PRs.',
    '- Do not update parent plan issues.',
    '- Do not create SUMMARY, STATE, ROADMAP, or requirements completion artifacts.',
  ].join('\n');
}

function executorContext(record, worktree, reviewFeedback = [], previousFindings = null) {
  return {
    version: 1,
    task_id: record.task_id,
    task_type: record.task.type || record.manifest_entry?.type || null,
    is_checkpoint: isCheckpointTask(record),
    issue: {
      number: record.issue_number,
      title: record.issue?.title || null,
      body: record.issue?.body || null,
    },
    parent: {
      issue: record.parent?.issue_number || null,
      title: record.parent?.issue?.title || null,
      plan_id: record.plan_id,
    },
    source_plan: sourcePathForPlan(record.plan),
    worktree,
    branch: record.branch_name,
    read_first: record.task.read_first,
    write_scope: {
      allowed: record.task.files,
      boundaries: record.task.boundaries || '',
    },
    action: record.task.action || '',
    acceptance_criteria: record.task.acceptance_criteria,
    validation_contract: record.task.validation_contract,
    verification: record.task.verify || '',
    review_feedback: reviewFeedback,
    previous_findings: previousFindings,
    prompt: executorPrompt(record, reviewFeedback),
  };
}

function runTaskExecutor(context, deps = {}) {
  if (deps.runTaskExecutor) return deps.runTaskExecutor(context);
  const result = childProcess.spawnSync(TASK_EXECUTOR_COMMAND, [], {
    cwd: context.worktree.path,
    encoding: 'utf8',
    input: `${JSON.stringify(context)}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) {
    const message = result.error.code === 'ENOENT'
      ? `Standalone ${TASK_EXECUTOR_COMMAND} was not found on PATH.`
      : result.error.message;
    throw new TaskExecutionError(message, 'executor_unavailable');
  }
  const stdout = String(result.stdout || '').trim();
  if (result.status !== 0) {
    throw new TaskExecutionError(String(result.stderr || stdout || `${TASK_EXECUTOR_COMMAND} exited with status ${result.status}`).trim(), 'executor_failed');
  }
  if (!stdout) return { ok: true, notes: '', raw: '' };
  try {
    return JSON.parse(stdout);
  } catch {
    return { ok: true, notes: stdout, raw: stdout };
  }
}

function runGit(cwd, args, opts = {}) {
  const result = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.error) {
    throw new TaskExecutionError(result.error.message, 'git_failed', { args });
  }
  if (result.status !== 0 && !opts.allowFailure) {
    throw new TaskExecutionError(stderr || `git ${args.join(' ')} exited with status ${result.status}`, 'git_failed', { args });
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
  };
}

function executorBlockers(executorResult) {
  const raw = executorResult?.blockers ?? executorResult?.blocker ?? executorResult?.blocked_by ?? [];
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.message || item.reason || item.code || JSON.stringify(item)).trim();
      return String(item || '').trim();
    }).filter(Boolean);
  }
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (raw && typeof raw === 'object') return [String(raw.message || raw.reason || raw.code || JSON.stringify(raw)).trim()].filter(Boolean);
  return raw ? [String(raw).trim()].filter(Boolean) : [];
}

function executorCommitHash(executorResult) {
  const raw = executorResult?.commit
    ?? executorResult?.commit_hash
    ?? executorResult?.commitHash
    ?? executorResult?.sha
    ?? executorResult?.commit_sha
    ?? null;
  const value = String(raw || '').trim();
  return value || null;
}

function normalizeExecutorEvidence(evidence) {
  const reasons = Array.isArray(evidence?.reasons) ? evidence.reasons : [];
  return {
    ok: Boolean(evidence?.ok) && reasons.length === 0,
    executor_success: Boolean(evidence?.executor_success),
    blockers: Array.isArray(evidence?.blockers) ? evidence.blockers : [],
    commit: evidence?.commit || null,
    reachable_commit: Boolean(evidence?.reachable_commit),
    branch_contains_commit: Boolean(evidence?.branch_contains_commit),
    committed_diff: Boolean(evidence?.committed_diff),
    clean_worktree: Boolean(evidence?.clean_worktree),
    reasons,
  };
}

function validateExecutorEvidence(worktree, executorResult, deps = {}) {
  if (deps.validateExecutorEvidence) {
    return normalizeExecutorEvidence(deps.validateExecutorEvidence({ worktree, executorResult }));
  }

  const reasons = [];
  const blockers = executorBlockers(executorResult);
  const executorSuccess = executorResult?.ok === true;
  if (!executorSuccess) {
    reasons.push({
      code: 'executor_not_successful',
      message: 'Executor did not report ok: true.',
    });
  }
  if (blockers.length > 0) {
    reasons.push({
      code: 'executor_blockers',
      message: `Executor reported blocker(s): ${blockers.join('; ')}`,
      blockers,
    });
  }

  let commit = executorCommitHash(executorResult);
  let reachableCommit = false;
  let branchContainsCommit = false;
  let committedDiff = false;
  let cleanWorktree = false;

  if (!commit) {
    reasons.push({
      code: 'missing_executor_commit',
      message: 'Executor did not return a commit hash.',
    });
  } else if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    reasons.push({
      code: 'invalid_executor_commit_hash',
      message: `Executor commit is not a hash: ${commit}`,
    });
  } else {
    const verified = runGit(worktree.path, ['rev-parse', '--verify', `${commit}^{commit}`], { allowFailure: true });
    if (verified.ok && verified.stdout) {
      commit = verified.stdout;
      reachableCommit = true;
    } else {
      reasons.push({
        code: 'unreachable_executor_commit',
        message: `Executor commit ${commit} is not reachable as a commit in the task worktree.`,
      });
    }

    if (reachableCommit) {
      const contained = runGit(worktree.path, ['merge-base', '--is-ancestor', commit, 'HEAD'], { allowFailure: true });
      branchContainsCommit = contained.ok;
      if (!branchContainsCommit) {
        reasons.push({
          code: 'executor_commit_not_on_head',
          message: `Executor commit ${commit} is not reachable from HEAD.`,
        });
      }

      const parents = runGit(worktree.path, ['rev-list', '--parents', '-n', '1', commit], { allowFailure: true });
      if (!parents.ok || !parents.stdout) {
        reasons.push({
          code: 'executor_commit_parent_unavailable',
          message: `Could not inspect parent(s) for executor commit ${commit}.`,
        });
      } else {
        const parts = parents.stdout.split(/\s+/).filter(Boolean);
        const diffArgs = parts.length > 1
          ? ['diff-tree', '--quiet', '--no-ext-diff', parts[1], commit, '--']
          : ['diff-tree', '--quiet', '--root', '--no-ext-diff', commit, '--'];
        const diff = runGit(worktree.path, diffArgs, { allowFailure: true });
        if (diff.status === 1) {
          committedDiff = true;
        } else if (diff.status === 0) {
          reasons.push({
            code: 'empty_executor_commit_diff',
            message: `Executor commit ${commit} has no committed diff.`,
          });
        } else {
          reasons.push({
            code: 'executor_commit_diff_unavailable',
            message: diff.stderr || `Could not inspect committed diff for executor commit ${commit}.`,
          });
        }
      }
    }
  }

  const status = runGit(worktree.path, ['status', '--porcelain', '--untracked-files=normal'], { allowFailure: true });
  if (!status.ok) {
    reasons.push({
      code: 'worktree_status_unavailable',
      message: status.stderr || 'Could not inspect task worktree status.',
    });
  } else if (status.stdout) {
    reasons.push({
      code: 'dirty_task_worktree_after_executor',
      message: 'Task worktree is not clean after executor commit.',
      status: status.stdout,
    });
  } else {
    cleanWorktree = true;
  }

  return normalizeExecutorEvidence({
    ok: reasons.length === 0,
    executor_success: executorSuccess,
    blockers,
    commit,
    reachable_commit: reachableCommit,
    branch_contains_commit: branchContainsCommit,
    committed_diff: committedDiff,
    clean_worktree: cleanWorktree,
    reasons,
  });
}

function defaultBranchRef(cwd) {
  runGit(cwd, ['fetch', 'origin']);
  const symbolic = runGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  if (symbolic.ok && symbolic.stdout) return symbolic.stdout.replace(/^refs\/remotes\//, '');
  for (const candidate of ['origin/main', 'origin/master', 'origin/trunk']) {
    const exists = runGit(cwd, ['rev-parse', '--verify', candidate], { allowFailure: true });
    if (exists.ok) return candidate;
  }
  throw new TaskExecutionError('Could not resolve the default remote branch from origin/HEAD.', 'default_branch_unresolved');
}

function branchExists(cwd, branch) {
  return runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
}

function worktreeForBranch(cwd, branch) {
  const listed = runGit(cwd, ['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(listed.stdout).find((entry) => entry.branch === branch) || null;
}

function defaultWorktreeRoot(cwd) {
  return path.join(path.dirname(cwd), `${path.basename(cwd)}.task-worktrees`);
}

function safeWorktreeLeaf(branch) {
  return String(branch).replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
}

function ensureTaskWorktree(cwd, record, deps = {}) {
  if (deps.ensureTaskWorktree) return deps.ensureTaskWorktree({ cwd, record });

  const branch = record.branch_name;
  const root = deps.worktreeRoot || defaultWorktreeRoot(cwd);
  const worktreePath = path.join(root, safeWorktreeLeaf(branch));
  fs.mkdirSync(root, { recursive: true });

  const baseRef = defaultBranchRef(cwd);
  const existing = worktreeForBranch(cwd, branch);
  if (existing) {
    const status = runGit(existing.path, ['status', '--porcelain']).stdout;
    if (status) {
      throw new TaskExecutionError(`Task worktree ${existing.path} has uncommitted changes.`, 'dirty_task_worktree', { path: existing.path });
    }
    const rebase = runGit(existing.path, ['rebase', baseRef], { allowFailure: true });
    if (!rebase.ok) {
      runGit(existing.path, ['rebase', '--abort'], { allowFailure: true });
      throw new TaskExecutionError(`Could not rebase ${branch} onto ${baseRef}: ${rebase.stderr}`, 'task_branch_rebase_conflict');
    }
    return {
      path: existing.path,
      branch,
      base_ref: baseRef,
      reused: true,
    };
  }

  if (fs.existsSync(worktreePath)) {
    throw new TaskExecutionError(`Task worktree path already exists without matching branch: ${worktreePath}`, 'worktree_path_collision', { path: worktreePath });
  }

  if (branchExists(cwd, branch)) {
    runGit(cwd, ['worktree', 'add', worktreePath, branch]);
    const rebase = runGit(worktreePath, ['rebase', baseRef], { allowFailure: true });
    if (!rebase.ok) {
      runGit(worktreePath, ['rebase', '--abort'], { allowFailure: true });
      throw new TaskExecutionError(`Could not rebase ${branch} onto ${baseRef}: ${rebase.stderr}`, 'task_branch_rebase_conflict');
    }
  } else {
    runGit(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  }

  return {
    path: worktreePath,
    branch,
    base_ref: baseRef,
    reused: false,
  };
}

function listChangedFiles(worktree, deps = {}) {
  if (deps.listChangedFiles) return deps.listChangedFiles(worktree);
  const committed = runGit(worktree.path, ['diff', '--name-only', `${worktree.base_ref}...HEAD`]).stdout;
  const unstaged = runGit(worktree.path, ['diff', '--name-only']).stdout;
  const staged = runGit(worktree.path, ['diff', '--cached', '--name-only']).stdout;
  const untracked = runGit(worktree.path, ['ls-files', '--others', '--exclude-standard']).stdout;
  return [...new Set([committed, unstaged, staged, untracked]
    .flatMap((text) => String(text || '').split(/\r?\n/))
    .map(normalizeRepoPath)
    .filter(Boolean))]
    .sort();
}

function pushTaskBranch(worktree, deps = {}) {
  if (deps.pushBranch) return deps.pushBranch(worktree);
  runGit(worktree.path, ['push', '--set-upstream', 'origin', worktree.branch]);
  return {
    pushed: true,
    branch: worktree.branch,
  };
}

function reviewFeedback(adapter, record) {
  const pr = latestPr([...record.linked_prs.open, ...record.linked_prs.closedUnmerged]);
  if (!pr || !adapter || typeof adapter.listPullRequestFeedback !== 'function') return [];
  return callWrite(`list_pull_request_feedback:${pr.number}`, () => adapter.listPullRequestFeedback(pr.number));
}

function prBody(record, validation, executorResult, ready) {
  const lines = [
    `## Task`,
    '',
    `- Issue: #${record.issue_number}`,
    `- Task ID: \`${record.task_id}\``,
    `- Source plan: \`${sourcePathForPlan(record.plan)}\``,
    '',
    '## Implementation Notes',
    String(executorResult?.notes || executorResult?.summary || 'No implementation notes returned.').trim(),
    '',
    validationMarkdown(validation),
  ];
  if (ready) {
    lines.push('', `Closes #${record.issue_number}`);
  } else {
    lines.push('', 'This draft intentionally does not close the task issue because automated validation has not passed.');
  }
  return lines.join('\n');
}

function withTemporaryPrBodyFile(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-task-pr-body-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, String(body || ''), 'utf8');
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openOrUpdatePullRequest(adapter, record, worktree, validation, executorResult, ready) {
  const existingOpen = latestPr(record.linked_prs.open);
  const existingClosed = latestPr(record.linked_prs.closedUnmerged);
  const body = prBody(record, validation, executorResult, ready);
  const title = `[GTD ${record.task_id}] ${record.task.name}`;

  if (existingOpen) {
    if (!adapter || typeof adapter.updatePullRequest !== 'function') {
      throw new TaskExecutionError('GitHub PR update is unavailable.', 'github_pr_unavailable');
    }
    return callWrite(`update_pull_request:${existingOpen.number}`, () => adapter.updatePullRequest(existingOpen.number, {
      title,
      body,
      draft: !ready,
      labels: ready ? [] : ['gtd:validation-failed'],
    }));
  }

  if (existingClosed && adapter && typeof adapter.reopenPullRequest === 'function') {
    callWrite(`reopen_pull_request:${existingClosed.number}`, () => adapter.reopenPullRequest(existingClosed.number));
    return callWrite(`update_pull_request:${existingClosed.number}`, () => adapter.updatePullRequest(existingClosed.number, {
      title,
      body,
      draft: !ready,
      labels: ready ? [] : ['gtd:validation-failed'],
    }));
  }

  if (!adapter || typeof adapter.createPullRequest !== 'function') {
    throw new TaskExecutionError('GitHub PR creation is unavailable.', 'github_pr_unavailable');
  }
  return callWrite(`create_pull_request:${worktree.branch}`, () => adapter.createPullRequest({
    title,
    body,
    head: worktree.branch,
    base: worktree.base_ref.replace(/^origin\//, ''),
    draft: !ready,
    labels: ready ? [] : ['gtd:validation-failed'],
  }));
}

function finalizeIssueAfterPr(adapter, record, pr, validation, ready) {
  const labels = ready
    ? mergeLabelSet(record.labels.virtual, ['gtd:pr-open'], ['gtd:in-progress', 'gtd:ready', 'gtd:blocked', 'gtd:needs-rework', 'gtd:validation-failed', 'gtd:rejected'])
    : mergeLabelSet(record.labels.virtual, ['gtd:pr-open', 'gtd:validation-failed'], ['gtd:in-progress', 'gtd:ready', 'gtd:blocked']);
  setIssueLabels(adapter, record.issue_number, labels);
  const body = [
    ready ? 'Task PR is ready for review.' : 'Draft task PR opened with validation failures.',
    '',
    `PR: ${pr.url || `#${pr.number}`}`,
    '',
    validationMarkdown(validation),
  ].join('\n');
  commentIssue(adapter, record.issue_number, body);
  return {
    labels,
    comment_posted: true,
  };
}

function executorEvidenceMarkdown(executorEvidence) {
  const lines = [
    '## Executor Evidence',
    '',
    executorEvidence?.ok ? 'Executor commit evidence passed.' : 'Executor commit evidence failed.',
  ];
  for (const reason of executorEvidence?.reasons || []) {
    lines.push(`- ${reason.code || 'executor_evidence'}: ${reason.message || 'Evidence check failed.'}`);
  }
  return lines.join('\n');
}

function markExecutorEvidenceFailedWithoutPr(adapter, record, validation, executorEvidence) {
  const labels = mergeLabelSet(record.labels.virtual, ['gtd:validation-failed'], ['gtd:in-progress', 'gtd:ready', 'gtd:blocked']);
  setIssueLabels(adapter, record.issue_number, labels);
  commentIssue(adapter, record.issue_number, [
    'Task execution did not produce valid executor commit evidence. No PR was opened.',
    '',
    validationMarkdown(validation),
    '',
    executorEvidenceMarkdown(executorEvidence),
  ].join('\n'));
  return {
    labels,
    comment_posted: true,
  };
}

function sameMarker(marker, expected) {
  if (!marker || marker.phase !== expected.phase || marker.plan !== expected.plan) return false;
  if (Object.prototype.hasOwnProperty.call(expected, 'task')) return marker.task === expected.task;
  return marker.task === null;
}

function setAddMany(set, labels) {
  for (const label of labels) set.add(label);
}

function setDeleteMany(set, labels) {
  for (const label of labels) set.delete(label);
}

function labelActions(currentLabels, virtualLabels, managedLabels) {
  const current = new Set(currentLabels);
  const virtual = new Set(virtualLabels);
  const managed = new Set(managedLabels);
  return {
    add: [...virtual].filter((label) => managed.has(label) && !current.has(label)).sort(),
    remove: [...current].filter((label) => managed.has(label) && !virtual.has(label)).sort(),
  };
}

function openIssueNumbers(issues) {
  return (issues || []).filter(isIssueOpen).map((issue) => Number(issue.number)).filter(Boolean).sort((a, b) => a - b);
}

function sourcePathForPlan(plan) {
  return plan?.source_path || null;
}

function isCheckpointTask(record) {
  if (!record) return false;
  const labels = new Set(record.labels?.virtual || record.labels?.current || []);
  return isCheckpointTaskType(record.task?.type || record.manifest_entry?.type) ||
    labels.has('gtd:checkpoint') ||
    labels.has('type:checkpoint');
}

function isResolvedCheckpointTask(record) {
  return isCheckpointTask(record) && record.issue && !isIssueOpen(record.issue);
}

function applyCheckpointVirtualState(record, virtualLabels) {
  if (!isCheckpointTask(record) || !record.issue) return;
  setAddMany(virtualLabels, ['gtd:checkpoint', 'gtd:human-in-the-loop']);
  virtualLabels.delete('type:task');
  virtualLabels.add('type:checkpoint');

  if (isIssueOpen(record.issue)) {
    setAddMany(virtualLabels, ['gtd:blocked', 'gtd:blocked-human']);
    setDeleteMany(virtualLabels, [
      'gtd:ready',
      'gtd:in-progress',
      'gtd:pr-open',
      'gtd:needs-rework',
      'gtd:validation-failed',
      'gtd:rejected',
      'gtd:merged',
      'gtd:checkpoint-resolved',
    ]);
    return;
  }

  virtualLabels.add('gtd:checkpoint-resolved');
  setDeleteMany(virtualLabels, [
    'gtd:ready',
    'gtd:blocked',
    'gtd:in-progress',
    'gtd:pr-open',
    'gtd:needs-rework',
    'gtd:validation-failed',
    'gtd:rejected',
    'gtd:merged',
    'gtd:blocked-human',
  ]);
}

function makeTaskRecord(scope, plan, task, parentRecord, adapter) {
  const errors = [];
  const taskEntry = manifestTaskEntry(scope, plan.id, task.id);
  const issueNumber = taskEntry?.issue || null;
  const issue = issueNumber
    ? callRead(`get_issue:${issueNumber}`, null, () => adapter.getIssue(issueNumber), errors)
    : null;
  const blockers = issueNumber
    ? listBlockedBy(adapter, issueNumber, errors, `list_blocked_by:${issueNumber}`)
    : [];
  const branchName = issueNumber ? taskBranchName(task.id, issueNumber) : null;
  const prs = issueNumber ? listPullRequestsForIssue(adapter, issueNumber, branchName, errors) : [];
  const pr = prState(prs);
  const currentLabels = issueLabels(issue);
  const virtualLabels = new Set(currentLabels);
  setAddMany(virtualLabels, ['gtd:task']);

  const marker = parseExportMarker(issue?.body || '');
  const expectedMarker = {
    phase: scope.phase.phaseSlug,
    plan: plan.id,
    task: task.id,
  };
  const markerValid = sameMarker(marker, expectedMarker);
  const sourceDrift =
    !markerValid ||
    marker.source_hash !== task.source_hash ||
    taskEntry?.source_hash !== task.source_hash;

  const openBlockers = blockers.filter(isIssueOpen);
  if (sourceDrift) virtualLabels.add('gtd:source-drift');
  const checkpointTask = isCheckpointTask({
    task,
    manifest_entry: taskEntry,
    labels: {
      current: currentLabels,
      virtual: [...virtualLabels],
    },
  });

  if (checkpointTask) {
    applyCheckpointVirtualState({
      task,
      manifest_entry: taskEntry,
      issue,
      labels: {
        current: currentLabels,
        virtual: [...virtualLabels],
      },
    }, virtualLabels);
  } else if (pr.merged.length > 0) {
    virtualLabels.add('gtd:merged');
    setDeleteMany(virtualLabels, [
      'gtd:ready',
      'gtd:blocked',
      'gtd:in-progress',
      'gtd:pr-open',
      'gtd:needs-rework',
      'gtd:validation-failed',
      'gtd:rejected',
    ]);
  } else if (pr.open.length > 0) {
    virtualLabels.add('gtd:pr-open');
    virtualLabels.delete('gtd:merged');
    virtualLabels.delete('gtd:ready');
    virtualLabels.delete('gtd:blocked');
    if (pr.openNeedsRework.length > 0) virtualLabels.add('gtd:needs-rework');
  } else if (pr.closedUnmerged.length > 0) {
    virtualLabels.add('gtd:rejected');
    virtualLabels.add('gtd:needs-rework');
    virtualLabels.delete('gtd:pr-open');
  } else if (issue && isIssueOpen(issue)) {
    const hasBlockingLabel = ['gtd:blocked-human', 'gtd:source-drift'].some((label) => virtualLabels.has(label));
    if (openBlockers.length > 0 || hasBlockingLabel) {
      virtualLabels.add('gtd:blocked');
      virtualLabels.delete('gtd:ready');
    } else {
      virtualLabels.add('gtd:ready');
      virtualLabels.delete('gtd:blocked');
    }
  }

  const record = {
    kind: 'task',
    scope,
    plan,
    task,
    task_id: task.id,
    plan_id: plan.id,
    issue_number: issueNumber,
    issue,
    parent: parentRecord,
    manifest_entry: taskEntry,
    marker,
    marker_valid: markerValid,
    source_drift: sourceDrift,
    labels: {
      current: currentLabels.sort(),
      virtual: [...virtualLabels].sort(),
      actions: labelActions(currentLabels, virtualLabels, TASK_STATE_LABELS),
    },
    blockers,
    open_blockers: openBlockers,
    linked_prs: pr,
    branch_name: branchName,
    errors,
  };
  record.workability = evaluateWorkability(record);
  record.selection_bucket = selectionBucket(record);
  return record;
}

function makeParentRecord(scope, plan, adapter) {
  const errors = [];
  const planEntry = manifestPlanEntry(scope, plan.id);
  const issueNumber = planEntry?.issue || null;
  const issue = issueNumber
    ? callRead(`get_issue:${issueNumber}`, null, () => adapter.getIssue(issueNumber), errors)
    : null;
  const blockers = issueNumber
    ? listBlockedBy(adapter, issueNumber, errors, `list_blocked_by:${issueNumber}`)
    : [];
  const branchName = issueNumber ? reconciliationBranchName(plan.id, issueNumber) : null;
  const prs = issueNumber ? listPullRequestsForIssue(adapter, issueNumber, branchName, errors) : [];
  const pr = prState(prs);
  const currentLabels = issueLabels(issue);
  const virtualLabels = new Set(currentLabels);
  setAddMany(virtualLabels, ['gtd:plan']);

  const marker = parseExportMarker(issue?.body || '');
  const expectedMarker = {
    phase: scope.phase.phaseSlug,
    plan: plan.id,
  };
  const markerValid = sameMarker(marker, expectedMarker);
  const sourceDrift =
    !markerValid ||
    marker.source_hash !== plan.source_hash ||
    planEntry?.source_hash !== plan.source_hash;
  if (sourceDrift) virtualLabels.add('gtd:source-drift');

  const parentRecord = {
    kind: 'parent_plan',
    scope,
    plan,
    plan_id: plan.id,
    issue_number: issueNumber,
    issue,
    manifest_entry: planEntry,
    marker,
    marker_valid: markerValid,
    source_drift: sourceDrift,
    labels: {
      current: currentLabels.sort(),
      virtual: null,
      actions: null,
    },
    blockers,
    open_blockers: blockers.filter(isIssueOpen),
    linked_prs: pr,
    branch_name: branchName,
    tasks: [],
    errors,
    reconciliation: null,
  };

  parentRecord.labels.virtual = [...virtualLabels].sort();
  parentRecord.labels.actions = labelActions(currentLabels, virtualLabels, PARENT_STATE_LABELS);
  return parentRecord;
}

function evaluateWorkability(record) {
  const reasons = [];
  const virtualLabels = new Set(record.labels.virtual);
  const issueNumber = record.issue_number ? `#${record.issue_number}` : 'unknown issue';
  const checkpointTask = isCheckpointTask(record);

  if (!record.manifest_entry?.issue) {
    reasons.push({ code: 'missing_manifest_task_issue', message: `${record.task_id} has no task issue in the export manifest.` });
  }
  if (checkpointTask) {
    reasons.push({
      code: 'checkpoint_human_resolution',
      message: record.issue && !isIssueOpen(record.issue)
        ? `${issueNumber} is a resolved human-in-the-loop checkpoint. Checkpoint tasks are not executable implementation work.`
        : `${issueNumber} is a human-in-the-loop checkpoint. Resolve it by recording the human decision/result in GitHub and closing the checkpoint issue; dependent implementation tasks remain blocked while it is open.`,
      status: record.issue && !isIssueOpen(record.issue) ? CHECKPOINT_RESOLVED_STATUS : 'checkpoint_open',
    });
  }
  if (!record.issue) {
    reasons.push({ code: 'issue_not_found', message: `${issueNumber} could not be read from GitHub.` });
  } else if (!isIssueOpen(record.issue)) {
    reasons.push({ code: 'issue_closed', message: `${issueNumber} is closed.` });
  }
  if (!virtualLabels.has('gtd:task')) {
    reasons.push({ code: 'missing_task_label', message: `${issueNumber} is not labeled gtd:task.` });
  }
  if (!record.marker_valid) {
    reasons.push({ code: 'invalid_marker', message: `${issueNumber} does not contain the expected gtd-export marker for ${record.task_id}.` });
  }
  if (record.source_drift) {
    reasons.push({
      code: 'source_drift',
      message: `${record.task_id} source hash differs from the manifest or issue marker.`,
      details: {
        issue_hash: record.marker?.source_hash || null,
        manifest_hash: record.manifest_entry?.source_hash || null,
        current_hash: record.task.source_hash,
      },
    });
  }
  for (const err of record.errors) {
    reasons.push({ code: 'preflight_read_failed', message: `${err.operation}: ${err.message}` });
  }
  const openBlockerNumbers = openIssueNumbers(record.open_blockers);
  if (openBlockerNumbers.length > 0) {
    reasons.push({
      code: 'open_task_blockers',
      message: `${issueNumber} is blocked by open issue(s): ${openBlockerNumbers.map((n) => `#${n}`).join(', ')}.`,
      blockers: openBlockerNumbers,
    });
  }
  const blockingLabels = BLOCKING_TASK_LABELS.filter((label) => virtualLabels.has(label));
  if (blockingLabels.length > 0) {
    reasons.push({
      code: 'blocking_task_labels',
      message: `${issueNumber} has blocking label(s): ${blockingLabels.join(', ')}.`,
      labels: blockingLabels,
    });
  }
  const parentBlockers = openIssueNumbers(record.parent?.open_blockers || []);
  if (parentBlockers.length > 0) {
    reasons.push({
      code: 'open_parent_blockers',
      message: `Parent plan #${record.parent.issue_number} is blocked by open issue(s): ${parentBlockers.map((n) => `#${n}`).join(', ')}.`,
      blockers: parentBlockers,
    });
  }
  if (virtualLabels.has('gtd:in-progress') && !isResumable(record)) {
    reasons.push({
      code: 'active_claim',
      message: `${issueNumber} is already labeled gtd:in-progress; read-only mode does not clear or take over claims.`,
    });
  }
  if (!isActionableState(record)) {
    reasons.push({
      code: 'not_actionable',
      message: `${issueNumber} is not ready, not a rework task, and has no resumable rejected or validation-failed state.`,
    });
  }

  return {
    workable: reasons.length === 0,
    reasons,
    skipped_checks: [
      'task worktree creation/reuse is checked in task execution mode',
    ],
  };
}

function isResumable(record) {
  const labels = new Set(record.labels.virtual);
  return record.linked_prs.openNeedsRework.length > 0 ||
    record.linked_prs.closedUnmerged.length > 0 ||
    REWORK_LABELS.some((label) => labels.has(label));
}

function isReadyNewWork(record) {
  const labels = new Set(record.labels.virtual);
  return labels.has('gtd:ready') &&
    record.open_blockers.length === 0 &&
    record.linked_prs.open.length === 0 &&
    record.linked_prs.closedUnmerged.length === 0 &&
    record.linked_prs.merged.length === 0;
}

function isActionableState(record) {
  const labels = new Set(record.labels.virtual);
  return isReadyNewWork(record) ||
    record.linked_prs.openNeedsRework.length > 0 ||
    record.linked_prs.closedUnmerged.length > 0 ||
    REWORK_LABELS.some((label) => labels.has(label));
}

function selectionBucket(record) {
  const labels = new Set(record.labels.virtual);
  if (!record.workability?.workable) return null;
  if (record.linked_prs.openNeedsRework.length > 0) return 1;
  if (REWORK_LABELS.some((label) => labels.has(label))) return 2;
  if (isReadyNewWork(record)) return 3;
  return null;
}

function evaluateReconciliation(parent) {
  const reasons = [];
  const issueNumber = parent.issue_number ? `#${parent.issue_number}` : 'unknown issue';
  const hasMergedReconciliation = parent.linked_prs?.merged?.length > 0;
  const hasOpenReconciliation = parent.linked_prs?.open?.length > 0;

  if (hasMergedReconciliation) {
    const virtualLabels = new Set(parent.labels.virtual);
    virtualLabels.add('gtd:complete');
    setDeleteMany(virtualLabels, [
      'gtd:ready',
      'gtd:blocked',
      'gtd:ready-for-reconcile',
      'gtd:reconcile-pr-open',
      'gtd:reconcile-failed',
      'gtd:source-drift',
    ]);
    parent.labels.virtual = [...virtualLabels].sort();
    parent.labels.actions = labelActions(parent.labels.current, virtualLabels, PARENT_STATE_LABELS);
    parent.reconciliation = {
      ready: false,
      permission_required: false,
      reasons: [],
      proposed_branch: parent.branch_name,
      plan_verification: parent.plan.verification || '',
      artifacts: [
        summaryPathForPlan(parent.plan),
        '.planning/STATE.md',
        '.planning/ROADMAP.md',
        'requirements completion metadata',
      ],
      status: 'complete',
    };
    return;
  }

  if (!parent.issue) {
    reasons.push({ code: 'parent_issue_not_found', message: `${issueNumber} could not be read from GitHub.` });
  } else if (!isIssueOpen(parent.issue)) {
    reasons.push({ code: 'parent_closed', message: `${issueNumber} is closed.` });
  }
  if (hasOpenReconciliation) {
    reasons.push({
      code: 'reconciliation_pr_open',
      message: `${issueNumber} already has an open reconciliation PR.`,
      prs: parent.linked_prs.open.map((pr) => pr.number).filter(Boolean),
    });
  }
  if (!parent.marker_valid) {
    reasons.push({ code: 'invalid_parent_marker', message: `${issueNumber} does not contain the expected parent plan marker.` });
  }
  if (parent.source_drift) {
    reasons.push({
      code: 'parent_source_drift',
      message: `${parent.plan_id} source hash differs from the manifest or parent issue marker.`,
      details: {
        issue_hash: parent.marker?.source_hash || null,
        manifest_hash: parent.manifest_entry?.source_hash || null,
        current_hash: parent.plan.source_hash,
        source_path: sourcePathForPlan(parent.plan),
      },
    });
  }
  const parentBlockers = openIssueNumbers(parent.open_blockers);
  if (parentBlockers.length > 0) {
    reasons.push({
      code: 'open_parent_blockers',
      message: `${issueNumber} is blocked by open issue(s): ${parentBlockers.map((n) => `#${n}`).join(', ')}.`,
      blockers: parentBlockers,
    });
  }
  for (const err of parent.errors) {
    reasons.push({ code: 'preflight_read_failed', message: `${err.operation}: ${err.message}` });
  }

  for (const task of parent.tasks) {
    const labels = new Set(task.labels.virtual);
    const resolvedCheckpoint = isResolvedCheckpointTask(task);
    if (task.issue && isIssueOpen(task.issue)) {
      reasons.push({
        code: 'child_task_open',
        message: `Child task #${task.issue_number} (${task.task_id}) is still open.`,
        issue: task.issue_number,
      });
    }
    if (task.linked_prs.merged.length === 0 && !resolvedCheckpoint) {
      reasons.push({
        code: 'child_pr_not_merged',
        message: `Child task #${task.issue_number} (${task.task_id}) has no merged linked PR.`,
        issue: task.issue_number,
      });
    }
    const blockingLabels = ['gtd:needs-rework', 'gtd:blocked-human', 'gtd:source-drift'].filter((label) => labels.has(label));
    if (blockingLabels.length > 0) {
      reasons.push({
        code: 'child_blocking_labels',
        message: `Child task #${task.issue_number} (${task.task_id}) has blocking label(s): ${blockingLabels.join(', ')}.`,
        issue: task.issue_number,
        labels: blockingLabels,
      });
    }
  }

  const virtualLabels = new Set(parent.labels.virtual);
  if (reasons.length === 0) {
    virtualLabels.add('gtd:ready-for-reconcile');
    virtualLabels.delete('gtd:blocked');
    virtualLabels.delete('gtd:reconcile-pr-open');
  } else if (parent.source_drift) {
    virtualLabels.delete('gtd:ready-for-reconcile');
    virtualLabels.add('gtd:source-drift');
  } else if (hasOpenReconciliation) {
    virtualLabels.delete('gtd:ready-for-reconcile');
    virtualLabels.add('gtd:reconcile-pr-open');
  }

  parent.labels.virtual = [...virtualLabels].sort();
  parent.labels.actions = labelActions(parent.labels.current, virtualLabels, PARENT_STATE_LABELS);
  parent.reconciliation = {
    ready: reasons.length === 0,
    permission_required: reasons.length === 0,
    reasons,
    proposed_branch: parent.issue_number ? reconciliationBranchName(parent.plan_id, parent.issue_number) : null,
    plan_verification: parent.plan.verification || '',
    artifacts: [
      summaryPathForPlan(parent.plan),
      '.planning/STATE.md',
      '.planning/ROADMAP.md',
      'requirements completion metadata',
    ],
    status: hasOpenReconciliation ? 'pr_open' : (reasons.length === 0 ? 'ready' : 'blocked'),
  };
}

function phaseSortText(record) {
  return String(record.scope.phase.phaseNumber || record.scope.phase.phaseSlug || '');
}

function taskIndex(record) {
  const match = String(record.task_id || '').match(/-T(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function waveNumber(record) {
  const raw = record.plan?.wave;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function compareRecords(a, b) {
  const phase = phaseSortText(a).localeCompare(phaseSortText(b), undefined, { numeric: true, sensitivity: 'base' });
  if (phase !== 0) return phase;
  const wave = waveNumber(a) - waveNumber(b);
  if (wave !== 0) return wave;
  const plan = String(a.plan_id).localeCompare(String(b.plan_id), undefined, { numeric: true, sensitivity: 'base' });
  if (plan !== 0) return plan;
  const task = taskIndex(a) - taskIndex(b);
  if (task !== 0) return task;
  return Number(a.issue_number || 0) - Number(b.issue_number || 0);
}

function compareParents(a, b) {
  const phase = phaseSortText(a).localeCompare(phaseSortText(b), undefined, { numeric: true, sensitivity: 'base' });
  if (phase !== 0) return phase;
  const wave = waveNumber(a) - waveNumber(b);
  if (wave !== 0) return wave;
  const plan = String(a.plan_id).localeCompare(String(b.plan_id), undefined, { numeric: true, sensitivity: 'base' });
  if (plan !== 0) return plan;
  return Number(a.issue_number || 0) - Number(b.issue_number || 0);
}

function collectRecords(scopes, adapterForRepo) {
  const parents = [];
  const tasks = [];
  for (const scope of scopes) {
    const adapter = adapterForRepo(scope.repo);
    for (const plan of scope.plans) {
      const parent = makeParentRecord(scope, plan, adapter);
      parents.push(parent);
      for (const task of plan.tasks) {
        const record = makeTaskRecord(scope, plan, task, parent, adapter);
        parent.tasks.push(record);
        tasks.push(record);
      }
      evaluateReconciliation(parent);
    }
  }
  return {
    parents: parents.sort(compareParents),
    tasks: tasks.sort(compareRecords),
  };
}

function resolveExplicitTask(selector, tasks, parents) {
  if (selector.type === 'task_id') {
    return tasks.filter((task) => task.task_id.toUpperCase() === selector.task_id);
  }
  if (selector.type === 'plan_id') {
    const parentMatch = parents.find((parent) => parent.plan_id.toUpperCase() === selector.plan_id);
    if (parentMatch) {
      return [{
        kind: 'resolution_error',
        workability: {
          workable: false,
          reasons: [{
            code: 'selector_resolved_parent_plan',
            message: `${selector.raw} is a parent plan selector; use --reconcile to reconcile parent plans.`,
          }],
          skipped_checks: [],
        },
      }];
    }
  }
  if (selector.type === 'issue') {
    const matches = tasks.filter((task) => Number(task.issue_number) === selector.issue);
    if (matches.length > 0) return matches;
    const parentMatch = parents.find((parent) => Number(parent.issue_number) === selector.issue);
    if (parentMatch) {
      return [{
        kind: 'resolution_error',
        workability: {
          workable: false,
          reasons: [{
            code: 'selector_resolved_parent_plan',
            message: `#${selector.issue} is a parent plan issue; step 3 explicit mode only resolves child task issues.`,
          }],
          skipped_checks: [],
        },
      }];
    }
  }
  return [];
}

function resolveExplicitParent(selector, parents, tasks) {
  if (selector.type === 'plan_id') {
    return parents.filter((parent) => parent.plan_id.toUpperCase() === selector.plan_id);
  }
  if (selector.type === 'issue') {
    const matches = parents.filter((parent) => Number(parent.issue_number) === selector.issue);
    if (matches.length > 0) return matches;
    const taskMatch = tasks.find((task) => Number(task.issue_number) === selector.issue);
    if (taskMatch) {
      return [{
        kind: 'resolution_error',
        reconciliation: {
          ready: false,
          permission_required: false,
          reasons: [{
            code: 'selector_resolved_child_task',
            message: `#${selector.issue} is a child task issue; omit --reconcile to work task issues.`,
          }],
        },
      }];
    }
  }
  if (selector.type === 'task_id') {
    const taskMatch = tasks.find((task) => task.task_id.toUpperCase() === selector.task_id);
    if (taskMatch) {
      return [{
        kind: 'resolution_error',
        reconciliation: {
          ready: false,
          permission_required: false,
          reasons: [{
            code: 'selector_resolved_child_task',
            message: `${selector.raw} is a child task selector; omit --reconcile to work task issues.`,
          }],
        },
      }];
    }
  }
  return [];
}

function selectAutomatic(tasks, parents) {
  const workable = tasks.filter((task) => task.workability.workable && task.selection_bucket !== null);
  for (const bucket of [1, 2, 3]) {
    const match = workable.filter((task) => task.selection_bucket === bucket).sort(compareRecords)[0];
    if (match) return { kind: 'task', record: match };
  }

  const reconcile = parents.filter((parent) => parent.reconciliation.ready).sort(compareParents)[0];
  if (reconcile) return { kind: 'reconciliation_permission', record: reconcile };

  return { kind: 'none', record: null };
}

function prOutput(pr) {
  return {
    number: pr.number || null,
    title: pr.title || '',
    state: pr.state || '',
    url: pr.url || null,
    headRefName: pr.headRefName || null,
    isDraft: pr.isDraft,
    mergedAt: pr.mergedAt || null,
    reviewDecision: pr.reviewDecision || null,
    changesRequested: pr.changesRequested,
  };
}

function taskOutput(record) {
  if (record.kind === 'resolution_error') {
    return {
      kind: 'task',
      resolved: false,
      workability: record.workability,
    };
  }
  return {
    kind: 'task',
    resolved: true,
    issue: record.issue_number,
    title: record.issue?.title || null,
    state: record.issue?.state || null,
    repo: record.scope.repo,
    phase: record.scope.phase.phaseSlug,
    plan_id: record.plan_id,
    task_id: record.task_id,
    task_type: record.task.type || record.manifest_entry?.type || null,
    manifest_export_status: manifestTaskExportStatus(record.manifest_entry),
    checkpoint_status: manifestTaskCheckpointStatus(record.manifest_entry),
    checkpoint_resolved: isResolvedCheckpointTask(record),
    source_path: sourcePathForPlan(record.plan),
    branch: record.branch_name,
    labels: record.labels,
    blockers: {
      task: openIssueNumbers(record.open_blockers),
      parent: openIssueNumbers(record.parent?.open_blockers || []),
    },
    linked_prs: {
      open: record.linked_prs.open.map(prOutput),
      open_needs_rework: record.linked_prs.openNeedsRework.map(prOutput),
      closed_unmerged: record.linked_prs.closedUnmerged.map(prOutput),
      merged: record.linked_prs.merged.map(prOutput),
    },
    marker: {
      valid: record.marker_valid,
      issue_hash: record.marker?.source_hash || null,
      manifest_hash: record.manifest_entry?.source_hash || null,
      current_hash: record.task.source_hash,
    },
    source_drift: record.source_drift,
    selection_bucket: record.selection_bucket,
    workability: record.workability,
  };
}

function parentOutput(parent) {
  if (parent.kind === 'resolution_error') {
    return {
      kind: 'parent_plan',
      resolved: false,
      reconciliation: parent.reconciliation,
    };
  }
  return {
    kind: 'parent_plan',
    resolved: true,
    issue: parent.issue_number,
    title: parent.issue?.title || null,
    state: parent.issue?.state || null,
    repo: parent.scope.repo,
    phase: parent.scope.phase.phaseSlug,
    plan_id: parent.plan_id,
    source_path: sourcePathForPlan(parent.plan),
    labels: parent.labels,
    blockers: {
      parent: openIssueNumbers(parent.open_blockers),
    },
    linked_prs: {
      open: parent.linked_prs.open.map(prOutput),
      merged: parent.linked_prs.merged.map(prOutput),
      closed_unmerged: parent.linked_prs.closedUnmerged.map(prOutput),
    },
    marker: {
      valid: parent.marker_valid,
      issue_hash: parent.marker?.source_hash || null,
      manifest_hash: parent.manifest_entry?.source_hash || null,
      current_hash: parent.plan.source_hash,
    },
    source_drift: parent.source_drift,
    reconciliation: {
      ready: parent.reconciliation.ready,
      permission_required: parent.reconciliation.permission_required,
      reasons: parent.reconciliation.reasons,
      proposed_branch: parent.reconciliation.proposed_branch,
      plan_verification: parent.reconciliation.plan_verification,
      artifacts: parent.reconciliation.artifacts,
      status: parent.reconciliation.status,
      child_tasks: parent.tasks.map((task) => ({
        issue: task.issue_number,
        task_id: task.task_id,
        task_type: task.task.type || task.manifest_entry?.type || null,
        checkpoint_resolved: isResolvedCheckpointTask(task),
        merged_prs: task.linked_prs.merged.map(prOutput),
      })),
    },
  };
}

function labelActionSummaries(records) {
  const actions = [];
  for (const record of records) {
    if (record.labels.actions.add.length === 0 && record.labels.actions.remove.length === 0) continue;
    actions.push({
      kind: record.kind,
      issue: record.issue_number,
      plan_id: record.plan_id,
      task_id: record.task_id || null,
      add: record.labels.actions.add,
      remove: record.labels.actions.remove,
    });
  }
  return actions;
}

function blockingStateOutput(tasks, parents) {
  return {
    non_workable_tasks: tasks.map((task) => ({
      issue: task.issue_number,
      task_id: task.task_id,
      plan_id: task.plan_id,
      labels: task.labels.virtual,
      reasons: task.workability.reasons,
      blockers: {
        task: openIssueNumbers(task.open_blockers),
        parent: openIssueNumbers(task.parent?.open_blockers || []),
      },
    })),
    parent_reconciliation: parents.map((parent) => ({
      issue: parent.issue_number,
      plan_id: parent.plan_id,
      ready: parent.reconciliation.ready,
      reasons: parent.reconciliation.reasons,
    })),
  };
}

function buildReadOnly(cwd, opts, adapterOrFactory = null) {
  if (opts.completePhase) return buildCompletePhaseTail(cwd, opts);
  const selector = parseSelector(opts.selector);
  const effectiveOpts = {
    ...opts,
    repo: opts.repo || selector.repo || null,
  };
  const scopes = loadScopes(cwd, effectiveOpts, selector);
  const adapters = new Map();
  const adapterForRepo = (repo) => {
    if (adapterOrFactory && typeof adapterOrFactory === 'function') return adapterOrFactory(repo);
    if (adapterOrFactory) return adapterOrFactory;
    if (!adapters.has(repo)) adapters.set(repo, new GhCliTaskIssueAdapter({ cwd, repo }));
    return adapters.get(repo);
  };

  const records = collectRecords(scopes, adapterForRepo);
  const allRecords = [...records.parents, ...records.tasks];
  const preflightErrors = allRecords.flatMap((record) => record.errors.map((err) => ({
    issue: record.issue_number,
    operation: err.operation,
    message: err.message,
  })));

  let selected = null;
  let action = null;
  let reconciliation = {
    ready: false,
    permission_required: false,
    plans: records.parents.filter((parent) => parent.reconciliation.ready).map(parentOutput),
  };

  if (opts.reconcile) {
    if (selector.mode === 'explicit') {
      const matches = resolveExplicitParent(selector, records.parents, records.tasks);
      if (matches.length === 1) {
        selected = parentOutput(matches[0]);
        action = selected.reconciliation?.ready ? 'preview_reconciliation_ready' : 'report_unworkable_reconciliation';
        reconciliation = {
          ready: Boolean(selected.reconciliation?.ready),
          permission_required: Boolean(selected.reconciliation?.ready),
          plans: [selected],
        };
      } else if (matches.length > 1) {
        selected = {
          kind: 'parent_plan',
          resolved: false,
          reconciliation: {
            ready: false,
            permission_required: false,
            reasons: [{
              code: 'selector_ambiguous',
              message: `Selector ${selector.raw} resolved to multiple parent plan issues: ${matches.map((parent) => `#${parent.issue_number}`).join(', ')}.`,
            }],
          },
        };
        action = 'report_unresolved_reconciliation_selector';
      } else {
        selected = {
          kind: 'parent_plan',
          resolved: false,
          reconciliation: {
            ready: false,
            permission_required: false,
            reasons: [{
              code: 'selector_not_found',
              message: `Selector ${selector.raw} did not match any exported parent plan issue in the loaded manifest scope.`,
            }],
          },
        };
        action = 'report_unresolved_reconciliation_selector';
      }
    } else {
      const reconcile = records.parents.filter((parent) => parent.reconciliation.ready).sort(compareParents)[0];
      if (reconcile) {
        selected = parentOutput(reconcile);
        action = 'request_reconciliation_permission';
        reconciliation = {
          ready: true,
          permission_required: true,
          plans: [selected],
        };
      } else {
        action = 'report_blocking_state';
      }
    }
  } else if (selector.mode === 'explicit') {
    const matches = resolveExplicitTask(selector, records.tasks, records.parents);
    if (matches.length === 1) {
      selected = taskOutput(matches[0]);
      action = selected.workability.workable ? 'report_workable_task' : 'report_unworkable_task';
    } else if (matches.length > 1) {
      selected = {
        kind: 'task',
        resolved: false,
        workability: {
          workable: false,
          reasons: [{
            code: 'selector_ambiguous',
            message: `Selector ${selector.raw} resolved to multiple task issues: ${matches.map((task) => `#${task.issue_number}`).join(', ')}.`,
          }],
          skipped_checks: [],
        },
      };
      action = 'report_unresolved_selector';
    } else {
      selected = {
        kind: 'task',
        resolved: false,
        workability: {
          workable: false,
          reasons: [{
            code: 'selector_not_found',
            message: `Selector ${selector.raw} did not match any exported child task issue in the loaded manifest scope.`,
          }],
          skipped_checks: [],
        },
      };
      action = 'report_unresolved_selector';
    }
  } else {
    const automatic = selectAutomatic(records.tasks, records.parents);
    if (automatic.kind === 'task') {
      selected = taskOutput(automatic.record);
      action = 'report_next_actionable_task';
    } else if (automatic.kind === 'reconciliation_permission') {
      selected = parentOutput(automatic.record);
      action = 'request_reconciliation_permission';
      reconciliation = {
        ready: true,
        permission_required: true,
        plans: [selected],
      };
    } else {
      action = 'report_blocking_state';
    }
  }

  return {
    ok: true,
    version: 1,
    mode: 'read-only',
    writes: false,
    implementation: false,
    pr_creation: false,
    selector,
    scope: scopes.map((scope) => ({
      repo: scope.repo,
      phase: scope.phase.phaseSlug,
      phase_number: scope.phase.phaseNumber,
      manifest: scope.manifest.path,
    })),
    preflight: {
      ok: preflightErrors.length === 0,
      checked_parent_plans: records.parents.length,
      checked_tasks: records.tasks.length,
      label_actions: labelActionSummaries(allRecords),
      errors: preflightErrors,
    },
    action,
    selected,
    reconciliation,
    blocking_state: selected ? null : blockingStateOutput(records.tasks, records.parents),
  };
}

function adapterFactoryFor(cwd, adapterOrFactory) {
  const adapters = new Map();
  return (repo) => {
    if (adapterOrFactory && typeof adapterOrFactory === 'function') return adapterOrFactory(repo);
    if (adapterOrFactory) return adapterOrFactory;
    if (!adapters.has(repo)) adapters.set(repo, new GhCliTaskIssueAdapter({ cwd, repo }));
    return adapters.get(repo);
  };
}

function loadExecutionState(cwd, opts, adapterOrFactory = null) {
  const selector = parseSelector(opts.selector);
  const effectiveOpts = {
    ...opts,
    repo: opts.repo || selector.repo || null,
  };
  const scopes = loadScopes(cwd, effectiveOpts, selector);
  const adapterForRepo = adapterFactoryFor(cwd, adapterOrFactory);
  const records = collectRecords(scopes, adapterForRepo);
  return {
    selector,
    scopes,
    adapterForRepo,
    records,
  };
}

function resolveExecutionSelection(selector, records) {
  if (selector.mode === 'explicit') {
    const matches = resolveExplicitTask(selector, records.tasks, records.parents);
    if (matches.length === 1) {
      const record = matches[0];
      if (record.kind === 'resolution_error') return { kind: 'unresolved', record };
      return { kind: 'task', record };
    }
    if (matches.length > 1) {
      return {
        kind: 'unresolved',
        record: {
          kind: 'resolution_error',
          workability: {
            workable: false,
            reasons: [{
              code: 'selector_ambiguous',
              message: `Selector ${selector.raw} resolved to multiple task issues: ${matches.map((task) => `#${task.issue_number}`).join(', ')}.`,
            }],
            skipped_checks: [],
          },
        },
      };
    }
    return {
      kind: 'unresolved',
      record: {
        kind: 'resolution_error',
        workability: {
          workable: false,
          reasons: [{
            code: 'selector_not_found',
            message: `Selector ${selector.raw} did not match any exported child task issue in the loaded manifest scope.`,
          }],
          skipped_checks: [],
        },
      },
    };
  }
  return selectAutomatic(records.tasks, records.parents);
}

function executeTaskRecord(cwd, record, adapter, deps = {}) {
  if (isCheckpointTask(record)) {
    throw new TaskExecutionError(
      `${record.task_id} is a human-in-the-loop checkpoint task and cannot be executed. Resolve it by closing the checkpoint issue after recording the human decision/result.`,
      'checkpoint_task_not_executable',
      { issue: record.issue_number, task_id: record.task_id },
    );
  }

  const claim = claimTaskIssue(adapter, record, deps);
  record.labels.virtual = claim.labels;
  record.labels.current = claim.labels;

  const worktree = ensureTaskWorktree(cwd, record, deps);
  const feedback = reviewFeedback(adapter, record);
  const attempts = [];
  let executorResult = null;
  let validation = null;
  let changedFiles = [];
  let executorEvidence = null;
  let previousFindings = null;
  const retryBudget = deps.retryBudget ?? DEFAULT_EXECUTOR_RETRY_BUDGET;

  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    const context = executorContext(record, worktree, feedback, previousFindings);
    executorResult = runTaskExecutor(context, deps);
    changedFiles = listChangedFiles(worktree, deps);
    validation = validateTask(worktree.path, record, changedFiles, deps);
    attempts.push({
      attempt: attempt + 1,
      executor: executorResult,
      changed_files: changedFiles,
      validation,
    });
    if (validation.ok) break;
    previousFindings = validation.failed;
  }

  executorEvidence = validateExecutorEvidence(worktree, executorResult, deps);
  if (!executorEvidence.ok) {
    const issue_update = markExecutorEvidenceFailedWithoutPr(adapter, record, validation, executorEvidence);
    return {
      action: 'validation_failed_no_pr',
      claim,
      worktree,
      review_feedback: feedback,
      attempts,
      changed_files: changedFiles,
      validation,
      executor_evidence: executorEvidence,
      useful_changes: false,
      pushed: null,
      pr: null,
      issue_update,
    };
  }

  const pushed = pushTaskBranch(worktree, deps);
  const ready = validation.ok;
  const pr = openOrUpdatePullRequest(adapter, record, worktree, validation, executorResult, ready);
  const issue_update = finalizeIssueAfterPr(adapter, record, pr, validation, ready);

  return {
    action: ready ? 'ready_pr_opened_or_updated' : 'draft_pr_opened_or_updated',
    claim,
    worktree,
    review_feedback: feedback,
    attempts,
    changed_files: changedFiles,
    validation,
    executor_evidence: executorEvidence,
    useful_changes: true,
    pushed,
    pr,
    issue_update,
  };
}

function ensureReconciliationWorktree(cwd, record, deps = {}) {
  if (deps.ensureReconciliationWorktree) return deps.ensureReconciliationWorktree({ cwd, record });

  const branch = record.branch_name || reconciliationBranchName(record.plan_id, record.issue_number);
  const root = deps.worktreeRoot || defaultWorktreeRoot(cwd);
  const worktreePath = path.join(root, safeWorktreeLeaf(branch));
  fs.mkdirSync(root, { recursive: true });

  const baseRef = defaultBranchRef(cwd);
  const existing = worktreeForBranch(cwd, branch);
  if (existing) {
    const status = runGit(existing.path, ['status', '--porcelain']).stdout;
    if (status) {
      throw new TaskExecutionError(`Reconciliation worktree ${existing.path} has uncommitted changes.`, 'dirty_reconciliation_worktree', { path: existing.path });
    }
    const rebase = runGit(existing.path, ['rebase', baseRef], { allowFailure: true });
    if (!rebase.ok) {
      runGit(existing.path, ['rebase', '--abort'], { allowFailure: true });
      throw new TaskExecutionError(`Could not rebase ${branch} onto ${baseRef}: ${rebase.stderr}`, 'reconciliation_branch_rebase_conflict');
    }
    return {
      path: existing.path,
      branch,
      base_ref: baseRef,
      reused: true,
    };
  }

  if (fs.existsSync(worktreePath)) {
    throw new TaskExecutionError(`Reconciliation worktree path already exists without matching branch: ${worktreePath}`, 'worktree_path_collision', { path: worktreePath });
  }

  if (branchExists(cwd, branch)) {
    runGit(cwd, ['worktree', 'add', worktreePath, branch]);
    const rebase = runGit(worktreePath, ['rebase', baseRef], { allowFailure: true });
    if (!rebase.ok) {
      runGit(worktreePath, ['rebase', '--abort'], { allowFailure: true });
      throw new TaskExecutionError(`Could not rebase ${branch} onto ${baseRef}: ${rebase.stderr}`, 'reconciliation_branch_rebase_conflict');
    }
  } else {
    runGit(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  }

  return {
    path: worktreePath,
    branch,
    base_ref: baseRef,
    reused: false,
  };
}

function runPlanVerification(worktreePath, record, deps = {}) {
  if (deps.runPlanVerification) return deps.runPlanVerification(worktreePath, record);
  const declaredVerification = String(record.plan.verification || '').trim();
  if (isResolvedCheckpointOnlyPlan(record)) {
    return {
      ok: true,
      skipped: true,
      skip_reason: 'resolved_human_checkpoint_only_plan',
      command: '',
      declared_verification: declaredVerification,
      status: 0,
      stdout: '',
      stderr: '',
    };
  }
  const command = declaredVerification;
  if (!command) {
    return {
      ok: true,
      skipped: true,
      skip_reason: 'no_plan_verification_declared',
      command: '',
      declared_verification: '',
      status: 0,
      stdout: '',
      stderr: '',
    };
  }
  const result = runShellCommand(command, worktreePath, deps);
  return {
    ok: result.status === 0,
    skipped: false,
    command,
    declared_verification: command,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error || '').trim(),
  };
}

function isResolvedCheckpointOnlyPlan(record) {
  const tasks = record?.tasks || [];
  return tasks.length > 0 &&
    tasks.every((task) => isCheckpointTask(task) && isResolvedCheckpointTask(task));
}

function singleLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function verificationCommandDisplay(verification) {
  if (verification.skipped && verification.skip_reason === 'resolved_human_checkpoint_only_plan') {
    return 'not run (resolved human checkpoint-only plan)';
  }
  return verification.command ? `\`${verification.command}\`` : 'not declared';
}

function appendVerificationDetails(lines, verification) {
  lines.push(
    `- Command: ${verificationCommandDisplay(verification)}`,
    `- Result: ${verification.ok ? 'passed' : 'failed'}`,
  );

  const declared = singleLine(verification.declared_verification);
  if (declared && declared !== verification.command) {
    lines.push(`- Declared verification: ${declared}`);
  }

  if (verification.skipped && verification.skip_reason === 'resolved_human_checkpoint_only_plan') {
    lines.push('- Note: resolved checkpoint issue closure satisfied plan verification.');
  } else if (verification.skipped) {
    lines.push('- Note: no plan-level verification command was declared.');
  }
}

function yamlInlineArray(items) {
  const values = (items || []).map((item) => String(item).trim()).filter(Boolean);
  if (values.length === 0) return '[]';
  return `[${values.join(', ')}]`;
}

function mergedPrRefs(record) {
  return record.tasks.flatMap((task) =>
    task.linked_prs.merged.map((pr) => ({
      task_id: task.task_id,
      issue: task.issue_number,
      pr: pr.number || null,
      url: pr.url || null,
      merged_at: pr.mergedAt || null,
    })),
  );
}

function renderReconciliationSummary(record, verification, deps = {}) {
  const completed = (deps.now ? deps.now() : new Date()).toISOString().split('T')[0];
  const taskCount = record.tasks.length;
  const prs = mergedPrRefs(record);
  const requirements = record.plan.requirements || [];
  const phase = record.scope.phase.phaseNumber || record.scope.phase.phaseSlug;
  const planPart = String(record.plan_id).split('-').slice(1).join('-') || record.plan_id;
  const title = `Phase ${phase} Plan ${planPart}: Issue-Driven Task Reconciliation Summary`;
  const lines = [
    '---',
    `phase: ${record.scope.phase.phaseSlug}`,
    `plan: ${record.plan_id}`,
    'subsystem: issue-driven-task-execution',
    'tags: [github-issues, task-reconciliation]',
    'requires: []',
    'provides: []',
    'affects: []',
    'tech-stack:',
    '  added: []',
    '  patterns: []',
    'key-files:',
    '  created: []',
    '  modified: []',
    'key-decisions: []',
    `requirements-completed: ${yamlInlineArray(requirements)}`,
    'duration: issue-driven',
    `completed: ${completed}`,
    '---',
    '',
    `# ${title}`,
    '',
    `Completed parent plan \`${record.plan_id}\` through exported GitHub task issues.`,
    '',
    '## Execution Summary',
    '',
    `- Parent issue: #${record.issue_number}`,
    `- Source plan: \`${sourcePathForPlan(record.plan)}\``,
    `- Tasks reconciled: ${taskCount}`,
    `- Requirements completed: ${requirements.length ? requirements.map((req) => `\`${req}\``).join(', ') : 'none declared'}`,
    '',
    '## Child Task Evidence',
    '',
  ];
  if (prs.length === 0) {
    lines.push('- No merged child task PRs were detected.');
  } else {
    for (const pr of prs) {
      const link = pr.url ? `[PR #${pr.pr}](${pr.url})` : `PR #${pr.pr || 'unknown'}`;
      lines.push(`- \`${pr.task_id}\` via task issue #${pr.issue}: ${link}`);
    }
  }
  lines.push(
    '',
    '## Plan Verification',
    '',
  );
  appendVerificationDetails(lines, verification);
  if (verification.stdout) lines.push('', '### Stdout', '', '```text', verification.stdout, '```');
  if (verification.stderr) lines.push('', '### Stderr', '', '```text', verification.stderr, '```');
  lines.push(
    '',
    '## Issues Encountered',
    '',
    'None.',
    '',
    '## Next',
    '',
    'Plan reconciliation complete. Continue with phase completion when every plan in this phase has a summary.',
    '',
  );
  return lines.join('\n');
}

function writeReconciliationSummary(worktreePath, record, verification, deps = {}) {
  const relPath = summaryPathForPlan(record.plan);
  const absPath = path.join(worktreePath, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const content = renderReconciliationSummary(record, verification, deps);
  fs.writeFileSync(absPath, `${content.replace(/\s+$/g, '')}\n`, 'utf8');
  return {
    path: relPath,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function runGtdSdkQuery(worktreePath, args, deps = {}) {
  if (deps.runGtdSdkQuery) return deps.runGtdSdkQuery(args, worktreePath);
  const sdkPath = path.resolve(__dirname, '..', '..', '..', 'bin', 'gtd-sdk.js');
  const useLocalShim = fs.existsSync(sdkPath);
  const result = childProcess.spawnSync(useLocalShim ? process.execPath : 'gtd-sdk', useLocalShim ? [sdkPath, 'query', ...args] : ['query', ...args], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    command: ['gtd-sdk', 'query', ...args].join(' '),
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error || '').trim(),
  };
}

function requireSdkOk(result) {
  if (result?.ok) return result;
  throw new TaskExecutionError(result?.stderr || `${result?.command || 'gtd-sdk query'} failed`, 'canonical_state_update_failed', result);
}

function updateCanonicalPlanState(worktreePath, record, deps = {}) {
  const phase = record.scope.phase.phaseNumber || record.scope.phase.phaseSlug;
  const planPart = String(record.plan_id).split('-').slice(1).join('-') || record.plan_id;
  const operations = [];
  const run = (args) => {
    const result = runGtdSdkQuery(worktreePath, args, deps);
    operations.push(result);
    requireSdkOk(result);
  };

  run(['state.advance-plan']);
  run(['state.update-progress']);
  run([
    'state.record-metric',
    '--phase',
    String(phase),
    '--plan',
    String(planPart),
    '--duration',
    'issue-driven',
    '--tasks',
    String(record.tasks.length),
    '--files',
    '0',
  ]);
  run(['roadmap.update-plan-progress', String(phase)]);
  if (record.plan.requirements?.length) {
    run(['requirements.mark-complete', ...record.plan.requirements]);
  }
  run([
    'state.record-session',
    '--stopped-at',
    `Completed ${record.plan_id}-PLAN.md via issue-driven reconciliation`,
    '--resume-file',
    'None',
  ]);

  return operations;
}

function commitReconciliationArtifacts(worktree, record, summary, deps = {}) {
  if (deps.commitReconciliationArtifacts) return deps.commitReconciliationArtifacts(worktree, record, summary);
  const candidates = [
    summary.path,
    '.planning/STATE.md',
    '.planning/ROADMAP.md',
    '.planning/REQUIREMENTS.md',
  ].filter((relPath) => fs.existsSync(path.join(worktree.path, relPath)));
  runGit(worktree.path, ['add', ...candidates]);
  const status = runGit(worktree.path, ['status', '--porcelain']).stdout;
  if (!status) {
    return {
      committed: false,
      pushed: false,
      files: candidates,
      message: 'No reconciliation artifact changes to commit.',
    };
  }
  const message = `Reconcile GTD plan ${record.plan_id}`;
  runGit(worktree.path, ['commit', '-m', message]);
  runGit(worktree.path, ['push', '--set-upstream', 'origin', worktree.branch]);
  return {
    committed: true,
    pushed: true,
    files: candidates,
    message,
  };
}

function reconciliationPrBody(record, summary, verification) {
  const lines = [
    `## GTD Plan Reconciliation`,
    '',
    `- Parent issue: #${record.issue_number}`,
    `- Plan ID: \`${record.plan_id}\``,
    `- Source plan: \`${sourcePathForPlan(record.plan)}\``,
    `- Summary: \`${summary.path}\``,
    '',
    '## Child Task Evidence',
    '',
  ];
  for (const task of record.tasks) {
    const prs = task.linked_prs.merged.map((pr) => pr.url || `#${pr.number}`).join(', ') || 'none';
    lines.push(`- \`${task.task_id}\`: Refs #${task.issue_number}; merged PRs ${prs}`);
  }
  lines.push(
    '',
    '## Verification',
    '',
  );
  appendVerificationDetails(lines, verification);
  lines.push('', `Closes #${record.issue_number}`);
  return lines.join('\n');
}

function openReconciliationPullRequest(adapter, record, worktree, summary, verification) {
  if (!adapter || typeof adapter.createPullRequest !== 'function') {
    throw new TaskExecutionError('GitHub PR creation is unavailable.', 'github_pr_unavailable');
  }
  return callWrite(`create_reconciliation_pull_request:${worktree.branch}`, () => adapter.createPullRequest({
    title: `[GTD ${record.plan_id}] Reconcile completed task issues`,
    body: reconciliationPrBody(record, summary, verification),
    head: worktree.branch,
    base: worktree.base_ref.replace(/^origin\//, ''),
    draft: false,
    labels: [],
  }));
}

function markReconciliationFailed(adapter, record, verification) {
  const labels = mergeLabelSet(record.labels.virtual, ['gtd:reconcile-failed'], [
    'gtd:ready-for-reconcile',
    'gtd:reconcile-pr-open',
    'gtd:ready',
  ]);
  setIssueLabels(adapter, record.issue_number, labels);
  commentIssue(adapter, record.issue_number, [
    'Parent plan reconciliation failed plan-level verification. Canonical GTD state was not updated.',
    '',
    `Command: ${verification.command ? `\`${verification.command}\`` : 'not declared'}`,
    `Status: ${verification.status}`,
    verification.stderr ? `\nStderr:\n\n\`\`\`text\n${verification.stderr}\n\`\`\`` : '',
    verification.stdout ? `\nStdout:\n\n\`\`\`text\n${verification.stdout}\n\`\`\`` : '',
  ].filter(Boolean).join('\n'));
  return {
    labels,
    comment_posted: true,
  };
}

function finalizeReconciliationIssue(adapter, record, pr) {
  const labels = mergeLabelSet(record.labels.virtual, ['gtd:reconcile-pr-open'], [
    'gtd:ready-for-reconcile',
    'gtd:reconcile-failed',
    'gtd:ready',
    'gtd:blocked',
  ]);
  setIssueLabels(adapter, record.issue_number, labels);
  commentIssue(adapter, record.issue_number, [
    'Parent plan reconciliation PR opened.',
    '',
    `PR: ${pr.url || `#${pr.number}`}`,
    '',
    'Canonical GTD artifacts will be considered complete after this PR is merged and synced.',
  ].join('\n'));
  return {
    labels,
    comment_posted: true,
  };
}

function executeReconciliationRecord(cwd, record, adapter, deps = {}) {
  if (!record.reconciliation.ready) {
    return {
      action: 'reconciliation_not_ready',
      reasons: record.reconciliation.reasons,
    };
  }
  const worktree = ensureReconciliationWorktree(cwd, record, deps);
  const verification = runPlanVerification(worktree.path, record, deps);
  if (!verification.ok) {
    const issue_update = markReconciliationFailed(adapter, record, verification);
    return {
      action: 'reconciliation_verification_failed',
      worktree,
      verification,
      summary: null,
      canonical_state: [],
      commit: null,
      pr: null,
      issue_update,
    };
  }

  const summary = writeReconciliationSummary(worktree.path, record, verification, deps);
  const canonicalState = updateCanonicalPlanState(worktree.path, record, deps);
  const commit = commitReconciliationArtifacts(worktree, record, summary, deps);
  const pr = openReconciliationPullRequest(adapter, record, worktree, summary, verification);
  const issue_update = finalizeReconciliationIssue(adapter, record, pr);

  return {
    action: 'reconciliation_pr_opened',
    worktree,
    verification,
    summary,
    canonical_state: canonicalState,
    commit,
    pr,
    issue_update,
  };
}

function resolveReconciliationSelection(selector, records) {
  if (selector.mode === 'explicit') {
    const matches = resolveExplicitParent(selector, records.parents, records.tasks);
    if (matches.length === 1) {
      const record = matches[0];
      if (record.kind === 'resolution_error') return { kind: 'unresolved', record };
      return { kind: 'reconciliation', record };
    }
    if (matches.length > 1) {
      return {
        kind: 'unresolved',
        record: {
          kind: 'resolution_error',
          reconciliation: {
            ready: false,
            permission_required: false,
            reasons: [{
              code: 'selector_ambiguous',
              message: `Selector ${selector.raw} resolved to multiple parent plan issues: ${matches.map((parent) => `#${parent.issue_number}`).join(', ')}.`,
            }],
          },
        },
      };
    }
    return {
      kind: 'unresolved',
      record: {
        kind: 'resolution_error',
        reconciliation: {
          ready: false,
          permission_required: false,
          reasons: [{
            code: 'selector_not_found',
            message: `Selector ${selector.raw} did not match any exported parent plan issue in the loaded manifest scope.`,
          }],
        },
      },
    };
  }
  const ready = records.parents.filter((parent) => parent.reconciliation.ready).sort(compareParents)[0];
  if (ready) return { kind: 'reconciliation', record: ready };
  return { kind: 'none', record: null };
}

function phaseSummaryStatus(cwd, phaseArg) {
  const source = loadExportSource(cwd, { phase: phaseArg });
  const plans = source.plans.map((plan) => {
    const summary = summaryPathForPlan(plan);
    return {
      plan_id: plan.id,
      source_path: sourcePathForPlan(plan),
      summary_path: summary,
      summary_exists: fs.existsSync(path.join(cwd, summary)),
    };
  });
  return {
    phase: source.phase.phaseSlug,
    phase_number: source.phase.phaseNumber,
    manifest: source.manifest.path,
    plan_count: plans.length,
    summary_count: plans.filter((plan) => plan.summary_exists).length,
    plans,
    missing_summaries: plans.filter((plan) => !plan.summary_exists),
  };
}

function buildCompletePhaseTail(cwd, opts, deps = {}) {
  const status = phaseSummaryStatus(cwd, opts.completePhase);
  const ready = status.missing_summaries.length === 0 && status.plan_count > 0;
  const phaseRef = status.phase_number || status.phase;
  const finalizationCommand = `${formatGtdSlashFor(cwd, 'work-task-issue')} --complete-phase ${phaseRef} --execute`;
  const base = {
    ok: true,
    version: 1,
    mode: opts.mode || 'read-only',
    writes: false,
    implementation: false,
    pr_creation: false,
    action: null,
    phase_completion: {
      ready,
      ...status,
      finalization_command: finalizationCommand,
      finalization_scope: 'post_phase_gates_only',
      required_gates: [
        'code-review',
        'regression',
        'schema-drift',
        'codebase-drift',
        'gtd-verifier',
        'phase.complete',
      ],
      next_verify_work_command: ready
        ? `${formatGtdSlashFor(cwd, 'verify-work')} ${phaseRef}`
        : null,
    },
  };

  if (!ready) {
    return {
      ...base,
      action: 'phase_completion_blocked_missing_summaries',
    };
  }
  if (opts.mode !== 'execute') {
    return {
      ...base,
      action: 'preview_phase_completion_finalization',
    };
  }
  const runFinalization = deps.runPhaseFinalization || deps.runPhaseCompletionTail;
  if (runFinalization) {
    const execution = runFinalization(cwd, {
      ...status,
      finalization_command: finalizationCommand,
      finalization_scope: 'post_phase_gates_only',
      required_gates: base.phase_completion.required_gates,
    });
    return {
      ...base,
      writes: Boolean(execution?.writes),
      action: execution?.action || 'phase_completion_finalization_executed',
      execution,
    };
  }
  return {
    ...base,
    action: 'phase_completion_finalization_requires_workflow_gates',
    note: `Continue through ${finalizationCommand}; this path runs only post-phase finalization gates and does not rerun implementation tasks.`,
  };
}

function buildExecution(cwd, opts, adapterOrFactory = null, deps = {}) {
  if (opts.completePhase) return buildCompletePhaseTail(cwd, opts, deps);
  const state = loadExecutionState(cwd, opts, adapterOrFactory);
  const allRecords = [...state.records.parents, ...state.records.tasks];
  const readErrors = allRecords.flatMap((record) => record.errors.map((err) => ({
    issue: record.issue_number,
    operation: err.operation,
    message: err.message,
  })));
  const labelSync = applyStateSync(state.records, state.adapterForRepo, cwd);
  const selection = opts.reconcile
    ? resolveReconciliationSelection(state.selector, state.records)
    : resolveExecutionSelection(state.selector, state.records);
  const reconciliation = {
    ready: false,
    permission_required: false,
    plans: state.records.parents.filter((parent) => parent.reconciliation.ready).map(parentOutput),
  };

  const base = {
    ok: true,
    version: 1,
    mode: 'execute',
    writes: true,
    implementation: false,
    pr_creation: false,
    selector: state.selector,
    scope: state.scopes.map((scope) => ({
      repo: scope.repo,
      phase: scope.phase.phaseSlug,
      phase_number: scope.phase.phaseNumber,
      manifest: scope.manifest.path,
    })),
    preflight: {
      ok: readErrors.length === 0,
      checked_parent_plans: state.records.parents.length,
      checked_tasks: state.records.tasks.length,
      label_sync: labelSync,
      errors: readErrors,
    },
    reconciliation,
    blocking_state: null,
    selected: null,
    execution: null,
    action: null,
  };

  if (selection.kind === 'task') {
    const record = selection.record;
    base.selected = taskOutput(record);
    if (!record.workability.workable) {
      base.action = 'report_unworkable_task';
      return base;
    }
    const adapter = state.adapterForRepo(record.scope.repo);
    base.execution = executeTaskRecord(cwd, record, adapter, deps);
    base.implementation = true;
    base.pr_creation = Boolean(base.execution.pr);
    base.action = base.execution.action;
    return base;
  }

  if (selection.kind === 'reconciliation') {
    const record = selection.record;
    base.selected = parentOutput(record);
    base.reconciliation = {
      ready: record.reconciliation.ready,
      permission_required: false,
      plans: [base.selected],
    };
    if (!record.reconciliation.ready) {
      base.action = 'report_unworkable_reconciliation';
      return base;
    }
    const adapter = state.adapterForRepo(record.scope.repo);
    base.execution = executeReconciliationRecord(cwd, record, adapter, deps);
    base.implementation = false;
    base.pr_creation = Boolean(base.execution.pr);
    base.action = base.execution.action;
    return base;
  }

  if (selection.kind === 'reconciliation_permission') {
    const selected = parentOutput(selection.record);
    base.selected = selected;
    base.action = 'request_reconciliation_permission';
    base.reconciliation = {
      ready: true,
      permission_required: true,
      plans: [selected],
    };
    return base;
  }

  if (selection.kind === 'unresolved') {
    base.selected = opts.reconcile ? parentOutput(selection.record) : taskOutput(selection.record);
    base.action = 'report_unresolved_selector';
    return base;
  }

  base.action = 'report_blocking_state';
  base.blocking_state = blockingStateOutput(state.records.tasks, state.records.parents);
  return base;
}

class GhCliTaskIssueAdapter {
  constructor({ cwd, repo }) {
    this.cwd = cwd;
    this.repo = repo;
  }

  runGh(args, input = null, operation = null, allow404 = false) {
    return runGhCommand({
      cwd: this.cwd,
      args,
      input,
      operation,
      allow404,
      ErrorClass: GitHubTaskIssueError,
      missingGhMessage: 'GitHub CLI `gh` was not found; install and authenticate gh before running work-task-issue.',
    });
  }

  api(method, endpoint, body = null, operation = null, allow404 = false) {
    return ghApi({
      cwd: this.cwd,
      repo: this.repo,
      method,
      endpoint,
      body,
      operation,
      allow404,
      ErrorClass: GitHubTaskIssueError,
      missingGhMessage: 'GitHub CLI `gh` was not found; install and authenticate gh before running work-task-issue.',
    });
  }

  repoEndpoint(suffix) {
    return ghRepoEndpoint(this.repo, suffix);
  }

  getIssue(number) {
    return this.api('GET', this.repoEndpoint(`issues/${number}`), null, `get_issue:${number}`, true);
  }

  setIssueLabels(number, labels) {
    return this.api('PATCH', this.repoEndpoint(`issues/${number}`), { labels }, `set_issue_labels:${number}`);
  }

  updateIssueState(number, state) {
    return this.api('PATCH', this.repoEndpoint(`issues/${number}`), { state }, `update_issue_state:${number}:${state}`);
  }

  commentIssue(number, body) {
    return this.api('POST', this.repoEndpoint(`issues/${number}/comments`), { body }, `comment_issue:${number}`);
  }

  listBlockedBy(issueNumber) {
    return this.api('GET', this.repoEndpoint(`issues/${issueNumber}/dependencies/blocked_by?per_page=100`), null, `list_blocked_by:${issueNumber}`);
  }

  listPullRequestsForIssue(issueNumber, branchName) {
    const fields = 'number,title,state,isDraft,mergedAt,headRefName,url,reviewDecision,body';
    const queries = [
      `Closes #${issueNumber}`,
      `Fixes #${issueNumber}`,
      `Resolves #${issueNumber}`,
      branchName ? `head:${branchName}` : null,
    ].filter(Boolean);
    const prs = [];

    for (const query of queries) {
      const stdout = this.runGh([
        'pr',
        'list',
        '--repo',
        this.repo,
        '--state',
        'all',
        '--limit',
        '50',
        '--search',
        query,
        '--json',
        fields,
      ], null, `list_pull_requests_for_issue:${issueNumber}`);
      const parsed = stdout ? JSON.parse(stdout) : [];
      for (const pr of parsed) {
        const body = String(pr.body || '');
        if (
          pr.headRefName === branchName ||
          body.includes(`#${issueNumber}`) ||
          body.includes(`/${issueNumber}`)
        ) {
          prs.push(pr);
        }
      }
    }

    return dedupePrs(prs);
  }

  listPullRequestFeedback(prNumber) {
    const stdout = this.runGh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      this.repo,
      '--comments',
      '--json',
      'comments,reviews',
    ], null, `list_pull_request_feedback:${prNumber}`);
    const parsed = stdout ? JSON.parse(stdout) : {};
    const comments = (parsed.comments || []).map((comment) => ({
      kind: 'comment',
      author: comment.author?.login || null,
      body: comment.body || '',
      createdAt: comment.createdAt || null,
    }));
    const reviews = (parsed.reviews || []).map((review) => ({
      kind: 'review',
      author: review.author?.login || null,
      state: review.state || null,
      body: review.body || '',
      submittedAt: review.submittedAt || null,
    }));
    const reviewComments = this.api(
      'GET',
      this.repoEndpoint(`pulls/${prNumber}/comments?per_page=100`),
      null,
      `list_pull_request_review_comments:${prNumber}`,
      true,
    ) || [];
    return [
      ...comments,
      ...reviews,
      ...reviewComments.map((comment) => ({
        kind: 'review_comment',
        author: comment.user?.login || null,
        body: comment.body || '',
        path: comment.path || null,
        line: comment.line || comment.original_line || null,
        createdAt: comment.created_at || null,
      })),
    ];
  }

  viewPullRequest(numberOrUrl) {
    const stdout = this.runGh([
      'pr',
      'view',
      String(numberOrUrl),
      '--repo',
      this.repo,
      '--json',
      'number,title,state,isDraft,mergedAt,headRefName,baseRefName,url,reviewDecision,body',
    ], null, `view_pull_request:${numberOrUrl}`);
    return stdout ? normalizePr(JSON.parse(stdout)) : null;
  }

  listPullRequestCommits(prNumber) {
    const stdout = this.runGh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      this.repo,
      '--json',
      'commits',
    ], null, `list_pull_request_commits:${prNumber}`);
    const parsed = stdout ? JSON.parse(stdout) : {};
    return (parsed.commits || []).map((commit) => ({
      oid: commit.oid || commit.sha || null,
      messageHeadline: commit.messageHeadline || '',
      messageBody: commit.messageBody || '',
      authors: commit.authors || [],
    }));
  }

  listPullRequestChecks(prNumber) {
    const stdout = this.runGh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      this.repo,
      '--json',
      'statusCheckRollup',
    ], null, `list_pull_request_checks:${prNumber}`);
    const parsed = stdout ? JSON.parse(stdout) : {};
    return (parsed.statusCheckRollup || []).map((check) => ({
      name: check.name || check.context || '',
      status: check.status || '',
      conclusion: check.conclusion || '',
      state: check.state || '',
    }));
  }

  createPullRequest({ title, body, head, base, draft, labels }) {
    return withTemporaryPrBodyFile(body, (bodyFile) => {
      const args = [
        'pr',
        'create',
        '--repo',
        this.repo,
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ];
      if (draft) args.push('--draft');
      for (const label of labels || []) args.push('--label', label);
      const url = this.runGh(args, null, `create_pull_request:${head}`);
      return this.viewPullRequest(url);
    });
  }

  updatePullRequest(number, { title, body, draft, labels }) {
    withTemporaryPrBodyFile(body, (bodyFile) => {
      const args = [
        'pr',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ];
      for (const label of labels || []) args.push('--add-label', label);
      this.runGh(args, null, `update_pull_request:${number}`);
    });
    if (draft === false) {
      this.runGh(['pr', 'ready', String(number), '--repo', this.repo], null, `mark_pull_request_ready:${number}`, true);
    }
    return this.viewPullRequest(number);
  }

  reopenPullRequest(number) {
    this.runGh(['pr', 'reopen', String(number), '--repo', this.repo], null, `reopen_pull_request:${number}`);
    return this.viewPullRequest(number);
  }

  mergePullRequest(number, { method = 'squash', subject = null, body = null } = {}) {
    const args = [
      'pr',
      'merge',
      String(number),
      '--repo',
      this.repo,
    ];
    if (method === 'squash') args.push('--squash');
    else if (method === 'merge') args.push('--merge');
    else if (method === 'rebase') args.push('--rebase');
    if (subject) args.push('--subject', subject);
    if (body) args.push('--body', body);
    this.runGh(args, null, `merge_pull_request:${number}`);
    return this.viewPullRequest(number);
  }
}

function cmdWorkTaskIssue(cwd, args, raw) {
  const opts = parseArgs(args);
  try {
    output(opts.mode === 'execute' ? buildExecution(cwd, opts) : buildReadOnly(cwd, opts), raw);
  } catch (err) {
    error(err.message || String(err), ERROR_REASON.UNKNOWN);
  }
}

module.exports = {
  buildExecution,
  buildReadOnly,
  cmdWorkTaskIssue,
  GhCliTaskIssueAdapter,
  GitHubTaskIssueError,
  TaskExecutionError,
  executorContext,
  executeReconciliationRecord,
  loadExecutionState,
  taskOutput,
  parentOutput,
  compareRecords,
  resolveExplicitParent,
  buildCompletePhaseTail,
  validateDiffScope,
  validateExecutorEvidence,
  validateTask,
  parseArgs,
  parseSelector,
};

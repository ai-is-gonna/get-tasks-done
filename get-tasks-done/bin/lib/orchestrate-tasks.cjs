'use strict';

/**
 * Bulk task orchestration for exported GitHub task issues.
 *
 * The deterministic library path owns task selection, reviewability gating,
 * branch/PR safety checks, compact manifest state, and final PR assembly. The
 * interactive workflow can still use runtime agents for real parallel work, but
 * it must follow the same contracts this module enforces.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  ERROR_REASON,
  error,
  isGitIgnored,
  loadConfig,
  output,
  toPosixPath,
} = require('./core.cjs');
const { planningDir } = require('./planning-workspace.cjs');
const { runGitCommand } = require('./git-runner.cjs');
const { normalizeGitHubRepo } = require('./github-repo.cjs');
const {
  TASK_ID_RE,
  isIssueOpen: issueIsOpen,
  issueLabels,
  mergeLabelSet,
  normalizeRepoPath,
  readJsonIfExists,
} = require('./task-issue-shared.cjs');
const {
  GhCliTaskIssueAdapter,
  TaskExecutionError,
  compareRecords,
  executorContext,
  loadExecutionState,
  parentOutput,
  validateExecutorEvidence,
  validateTask,
} = require('./work-task-issue.cjs');

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_EXECUTOR_BACKEND = 'agent';
const DEFAULT_EXECUTOR_COMMAND = 'gtd-task-executor';
const DEFAULT_REVIEW_THRESHOLDS = Object.freeze({
  tasks: 5,
  files: 20,
  changed_loc: 800,
  subsystems: 2,
  manual_checks: 12,
});

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+\b/i;

function usage() {
  return 'Usage: gtd-tools orchestrate-tasks <issue-number> [<issue-number> ...] [--repo owner/name] [--max-concurrency N] [--dry-run] [--resume <id>] [--allow-partial]';
}

function normalizeRepo(repo) {
  const value = normalizeGitHubRepo(repo);
  if (!value) {
    error(`Invalid GitHub repository "${repo}". Expected owner/name.`, ERROR_REASON.USAGE);
  }
  return value;
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    error(`${flag} must be a positive integer.`, ERROR_REASON.USAGE);
  }
  return value;
}

function parseArgs(args) {
  const opts = {
    issueNumbers: [],
    repo: null,
    dryRun: false,
    resume: null,
    allowPartial: false,
    confirmPartial: false,
    confirmReviewability: false,
    executorBackend: DEFAULT_EXECUTOR_BACKEND,
    executorCommand: null,
    maxConcurrency: null,
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--phase') {
      error('orchestrate-tasks no longer accepts --phase. Resolve the desired scope to exact child issue numbers before calling this helper.', ERROR_REASON.USAGE);
    } else if (arg === '--repo') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.repo = normalizeRepo(value);
      i += 1;
    } else if (arg === '--max-concurrency') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.maxConcurrency = parsePositiveInt(value, '--max-concurrency');
      i += 1;
    } else if (arg === '--resume') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.resume = value;
      i += 1;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--allow-partial') {
      opts.allowPartial = true;
    } else if (arg === '--confirm-partial') {
      opts.confirmPartial = true;
    } else if (arg === '--confirm-reviewability') {
      opts.confirmReviewability = true;
    } else if (arg === '--executor-backend') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      if (!['agent', 'command'].includes(value)) {
        error('--executor-backend must be "agent" or "command".', ERROR_REASON.USAGE);
      }
      opts.executorBackend = value;
      i += 1;
    } else if (arg === '--executor-command') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) error(usage(), ERROR_REASON.USAGE);
      opts.executorCommand = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      error(`Unknown orchestrate-tasks flag: ${arg}`, ERROR_REASON.USAGE);
    } else {
      opts.issueNumbers.push(parseIssueNumberToken(arg));
    }
  }

  opts.issueNumbers = [...new Set(opts.issueNumbers)];
  if (!opts.resume && opts.issueNumbers.length === 0) {
    error('orchestrate-tasks requires at least one child issue number. Resolve the task scope before calling this helper.', ERROR_REASON.USAGE);
  }
  return opts;
}

function parseIssueNumberToken(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^#?(\d+)$/);
  if (match) {
    return parsePositiveInt(match[1], 'issue number');
  }
  if (/^https?:\/\/github\.com\//i.test(text)) {
    error('orchestrate-tasks accepts only issue numbers, not issue URLs. Resolve URLs to child issue numbers before calling this helper.', ERROR_REASON.USAGE);
  }
  if (TASK_ID_RE.test(text)) {
    error('orchestrate-tasks accepts only GitHub child issue numbers, not task IDs. Resolve task IDs before calling this helper.', ERROR_REASON.USAGE);
  }
  if (/^(?:tasks?|next|phase)$/i.test(text) || /\s/.test(text)) {
    error('orchestrate-tasks accepts only exact child issue numbers. Resolve natural-language task selectors in the skill layer first.', ERROR_REASON.USAGE);
  }
  error(`Invalid orchestrate-tasks issue "${raw}". Expected issue numbers like 123 or #123.`, ERROR_REASON.USAGE);
}

function issueSelector(issueNumbers) {
  const numbers = [...new Set((issueNumbers || []).map((issue) => Number(issue)))].filter(Boolean);
  return {
    mode: 'issues',
    raw: numbers.map((issue) => `#${issue}`).join(' '),
    issue_numbers: numbers,
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

function resolveIssueRecords(selector, tasks, parents) {
  const selected = [];
  const errors = [];
  const seen = new Set();

  for (const issue of selector.issue_numbers || []) {
    const raw = `#${issue}`;
    const matches = tasks.filter((task) => Number(task.issue_number) === Number(issue));
    if (matches.length === 0 && parents.some((parent) => Number(parent.issue_number) === Number(issue))) {
      errors.push({
        selector: raw,
        code: 'selector_resolved_parent_plan',
        message: `Issue ${raw} resolves to a parent plan issue, not a child task issue.`,
      });
      continue;
    }

    if (matches.length === 0) {
      errors.push({
        selector: raw,
        code: 'selector_not_found',
        message: `Issue ${raw} did not match any exported child task issue in the loaded scope.`,
      });
      continue;
    }
    if (matches.length > 1) {
      errors.push({
        selector: raw,
        code: 'selector_ambiguous',
        message: `Issue ${raw} matched multiple task issues: ${matches.map((task) => `#${task.issue_number}`).join(', ')}.`,
      });
      continue;
    }

    const record = matches[0];
    if (!seen.has(record.task_id)) {
      selected.push(record);
      seen.add(record.task_id);
    }
  }

  return { selected: selected.sort(compareRecords), errors };
}

function recordLabels(record) {
  return new Set(record?.labels?.virtual || record?.labels?.current || []);
}

function isCheckpointRecord(record) {
  if (!record) return false;
  const labels = recordLabels(record);
  const type = String(record.task?.type || record.manifest_entry?.type || '').toLowerCase();
  return type.startsWith('checkpoint:') ||
    labels.has('gtd:checkpoint') ||
    labels.has('type:checkpoint');
}

function isResolvedCheckpointRecord(record) {
  return isCheckpointRecord(record) && record.issue && !issueIsOpen(record.issue);
}

function blockerKeys(issue) {
  return [
    issue?.id ? `id:${issue.id}` : null,
    issue?.number ? `number:${Number(issue.number)}` : null,
  ].filter(Boolean);
}

function selectedIssueKeyMap(records) {
  const map = new Map();
  for (const record of records) {
    if (record.issue?.id) map.set(`id:${record.issue.id}`, record);
    if (record.issue_number) map.set(`number:${Number(record.issue_number)}`, record);
  }
  return map;
}

function internalBlockersFor(record, selectedMap = selectedIssueKeyMap([record])) {
  const blockers = [];
  const seen = new Set();
  for (const blocker of record.open_blockers || []) {
    for (const key of blockerKeys(blocker)) {
      const selected = selectedMap.get(key);
      if (!selected || selected.task_id === record.task_id || seen.has(selected.task_id)) continue;
      blockers.push(selected);
      seen.add(selected.task_id);
    }
  }
  return blockers.sort(compareRecords);
}

function externalBlockersFor(record, selectedMap) {
  return (record.open_blockers || [])
    .filter((blocker) => !blockerKeys(blocker).some((key) => selectedMap.has(key)))
    .map((blocker) => Number(blocker.number))
    .filter(Boolean)
    .sort((a, b) => a - b);
}

function reasonWithExternalBlockers(reason, blockers) {
  return {
    ...reason,
    blockers,
    message: blockers.length
      ? `${reason.message} External blocker(s) outside the selected orchestration scope: ${blockers.map((n) => `#${n}`).join(', ')}.`
      : reason.message,
  };
}

function isSoftCheckpointReason(reason) {
  const code = reason?.code;
  if (code === 'checkpoint_human_resolution' || code === 'not_actionable' || code === 'issue_closed') {
    return true;
  }
  if (code === 'blocking_task_labels') {
    const labels = reason.labels || [];
    return labels.length > 0 && labels.every((label) => label === 'gtd:blocked-human');
  }
  return false;
}

function classifySelectedRecords(selected) {
  const selectedMap = selectedIssueKeyMap(selected);
  const nonWorkable = [];
  const internalBlocked = [];

  for (const record of selected) {
    const checkpoint = isCheckpointRecord(record);
    const internalBlockers = internalBlockersFor(record, selectedMap);
    const externalBlockers = externalBlockersFor(record, selectedMap);
    const hardReasons = [];
    let hasInternalTaskBlocker = false;

    for (const reason of record.workability?.reasons || []) {
      if (reason.code === 'open_task_blockers') {
        if (internalBlockers.length > 0) hasInternalTaskBlocker = true;
        if (externalBlockers.length > 0) hardReasons.push(reasonWithExternalBlockers(reason, externalBlockers));
        continue;
      }
      if (reason.code === 'not_actionable' && internalBlockers.length > 0 && externalBlockers.length === 0) {
        hasInternalTaskBlocker = true;
        continue;
      }
      if (checkpoint && isSoftCheckpointReason(reason)) {
        continue;
      }
      hardReasons.push(reason);
    }

    if (hasInternalTaskBlocker) {
      internalBlocked.push({
        task_id: record.task_id,
        issue: record.issue_number,
        blocked_by: internalBlockers.map((blocker) => ({
          task_id: blocker.task_id,
          issue: blocker.issue_number,
        })),
      });
    }

    if (hardReasons.length > 0) {
      nonWorkable.push({
        task_id: record.task_id,
        issue: record.issue_number,
        reasons: hardReasons,
      });
    }
  }

  return { non_workable: nonWorkable, internal_blocked: internalBlocked };
}

function checkpointGateFor(record, selectedMap = selectedIssueKeyMap([record])) {
  const blockers = internalBlockersFor(record, selectedMap).map((blocker) => ({
    task_id: blocker.task_id,
    issue: blocker.issue_number,
  }));
  let status = 'pending';
  if (isResolvedCheckpointRecord(record)) status = 'resolved';
  else if (blockers.length > 0) status = 'waiting_dependencies';
  return {
    task_id: record.task_id,
    issue: record.issue_number,
    status,
    depends_on: blockers,
    blocked_by: blockers,
    hard_signal: 'issue_closed',
  };
}

function checkpointGatesFor(records) {
  const selectedMap = selectedIssueKeyMap(records);
  return records
    .filter(isCheckpointRecord)
    .map((record) => checkpointGateFor(record, selectedMap));
}

function checkpointGateStatusFromManifest(status) {
  if (status === 'checkpoint_resolved') return 'resolved';
  if (status === 'checkpoint_waiting_human') return 'pending';
  return 'waiting_dependencies';
}

function checkpointGatesForManifest(records, manifest) {
  return checkpointGatesFor(records).map((gate) => {
    const status = manifest.tasks?.[gate.task_id]?.status;
    return status ? { ...gate, status: checkpointGateStatusFromManifest(status) } : gate;
  });
}

function checkpointIssueSummariesFromGates(gates, { includeResolved = false } = {}) {
  return (gates || [])
    .filter((gate) => includeResolved || gate.status !== 'resolved')
    .map((gate) => ({
      task_id: gate.task_id,
      issue: gate.issue,
      status: gate.status,
    }));
}

function checkpointIssueSummariesFromSync(entries) {
  return (entries || []).map((entry) => ({
    task_id: entry.task_id,
    issue: entry.issue,
    status: checkpointGateStatusFromManifest(entry.status),
  }));
}

function checkpointIssuePhrase(checkpointIssues) {
  const refs = (checkpointIssues || [])
    .map((entry) => entry.issue ? `#${entry.issue}` : null)
    .filter(Boolean);
  if (refs.length === 0) return 'the checkpoint issue';
  if (refs.length === 1) return `checkpoint issue ${refs[0]}`;
  return `checkpoint issues ${refs.join(', ')}`;
}

function checkpointUserNextStep(kind, checkpointIssues) {
  const phrase = checkpointIssuePhrase(checkpointIssues);
  const plural = (checkpointIssues || []).length > 1;
  let message;
  if (kind === 'human_checkpoint_required') {
    message = `Complete the instructions in ${phrase}, close ${plural ? 'those issues' : 'the issue'} when done, then tell me to continue here. I will continue the orchestration from the recorded state.`;
  } else if (kind === 'human_checkpoint_pending') {
    message = `${phrase[0].toUpperCase()}${phrase.slice(1)} ${plural ? 'are' : 'is'} still open. Complete ${plural ? 'their' : 'its'} instructions, close ${plural ? 'those issues' : 'the issue'}, then tell me to continue here. I will handle the recorded orchestration state.`;
  } else if (kind === 'human_checkpoint_resolved') {
    message = `${phrase[0].toUpperCase()}${phrase.slice(1)} ${plural ? 'are' : 'is'} closed. I can continue the orchestration from the recorded state without asking you to run any command.`;
  } else {
    message = `Review ${phrase} and tell me to continue here when it is closed.`;
  }
  return {
    kind,
    message,
    checkpoint_issues: checkpointIssues,
  };
}

function selectRecords(selector, records) {
  const tasks = records.tasks;
  const parents = records.parents;
  const explicit = resolveIssueRecords(selector, tasks, parents);
  const selected = explicit.selected;
  const errors = explicit.errors;

  const selectedState = classifySelectedRecords(selected);

  return {
    selected,
    errors,
    non_workable: selectedState.non_workable,
    internal_blocked: selectedState.internal_blocked,
  };
}

function dependencyOrderFor(internalBlocked) {
  return (internalBlocked || []).map((entry) => ({
    task_id: entry.task_id,
    issue: entry.issue,
    depends_on: (entry.blocked_by || []).map((dependency) => ({
      task_id: dependency.task_id,
      issue: dependency.issue,
    })),
  }));
}

function reviewabilityDecisionOptions(reviewability) {
  if (!reviewability?.requires_confirmation) return [];
  return [
    {
      id: 'continue_full_scope',
      label: 'Continue with full selected scope',
      effect: 'Rerun the same exact issue list with --confirm-reviewability. Internal dependencies remain scheduled in waves; checkpoint gates remain in scope as pause points.',
    },
    {
      id: 'choose_smaller_scope',
      label: 'Choose a smaller explicit scope',
      effect: 'Resolve the smaller scope to exact child issue numbers and rerun the Start Gate. The recommended_subset is advisory input for this option only.',
    },
    {
      id: 'abort',
      label: 'Abort orchestration',
      effect: 'Stop without creating branches, issue claims, PRs, executors, or manifests.',
    },
  ];
}

function pathOverlaps(a, b) {
  const left = normalizeRepoPath(a);
  const right = normalizeRepoPath(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function taskScopes(record) {
  return (record.task.files || []).map(normalizeRepoPath).filter(Boolean);
}

function recordsOverlap(a, b) {
  if (a.plan_id === b.plan_id) return true;
  const aScopes = taskScopes(a);
  const bScopes = taskScopes(b);
  if (aScopes.length === 0 || bScopes.length === 0) return true;
  return aScopes.some((left) => bScopes.some((right) => pathOverlaps(left, right)));
}

function buildWaves(records, maxConcurrency = DEFAULT_MAX_CONCURRENCY) {
  const selectedMap = selectedIssueKeyMap(records);
  const internalDeps = new Map(records.map((record) => [
    record.task_id,
    internalBlockersFor(record, selectedMap).map((blocker) => blocker.task_id),
  ]));
  const waves = [];
  const remaining = [...records].sort(compareRecords);
  const completed = new Set();

  while (remaining.length > 0) {
    const wave = [];
    for (const record of remaining) {
      const deps = internalDeps.get(record.task_id) || [];
      if (deps.some((dep) => !completed.has(dep))) continue;
      if (wave.length >= maxConcurrency) continue;
      if (wave.some((existing) => recordsOverlap(existing, record))) continue;
      wave.push(record);
    }

    const selected = wave.length > 0 ? wave : [remaining[0]];
    waves.push({ records: selected });
    for (const record of selected) {
      completed.add(record.task_id);
      const index = remaining.findIndex((candidate) => candidate.task_id === record.task_id);
      if (index >= 0) remaining.splice(index, 1);
    }
  }

  return waves.map((wave, index) => ({
    index: index + 1,
    parallel_tasks: wave.records.map((record) => record.task_id),
    records: wave.records,
  }));
}

function loadReviewThresholds(cwd) {
  const config = readJsonIfExists(path.join(planningDir(cwd), 'config.json')) || {};
  const fromConfig = config.orchestrate_tasks?.review_thresholds || config.workflow?.orchestrate_tasks?.review_thresholds || {};
  return {
    tasks: Number(fromConfig.tasks || DEFAULT_REVIEW_THRESHOLDS.tasks),
    files: Number(fromConfig.files || DEFAULT_REVIEW_THRESHOLDS.files),
    changed_loc: Number(fromConfig.changed_loc || DEFAULT_REVIEW_THRESHOLDS.changed_loc),
    subsystems: Number(fromConfig.subsystems || DEFAULT_REVIEW_THRESHOLDS.subsystems),
    manual_checks: Number(fromConfig.manual_checks || DEFAULT_REVIEW_THRESHOLDS.manual_checks),
  };
}

function listFilesUnder(absPath, limit = 200) {
  const out = [];
  function walk(current) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(next);
      if (out.length >= limit) return;
    }
  }
  walk(absPath);
  return out;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function scopeFileStats(cwd, scope) {
  const rel = normalizeRepoPath(scope);
  if (!rel) return { files: [], loc: 0, generated_risk: false };
  const abs = path.join(cwd, rel);
  const generatedRisk = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|schema\.prisma|migrations?|generated|snapshots?|__snapshots__)(\/|$)/i.test(rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const files = listFilesUnder(abs);
    return {
      files: files.map((file) => normalizeRepoPath(path.relative(cwd, file))),
      loc: files.reduce((sum, file) => sum + countLines(file), 0),
      generated_risk: generatedRisk,
    };
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return {
      files: [rel],
      loc: countLines(abs),
      generated_risk: generatedRisk,
    };
  }
  return {
    files: [rel],
    loc: 0,
    generated_risk: generatedRisk,
  };
}

function estimateChangedLocForScope(stat) {
  if (stat.loc <= 0) return 80;
  return Math.max(40, Math.min(300, Math.ceil(stat.loc * 0.35)));
}

function manualCheckCount(record) {
  const acceptance = record.task.acceptance_criteria?.length || 0;
  const manual = (record.task.validation_contract?.checks || []).filter((check) => check.type === 'manual').length;
  return acceptance + manual;
}

function estimateReviewability(cwd, records, thresholds = loadReviewThresholds(cwd)) {
  const uniqueScopes = [...new Set(records.flatMap(taskScopes))].sort();
  const uniqueFiles = new Set();
  const subsystems = new Set();
  let currentLoc = 0;
  let estimatedChangedLoc = 0;
  let generatedRisk = false;

  for (const scope of uniqueScopes) {
    const stat = scopeFileStats(cwd, scope);
    currentLoc += stat.loc;
    estimatedChangedLoc += estimateChangedLocForScope(stat);
    generatedRisk = generatedRisk || stat.generated_risk;
    for (const file of stat.files) {
      uniqueFiles.add(file);
      const first = file.split('/')[0] || file;
      subsystems.add(first);
    }
  }

  const migrationAndFrontend = uniqueScopes.some((scope) => /migration|schema/i.test(scope)) &&
    uniqueScopes.some((scope) => /frontend|ui|client|app|pages|components/i.test(scope));
  const manualChecks = records.reduce((sum, record) => sum + manualCheckCount(record), 0);
  const triggered = [];
  if (records.length > thresholds.tasks) triggered.push('task_count');
  if (uniqueFiles.size > thresholds.files) triggered.push('file_count');
  if (estimatedChangedLoc > thresholds.changed_loc) triggered.push('changed_loc');
  if (subsystems.size > thresholds.subsystems) triggered.push('subsystem_count');
  if (migrationAndFrontend) triggered.push('migration_plus_frontend');
  if (manualChecks > thresholds.manual_checks) triggered.push('manual_check_count');

  const risk = triggered.length === 0 ? 'low' : (triggered.length <= 2 ? 'medium' : 'high');
  return {
    ok: triggered.length === 0,
    requires_confirmation: triggered.length > 0,
    risk,
    thresholds,
    triggered,
    estimate: {
      tasks: records.length,
      files: uniqueFiles.size,
      current_scope_loc: currentLoc,
      expected_changed_loc: estimatedChangedLoc,
      subsystems: subsystems.size,
      manual_checks: manualChecks,
      generated_or_migration_risk: generatedRisk || migrationAndFrontend,
    },
  };
}

function recommendedSubset(cwd, records, thresholds) {
  const subset = [];
  for (const record of records) {
    const candidate = [...subset, record];
    const estimate = estimateReviewability(cwd, candidate, thresholds);
    if (subset.length > 0 && estimate.requires_confirmation) break;
    subset.push(record);
  }
  return subset.length > 0 ? subset : records.slice(0, 1);
}

function orchestrationId(deps = {}) {
  if (deps.id) return deps.id;
  const now = deps.now ? deps.now() : new Date();
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/[^\dTZ]/g, '').toLowerCase();
}

function safeIdPart(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'tasks';
}

function taskBranchName(record, bulkId) {
  return `gtd/task-${record.task_id}-${record.issue_number}-bulk-${safeIdPart(bulkId)}`;
}

function bulkBranchName(id) {
  return `gtd/orchestrate-${safeIdPart(id)}`;
}

function orchestrationDir(cwd) {
  return path.join(planningDir(cwd), 'github', 'orchestrations');
}

function manifestPath(cwd, id) {
  return path.join(orchestrationDir(cwd), `${safeIdPart(id)}.json`);
}

function writeManifest(cwd, manifest) {
  fs.mkdirSync(orchestrationDir(cwd), { recursive: true });
  const file = manifestPath(cwd, manifest.id);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return file;
}

function relativeManifestPath(cwd, manifest) {
  return toPosixPath(path.relative(cwd, manifestPath(cwd, manifest.id)));
}

function readManifest(cwd, id) {
  const file = manifestPath(cwd, id);
  if (!fs.existsSync(file)) {
    throw new TaskExecutionError(`Orchestration manifest not found: ${toPosixPath(path.relative(cwd, file))}`, 'manifest_not_found');
  }
  return {
    path: file,
    data: JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

function runGit(cwd, args, opts = {}) {
  const result = runGitCommand(args, {
    cwd,
    env: opts.env,
    timeout: opts.timeout,
    spawnSync: opts.spawnSync,
    commonGitPaths: opts.commonGitPaths,
  });
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.error) throw new TaskExecutionError(stderr || result.error.message, 'git_failed', { args });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new TaskExecutionError(stderr || `git ${args.join(' ')} exited with status ${result.status}`, 'git_failed', { args });
  }
  return { ok: result.status === 0, status: result.status, stdout, stderr };
}

function commitOrchestrationManifest(cwd, manifest, deps = {}) {
  const relPath = relativeManifestPath(cwd, manifest);
  if (deps.commitOrchestrationManifest) {
    return deps.commitOrchestrationManifest({ cwd, manifest, path: relPath });
  }

  const inGitRepo = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (!inGitRepo.ok) {
    return { committed: false, hash: null, path: relPath, reason: 'skipped_not_git_repo' };
  }

  const config = loadConfig(cwd);
  if (!config.commit_docs) {
    return { committed: false, hash: null, path: relPath, reason: 'skipped_commit_docs_false' };
  }

  if (isGitIgnored(cwd, '.planning/') || isGitIgnored(cwd, '.planning')) {
    return { committed: false, hash: null, path: relPath, reason: 'skipped_gitignored' };
  }

  const add = runGit(cwd, ['add', '--', relPath], { allowFailure: true });
  if (!add.ok) {
    return {
      committed: false,
      hash: null,
      path: relPath,
      reason: 'git_add_failed',
      error: add.stderr || add.stdout,
    };
  }

  const staged = runGit(cwd, ['diff', '--cached', '--name-only', '--', relPath], { allowFailure: true });
  if (!staged.ok) {
    return {
      committed: false,
      hash: null,
      path: relPath,
      reason: 'git_diff_failed',
      error: staged.stderr || staged.stdout,
    };
  }
  if (!staged.stdout) {
    return { committed: false, hash: null, path: relPath, reason: 'nothing_staged' };
  }

  const message = `docs(orchestrate-tasks): record orchestration ${manifest.id}`;
  const commit = runGit(cwd, ['commit', '-m', message, '--', relPath], { allowFailure: true });
  if (!commit.ok) {
    const text = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit/i.test(text)) {
      return { committed: false, hash: null, path: relPath, reason: 'nothing_to_commit' };
    }
    return {
      committed: false,
      hash: null,
      path: relPath,
      reason: 'git_commit_failed',
      error: commit.stderr || commit.stdout,
    };
  }

  const hash = runGit(cwd, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  return {
    committed: true,
    hash: hash.ok ? hash.stdout : null,
    path: relPath,
    message,
    reason: 'committed',
  };
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

function ensureBulkBranch(cwd, id, deps = {}) {
  if (deps.ensureBulkBranch) return deps.ensureBulkBranch({ cwd, id, branch: bulkBranchName(id) });
  const branch = bulkBranchName(id);
  const defaultRef = defaultBranchRef(cwd);
  const localExists = runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
  if (!localExists) runGit(cwd, ['branch', branch, defaultRef]);
  runGit(cwd, ['push', '--set-upstream', 'origin', branch]);
  return {
    branch,
    default_branch: defaultRef.replace(/^origin\//, ''),
    default_ref: defaultRef,
    pushed: true,
  };
}

function claimTask(adapter, record, bulkId, deps = {}) {
  const current = issueLabels(record.issue);
  const labels = mergeLabelSet(current, ['gtd:in-progress', 'gtd:bulk-orchestrated'], ['gtd:ready', 'gtd:blocked']);
  if (adapter?.setIssueLabels) adapter.setIssueLabels(record.issue_number, labels);
  const timestamp = (deps.now ? deps.now() : new Date()).toISOString();
  const body = [
    '<!-- gtd-orchestrate-tasks:claim -->',
    `GTD bulk orchestration claim at ${timestamp}.`,
    '',
    `Orchestration: \`${bulkId}\``,
    `Bulk branch: \`${bulkBranchName(bulkId)}\``,
    `Task: \`${record.task_id}\``,
  ].join('\n');
  const comment = adapter?.commentIssue ? adapter.commentIssue(record.issue_number, body) : null;
  return { labels, comment, claimed_at: timestamp };
}

function commandExists(command, cwd, deps = {}) {
  if (deps.commandExists) return Boolean(deps.commandExists(command));
  const value = String(command || '').trim();
  if (!value) return false;
  if (value.includes('/') || path.isAbsolute(value)) {
    try {
      fs.accessSync(path.resolve(cwd, value), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = childProcess.spawnSync('which', [value], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return !result.error && result.status === 0 && String(result.stdout || '').trim().length > 0;
}

function executorPreflight(cwd, opts = {}, deps = {}) {
  if (deps.executeTaskLane || deps.runTaskExecutor) {
    return {
      ok: true,
      backend: 'injected',
      mode: 'all_in_one',
      command: deps.executorCommand || null,
    };
  }

  const backend = opts.executorBackend || DEFAULT_EXECUTOR_BACKEND;
  if (backend === 'agent') {
    return {
      ok: true,
      backend: 'agent',
      mode: 'agent_managed',
      command: null,
      agent: {
        name: 'gtd-task-executor',
        model: 'gpt-5.4-mini',
        reasoning_effort: 'medium',
      },
    };
  }

  const command = opts.executorCommand || process.env.GTD_TASK_EXECUTOR_COMMAND || DEFAULT_EXECUTOR_COMMAND;
  if (!commandExists(command, cwd, deps)) {
    return {
      ok: false,
      backend: 'command',
      mode: 'all_in_one',
      command,
      code: 'executor_command_unavailable',
      message: `Task executor command "${command}" was not found. Use the default agent backend or configure an available executor command.`,
    };
  }

  return {
    ok: true,
    backend: 'command',
    mode: 'all_in_one',
    command,
  };
}

function agentLaneContext(record, manifest, bulk, selectedMap) {
  return {
    task_id: record.task_id,
    issue: record.issue_number,
    title: record.issue?.title || record.task.name,
    source_path: record.plan.source_path || null,
    files: record.task.files || [],
    branch: taskBranchName(record, manifest.id),
    base_branch: bulk.branch,
    pr_base: bulk.branch,
    internal_blockers: internalBlockersFor(record, selectedMap).map((blocker) => ({
      task_id: blocker.task_id,
      issue: blocker.issue_number,
      branch: taskBranchName(blocker, manifest.id),
    })),
    agent: {
      name: 'gtd-task-executor',
      model: 'gpt-5.4-mini',
      reasoning_effort: 'medium',
    },
    instructions: [
      'Create the task branch from the bulk branch.',
      'Implement only the assigned task and declared write scope.',
      'Return commit evidence; the orchestrator opens the task PR against the bulk branch using Refs, not closing keywords.',
      'Read orchestrator PR comments for rework from a fresh context.',
    ],
  };
}

function taskPrBody(record, validation, executorResult, bulkId) {
  const manual = (validation?.manual || []).map((check) => check.description).filter(Boolean);
  const lines = [
    '<!-- gtd-orchestrate-tasks:task-pr -->',
    '## Task',
    '',
    `- Issue: #${record.issue_number}`,
    `- Task ID: \`${record.task_id}\``,
    `- Source plan: \`${record.plan.source_path || ''}\``,
    `- Orchestration: \`${bulkId}\``,
    '',
    '## Implementation Notes',
    String(executorResult?.notes || executorResult?.summary || 'No implementation notes returned.').trim(),
    '',
    '## Validation',
    validation?.ok ? 'Automated validation passed.' : 'Automated validation failed.',
  ];
  for (const check of validation?.checks || []) {
    const status = check.passed === null ? 'manual' : (check.passed ? 'pass' : 'fail');
    lines.push(`- ${check.id || check.type}: ${status}`);
  }
  if (record.task.acceptance_criteria?.length || manual.length) {
    lines.push('', '## Manual Review');
    for (const item of record.task.acceptance_criteria || []) lines.push(`- [ ] ${item}`);
    for (const item of manual) lines.push(`- [ ] ${item}`);
  }
  lines.push('', `Refs #${record.issue_number}`);
  return lines.join('\n');
}

function finalPrBody(manifest, acceptedTasks, validationSummary = {}) {
  const lines = [
    '<!-- gtd-orchestrate-tasks:final-pr -->',
    '## GTD Bulk Orchestration',
    '',
    `- Orchestration: \`${manifest.id}\``,
    `- Bulk branch: \`${manifest.bulk_branch}\``,
    '',
    '## Tasks',
    '',
    '| Task | Issue | Task PR | Decision | Validation |',
    '|---|---:|---:|---|---|',
  ];
  for (const task of acceptedTasks) {
    lines.push(`| \`${task.task_id}\` | #${task.issue} | #${task.pr || ''} | ${task.decision || 'accepted'} | ${task.validation?.status || 'unknown'} |`);
  }
  lines.push('', '## Integration Validation', '');
  lines.push(validationSummary.ok === false ? 'Final integration requires review.' : 'Final integration checks passed or are delegated to this PR.');
  lines.push('', '## Manual Review Checklist', '');
  const seen = new Set();
  for (const task of acceptedTasks) {
    for (const item of task.manual_checks || []) {
      const key = `${task.task_id}:${item}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- [ ] ${task.task_id}: ${item}`);
    }
  }
  if (seen.size === 0) lines.push('- [ ] Review the combined diff and CI results.');
  for (const task of acceptedTasks) lines.push('', `Closes #${task.issue}`);
  return lines.join('\n');
}

function hasClosingKeyword(text) {
  return CLOSING_KEYWORD_RE.test(String(text || ''));
}

function closingKeywordFindings(pr, commits = [], squash = {}) {
  const findings = [];
  if (hasClosingKeyword(pr?.title)) findings.push({ surface: 'pr_title', text: pr.title });
  if (hasClosingKeyword(pr?.body)) findings.push({ surface: 'pr_body', text: pr.body });
  if (hasClosingKeyword(squash.subject)) findings.push({ surface: 'squash_subject', text: squash.subject });
  if (hasClosingKeyword(squash.body)) findings.push({ surface: 'squash_body', text: squash.body });
  for (const commit of commits || []) {
    const message = [commit.messageHeadline, commit.messageBody, commit.message].filter(Boolean).join('\n');
    if (hasClosingKeyword(message)) findings.push({ surface: 'commit_message', oid: commit.oid || commit.sha || null, text: message });
  }
  return findings;
}

function expectedCheckNames(cwd) {
  const config = readJsonIfExists(path.join(planningDir(cwd), 'config.json')) || {};
  return config.orchestrate_tasks?.required_checks || config.workflow?.orchestrate_tasks?.required_checks || [];
}

function normalizeCheckPassed(check) {
  const conclusion = String(check.conclusion || check.state || check.status || '').toUpperCase();
  return ['SUCCESS', 'PASSED', 'COMPLETED', 'NEUTRAL', 'SKIPPED'].includes(conclusion);
}

function validateChecks(cwd, checks, deps = {}) {
  const expected = deps.requiredChecks || expectedCheckNames(cwd);
  if (!expected.length) return { ok: true, missing: [], failed: [], fallback_required: false };
  const byName = new Map((checks || []).map((check) => [check.name || check.context, check]));
  const missing = expected.filter((name) => !byName.has(name));
  const failed = expected
    .map((name) => byName.get(name))
    .filter(Boolean)
    .filter((check) => !normalizeCheckPassed(check))
    .map((check) => check.name || check.context);
  return {
    ok: missing.length === 0 && failed.length === 0,
    missing,
    failed,
    fallback_required: missing.length > 0,
  };
}

function unknownCommitFindings(commits, allowedCommitShas = []) {
  if (!allowedCommitShas.length) return [];
  const allowed = new Set(allowedCommitShas.filter(Boolean));
  return (commits || [])
    .filter((commit) => {
      const sha = commit.oid || commit.sha;
      return sha && !allowed.has(sha);
    })
    .map((commit) => ({
      oid: commit.oid || commit.sha,
      message: commit.messageHeadline || commit.message || '',
      authors: commit.authors || [],
    }));
}

function simulateMerge(cwd, bulkBranch, headBranch, deps = {}) {
  if (deps.simulateMerge) return deps.simulateMerge({ cwd, bulkBranch, headBranch });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-orchestrate-merge-'));
  const worktreePath = path.join(tmpRoot, 'worktree');
  try {
    runGit(cwd, ['fetch', 'origin']);
    runGit(cwd, ['worktree', 'add', '--detach', worktreePath, bulkBranch]);
    const merge = runGit(worktreePath, ['merge', '--no-commit', '--no-ff', headBranch], { allowFailure: true });
    if (!merge.ok) {
      runGit(worktreePath, ['merge', '--abort'], { allowFailure: true });
      return {
        ok: false,
        worktree: worktreePath,
        changed_files: [],
        error: merge.stderr || merge.stdout || 'merge failed',
      };
    }
    const changed = runGit(worktreePath, ['diff', '--name-only', 'HEAD']).stdout
      .split(/\r?\n/)
      .map(normalizeRepoPath)
      .filter(Boolean)
      .sort();
    return {
      ok: true,
      worktree: worktreePath,
      changed_files: changed,
      cleanup: () => {
        runGit(worktreePath, ['merge', '--abort'], { allowFailure: true });
        runGit(cwd, ['worktree', 'remove', '--force', worktreePath], { allowFailure: true });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      },
    };
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, worktree: null, changed_files: [], error: err.message || String(err) };
  }
}

function validationComment(record, validation, bulkReview) {
  const lines = [
    '<!-- gtd-orchestrate-tasks:validation -->',
    validation.ok ? 'GTD orchestration validation passed.' : 'GTD orchestration validation failed.',
    '',
    `Task: \`${record.task_id}\``,
  ];
  for (const finding of validation.findings || []) {
    lines.push(`- ${finding.code}: ${finding.message}`);
  }
  if (bulkReview?.notes?.length) {
    lines.push('', 'Bulk-level review:');
    for (const note of bulkReview.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

function proactiveValidateTaskPr(cwd, record, pr, bulkBranch, adapter, deps = {}) {
  const commits = deps.listPullRequestCommits
    ? deps.listPullRequestCommits(pr.number)
    : (adapter?.listPullRequestCommits ? adapter.listPullRequestCommits(pr.number) : []);
  const checks = deps.listPullRequestChecks
    ? deps.listPullRequestChecks(pr.number)
    : (adapter?.listPullRequestChecks ? adapter.listPullRequestChecks(pr.number) : []);
  const squash = {
    subject: `[GTD ${record.task_id}] ${record.task.name}`,
    body: `Refs #${record.issue_number}`,
  };
  const findings = [];

  const base = pr.baseRefName || pr.base || null;
  if (base && base !== bulkBranch) {
    findings.push({ code: 'wrong_pr_base', message: `Task PR base is ${base}; expected ${bulkBranch}.` });
  }

  for (const closing of closingKeywordFindings(pr, commits, squash)) {
    findings.push({ code: 'closing_keyword', message: `Closing keyword found in ${closing.surface}.`, details: closing });
  }

  for (const commit of unknownCommitFindings(commits, deps.allowedCommitShas || [])) {
    findings.push({ code: 'unknown_task_branch_commit', message: `Unknown commit on task branch: ${commit.oid}.`, details: commit });
  }

  const checkState = validateChecks(cwd, checks, deps);
  if (checkState.failed.length) {
    findings.push({ code: 'github_checks_failed', message: `Required checks failed: ${checkState.failed.join(', ')}.` });
  }
  if (checkState.missing.length && !deps.localFallbackValidationOk) {
    findings.push({ code: 'github_checks_missing', message: `Required checks did not run on the task PR: ${checkState.missing.join(', ')}.` });
  }

  const merge = simulateMerge(cwd, bulkBranch, pr.headRefName || pr.head || '', deps);
  if (!merge.ok) {
    findings.push({ code: 'merge_conflict', message: merge.error || 'Task PR did not merge cleanly into the bulk branch.' });
  }

  let taskValidation = { ok: findings.length === 0, checks: [], failed: [], manual: [], acceptance_criteria: [] };
  if (merge.ok && merge.worktree) {
    taskValidation = validateTask(merge.worktree, record, merge.changed_files, deps);
    if (!taskValidation.ok) {
      findings.push({ code: 'validation_contract_failed', message: 'Task validation contract failed against the simulated bulk merge.' });
    }
    if (typeof merge.cleanup === 'function') merge.cleanup();
  }

  const bulkReview = deps.bulkReview ? deps.bulkReview({ record, pr, merge, taskValidation }) : {
    ok: true,
    notes: [],
  };
  if (bulkReview && bulkReview.ok === false) {
    findings.push({ code: 'bulk_functional_review_failed', message: bulkReview.message || 'Bulk-level functional review failed.' });
  }

  const validation = {
    ok: findings.length === 0,
    findings,
    task_validation: taskValidation,
    check_state: checkState,
    missing_ci_fallback_used: checkState.fallback_required && Boolean(deps.localFallbackValidationOk),
  };
  const commentBody = validationComment(record, validation, bulkReview);
  const comment = adapter?.commentIssue && pr.number ? adapter.commentIssue(pr.number, commentBody) : null;
  validation.comment_ref = comment?.url || comment?.html_url || null;
  return validation;
}

function ensureTaskWorktree(cwd, record, bulkBranch, bulkId, deps = {}) {
  if (deps.ensureTaskWorktree) return deps.ensureTaskWorktree({ cwd, record, bulkBranch, bulkId });
  const branch = taskBranchName(record, bulkId);
  const root = path.join(path.dirname(cwd), `${path.basename(cwd)}.orchestrate-worktrees`);
  const worktreePath = path.join(root, branch.replace(/[\\/]/g, '__'));
  fs.mkdirSync(root, { recursive: true });
  const exists = runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
  if (exists) runGit(cwd, ['worktree', 'add', worktreePath, branch]);
  else runGit(cwd, ['worktree', 'add', '-b', branch, worktreePath, bulkBranch]);
  return { path: worktreePath, branch, base_ref: bulkBranch, reused: exists };
}

function runTaskExecutor(context, deps = {}) {
  if (deps.runTaskExecutor) return deps.runTaskExecutor(context);
  const command = deps.executorCommand || process.env.GTD_TASK_EXECUTOR_COMMAND || DEFAULT_EXECUTOR_COMMAND;
  const result = childProcess.spawnSync(command, [], {
    cwd: context.worktree.path,
    encoding: 'utf8',
    input: `${JSON.stringify(context)}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) {
    throw new TaskExecutionError(result.error.code === 'ENOENT' ? `Task executor command "${command}" was not found.` : result.error.message, 'executor_unavailable');
  }
  if (result.status !== 0) {
    throw new TaskExecutionError(String(result.stderr || result.stdout || `gtd-task-executor exited with ${result.status}`).trim(), 'executor_failed');
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) return { ok: true, notes: '' };
  try {
    return JSON.parse(stdout);
  } catch {
    return { ok: true, notes: stdout };
  }
}

function changedFiles(worktree, deps = {}) {
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

function pushBranch(worktree, deps = {}) {
  if (deps.pushBranch) return deps.pushBranch(worktree);
  runGit(worktree.path, ['push', '--set-upstream', 'origin', worktree.branch]);
  return { pushed: true, branch: worktree.branch };
}

function executeTaskLane(cwd, record, manifest, bulk, adapter, deps = {}) {
  if (deps.executeTaskLane) return deps.executeTaskLane({ cwd, record, manifest, bulk, adapter });
  const claim = claimTask(adapter, record, manifest.id, deps);
  const worktree = ensureTaskWorktree(cwd, record, bulk.branch, manifest.id, deps);
  const context = executorContext(record, worktree, [], null);
  context.bulk = {
    orchestration_id: manifest.id,
    bulk_branch: bulk.branch,
  };
  context.pr = null;

  const executorResult = runTaskExecutor(context, deps);
  const files = changedFiles(worktree, deps);
  const localValidation = validateTask(worktree.path, record, files, deps);
  const executorEvidence = validateExecutorEvidence(worktree, executorResult, deps);
  if (!executorEvidence.ok) {
    return {
      status: 'changes_requested',
      decision: 'changes_requested',
      claim,
      worktree,
      pushed: null,
      pr: null,
      validation: {
        ok: false,
        findings: executorEvidence.reasons.map((reason) => ({
          severity: 'error',
          code: reason.code,
          message: reason.message,
        })),
        evidence_gate: executorEvidence,
        local_validation: localValidation,
      },
      executor: executorResult,
      executor_evidence: executorEvidence,
      changed_files: files,
      manual_checks: record.task.acceptance_criteria || [],
    };
  }
  const pushed = pushBranch(worktree, deps);
  const pr = adapter.createPullRequest({
    title: `[GTD ${record.task_id}] ${record.task.name}`,
    body: taskPrBody(record, localValidation, executorResult, manifest.id),
    head: worktree.branch,
    base: bulk.branch,
    draft: !localValidation.ok,
    labels: localValidation.ok ? [] : ['gtd:validation-failed'],
  });
  const proactive = proactiveValidateTaskPr(cwd, record, pr, bulk.branch, adapter, {
    ...deps,
    allowedCommitShas: [executorEvidence.commit].filter(Boolean),
    localFallbackValidationOk: localValidation.ok,
  });

  if (!localValidation.ok || !proactive.ok) {
    return {
      status: 'changes_requested',
      decision: 'changes_requested',
      claim,
      worktree,
      pushed,
      pr,
      validation: proactive,
      executor: executorResult,
      executor_evidence: executorEvidence,
      changed_files: files,
      manual_checks: record.task.acceptance_criteria || [],
    };
  }

  const subject = `[GTD ${record.task_id}] ${record.task.name}`;
  const body = `Refs #${record.issue_number}\n\nOrchestration: ${manifest.id}`;
  const merged = adapter.mergePullRequest
    ? adapter.mergePullRequest(pr.number, { method: 'squash', subject, body })
    : null;
  return {
    status: 'accepted',
    decision: 'accepted',
    claim,
    worktree,
    pushed,
    pr,
    merged,
    validation: proactive,
    executor: executorResult,
    executor_evidence: executorEvidence,
    changed_files: files,
    manual_checks: record.task.acceptance_criteria || [],
  };
}

function buildPlan(cwd, opts, adapterOrFactory = null) {
  const selector = issueSelector(opts.issueNumbers);
  const effectiveOpts = {
    selector: null,
    repo: opts.repo,
    mode: 'read-only',
  };
  const state = loadExecutionState(cwd, effectiveOpts, adapterFactoryFor(cwd, adapterOrFactory));
  const selection = selectRecords(selector, state.records);
  const sorted = selection.selected.sort(compareRecords);
  const maxConcurrency = opts.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
  const waves = buildWaves(sorted, maxConcurrency);
  const thresholds = loadReviewThresholds(cwd);
  const reviewability = estimateReviewability(cwd, sorted, thresholds);
  const subset = recommendedSubset(cwd, sorted, thresholds);
  const preflightErrors = [...state.records.parents, ...state.records.tasks].flatMap((record) =>
    record.errors.map((err) => ({
      issue: record.issue_number,
      operation: err.operation,
      message: err.message,
    })));

  return {
    selector,
    effective_phase: null,
    state,
    selected_records: sorted,
    selection_errors: selection.errors,
    non_workable: selection.non_workable,
    internal_blocked: selection.internal_blocked,
    dependency_order: dependencyOrderFor(selection.internal_blocked),
    checkpoint_gates: checkpointGatesFor(sorted),
    waves,
    reviewability: {
      ...reviewability,
      recommended_subset: subset.map((record) => ({
        task_id: record.task_id,
        issue: record.issue_number,
      })),
      decision_options: reviewabilityDecisionOptions(reviewability),
    },
    preflight: {
      ok: preflightErrors.length === 0 && selection.errors.length === 0 && selection.non_workable.length === 0,
      checked_parent_plans: state.records.parents.length,
      checked_tasks: state.records.tasks.length,
      errors: preflightErrors,
    },
    max_concurrency: maxConcurrency,
  };
}

function scopeOutput(scope) {
  return {
    repo: scope.repo,
    phase: scope.phase.phaseSlug,
    phase_number: scope.phase.phaseNumber,
    manifest: scope.manifest.path,
  };
}

function planOutput(plan, mode) {
  return {
    ok: true,
    version: 1,
    mode,
    writes: false,
    implementation: false,
    pr_creation: false,
    selector: plan.selector,
    scope: plan.state.scopes.map(scopeOutput),
    preflight: plan.preflight,
    selection_errors: plan.selection_errors,
    non_workable: plan.non_workable,
    internal_blocked: plan.internal_blocked,
    dependency_order: plan.dependency_order,
    checkpoint_gates: plan.checkpoint_gates,
    presentation_guidance: {
      hard_blockers_field: 'non_workable',
      dependency_order_field: 'dependency_order',
      checkpoint_gates_field: 'checkpoint_gates',
      dependency_order_is_not_a_blocker: true,
      checkpoint_gates_are_not_blockers: true,
      checkpoint_gates_are_not_executor_lanes: true,
      reviewability_requires_user_direction_only_when_action_is_request_reviewability_direction: true,
    },
    selected_tasks: plan.selected_records.map((record) => ({
      task_id: record.task_id,
      issue: record.issue_number,
      title: record.issue?.title || record.task.name,
      plan_id: record.plan_id,
      phase: record.scope.phase.phaseSlug,
      source_path: record.plan.source_path || null,
      files: record.task.files || [],
      workability: record.workability,
      internal_blockers: internalBlockersFor(record, selectedIssueKeyMap(plan.selected_records)).map((blocker) => ({
        task_id: blocker.task_id,
        issue: blocker.issue_number,
      })),
    })),
    waves: plan.waves.map((wave) => ({
      index: wave.index,
      parallel_tasks: wave.parallel_tasks,
    })),
    reviewability: plan.reviewability,
    action: plan.selected_records.length === 0 ? 'report_blocking_state' : (plan.reviewability.requires_confirmation ? 'request_reviewability_direction' : 'report_orchestration_plan'),
  };
}

function buildDryRun(cwd, opts, adapterOrFactory = null) {
  return planOutput(buildPlan(cwd, opts, adapterOrFactory), 'dry-run');
}

function createManifest(plan, bulk, opts, id) {
  const selectedMap = selectedIssueKeyMap(plan.selected_records);
  return {
    version: 1,
    id,
    repo: plan.state.scopes[0]?.repo || opts.repo || null,
    status: 'running',
    created_at: (opts.now ? opts.now() : new Date()).toISOString(),
    default_branch: bulk.default_branch,
    bulk_branch: bulk.branch,
    bulk_pr: null,
    selector: plan.selector,
    settings: {
      max_concurrency: plan.max_concurrency,
      allow_partial: Boolean(opts.allowPartial),
      executor_backend: opts.executorBackend || DEFAULT_EXECUTOR_BACKEND,
      task_executor_model: 'gpt-5.4-mini',
      task_executor_reasoning_effort: 'medium',
    },
    reviewability: plan.reviewability,
    tasks: Object.fromEntries(plan.selected_records.map((record) => [record.task_id, {
      issue: record.issue_number,
      kind: isCheckpointRecord(record) ? 'checkpoint' : 'implementation',
      source_hash: record.task.source_hash,
      status: isCheckpointRecord(record)
        ? checkpointManifestStatus(checkpointGateFor(record, selectedMap))
        : 'selected',
      branch: taskBranchName(record, id),
      pr: null,
      decision: null,
      validation: null,
      internal_blockers: internalBlockersFor(record, selectedMap).map((blocker) => blocker.task_id),
    }])),
    waves: plan.waves.map((wave) => ({
      index: wave.index,
      parallel_tasks: wave.parallel_tasks,
    })),
    events: [],
  };
}

function checkpointManifestStatus(gate) {
  if (gate.status === 'resolved') return 'checkpoint_resolved';
  if (gate.status === 'waiting_dependencies') return 'checkpoint_waiting_dependencies';
  return 'checkpoint_waiting_human';
}

function taskResultsOutput(taskResults) {
  return taskResults.map(({ record, result }) => ({
    task_id: record.task_id,
    issue: record.issue_number,
    status: result.status,
    pr: result.pr || null,
    validation: result.validation || null,
  }));
}

function pendingCheckpointRecords(records) {
  return records.filter((record) => isCheckpointRecord(record) && !isResolvedCheckpointRecord(record));
}

function implementationRecords(records) {
  return records.filter((record) => !isCheckpointRecord(record));
}

function acceptedTasksFromManifest(plan, manifest) {
  const byId = new Map(plan.selected_records.map((record) => [record.task_id, record]));
  return Object.entries(manifest.tasks || {})
    .filter(([, entry]) => entry.kind !== 'checkpoint' && entry.status === 'accepted')
    .map(([taskId, entry]) => {
      const record = byId.get(taskId);
      return {
        task_id: taskId,
        issue: entry.issue,
        pr: entry.pr || null,
        decision: entry.decision || 'accepted',
        validation: { status: entry.validation?.status || 'unknown' },
        manual_checks: entry.manual_checks || record?.task?.acceptance_criteria || [],
      };
    });
}

function markHumanCheckpointPause(manifest, checkpoints) {
  for (const record of checkpoints) {
    manifest.tasks[record.task_id].status = 'checkpoint_waiting_human';
  }
  manifest.status = 'waiting_for_human_checkpoint';
  manifest.events.push({
    type: 'human_checkpoint_required',
    tasks: checkpoints.map((record) => record.task_id),
  });
}

function checkpointPauseResult(cwd, {
  base,
  plan,
  manifest,
  deps,
  implementation,
  prCreation,
  taskResults = null,
  executor = null,
}) {
  writeManifest(cwd, manifest);
  const manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
  const checkpointGates = checkpointGatesForManifest(plan.selected_records, manifest);
  const result = {
    ...base,
    writes: true,
    implementation,
    pr_creation: prCreation,
    action: 'human_checkpoint_required',
    checkpoint_gates: checkpointGates,
    user_next_step: checkpointUserNextStep(
      'human_checkpoint_required',
      checkpointIssueSummariesFromGates(checkpointGates),
    ),
    orchestration: manifest,
    manifest_commit: manifestCommit,
  };
  if (executor) result.executor = executor;
  if (taskResults) result.task_results = taskResultsOutput(taskResults);
  return result;
}

function applyTaskLaneResultToManifest(manifest, record, result, deps = {}) {
  const entry = manifest.tasks[record.task_id];
  entry.status = result.status;
  entry.pr = result.pr?.number || null;
  entry.decision = result.decision;
  entry.decision_reason = result.validation?.ok ? 'Automated and bulk-level validation passed.' : 'Validation requires changes.';
  entry.validation = {
    status: result.validation?.ok ? 'passed' : 'failed',
    comment_refs: [result.validation?.comment_ref].filter(Boolean),
    findings: result.validation?.findings || [],
  };
  entry.manual_checks = result.manual_checks || [];
  if (result.status === 'accepted') {
    entry.merged_to_bulk_at = (deps.now ? deps.now() : new Date()).toISOString();
    return true;
  }
  return false;
}

function rejectedTasksResult(cwd, {
  base,
  manifest,
  rejected,
  taskResults,
  deps,
  allowPartial,
  implementation,
  includeCheckpointGates = false,
  plan = null,
}) {
  manifest.status = allowPartial ? 'blocked' : 'changes_requested';
  manifest.events.push({
    type: allowPartial ? 'partial_confirmation_required' : 'task_rework_required',
    tasks: rejected.map(({ record }) => record.task_id),
  });
  writeManifest(cwd, manifest);
  const manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
  const result = {
    ...base,
    writes: true,
    implementation,
    pr_creation: taskResults.some(({ result: taskResult }) => taskResult.pr),
    action: allowPartial ? 'request_partial_confirmation' : 'changes_requested',
    orchestration: manifest,
    manifest_commit: manifestCommit,
    task_results: taskResultsOutput(taskResults),
  };
  if (includeCheckpointGates && plan) {
    result.checkpoint_gates = checkpointGatesForManifest(plan.selected_records, manifest);
  }
  return result;
}

function finalBulkPrResult(cwd, {
  base,
  plan,
  manifest,
  bulk,
  adapterForRepo,
  taskResults,
  deps,
  implementation,
}) {
  const finalAdapter = adapterForRepo(manifest.repo);
  const finalBody = finalPrBody(manifest, acceptedTasksFromManifest(plan, manifest), { ok: true });
  const finalPr = finalAdapter.createPullRequest({
    title: `[GTD] Bulk task orchestration ${manifest.id}`,
    body: finalBody,
    head: bulk.branch,
    base: bulk.default_branch,
    draft: false,
    labels: [],
  });
  manifest.bulk_pr = finalPr?.number || null;
  manifest.status = 'final_pr_open';
  writeManifest(cwd, manifest);
  const manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
  return {
    ...base,
    writes: true,
    implementation,
    pr_creation: true,
    action: 'final_pr_opened',
    orchestration: manifest,
    manifest_commit: manifestCommit,
    checkpoint_gates: checkpointGatesForManifest(plan.selected_records, manifest),
    task_results: taskResultsOutput(taskResults),
    final_pr: finalPr,
  };
}

function buildExecution(cwd, opts, adapterOrFactory = null, deps = {}) {
  if (opts.resume) return buildResume(cwd, opts, adapterOrFactory, deps);
  const plan = buildPlan(cwd, opts, adapterOrFactory);
  const base = planOutput(plan, 'execute');
  if (!plan.preflight.ok || plan.selected_records.length === 0) return base;
  if (plan.reviewability.requires_confirmation && !opts.confirmReviewability && !deps.confirmReviewability) {
    return {
      ...base,
      action: 'request_reviewability_direction',
      reviewability: plan.reviewability,
    };
  }

  const executor = executorPreflight(cwd, opts, deps);
  if (!executor.ok) {
    return {
      ...base,
      action: 'executor_unavailable',
      executor,
    };
  }

  const id = orchestrationId(deps);
  const bulk = ensureBulkBranch(cwd, id, deps);
  const manifest = createManifest(plan, bulk, opts, id);
  manifest.settings.executor_backend = executor.backend;
  manifest.settings.executor_mode = executor.mode;
  if (executor.command) manifest.settings.executor_command = executor.command;
  const adapterForRepo = adapterFactoryFor(cwd, adapterOrFactory);
  const taskResults = [];
  const rejected = [];
  const accepted = [];

  writeManifest(cwd, manifest);

  if (executor.mode === 'agent_managed') {
    const selectedMap = selectedIssueKeyMap(plan.selected_records);
    const agentWaves = [];
    let blockedCheckpointWave = null;

    for (const wave of plan.waves) {
      const checkpoints = pendingCheckpointRecords(wave.records);
      if (checkpoints.length > 0) {
        blockedCheckpointWave = { wave, checkpoints };
        break;
      }

      const records = implementationRecords(wave.records);
      if (records.length === 0) continue;
      for (const record of records) {
        const adapter = adapterForRepo(record.scope.repo);
        const claim = claimTask(adapter, record, manifest.id, deps);
        const entry = manifest.tasks[record.task_id];
        entry.status = entry.internal_blockers.length > 0 ? 'claimed_waiting_internal_dependency' : 'claimed_ready';
        entry.claim = {
          claimed_at: claim.claimed_at,
          comment_ref: claim.comment?.url || claim.comment?.html_url || null,
        };
      }
      agentWaves.push({
        index: wave.index,
        records,
      });
    }

    if (blockedCheckpointWave && agentWaves.length === 0) {
      markHumanCheckpointPause(manifest, blockedCheckpointWave.checkpoints);
      return checkpointPauseResult(cwd, {
        base,
        plan,
        manifest,
        deps,
        implementation: false,
        prCreation: false,
        executor,
      });
    }

    manifest.status = 'agent_lanes_required';
    writeManifest(cwd, manifest);
    const manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
    return {
      ...base,
      writes: true,
      implementation: false,
      pr_creation: false,
      action: 'agent_lanes_required',
      executor,
      orchestration: manifest,
      manifest_commit: manifestCommit,
      checkpoint_gates: checkpointGatesForManifest(plan.selected_records, manifest),
      agent_lanes: agentWaves.map((wave) => ({
        index: wave.index,
        parallel_tasks: wave.records.map((record) => agentLaneContext(record, manifest, bulk, selectedMap)),
      })),
    };
  }

  for (const wave of plan.waves) {
    const checkpoints = pendingCheckpointRecords(wave.records);
    if (checkpoints.length > 0) {
      markHumanCheckpointPause(manifest, checkpoints);
      return checkpointPauseResult(cwd, {
        base,
        plan,
        manifest,
        deps,
        implementation: accepted.length > 0 || rejected.length > 0,
        prCreation: taskResults.some(({ result }) => result.pr),
        taskResults,
      });
    }

    for (const record of implementationRecords(wave.records)) {
      const adapter = adapterForRepo(record.scope.repo);
      const result = executeTaskLane(cwd, record, manifest, bulk, adapter, {
        ...deps,
        executorCommand: executor.command || deps.executorCommand,
      });
      taskResults.push({ record, result });
      if (applyTaskLaneResultToManifest(manifest, record, result, deps)) {
        accepted.push({ record, result });
      } else {
        rejected.push({ record, result });
      }
      writeManifest(cwd, manifest);
    }
  }

  if (rejected.length > 0 && (!opts.allowPartial || (!opts.confirmPartial && !deps.confirmPartial))) {
    return rejectedTasksResult(cwd, {
      base,
      manifest,
      rejected,
      taskResults,
      deps,
      allowPartial: opts.allowPartial,
      implementation: accepted.length > 0 || rejected.length > 0,
    });
  }

  return finalBulkPrResult(cwd, {
    base,
    plan,
    manifest,
    bulk,
    adapterForRepo,
    taskResults,
    deps,
    implementation: true,
  });
}

function syncFinalMergedTaskIssues(manifest, adapter) {
  const operations = [];
  for (const [taskId, entry] of Object.entries(manifest.tasks || {})) {
    if (entry.status !== 'accepted' || !entry.issue) continue;
    const issue = adapter?.getIssue ? adapter.getIssue(entry.issue) : null;
    const labels = mergeLabelSet(issueLabels(issue), ['gtd:merged'], [
      'gtd:ready',
      'gtd:blocked',
      'gtd:in-progress',
      'gtd:pr-open',
      'gtd:needs-rework',
      'gtd:validation-failed',
      'gtd:rejected',
    ]);
    if (adapter?.setIssueLabels) adapter.setIssueLabels(entry.issue, labels);
    if (issue && issueIsOpen(issue) && adapter?.updateIssueState) adapter.updateIssueState(entry.issue, 'closed');
    entry.status = 'final_pr_merged';
    operations.push({
      task_id: taskId,
      issue: entry.issue,
      labels,
      closed: Boolean(issue && issueIsOpen(issue) && adapter?.updateIssueState),
    });
  }
  return operations;
}

function readyReconciliationCommands(cwd, manifest, adapterOrFactory) {
  try {
    const state = loadExecutionState(cwd, {
      selector: null,
      phase: null,
      repo: manifest.repo || null,
      mode: 'read-only',
    }, adapterOrFactory);
    const selectedTaskIds = new Set(Object.keys(manifest.tasks || {}));
    const ready = state.records.parents
      .filter((parent) => parent.reconciliation.ready)
      .filter((parent) => parent.tasks.some((task) => selectedTaskIds.has(task.task_id)))
      .sort((a, b) => String(a.plan_id).localeCompare(String(b.plan_id), undefined, { numeric: true, sensitivity: 'base' }));
    return {
      ok: true,
      plans: ready.map((parent) => ({
        ...parentOutput(parent),
        command: [
          'gtd-tools',
          'work-task-issue',
          String(parent.issue_number),
          '--repo',
          parent.scope.repo,
          '--phase',
          parent.scope.phase.phaseSlug,
          '--reconcile',
          '--execute',
        ].join(' '),
      })),
    };
  } catch (err) {
    return {
      ok: false,
      plans: [],
      error: err.message || String(err),
    };
  }
}

function dependencyStatusResolved(entry) {
  return ['accepted', 'final_pr_merged', 'checkpoint_resolved'].includes(entry?.status);
}

function checkpointDependenciesResolved(manifest, entry) {
  return (entry.internal_blockers || []).every((taskId) => dependencyStatusResolved(manifest.tasks?.[taskId]));
}

function syncCheckpointGateIssues(manifest, adapter) {
  const pending = [];
  const resolved = [];
  let changed = false;

  for (const [taskId, entry] of Object.entries(manifest.tasks || {})) {
    if (entry.kind !== 'checkpoint') continue;
    const issue = adapter?.getIssue ? adapter.getIssue(entry.issue) : null;
    if (issue && !issueIsOpen(issue)) {
      if (entry.status !== 'checkpoint_resolved') {
        entry.status = 'checkpoint_resolved';
        changed = true;
      }
      resolved.push({ task_id: taskId, issue: entry.issue });
      continue;
    }

    const nextStatus = checkpointDependenciesResolved(manifest, entry)
      ? 'checkpoint_waiting_human'
      : 'checkpoint_waiting_dependencies';
    if (entry.status !== nextStatus) {
      entry.status = nextStatus;
      changed = true;
    }
    pending.push({ task_id: taskId, issue: entry.issue, status: nextStatus });
  }

  return { pending, resolved, changed };
}

function continueCommandExecutionFromManifest(cwd, opts, manifest, adapterOrFactory, deps = {}) {
  const continueOpts = {
    ...opts,
    issueNumbers: manifest.selector?.issue_numbers || [],
    repo: manifest.repo,
    allowPartial: manifest.settings?.allow_partial,
    confirmPartial: opts.confirmPartial,
    confirmReviewability: true,
    executorBackend: 'command',
    executorCommand: manifest.settings?.executor_command || opts.executorCommand,
    maxConcurrency: manifest.settings?.max_concurrency,
  };
  const plan = buildPlan(cwd, continueOpts, adapterOrFactory);
  const base = {
    ...planOutput(plan, 'resume'),
    writes: true,
  };
  const executor = executorPreflight(cwd, continueOpts, deps);
  if (!executor.ok) {
    return {
      ...base,
      action: 'executor_unavailable',
      executor,
      orchestration: manifest,
    };
  }

  const bulk = {
    branch: manifest.bulk_branch,
    default_branch: manifest.default_branch,
    default_ref: manifest.default_branch ? `origin/${manifest.default_branch}` : null,
    pushed: true,
  };
  const adapterForRepo = adapterFactoryFor(cwd, adapterOrFactory);
  const taskResults = [];
  const rejected = [];

  for (const wave of plan.waves) {
    const checkpoints = pendingCheckpointRecords(wave.records)
      .filter((record) => manifest.tasks?.[record.task_id]?.status !== 'checkpoint_resolved');
    if (checkpoints.length > 0) {
      markHumanCheckpointPause(manifest, checkpoints);
      return checkpointPauseResult(cwd, {
        base,
        plan,
        manifest,
        deps,
        implementation: taskResults.length > 0,
        prCreation: taskResults.some(({ result }) => result.pr),
        taskResults,
      });
    }

    for (const record of implementationRecords(wave.records)) {
      const entry = manifest.tasks?.[record.task_id];
      if (dependencyStatusResolved(entry)) continue;
      const adapter = adapterForRepo(record.scope.repo);
      const result = executeTaskLane(cwd, record, manifest, bulk, adapter, {
        ...deps,
        executorCommand: executor.command || deps.executorCommand,
      });
      taskResults.push({ record, result });
      if (!applyTaskLaneResultToManifest(manifest, record, result, deps)) {
        rejected.push({ record, result });
      }
      writeManifest(cwd, manifest);
    }
  }

  if (rejected.length > 0 && (!manifest.settings?.allow_partial || (!opts.confirmPartial && !deps.confirmPartial))) {
    return rejectedTasksResult(cwd, {
      base,
      manifest,
      rejected,
      taskResults,
      deps,
      allowPartial: manifest.settings?.allow_partial,
      implementation: taskResults.length > 0,
      includeCheckpointGates: true,
      plan,
    });
  }

  return finalBulkPrResult(cwd, {
    base,
    plan,
    manifest,
    bulk,
    adapterForRepo,
    taskResults,
    deps,
    implementation: taskResults.length > 0,
  });
}

function buildResume(cwd, opts, adapterOrFactory = null, deps = {}) {
  const loaded = readManifest(cwd, opts.resume);
  const manifest = loaded.data;
  const adapter = adapterFactoryFor(cwd, adapterOrFactory)(manifest.repo);
  let finalPr = null;
  let manifestCommit = null;
  let issueSync = [];
  let reconciliation = { ok: true, plans: [] };
  if (manifest.bulk_pr && adapter?.viewPullRequest) finalPr = adapter.viewPullRequest(manifest.bulk_pr);
  const hasCheckpointTasks = Object.values(manifest.tasks || {}).some((entry) => entry.kind === 'checkpoint');
  if (!manifest.bulk_pr && hasCheckpointTasks) {
    const checkpointSync = syncCheckpointGateIssues(manifest, adapter);
    if (checkpointSync.pending.length > 0) {
      if (checkpointSync.changed) {
        writeManifest(cwd, manifest);
        manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
      }
      const checkpointIssues = checkpointIssueSummariesFromSync(checkpointSync.pending);
      return {
        ok: true,
        version: 1,
        mode: 'resume',
        writes: checkpointSync.changed,
        implementation: false,
        pr_creation: false,
        action: 'human_checkpoint_pending',
        manifest_path: toPosixPath(path.relative(cwd, loaded.path)),
        orchestration: manifest,
        manifest_commit: manifestCommit,
        checkpoint_sync: checkpointSync,
        user_next_step: checkpointUserNextStep('human_checkpoint_pending', checkpointIssues),
        final_pr: finalPr,
        issue_sync: issueSync,
        reconciliation,
      };
    }

    if (checkpointSync.resolved.length > 0) {
      manifest.events.push({
        type: 'human_checkpoint_resolved',
        tasks: checkpointSync.resolved.map((entry) => entry.task_id),
      });
      if ((manifest.settings?.executor_backend || DEFAULT_EXECUTOR_BACKEND) === 'command' || deps.executeTaskLane || deps.runTaskExecutor) {
        return continueCommandExecutionFromManifest(cwd, opts, manifest, adapterOrFactory, deps);
      }
      manifest.status = 'agent_lanes_required';
      writeManifest(cwd, manifest);
      manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
      const checkpointIssues = checkpointSync.resolved.map((entry) => ({
        task_id: entry.task_id,
        issue: entry.issue,
        status: 'resolved',
      }));
      return {
        ok: true,
        version: 1,
        mode: 'resume',
        writes: true,
        implementation: false,
        pr_creation: false,
        action: 'human_checkpoint_resolved',
        manifest_path: toPosixPath(path.relative(cwd, loaded.path)),
        orchestration: manifest,
        manifest_commit: manifestCommit,
        checkpoint_sync: checkpointSync,
        user_next_step: checkpointUserNextStep('human_checkpoint_resolved', checkpointIssues),
        final_pr: finalPr,
        issue_sync: issueSync,
        reconciliation,
      };
    }
  }
  if (finalPr?.merged) {
    manifest.status = 'final_pr_merged';
    issueSync = syncFinalMergedTaskIssues(manifest, adapter);
    reconciliation = readyReconciliationCommands(cwd, manifest, adapterOrFactory);
    if (!manifest.events.some((event) => event.type === 'final_pr_merged_synced')) {
      manifest.events.push({
        type: 'final_pr_merged_synced',
        final_pr: finalPr.number || null,
        issue_sync_count: issueSync.length,
        ready_reconciliation_plans: reconciliation.plans.map((plan) => plan.plan_id),
      });
    }
    writeManifest(cwd, manifest);
    manifestCommit = commitOrchestrationManifest(cwd, manifest, deps);
  }
  return {
    ok: true,
    version: 1,
    mode: 'resume',
    writes: Boolean(finalPr?.merged),
    implementation: false,
    pr_creation: false,
    action: finalPr?.merged ? 'final_pr_merged_synced' : 'report_resume_state',
    manifest_path: toPosixPath(path.relative(cwd, loaded.path)),
    orchestration: manifest,
    manifest_commit: manifestCommit,
    final_pr: finalPr,
    issue_sync: issueSync,
    reconciliation,
  };
}

function cmdOrchestrateTasks(cwd, args, raw) {
  const opts = parseArgs(args);
  try {
    output(opts.dryRun ? buildDryRun(cwd, opts) : buildExecution(cwd, opts), raw);
  } catch (err) {
    error(err.message || String(err), ERROR_REASON.UNKNOWN);
  }
}

module.exports = {
  buildDryRun,
  buildExecution,
  buildPlan,
  buildResume,
  buildWaves,
  closingKeywordFindings,
  commitOrchestrationManifest,
  cmdOrchestrateTasks,
  estimateReviewability,
  finalPrBody,
  parseArgs,
  parseIssueNumberToken,
  proactiveValidateTaskPr,
  recommendedSubset,
  taskPrBody,
};

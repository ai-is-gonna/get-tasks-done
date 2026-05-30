'use strict';

/**
 * Exporter for the task issue execution workflow.
 *
 * Dry-run mode stays read-only and deterministic. Write mode applies the same
 * derived operation graph through GitHub Issues and records resumable progress
 * in `.planning/github/phase-*-issues.json`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractFrontmatter } = require('./frontmatter.cjs');
const {
  ERROR_REASON,
  error,
  findPhaseInternal,
  output,
  toPosixPath,
} = require('./core.cjs');
const { planningDir } = require('./planning-workspace.cjs');
const { isRootPlanFile, isNestedPlanFile } = require('./plan-scan.cjs');
const {
  normalizeGitHubRepo,
  resolveGitHubRepoFromGit,
} = require('./github-repo.cjs');
const {
  TASK_EXPORT_STATUSES,
  isCheckpointTaskType,
  issueLabels: labelNamesFromIssue,
  normalizeTaskType,
} = require('./task-issue-shared.cjs');
const {
  api: ghApi,
  repoEndpoint: ghRepoEndpoint,
  runGhCommand,
} = require('./github-api-client.cjs');

const WORKFLOW_LABELS = Object.freeze([
  'gtd:plan',
  'gtd:task',
  'gtd:ready',
  'gtd:blocked',
  'gtd:in-progress',
  'gtd:pr-open',
  'gtd:needs-rework',
  'gtd:validation-failed',
  'gtd:merged',
  'gtd:rejected',
  'gtd:blocked-human',
  'gtd:checkpoint',
  'gtd:human-in-the-loop',
  'gtd:checkpoint-resolved',
  'gtd:source-drift',
  'gtd:export-partial',
  'gtd:ready-for-reconcile',
  'gtd:reconcile-pr-open',
  'gtd:reconcile-failed',
  'gtd:complete',
]);

const TYPE_LABELS = Object.freeze(['type:plan', 'type:task', 'type:checkpoint']);
const EXECUTABLE_TASK_TYPES = new Set(['auto', 'tdd']);

function sha256(text) {
  return crypto
    .createHash('sha256')
    .update(String(text).replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

function parseArgs(args) {
  const opts = {
    dryRun: false,
    phase: null,
    repo: null,
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--repo') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        error('Usage: gtd-tools export-phase-issues <phase> [--dry-run] [--repo owner/name]', ERROR_REASON.USAGE);
      }
      opts.repo = normalizeRepo(value);
      i += 1;
    } else if (arg === '--phase') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        error('Usage: gtd-tools export-phase-issues --phase <phase> [--dry-run] [--repo owner/name]', ERROR_REASON.USAGE);
      }
      opts.phase = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      error(`Unknown export-phase-issues flag: ${arg}`, ERROR_REASON.USAGE);
    } else if (!opts.phase) {
      opts.phase = arg;
    } else {
      error('Usage: gtd-tools export-phase-issues <phase> [--dry-run] [--repo owner/name]', ERROR_REASON.USAGE);
    }
  }

  if (!opts.phase) {
    error('Usage: gtd-tools export-phase-issues <phase> [--dry-run] [--repo owner/name]', ERROR_REASON.USAGE);
  }

  return opts;
}

function phaseNumberFromText(text) {
  const match = String(text || '').match(/\d+[A-Z]?(?:\.\d+)*/i);
  return match ? match[0] : null;
}

function phaseSlugFromDir(phaseDir) {
  return path.basename(phaseDir).toLowerCase();
}

function normalizeLabelToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizePlanToken(value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (/^\d+$/.test(raw)) return raw.padStart(2, '0');
  return raw;
}

function normalizeDependency(value, phaseNumber) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  if (/^\d+[A-Z]?(?:\.\d+)*-\d+[A-Z]?(?:\.\d+)*$/i.test(raw)) return raw;
  if (/^\d+[A-Z]?(?:\.\d+)*$/i.test(raw) && phaseNumber) {
    return `${phaseNumber}-${normalizePlanToken(raw)}`;
  }
  return raw;
}

function splitInlineArray(body) {
  const items = [];
  let current = '';
  let quote = null;

  for (const ch of String(body)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      const item = current.trim();
      if (item) items.push(item);
      current = '';
    } else {
      current += ch;
    }
  }

  const item = current.trim();
  if (item) items.push(item);
  return items;
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined) return [];
  const raw = String(value).trim();
  if (!raw || raw === '[]') return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitInlineArray(raw.slice(1, -1)).map((v) => v.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  }
  if (raw.includes(',')) return splitInlineArray(raw).map((v) => v.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  return [raw.replace(/^["']|["']$/g, '')];
}

function normalizeBlock(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const indents = lines
    .filter((line) => line.trim())
    .map((line) => (line.match(/^(\s*)/) || [''])[0].length);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(minIndent)).join('\n').trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = String(block).match(re);
  return match ? normalizeBlock(match[1]) : '';
}

function extractTaskType(block) {
  const match = String(block).match(/<task\b[^>]*\btype=["']([^"']+)["']/i);
  return match ? match[1].trim() : 'auto';
}

function isExecutableTaskType(type) {
  return EXECUTABLE_TASK_TYPES.has(normalizeTaskType(type));
}

function splitListText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  return raw
    .split(/\n|,/)
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\[[ xX]]\s+/, ''))
    .filter(Boolean);
}

function parseAcceptanceCriteria(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\[[ xX]]\s+/, ''))
    .filter(Boolean);
}

function parseCheckpointDetails(block, taskType) {
  if (!isCheckpointTaskType(taskType)) return null;
  return {
    type: normalizeTaskType(taskType),
    action: extractTag(block, 'action'),
    decision: extractTag(block, 'decision'),
    context: extractTag(block, 'context'),
    options: extractTag(block, 'options'),
    what_built: extractTag(block, 'what-built'),
    how_to_verify: extractTag(block, 'how-to-verify'),
    instructions: extractTag(block, 'instructions'),
    verification: extractTag(block, 'verification'),
    resume_signal: extractTag(block, 'resume-signal'),
  };
}

function cleanForbiddenPath(value) {
  return String(value || '')
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\[[ xX]]\s+/, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^["']|["']$/g, '')
    .replace(/[.;]\s*$/g, '')
    .replace(/\/\*$/, '')
    .trim();
}

function splitForbiddenPathText(text) {
  return String(text || '')
    .split(/\r?\n|,/)
    .map(cleanForbiddenPath)
    .filter(Boolean);
}

function parseForbiddenBoundaryPaths(boundaries) {
  const lines = String(boundaries || '').replace(/\r\n/g, '\n').split('\n');
  const paths = [];
  const prefixRe = /\b(?:DO NOT modify|Forbidden paths|Forbidden):\s*(.*)$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(prefixRe);
    if (!match) continue;

    const tail = match[1].trim();
    if (tail) {
      paths.push(...splitForbiddenPathText(tail));
      continue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (!next) break;
      if (prefixRe.test(next)) break;
      paths.push(...splitForbiddenPathText(next));
    }
  }

  return [...new Set(paths)];
}

function manualReviewItemsForTask(task) {
  if (task.acceptance_criteria.length > 0) return task.acceptance_criteria;
  return task.done ? [task.done] : [];
}

function firstNonEmptyLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function discoverPlanFiles(phaseDir) {
  const plans = [];
  const rootEntries = fs.readdirSync(phaseDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && isRootPlanFile(entry.name)) {
      plans.push({
        rel: entry.name,
        abs: path.join(phaseDir, entry.name),
      });
    }
  }

  const nestedDir = path.join(phaseDir, 'plans');
  if (fs.existsSync(nestedDir) && fs.statSync(nestedDir).isDirectory()) {
    const nestedEntries = fs.readdirSync(nestedDir, { withFileTypes: true });
    for (const entry of nestedEntries) {
      if (entry.isFile() && isNestedPlanFile(entry.name)) {
        plans.push({
          rel: toPosixPath(path.join('plans', entry.name)),
          abs: path.join(nestedDir, entry.name),
        });
      }
    }
  }

  return plans;
}

function derivePlanId(planFile, frontmatter, phaseNumber) {
  const fmPhase = phaseNumberFromText(frontmatter.phase) || phaseNumber;
  const fmPlan = frontmatter.plan ? normalizePlanToken(frontmatter.plan) : null;
  if (fmPhase && fmPlan) return `${fmPhase}-${fmPlan}`;

  const base = path.basename(planFile.rel);
  const exact = base.match(/^(\d+[A-Z]?(?:\.\d+)*)-(\d+[A-Z]?(?:\.\d+)*)-PLAN\.md$/i);
  if (exact) return `${exact[1]}-${normalizePlanToken(exact[2])}`;

  const nested = base.match(/(?:^|-)?PLAN-(\d+[A-Z]?(?:\.\d+)*)(?:-|\.md$)/i);
  if (nested && phaseNumber) return `${phaseNumber}-${normalizePlanToken(nested[1])}`;

  if (phaseNumber && base === 'PLAN.md') return `${phaseNumber}-01`;
  return null;
}

function validationContractForTask(task) {
  const checks = [
    {
      id: 'scope',
      type: 'diff-scope',
      paths: {
        allowed: task.files,
        forbidden: task.forbidden_paths,
      },
    },
  ];

  if (task.verify) {
    checks.push({
      id: 'task-verification',
      type: 'command',
      run: task.verify,
    });
  }

  const manualReviewItems = manualReviewItemsForTask(task);
  if (manualReviewItems.length > 0) {
    checks.push({
      id: 'manual-review',
      type: 'manual',
      description: manualReviewItems.join('; '),
    });
  }

  return { checks };
}

function validateExecutableTaskContract(planId, task, errors, relPath) {
  if (!isExecutableTaskType(task.type)) return;

  const prefix = `${relPath}: ${task.id}`;
  if (task.files.length === 0) errors.push(`${prefix} executable task missing non-empty <files>`);
  if (!task.action) errors.push(`${prefix} executable task missing non-empty <action>`);
  if (!task.verify) errors.push(`${prefix} executable task missing non-empty <verify>`);
  if (!task.done) errors.push(`${prefix} executable task missing non-empty <done>`);
  if (!task.boundaries) errors.push(`${prefix} executable task missing non-empty <boundaries>`);
  if (!planId) errors.push(`${prefix} cannot validate executable task without canonical plan id`);
}

function parseTasks(planId, content, errors, relPath) {
  const tasks = [];
  const re = /<task\b[\s\S]*?<\/task>/gi;
  let match;
  let index = 0;

  while ((match = re.exec(content)) !== null) {
    index += 1;
    const block = match[0];
    const taskId = `${planId}-T${String(index).padStart(2, '0')}`;
    const taskType = extractTaskType(block);
    const name =
      extractTag(block, 'name') ||
      extractTag(block, 'decision') ||
      extractTag(block, 'what-built') ||
      `Task ${String(index).padStart(2, '0')}`;

    const task = {
      id: taskId,
      index,
      type: taskType,
      name: collapseWhitespace(name),
      source_hash: sha256(block),
      files: splitListText(extractTag(block, 'files')),
      read_first: splitListText(extractTag(block, 'read_first')),
      boundaries: extractTag(block, 'boundaries'),
      forbidden_paths: [],
      action: extractTag(block, 'action'),
      verify: extractTag(block, 'verify'),
      done: extractTag(block, 'done'),
      acceptance_criteria: parseAcceptanceCriteria(extractTag(block, 'acceptance_criteria')),
      checkpoint_details: parseCheckpointDetails(block, taskType),
      validation_contract: null,
    };

    task.forbidden_paths = parseForbiddenBoundaryPaths(task.boundaries);
    task.validation_contract = validationContractForTask(task);
    validateExecutableTaskContract(planId, task, errors, relPath);
    tasks.push(task);
  }

  if (tasks.length === 0) {
    errors.push(`${relPath}: no <task> blocks found`);
  }

  return tasks;
}

function parsePlan(cwd, planFile, phaseNumber, phaseSlug, errors) {
  const content = fs.readFileSync(planFile.abs, 'utf8');
  const frontmatter = extractFrontmatter(content);
  const planId = derivePlanId(planFile, frontmatter, phaseNumber);

  if (!planId) errors.push(`${planFile.rel}: could not derive canonical plan id`);
  if (!frontmatter.phase) errors.push(`${planFile.rel}: missing required frontmatter field "phase"`);
  if (!frontmatter.plan) errors.push(`${planFile.rel}: missing required frontmatter field "plan"`);
  if (!frontmatter.wave) errors.push(`${planFile.rel}: missing required frontmatter field "wave"`);
  if (frontmatter.depends_on === undefined) errors.push(`${planFile.rel}: missing required frontmatter field "depends_on"`);
  if (frontmatter.requirements === undefined) errors.push(`${planFile.rel}: missing required frontmatter field "requirements"`);

  const phasePrefix = phaseNumberFromText(frontmatter.phase) || phaseNumber;
  const dependsOn = asArray(frontmatter.depends_on)
    .map((dep) => normalizeDependency(dep, phasePrefix))
    .filter(Boolean);

  const plan = {
    id: planId,
    title: `[GTD ${planId || 'UNKNOWN'}] ${collapseWhitespace(firstNonEmptyLine(extractTag(content, 'objective')) || path.basename(planFile.rel))}`,
    phase: frontmatter.phase || phaseSlug,
    phase_slug: phaseSlug,
    wave: frontmatter.wave === undefined ? null : String(frontmatter.wave),
    depends_on: dependsOn,
    requirements: asArray(frontmatter.requirements),
    priority: frontmatter.priority || null,
    stack: frontmatter.stack || null,
    stacks: frontmatter.stacks || null,
    source_path: toPosixPath(path.relative(cwd, planFile.abs)),
    source_hash: sha256(content),
    objective: extractTag(content, 'objective'),
    success_criteria: extractTag(content, 'success_criteria'),
    verification: extractTag(content, 'verification'),
    tasks: [],
    labels: [],
  };

  plan.tasks = parseTasks(plan.id || 'UNKNOWN', content, errors, planFile.rel);
  return plan;
}

function resolvePhase(cwd, phaseArg) {
  const direct = path.resolve(cwd, phaseArg);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    const phaseDir = direct;
    const phaseSlug = phaseSlugFromDir(phaseDir);
    return {
      phaseDir,
      phaseSlug,
      phaseNumber: phaseNumberFromText(path.basename(phaseDir)),
      phaseDirectory: toPosixPath(path.relative(cwd, phaseDir)),
    };
  }

  const info = findPhaseInternal(cwd, phaseArg);
  if (!info) {
    error(`Phase not found: ${phaseArg}`, ERROR_REASON.PHASE_NOT_FOUND);
  }

  const phaseDir = path.resolve(cwd, info.directory);
  return {
    phaseDir,
    phaseSlug: phaseSlugFromDir(phaseDir),
    phaseNumber: info.phase_number || phaseNumberFromText(path.basename(phaseDir)),
    phaseDirectory: info.directory,
  };
}

function loadExistingManifest(cwd, phaseSlug) {
  const manifestPath = path.join(planningDir(cwd), 'github', `phase-${phaseSlug}-issues.json`);
  if (!fs.existsSync(manifestPath)) {
    return {
      absPath: manifestPath,
      path: toPosixPath(path.relative(cwd, manifestPath)),
      exists: false,
      data: null,
    };
  }

  try {
    return {
      absPath: manifestPath,
      path: toPosixPath(path.relative(cwd, manifestPath)),
      exists: true,
      data: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    };
  } catch (err) {
    error(`Could not parse existing manifest ${toPosixPath(path.relative(cwd, manifestPath))}: ${err.message}`, ERROR_REASON.USAGE);
  }
}

function existingPlanEntry(manifest, planId) {
  return manifest.data?.plans?.[planId] || null;
}

function existingTaskEntry(manifest, planId, taskId) {
  return manifest.data?.plans?.[planId]?.tasks?.[taskId] || null;
}

function manifestAction(existing, newHash, kind) {
  if (!existing) return 'would_add';
  if (existing.source_hash === newHash) return 'would_keep';
  return kind === 'task' ? 'would_update_or_mark_drifted' : 'would_update';
}

function issueRef(existing, fallback) {
  return existing?.issue ? `#${existing.issue}` : `{${fallback}}`;
}

function markdownList(items, emptyText) {
  if (!items || items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function fenced(language, body) {
  return '```' + language + '\n' + String(body || '').trim() + '\n```';
}

function appendMarkdownSection(lines, heading, body) {
  const text = String(body || '').trim();
  if (!text) return;
  lines.push(heading, text, '');
}

function renderCheckpointOptions(options) {
  const raw = String(options || '').trim();
  if (!raw) return '';

  const rendered = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let match;
  let index = 0;
  while ((match = re.exec(raw)) !== null) {
    index += 1;
    const attrs = match[1] || '';
    const block = match[0];
    const id = (attrs.match(/\bid=["']([^"']+)["']/i) || [])[1] || '';
    const name = extractTag(block, 'name') || id || `Option ${index}`;
    const pros = extractTag(block, 'pros');
    const cons = extractTag(block, 'cons');
    const description = extractTag(block, 'description');

    rendered.push(`- ${id && name !== id ? `${name} (\`${id}\`)` : name}`);
    if (description) rendered.push(`  Description: ${collapseWhitespace(description)}`);
    if (pros) rendered.push(`  Pros: ${collapseWhitespace(pros)}`);
    if (cons) rendered.push(`  Cons: ${collapseWhitespace(cons)}`);
  }

  return rendered.length ? rendered.join('\n') : raw;
}

function renderCheckpointBody(plan, task, parentRef, blockedByRefs) {
  const marker = `<!-- gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} task=${task.id} source_hash=${task.source_hash} -->`;
  const details = task.checkpoint_details || {};
  const body = [
    marker,
    '',
    '## Task',
    task.name,
    '',
    '## Source',
    `- Plan: \`${plan.source_path}\``,
    `- Task ID: \`${task.id}\``,
    `- Parent plan issue: ${parentRef}`,
    `- Blocked by: ${blockedByRefs.length ? blockedByRefs.join(', ') : 'none'}`,
    '',
    '## Checkpoint Type',
    `\`${normalizeTaskType(task.type)}\``,
    '',
  ];

  appendMarkdownSection(body, '## What Is Ready For Human Review', details.what_built);
  appendMarkdownSection(body, '## Decision', details.decision);
  appendMarkdownSection(body, '## Context', details.context);
  appendMarkdownSection(body, '## Required Human Action', details.action);
  appendMarkdownSection(body, '## Human Instructions', details.how_to_verify || details.instructions);
  if (details.how_to_verify && details.instructions) {
    appendMarkdownSection(body, '## Additional Instructions', details.instructions);
  }
  appendMarkdownSection(body, '## Options', renderCheckpointOptions(details.options));
  appendMarkdownSection(body, '## Verification After Action', details.verification);
  appendMarkdownSection(body, '## Resume Signal', details.resume_signal);

  if (![
    details.what_built,
    details.decision,
    details.context,
    details.action,
    details.how_to_verify,
    details.instructions,
    details.options,
    details.verification,
    details.resume_signal,
  ].some((value) => String(value || '').trim())) {
    appendMarkdownSection(
      body,
      '## Human Instructions',
      'Record the required human decision or result in this GitHub issue, then close the issue.',
    );
  }

  body.push(
    '## Human Checkpoint Resolution',
    'This is a human-in-the-loop checkpoint, not an executable implementation task. Record the human decision or result in this GitHub issue, then close the issue. Orchestration waits until this checkpoint issue is closed before unblocking dependent tasks.',
    '',
    '## Executor Contract',
    'Do not implement or edit code for this checkpoint task. If a task executor is invoked for this issue, it must stop and report that the checkpoint requires human resolution.',
    '',
  );

  return body.join('\n');
}

function renderParentBody(plan, manifest) {
  const marker = `<!-- gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} source_hash=${plan.source_hash} -->`;
  const childLines = plan.tasks.map((task) => {
    const existing = existingTaskEntry(manifest, plan.id, task.id);
    return `- [ ] ${issueRef(existing, `task:${task.id}`)} ${task.id}: ${task.name}`;
  });

  return [
    marker,
    '',
    `# ${plan.title}`,
    '',
    '## Source',
    `- Phase: \`${plan.phase_slug}\``,
    `- Wave: \`${plan.wave}\``,
    `- Plan ID: \`${plan.id}\``,
    `- Source path: \`${plan.source_path}\``,
    `- Depends on: ${plan.depends_on.length ? plan.depends_on.map((dep) => `\`${dep}\``).join(', ') : 'none'}`,
    '',
    '## Requirements',
    markdownList(plan.requirements, 'No requirements declared'),
    '',
    '## Objective',
    plan.objective || 'No objective declared',
    '',
    '## Success Criteria',
    plan.success_criteria || 'No success criteria declared',
    '',
    '## Verification',
    plan.verification || 'No plan verification declared',
    '',
    '## Child Tasks',
    childLines.join('\n') || '- No child tasks declared',
    '',
    '## Reconciliation Status',
    'Not reconciled. Child task PRs must merge before plan reconciliation.',
    '',
  ].join('\n');
}

function renderChildBody(plan, task, parentRef, blockedByRefs) {
  const marker = `<!-- gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} task=${task.id} source_hash=${task.source_hash} -->`;
  const checkpointTask = isCheckpointTaskType(task.type);
  if (checkpointTask) return renderCheckpointBody(plan, task, parentRef, blockedByRefs);

  const validationYaml = [
    'checks:',
    ...task.validation_contract.checks.flatMap((check) => {
      if (check.type === 'diff-scope') {
        return [
          `  - id: ${check.id}`,
          `    type: ${check.type}`,
          '    paths:',
          '      allowed:',
          ...(check.paths.allowed.length ? check.paths.allowed.map((p) => `        - ${p}`) : ['        - ""']),
          '      forbidden:',
          ...(check.paths.forbidden.length ? check.paths.forbidden.map((p) => `        - ${p}`) : ['        - ""']),
        ];
      }
      if (check.type === 'command') {
        return [
          `  - id: ${check.id}`,
          `    type: ${check.type}`,
          `    run: ${JSON.stringify(check.run)}`,
        ];
      }
      return [
        `  - id: ${check.id}`,
        `    type: ${check.type}`,
        `    description: ${JSON.stringify(check.description)}`,
      ];
    }),
  ].join('\n');

  const body = [
    marker,
    '',
    '## Task',
    task.name,
    '',
    '## Source',
    `- Plan: \`${plan.source_path}\``,
    `- Task ID: \`${task.id}\``,
    `- Parent plan issue: ${parentRef}`,
    `- Blocked by: ${blockedByRefs.length ? blockedByRefs.join(', ') : 'none'}`,
    '',
    '## Required Read First',
    markdownList(task.read_first, 'None declared'),
    '',
    '## Write Scope',
    'Allowed:',
    markdownList(task.files, 'No explicit files declared'),
    '',
    'Boundaries:',
    task.boundaries || 'No boundaries declared',
    '',
    '## Action',
    task.action || 'No action block declared',
    '',
    '## Done',
    task.done || 'No done criteria declared',
    '',
    '## Acceptance Criteria',
    task.acceptance_criteria.length
      ? task.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`).join('\n')
      : '- [ ] No acceptance criteria declared',
    '',
    '## Validation Contract',
    fenced('yaml', validationYaml),
    '',
    '## Verification',
    fenced('bash', task.verify || ''),
    '',
  ];

  body.push(
    '## Executor Contract',
    'Implement only this task. Keep changes inside the declared write scope. Run the verification command and mechanically check every acceptance criterion that can be checked. The final PR must close this issue only.',
    '',
  );

  return body.join('\n');
}

function deriveLabels(plans, phaseSlug) {
  const labels = new Set([...WORKFLOW_LABELS, ...TYPE_LABELS, `phase:${phaseSlug}`]);
  for (const plan of plans) {
    if (plan.priority) labels.add(`priority:${normalizeLabelToken(plan.priority)}`);
    for (const stack of asArray(plan.stack || plan.stacks)) {
      const normalized = normalizeLabelToken(stack);
      if (normalized) labels.add(`stack:${normalized}`);
    }
  }
  return [...labels].sort();
}

function attachLabels(plans, phaseSlug) {
  for (const plan of plans) {
    const stateLabel = plan.depends_on.length > 0 ? 'gtd:blocked' : 'gtd:ready';
    plan.labels = ['gtd:plan', stateLabel, `phase:${phaseSlug}`, 'type:plan'];
    for (const task of plan.tasks) {
      if (isCheckpointTaskType(task.type)) {
        task.labels = [
          'gtd:task',
          'gtd:checkpoint',
          'gtd:human-in-the-loop',
          'gtd:blocked-human',
          'gtd:blocked',
          `phase:${phaseSlug}`,
          'type:checkpoint',
        ];
        continue;
      }
      const taskBlocked = task.index > 1 || (task.index === 1 && plan.depends_on.length > 0);
      task.labels = ['gtd:task', taskBlocked ? 'gtd:blocked' : 'gtd:ready', `phase:${phaseSlug}`, 'type:task'];
    }
  }
}

function validatePlans(plans, errors) {
  const planIds = new Set();
  for (const plan of plans) {
    if (planIds.has(plan.id)) errors.push(`duplicate plan id: ${plan.id}`);
    planIds.add(plan.id);
  }

  for (const plan of plans) {
    for (const dep of plan.depends_on) {
      if (!planIds.has(dep)) {
        errors.push(`${plan.source_path}: depends_on references missing plan "${dep}" in this export`);
      }
    }
  }
}

function loadExportSource(cwd, opts) {
  const phase = resolvePhase(cwd, opts.phase);
  const planFiles = discoverPlanFiles(phase.phaseDir);
  const errors = [];

  if (planFiles.length === 0) {
    errors.push(`${phase.phaseDirectory}: no PLAN.md files found`);
  }

  const plans = planFiles
    .map((planFile) => parsePlan(cwd, planFile, phase.phaseNumber, phase.phaseSlug, errors))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  validatePlans(plans, errors);

  if (errors.length > 0) {
    error(`Invalid export source:\n- ${errors.join('\n- ')}`, ERROR_REASON.USAGE);
  }

  attachLabels(plans, phase.phaseSlug);

  const manifest = loadExistingManifest(cwd, phase.phaseSlug);
  const labelNames = deriveLabels(plans, phase.phaseSlug);

  return {
    phase,
    plans,
    manifest,
    labelNames,
  };
}

function markerForPlan(plan) {
  return `<!-- gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} source_hash=${plan.source_hash} -->`;
}

function markerForTask(plan, task) {
  return `<!-- gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} task=${task.id} source_hash=${task.source_hash} -->`;
}

function markerIdentityForPlan(plan) {
  return `gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} source_hash=`;
}

function markerIdentityForTask(plan, task) {
  return `gtd-export:v1 phase=${plan.phase_slug} plan=${plan.id} task=${task.id} source_hash=`;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkerHash(body, identity) {
  const re = new RegExp(`<!--\\s*${escapeRegExp(identity)}([a-f0-9]+)\\s*-->`, 'i');
  const match = String(body || '').match(re);
  return match ? match[1] : null;
}

function hasMarkerIdentity(issue, identity) {
  return String(issue?.body || '').includes(identity);
}

function managedExportLabel(label) {
  return WORKFLOW_LABELS.includes(label) ||
    TYPE_LABELS.includes(label) ||
    label.startsWith('phase:') ||
    label.startsWith('priority:') ||
    label.startsWith('stack:');
}

function mergeExportLabels(existingLabels, desiredLabels) {
  const merged = new Set();
  for (const label of existingLabels || []) {
    if (!managedExportLabel(label)) merged.add(label);
  }
  for (const label of desiredLabels || []) merged.add(label);
  return [...merged].sort();
}

function exportManagedLabels(labels) {
  return [...new Set((labels || []).filter((label) => managedExportLabel(label)))].sort();
}

function sameStringArray(a, b) {
  const left = [...(a || [])].sort();
  const right = [...(b || [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issueRefFromNumber(number, fallback) {
  return number ? `#${number}` : `{${fallback}}`;
}

function manifestView(manifestData) {
  return { data: manifestData };
}

function normalizeRepo(repo) {
  const value = normalizeGitHubRepo(repo);
  if (!value) {
    error(`Invalid GitHub repository "${repo}". Expected owner/name.`, ERROR_REASON.USAGE);
  }
  return value;
}

function resolveOptionalTargetRepo(cwd, opts, manifest) {
  const manifestRepo = manifest.data?.repo || null;
  if (opts.repo && manifestRepo && opts.repo !== manifestRepo) {
    error(`Export manifest targets ${manifestRepo}; refusing to write to ${opts.repo}.`, ERROR_REASON.USAGE);
  }
  if (opts.repo) return { repo: normalizeRepo(opts.repo), source: 'argument' };
  if (manifestRepo) return { repo: normalizeRepo(manifestRepo), source: 'manifest' };

  const inferred = resolveGitHubRepoFromGit(cwd);
  if (inferred.ok) {
    return { repo: normalizeRepo(inferred.repo), source: inferred.source, git: inferred };
  }
  return { repo: null, source: null, git: inferred };
}

function resolveTargetRepo(cwd, opts, manifest) {
  const resolved = resolveOptionalTargetRepo(cwd, opts, manifest);
  if (!resolved.repo) {
    error(`Write mode requires --repo owner/name, an existing manifest with a repo, or an unambiguous GitHub git remote (${resolved.git?.message || 'repository inference failed'}).`, ERROR_REASON.USAGE);
  }
  return resolved.repo;
}

function labelSpec(label) {
  if (label === 'gtd:checkpoint') {
    return { color: 'fbca04', description: 'GTD human checkpoint task issue' };
  }
  if (label === 'gtd:human-in-the-loop') {
    return { color: 'd93f0b', description: 'GTD task requires explicit human action' };
  }
  if (label === 'gtd:checkpoint-resolved') {
    return { color: '0e8a16', description: 'GTD human checkpoint has been resolved' };
  }
  if (label.startsWith('phase:')) {
    return { color: '0e8a16', description: `GTD phase ${label.slice('phase:'.length)}` };
  }
  if (label.startsWith('priority:')) {
    return { color: 'fbca04', description: `GTD priority ${label.slice('priority:'.length)}` };
  }
  if (label.startsWith('stack:')) {
    return { color: '1d76db', description: `GTD stack ${label.slice('stack:'.length)}` };
  }
  if (label.startsWith('type:')) {
    return { color: 'c2e0c6', description: `GTD exported ${label.slice('type:'.length)} issue` };
  }
  return { color: '5319e7', description: `GTD workflow label ${label}` };
}

class GitHubExportError extends Error {
  constructor(message, operation = null) {
    super(message);
    this.name = 'GitHubExportError';
    this.operation = operation;
  }
}

class GhCliGitHubAdapter {
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
      ErrorClass: GitHubExportError,
      missingGhMessage: 'GitHub CLI `gh` was not found; install and authenticate gh before running export write mode.',
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
      ErrorClass: GitHubExportError,
      missingGhMessage: 'GitHub CLI `gh` was not found; install and authenticate gh before running export write mode.',
    });
  }

  repoEndpoint(suffix) {
    return ghRepoEndpoint(this.repo, suffix);
  }

  getLabel(name) {
    return this.api('GET', this.repoEndpoint(`labels/${encodeURIComponent(name)}`), null, `get_label:${name}`, true);
  }

  ensureLabel(name) {
    const spec = labelSpec(name);
    const existing = this.getLabel(name);
    if (!existing) {
      return {
        action: 'created',
        label: this.api('POST', this.repoEndpoint('labels'), {
          name,
          color: spec.color,
          description: spec.description,
        }, `create_label:${name}`),
      };
    }

    const existingDescription = existing.description || '';
    const existingColor = String(existing.color || '').toLowerCase();
    if (existingColor !== spec.color || existingDescription !== spec.description) {
      return {
        action: 'updated',
        label: this.api('PATCH', this.repoEndpoint(`labels/${encodeURIComponent(name)}`), {
          new_name: name,
          color: spec.color,
          description: spec.description,
        }, `update_label:${name}`),
      };
    }

    return { action: 'kept', label: existing };
  }

  getIssue(number) {
    return this.api('GET', this.repoEndpoint(`issues/${number}`), null, `get_issue:${number}`, true);
  }

  searchIssuesContaining(identity) {
    const query = `repo:${this.repo} is:issue in:body "${identity.replace(/"/g, '')}"`;
    const search = this.api(
      'GET',
      `search/issues?q=${encodeURIComponent(query)}&per_page=10`,
      null,
      `search_marker:${identity}`,
    );
    const issues = [];
    for (const item of search.items || []) {
      const issue = this.getIssue(item.number);
      if (hasMarkerIdentity(issue, identity)) issues.push(issue);
    }
    return issues.sort((a, b) => a.number - b.number);
  }

  createIssue({ title, body, labels }) {
    return this.api('POST', this.repoEndpoint('issues'), { title, body, labels }, `create_issue:${title}`);
  }

  updateIssue(number, { title, body, labels }) {
    return this.api('PATCH', this.repoEndpoint(`issues/${number}`), { title, body, labels }, `update_issue:${number}`);
  }

  addLabels(number, labels) {
    return this.api('POST', this.repoEndpoint(`issues/${number}/labels`), { labels }, `add_labels:${number}`);
  }

  commentIssue(number, body) {
    return this.api('POST', this.repoEndpoint(`issues/${number}/comments`), { body }, `comment_issue:${number}`);
  }

  listSubIssues(parentNumber) {
    return this.api('GET', this.repoEndpoint(`issues/${parentNumber}/sub_issues?per_page=100`), null, `list_sub_issues:${parentNumber}`);
  }

  addSubIssue(parentNumber, childIssueId) {
    return this.api('POST', this.repoEndpoint(`issues/${parentNumber}/sub_issues`), {
      sub_issue_id: childIssueId,
    }, `add_sub_issue:${parentNumber}:${childIssueId}`);
  }

  listBlockedBy(issueNumber) {
    return this.api('GET', this.repoEndpoint(`issues/${issueNumber}/dependencies/blocked_by?per_page=100`), null, `list_blocked_by:${issueNumber}`);
  }

  addBlockedBy(issueNumber, blockingIssueId) {
    return this.api('POST', this.repoEndpoint(`issues/${issueNumber}/dependencies/blocked_by`), {
      issue_id: blockingIssueId,
    }, `add_blocked_by:${issueNumber}:${blockingIssueId}`);
  }
}

function createManifestData({ repo, phase, plans, previous }) {
  const data = {
    version: 1,
    repo,
    phase: phase.phaseSlug,
    phase_number: phase.phaseNumber,
    directory: phase.phaseDirectory,
    status: 'partial',
    exported_at: previous?.exported_at || null,
    updated_at: new Date().toISOString(),
    plans: {},
    operation_state: {
      completed: previous?.operation_state?.completed || [],
      failed: null,
    },
  };

  for (const plan of plans) {
    const existingPlan = previous?.plans?.[plan.id] || {};
    data.plans[plan.id] = {
      issue: existingPlan.issue || null,
      github_id: existingPlan.github_id || null,
      source_hash: plan.source_hash,
      status: existingPlan.status === 'complete' ? 'pending' : (existingPlan.status || 'pending'),
      relationships: {
        sub_issues_attached: false,
        dependencies_attached: false,
      },
      tasks: {},
    };

    for (const task of plan.tasks) {
      const existingTask = existingPlan.tasks?.[task.id] || {};
      const existingTaskExportStatus = existingTask.exportStatus ||
        (TASK_EXPORT_STATUSES.has(existingTask.status) ? existingTask.status : null);
      const taskEntryData = {
        issue: existingTask.issue || null,
        github_id: existingTask.github_id || null,
        source_hash: task.source_hash,
        type: task.type,
        done: task.done || null,
        checkpoint_details: task.checkpoint_details || null,
        exportStatus: existingTaskExportStatus === 'complete' ? 'pending' : (existingTaskExportStatus || 'pending'),
      };
      const checkpointStatus = existingTask.checkpointStatus ||
        (existingTask.status === 'checkpoint_resolved' ? 'checkpoint_resolved' : null);
      if (checkpointStatus) taskEntryData.checkpointStatus = checkpointStatus;
      data.plans[plan.id].tasks[task.id] = taskEntryData;
    }
  }

  return data;
}

function writeManifest(manifestInfo, manifestData) {
  fs.mkdirSync(path.dirname(manifestInfo.absPath), { recursive: true });
  manifestData.updated_at = new Date().toISOString();
  fs.writeFileSync(manifestInfo.absPath, `${JSON.stringify(manifestData, null, 2)}\n`, 'utf8');
}

function recordCompletedOperation(manifestData, key) {
  if (!manifestData.operation_state.completed.includes(key)) {
    manifestData.operation_state.completed.push(key);
  }
  manifestData.operation_state.failed = null;
}

function parentEntry(manifestData, planId) {
  return manifestData.plans[planId];
}

function taskEntry(manifestData, planId, taskId) {
  return manifestData.plans[planId].tasks[taskId];
}

function previousTaskId(plan, task) {
  return `${plan.id}-T${String(task.index - 1).padStart(2, '0')}`;
}

function findExistingExportIssue(adapter, identity, manifestIssueNumber, operation) {
  if (manifestIssueNumber) {
    const issue = adapter.getIssue(manifestIssueNumber);
    if (!issue) {
      throw new GitHubExportError(`Manifest issue #${manifestIssueNumber} for ${identity} was not found.`, operation);
    }
    if (!hasMarkerIdentity(issue, identity)) {
      throw new GitHubExportError(`Manifest issue #${manifestIssueNumber} does not contain marker "${identity}".`, operation);
    }
    return issue;
  }

  const matches = adapter.searchIssuesContaining(identity);
  if (matches.length > 1) {
    throw new GitHubExportError(`Multiple GitHub issues contain marker "${identity}"; clean up duplicates before rerunning.`, operation);
  }
  return matches[0] || null;
}

function issueWorkStarted(issue) {
  const labels = new Set(labelNamesFromIssue(issue));
  return labels.has('gtd:in-progress') ||
    labels.has('gtd:pr-open') ||
    labels.has('gtd:needs-rework') ||
    labels.has('gtd:validation-failed') ||
    labels.has('gtd:rejected') ||
    labels.has('gtd:merged');
}

function ensureExportIssue(adapter, spec) {
  const issue = findExistingExportIssue(adapter, spec.identity, spec.manifestIssueNumber, spec.operation);
  if (!issue) {
    return {
      action: 'created',
      issue: adapter.createIssue({
        title: spec.title,
        body: spec.body,
        labels: spec.labels,
      }),
    };
  }

  const oldHash = extractMarkerHash(issue.body, spec.identity);
  if (spec.kind === 'child_task' && oldHash && oldHash !== spec.sourceHash && issueWorkStarted(issue)) {
    const labels = new Set(labelNamesFromIssue(issue));
    if (!labels.has('gtd:source-drift')) {
      adapter.addLabels(issue.number, ['gtd:source-drift']);
      adapter.commentIssue(
        issue.number,
        [
          'GTD source drift detected during phase issue export.',
          '',
          `- Previous source hash: \`${oldHash}\``,
          `- Current source hash: \`${spec.sourceHash}\``,
          '',
          'The task issue was not rewritten because task work has already started. Update the source plan or task issue, then rerun export.',
        ].join('\n'),
      );
    }
    return { action: 'source_drift', issue: adapter.getIssue(issue.number) || issue };
  }

  const desiredLabels = mergeExportLabels(labelNamesFromIssue(issue), spec.labels);
  const sameTitle = issue.title === spec.title;
  const sameBody = String(issue.body || '') === spec.body;
  const sameLabels = sameStringArray(labelNamesFromIssue(issue), desiredLabels);
  if (sameTitle && sameBody && sameLabels) {
    return { action: 'kept', issue };
  }

  return {
    action: 'updated',
    issue: adapter.updateIssue(issue.number, {
      title: spec.title,
      body: spec.body,
      labels: desiredLabels,
    }),
  };
}

function taskBlockedByIssueNumbers(plan, task, manifestData) {
  if (task.index === 1) {
    return plan.depends_on
      .map((dep) => parentEntry(manifestData, dep)?.issue)
      .filter(Boolean);
  }

  const previous = taskEntry(manifestData, plan.id, previousTaskId(plan, task));
  return previous?.issue ? [previous.issue] : [];
}

function taskBlockedByIssueRefs(plan, task, manifestData) {
  if (task.index === 1) {
    return plan.depends_on.map((dep) => {
      const issue = parentEntry(manifestData, dep)?.issue;
      return issueRefFromNumber(issue, `plan:${dep}`);
    });
  }

  const previousId = previousTaskId(plan, task);
  const previous = taskEntry(manifestData, plan.id, previousId);
  return [issueRefFromNumber(previous?.issue, `task:${previousId}`)];
}

function writePartialFailureState(adapter, manifestInfo, manifestData, failure, plans) {
  manifestData.status = 'partial';
  manifestData.operation_state.failed = {
    operation: failure.operation || 'unknown',
    message: failure.message,
  };
  writeManifest(manifestInfo, manifestData);

  for (const plan of plans) {
    const issueNumber = parentEntry(manifestData, plan.id)?.issue;
    if (!issueNumber) continue;
    try {
      adapter.addLabels(issueNumber, ['gtd:export-partial']);
    } catch {
      // Best effort only; the manifest remains the authoritative partial record.
    }
  }
}

function verifyLabels(adapter, labelNames, errors) {
  for (const label of labelNames) {
    if (!adapter.getLabel(label)) {
      errors.push(`missing label ${label}`);
    }
  }
}

function verifyIssueMarker(adapter, issueNumber, marker, labelSpecList, errors, context) {
  const issue = adapter.getIssue(issueNumber);
  if (!issue) {
    errors.push(`${context}: issue #${issueNumber} was not found`);
    return null;
  }
  if (!String(issue.body || '').includes(marker)) {
    errors.push(`${context}: issue #${issueNumber} does not contain expected marker`);
  }
  const actualManaged = exportManagedLabels(labelNamesFromIssue(issue));
  const expectedManaged = exportManagedLabels(labelSpecList);
  if (!sameStringArray(actualManaged, expectedManaged)) {
    errors.push(`${context}: issue #${issueNumber} labels do not match derived export labels`);
  }
  return issue;
}

function verifyNoDuplicateMarker(adapter, identity, expectedIssueNumber, errors) {
  const matches = adapter.searchIssuesContaining(identity);
  const numbers = matches.map((issue) => issue.number);
  const unique = [...new Set(numbers)];
  if (unique.length !== 1 || unique[0] !== expectedIssueNumber) {
    errors.push(`marker "${identity}" expected only on #${expectedIssueNumber}; found ${unique.length ? unique.map((n) => `#${n}`).join(', ') : 'none'}`);
  }
}

function runPostExportConsistencyCheck(adapter, { plans, labelNames, manifestData }) {
  const errors = [];
  verifyLabels(adapter, labelNames, errors);

  for (const plan of plans) {
    const planManifest = parentEntry(manifestData, plan.id);
    const parentIssue = verifyIssueMarker(adapter, planManifest.issue, markerForPlan(plan), plan.labels, errors, `plan ${plan.id}`);
    if (parentIssue) {
      verifyNoDuplicateMarker(adapter, markerIdentityForPlan(plan), parentIssue.number, errors);
      for (const task of plan.tasks) {
        const childIssueNumber = taskEntry(manifestData, plan.id, task.id).issue;
        if (!String(parentIssue.body || '').includes(`#${childIssueNumber}`) ||
            !String(parentIssue.body || '').includes(task.id)) {
          errors.push(`plan ${plan.id}: parent checklist does not reference task ${task.id} issue #${childIssueNumber}`);
        }
      }
    }

    const subIssueIds = new Set((adapter.listSubIssues(planManifest.issue) || []).map((issue) => issue.id));
    for (const task of plan.tasks) {
      const childManifest = taskEntry(manifestData, plan.id, task.id);
      const childIssue = verifyIssueMarker(adapter, childManifest.issue, markerForTask(plan, task), task.labels, errors, `task ${task.id}`);
      if (childIssue) {
        verifyNoDuplicateMarker(adapter, markerIdentityForTask(plan, task), childIssue.number, errors);
        if (!subIssueIds.has(childIssue.id)) {
          errors.push(`task ${task.id}: issue #${childIssue.number} is not attached as a sub-issue of #${planManifest.issue}`);
        }
      }
    }

    const parentBlockerIds = new Set((adapter.listBlockedBy(planManifest.issue) || []).map((issue) => issue.id));
    for (const dep of plan.depends_on) {
      const depEntry = parentEntry(manifestData, dep);
      if (!depEntry?.github_id || !parentBlockerIds.has(depEntry.github_id)) {
        errors.push(`plan ${plan.id}: missing blocked-by dependency on plan ${dep}`);
      }
    }

    for (const task of plan.tasks) {
      const childManifest = taskEntry(manifestData, plan.id, task.id);
      const childBlockerIds = new Set((adapter.listBlockedBy(childManifest.issue) || []).map((issue) => issue.id));
      for (const blockerNumber of taskBlockedByIssueNumbers(plan, task, manifestData)) {
        const blocker = adapter.getIssue(blockerNumber);
        if (!blocker || !childBlockerIds.has(blocker.id)) {
          errors.push(`task ${task.id}: missing blocked-by dependency on #${blockerNumber}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function planOutput(plan, manifestData) {
  const planManifest = parentEntry(manifestData, plan.id);
  return {
    id: plan.id,
    issue: planManifest?.issue || null,
    source_path: plan.source_path,
    source_hash: plan.source_hash,
    title: plan.title,
    labels: plan.labels,
    depends_on: plan.depends_on,
    tasks: plan.tasks.map((task) => {
      const childManifest = taskEntry(manifestData, plan.id, task.id);
      return {
        id: task.id,
        issue: childManifest?.issue || null,
        index: task.index,
        type: task.type,
        name: task.name,
        source_hash: task.source_hash,
        labels: task.labels,
        blocked_by: task.index === 1 ? plan.depends_on : [previousTaskId(plan, task)],
        read_first: task.read_first,
        files: task.files,
        boundaries: task.boundaries,
        forbidden_paths: task.forbidden_paths,
        done: task.done,
        verify: task.verify,
        acceptance_criteria: task.acceptance_criteria,
        checkpoint_details: task.checkpoint_details,
        validation_contract: task.validation_contract,
      };
    }),
  };
}

function buildDryRun(cwd, opts) {
  const { phase, plans, manifest, labelNames } = loadExportSource(cwd, opts);
  const github = [];
  const manifestOps = [];
  const unavailable = [];

  let order = 1;
  for (const label of labelNames) {
    github.push({ order: order++, op: 'ensure_label', label });
  }

  for (const plan of plans) {
    const existingPlan = existingPlanEntry(manifest, plan.id);
    const parentRef = issueRef(existingPlan, `plan:${plan.id}`);
    github.push({
      order: order++,
      op: 'create_or_update_issue',
      issue_kind: 'parent_plan',
      plan_id: plan.id,
      issue_ref: parentRef,
      title: plan.title,
      labels: plan.labels,
      marker: markerForPlan(plan),
      source_hash: plan.source_hash,
      body: renderParentBody(plan, manifest),
    });

    manifestOps.push({
      order: order++,
      op: 'record_manifest_entry',
      entry_kind: 'parent_plan',
      plan_id: plan.id,
      issue: existingPlan?.issue || null,
      source_hash: plan.source_hash,
      action: manifestAction(existingPlan, plan.source_hash, 'plan'),
      status: 'dry-run',
    });
  }

  for (const plan of plans) {
    const parentRef = issueRef(existingPlanEntry(manifest, plan.id), `plan:${plan.id}`);
    for (const task of plan.tasks) {
      const existingTask = existingTaskEntry(manifest, plan.id, task.id);
      const previousId = task.index > 1 ? previousTaskId(plan, task) : null;
      const blockedBy = task.index === 1
        ? plan.depends_on.map((dep) => issueRef(existingPlanEntry(manifest, dep), `plan:${dep}`))
        : [issueRef(existingTaskEntry(manifest, plan.id, previousId), `task:${previousId}`)];

      github.push({
        order: order++,
        op: 'create_or_update_issue',
        issue_kind: 'child_task',
        plan_id: plan.id,
        task_id: task.id,
        issue_ref: issueRef(existingTask, `task:${task.id}`),
        title: `[GTD ${task.id}] ${task.name}`,
        labels: task.labels,
        marker: markerForTask(plan, task),
        source_hash: task.source_hash,
        body: renderChildBody(plan, task, parentRef, blockedBy),
      });

      manifestOps.push({
        order: order++,
        op: 'record_manifest_entry',
        entry_kind: 'child_task',
        plan_id: plan.id,
        task_id: task.id,
        issue: existingTask?.issue || null,
        source_hash: task.source_hash,
        action: manifestAction(existingTask, task.source_hash, 'task'),
        status: 'dry-run',
      });
    }
  }

  for (const plan of plans) {
    const parentRef = issueRef(existingPlanEntry(manifest, plan.id), `plan:${plan.id}`);
    for (const task of plan.tasks) {
      github.push({
        order: order++,
        op: 'attach_sub_issue',
        parent_plan_id: plan.id,
        child_task_id: task.id,
        parent_issue_ref: parentRef,
        child_issue_ref: issueRef(existingTaskEntry(manifest, plan.id, task.id), `task:${task.id}`),
      });
    }
  }

  for (const plan of plans) {
    for (const dep of plan.depends_on) {
      github.push({
        order: order++,
        op: 'ensure_blocked_by_dependency',
        issue_kind: 'parent_plan',
        plan_id: plan.id,
        issue_ref: issueRef(existingPlanEntry(manifest, plan.id), `plan:${plan.id}`),
        blocked_by_plan_id: dep,
        blocked_by_issue_ref: issueRef(existingPlanEntry(manifest, dep), `plan:${dep}`),
      });
    }

    for (const task of plan.tasks) {
      if (task.index === 1) {
        for (const dep of plan.depends_on) {
          github.push({
            order: order++,
            op: 'ensure_blocked_by_dependency',
            issue_kind: 'child_task',
            plan_id: plan.id,
            task_id: task.id,
            issue_ref: issueRef(existingTaskEntry(manifest, plan.id, task.id), `task:${task.id}`),
            blocked_by_plan_id: dep,
            blocked_by_issue_ref: issueRef(existingPlanEntry(manifest, dep), `plan:${dep}`),
          });
        }
      } else {
        const previousId = previousTaskId(plan, task);
        github.push({
          order: order++,
          op: 'ensure_blocked_by_dependency',
          issue_kind: 'child_task',
          plan_id: plan.id,
          task_id: task.id,
          issue_ref: issueRef(existingTaskEntry(manifest, plan.id, task.id), `task:${task.id}`),
          blocked_by_task_id: previousId,
          blocked_by_issue_ref: issueRef(existingTaskEntry(manifest, plan.id, previousId), `task:${previousId}`),
        });
      }
    }
  }

  const targetRepo = resolveOptionalTargetRepo(cwd, opts, manifest);

  if (!targetRepo.repo) {
    unavailable.push({
      op: 'target_repository_resolution',
      reason: `no repository supplied and GitHub repository inference failed (${targetRepo.git?.message || 'repository inference failed'}); pass --repo owner/name to bind the dry-run to a GitHub target`,
    });
  }

  unavailable.push(
    {
      op: 'github_label_existence_check',
      reason: 'dry-run mode is read-only and does not query GitHub labels',
    },
    {
      op: 'github_marker_search',
      reason: 'dry-run mode does not search GitHub for existing idempotency markers',
    },
    {
      op: 'github_issue_dependency_diff',
      reason: 'dry-run mode cannot compute dependency removals without live GitHub state',
    },
    {
      op: 'github_sub_issue_capability_check',
      reason: 'dry-run mode does not verify repository support for native sub-issues',
    },
  );

  return {
    ok: true,
    version: 1,
    mode: 'dry-run',
    writes: false,
    repo: targetRepo.repo,
    phase: {
      phase_slug: phase.phaseSlug,
      phase_number: phase.phaseNumber,
      directory: phase.phaseDirectory,
    },
    manifest: {
      path: manifest.path,
      exists: manifest.exists,
      would_write: false,
    },
    labels: labelNames,
    plans: plans.map((plan) => ({
      id: plan.id,
      source_path: plan.source_path,
      source_hash: plan.source_hash,
      title: plan.title,
      labels: plan.labels,
      depends_on: plan.depends_on,
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        index: task.index,
        type: task.type,
        name: task.name,
        source_hash: task.source_hash,
        labels: task.labels,
        blocked_by: task.index === 1 ? plan.depends_on : [previousTaskId(plan, task)],
        read_first: task.read_first,
        files: task.files,
        boundaries: task.boundaries,
        forbidden_paths: task.forbidden_paths,
        done: task.done,
        verify: task.verify,
        acceptance_criteria: task.acceptance_criteria,
        checkpoint_details: task.checkpoint_details,
        validation_contract: task.validation_contract,
      })),
    })),
    operations: {
      github,
      manifest: manifestOps,
      unavailable,
      no_ops: [
        'no labels created',
        'no issues created or updated',
        'no comments posted',
        'no sub-issues attached',
        'no dependencies created or removed',
        'no branches created',
        'no commits created',
        'no manifest files written',
      ],
    },
  };
}

function buildWriteMode(cwd, opts, adapterOverride = null) {
  const { phase, plans, manifest, labelNames } = loadExportSource(cwd, opts);
  const repo = resolveTargetRepo(cwd, opts, manifest);
  const adapter = adapterOverride || new GhCliGitHubAdapter({ cwd, repo });
  const manifestData = createManifestData({
    repo,
    phase,
    plans,
    previous: manifest.data,
  });
  const completed = [];

  const persistCompleted = (operation) => {
    recordCompletedOperation(manifestData, operation);
    completed.push(operation);
    writeManifest(manifest, manifestData);
  };

  try {
    for (const label of labelNames) {
      adapter.ensureLabel(label);
      persistCompleted(`ensure_label:${label}`);
    }

    for (const plan of plans) {
      const entry = parentEntry(manifestData, plan.id);
      const result = ensureExportIssue(adapter, {
        kind: 'parent_plan',
        identity: markerIdentityForPlan(plan),
        sourceHash: plan.source_hash,
        manifestIssueNumber: entry.issue,
        title: plan.title,
        body: renderParentBody(plan, manifestView(manifestData)),
        labels: plan.labels,
        operation: `ensure_parent_issue:${plan.id}`,
      });
      entry.issue = result.issue.number;
      entry.github_id = result.issue.id;
      entry.source_hash = plan.source_hash;
      entry.status = result.action === 'source_drift' ? 'source_drift' : 'exported';
      persistCompleted(`ensure_parent_issue:${plan.id}:${result.action}`);
    }

    for (const plan of plans) {
      const parentRef = issueRefFromNumber(parentEntry(manifestData, plan.id).issue, `plan:${plan.id}`);
      for (const task of plan.tasks) {
        const entry = taskEntry(manifestData, plan.id, task.id);
        const result = ensureExportIssue(adapter, {
          kind: 'child_task',
          identity: markerIdentityForTask(plan, task),
          sourceHash: task.source_hash,
          manifestIssueNumber: entry.issue,
          title: `[GTD ${task.id}] ${task.name}`,
          body: renderChildBody(plan, task, parentRef, taskBlockedByIssueRefs(plan, task, manifestData)),
          labels: task.labels,
          operation: `ensure_child_issue:${task.id}`,
        });
        entry.issue = result.issue.number;
        entry.github_id = result.issue.id;
        entry.source_hash = task.source_hash;
        entry.exportStatus = result.action === 'source_drift' ? 'source_drift' : 'exported';
        persistCompleted(`ensure_child_issue:${task.id}:${result.action}`);
      }
    }

    for (const plan of plans) {
      const planManifest = parentEntry(manifestData, plan.id);
      const existingSubIssueIds = new Set((adapter.listSubIssues(planManifest.issue) || []).map((issue) => issue.id));
      for (const task of plan.tasks) {
        const childManifest = taskEntry(manifestData, plan.id, task.id);
        if (!existingSubIssueIds.has(childManifest.github_id)) {
          adapter.addSubIssue(planManifest.issue, childManifest.github_id);
        }
        persistCompleted(`attach_sub_issue:${plan.id}:${task.id}`);
      }
      planManifest.relationships.sub_issues_attached = true;
      writeManifest(manifest, manifestData);
    }

    for (const plan of plans) {
      const planManifest = parentEntry(manifestData, plan.id);
      for (const dep of plan.depends_on) {
        const depManifest = parentEntry(manifestData, dep);
        const blockers = new Set((adapter.listBlockedBy(planManifest.issue) || []).map((issue) => issue.id));
        if (!blockers.has(depManifest.github_id)) {
          adapter.addBlockedBy(planManifest.issue, depManifest.github_id);
        }
        persistCompleted(`ensure_blocked_by:plan:${plan.id}:${dep}`);
      }

      for (const task of plan.tasks) {
        const childManifest = taskEntry(manifestData, plan.id, task.id);
        const blockers = new Set((adapter.listBlockedBy(childManifest.issue) || []).map((issue) => issue.id));
        for (const blockerNumber of taskBlockedByIssueNumbers(plan, task, manifestData)) {
          const blocker = adapter.getIssue(blockerNumber);
          if (!blocker) {
            throw new GitHubExportError(`Dependency blocker issue #${blockerNumber} was not found.`, `ensure_blocked_by:task:${task.id}:#${blockerNumber}`);
          }
          if (!blockers.has(blocker.id)) {
            adapter.addBlockedBy(childManifest.issue, blocker.id);
          }
          persistCompleted(`ensure_blocked_by:task:${task.id}:#${blockerNumber}`);
        }
      }

      planManifest.relationships.dependencies_attached = true;
      writeManifest(manifest, manifestData);
    }

    for (const plan of plans) {
      const entry = parentEntry(manifestData, plan.id);
      const existing = adapter.getIssue(entry.issue);
      const labels = mergeExportLabels(labelNamesFromIssue(existing), plan.labels);
      const updated = adapter.updateIssue(entry.issue, {
        title: plan.title,
        body: renderParentBody(plan, manifestView(manifestData)),
        labels,
      });
      entry.github_id = updated.id;
      persistCompleted(`update_parent_checklist:${plan.id}`);
    }

    const consistency = runPostExportConsistencyCheck(adapter, { plans, labelNames, manifestData });
    if (!consistency.ok) {
      throw new GitHubExportError(`Post-export consistency check failed:\n- ${consistency.errors.join('\n- ')}`, 'post_export_consistency_check');
    }

    for (const plan of plans) {
      const entry = parentEntry(manifestData, plan.id);
      entry.status = 'complete';
      entry.relationships.sub_issues_attached = true;
      entry.relationships.dependencies_attached = true;
      for (const task of plan.tasks) {
        const child = taskEntry(manifestData, plan.id, task.id);
        child.exportStatus = 'complete';
      }
    }

    manifestData.status = 'complete';
    manifestData.exported_at = new Date().toISOString();
    manifestData.operation_state.failed = null;
    writeManifest(manifest, manifestData);

    return {
      ok: true,
      version: 1,
      mode: 'write',
      writes: true,
      repo,
      phase: {
        phase_slug: phase.phaseSlug,
        phase_number: phase.phaseNumber,
        directory: phase.phaseDirectory,
      },
      manifest: {
        path: manifest.path,
        exists: true,
        wrote: true,
        status: 'complete',
      },
      labels: labelNames,
      plans: plans.map((plan) => planOutput(plan, manifestData)),
      operations: {
        completed,
        consistency,
      },
    };
  } catch (err) {
    const failure = err instanceof GitHubExportError
      ? err
      : new GitHubExportError(err.message || String(err), 'unknown');
    writePartialFailureState(adapter, manifest, manifestData, failure, plans);
    failure.message = [
      failure.message,
      '',
      `Partial export recorded in ${manifest.path}.`,
      `Safe rerun: gtd-tools export-phase-issues ${opts.phase} --repo ${repo}`,
    ].join('\n');
    throw failure;
  }
}

function cmdExportPhaseIssues(cwd, args, raw) {
  const opts = parseArgs(args);
  try {
    output(opts.dryRun ? buildDryRun(cwd, opts) : buildWriteMode(cwd, opts), raw);
  } catch (err) {
    error(err.message || String(err), ERROR_REASON.UNKNOWN);
  }
}

module.exports = {
  buildDryRun,
  buildWriteMode,
  cmdExportPhaseIssues,
  GhCliGitHubAdapter,
  GitHubExportError,
  loadExportSource,
  parseArgs,
};

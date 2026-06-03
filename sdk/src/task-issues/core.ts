import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runGitCommand } from './git-runner.js';
import { isNestedPlanFile, isNestedSummaryFile, isRootPlanFile, isRootSummaryFile } from './plan-scan.js';

export const ERROR_REASON: Readonly<Record<string, string>> = Object.freeze({
  USAGE: 'usage',
  UNKNOWN: 'unknown',
});

export class TaskIssueCommandError extends Error {
  readonly reason: string;

  constructor(message: string, reason = ERROR_REASON.UNKNOWN) {
    super(message);
    this.name = 'TaskIssueCommandError';
    this.reason = reason;
  }
}

export function error(message: string, reason = ERROR_REASON.UNKNOWN): never {
  throw new TaskIssueCommandError(message, reason);
}

export function output(result: unknown, raw?: boolean, rawValue?: unknown): void {
  const data = raw && rawValue !== undefined ? String(rawValue) : JSON.stringify(result, null, 2);
  fs.writeSync(1, data ?? '');
}

export function toPosixPath(p: string): string {
  return String(p || '').split(path.sep).join('/');
}

export function planningDir(cwd: string, ws?: string | null, project?: string | null): string {
  const projectName = project === undefined ? process.env.GTD_PROJECT || null : project;
  const workstreamName = ws === undefined ? process.env.GTD_WORKSTREAM || null : ws;
  const badSegment = /[/\\]|\.\./;
  if (projectName && badSegment.test(projectName)) {
    throw new TaskIssueCommandError(`GTD_PROJECT contains invalid path characters: ${projectName}`, ERROR_REASON.USAGE);
  }
  if (workstreamName && badSegment.test(workstreamName)) {
    throw new TaskIssueCommandError(`GTD_WORKSTREAM contains invalid path characters: ${workstreamName}`, ERROR_REASON.USAGE);
  }
  let base = path.join(cwd, '.planning');
  if (projectName) base = path.join(base, projectName);
  if (workstreamName) base = path.join(base, 'workstreams', workstreamName);
  return base;
}

function readJsonIfExists(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getConfigValue(parsed: Record<string, unknown> | null, flatKey: string, nested?: { section: string; field: string }): unknown {
  if (!parsed) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, flatKey)) return parsed[flatKey];
  if (!nested) return undefined;
  const section = parsed[nested.section];
  if (!section || typeof section !== 'object') return undefined;
  return (section as Record<string, unknown>)[nested.field];
}

export function loadConfig(cwd: string, options: { workstream?: string | null } = {}): Record<string, unknown> {
  const workstream = Object.prototype.hasOwnProperty.call(options, 'workstream')
    ? options.workstream
    : process.env.GTD_WORKSTREAM || null;
  const rootConfig = readJsonIfExists(path.join(cwd, '.planning', 'config.json'));
  const wsConfig = workstream
    ? readJsonIfExists(path.join(planningDir(cwd, workstream), 'config.json'))
    : null;
  const parsed = { ...(rootConfig || {}), ...(wsConfig || {}) };
  const commitDocs = getConfigValue(parsed, 'commit_docs', { section: 'planning', field: 'commit_docs' });
  const searchGitignored = getConfigValue(parsed, 'search_gitignored', { section: 'planning', field: 'search_gitignored' });
  return {
    ...parsed,
    commit_docs: commitDocs === undefined ? true : commitDocs,
    search_gitignored: searchGitignored === undefined ? false : searchGitignored,
  };
}

const gitIgnoredCache = new Map<string, boolean>();

export function isGitIgnored(cwd: string, targetPath: string): boolean {
  const key = `${cwd}::${targetPath}`;
  if (gitIgnoredCache.has(key)) return gitIgnoredCache.get(key)!;
  const result = runGitCommand(['check-ignore', '-q', '--no-index', '--', targetPath], {
    cwd,
    timeout: 5000,
  });
  const ignored = result.status === 0;
  gitIgnoredCache.set(key, ignored);
  return ignored;
}

function normalizePhaseName(phase: string): string {
  const str = String(phase);
  const stripped = str.replace(/^[A-Z]{1,6}-(?=\d)/, '');
  const match = stripped.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (match) {
    return `${match[1].padStart(2, '0')}${match[2] || ''}${match[3] || ''}`;
  }
  return str;
}

function comparePhaseNum(a: string, b: string): number {
  const sa = String(a).replace(/^[A-Z]{1,6}-/, '');
  const sb = String(b).replace(/^[A-Z]{1,6}-/, '');
  const pa = sa.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = sb.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  const aDecParts = pa[3] ? pa[3].slice(1).split('.').map((p) => parseInt(p, 10)) : [];
  const bDecParts = pb[3] ? pb[3].slice(1).split('.').map((p) => parseInt(p, 10)) : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i += 1) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function extractPhaseToken(dirName: string): string {
  const codePrefixed = dirName.match(/^([A-Z]{1,6}-\d+[A-Z]?(?:\.\d+)*)(?:-|$)/i);
  if (codePrefixed) return codePrefixed[1];
  const numeric = dirName.match(/^(\d+[A-Z]?(?:\.\d+)*)(?:-|$)/i);
  if (numeric) return numeric[1];
  const custom = dirName.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?:-[a-z]|$)/i);
  if (custom) return custom[1];
  return dirName;
}

function phaseTokenMatches(dirName: string, normalized: string): boolean {
  const token = extractPhaseToken(dirName);
  if (token.toUpperCase() === normalized.toUpperCase()) return true;
  const stripped = dirName.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
  if (stripped !== dirName) {
    const strippedToken = extractPhaseToken(stripped);
    if (strippedToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  return false;
}

function extractCanonicalPlanId(filename: string): string {
  const base = filename.replace(/-PLAN\.md$/i, '').replace(/-SUMMARY\.md$/i, '').replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  const tokenRe = /^\d+[A-Z]?(?:\.\d+)*$/i;
  const phaseIdx = parts.findIndex((p) => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && tokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
}

function readSubdirectories(dirPath: string, sort = false): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    return sort ? dirs.sort((a, b) => comparePhaseNum(a, b)) : dirs;
  } catch {
    return [];
  }
}

function getPhaseFileStats(phaseDir: string): {
  plans: string[];
  summaries: string[];
  hasResearch: boolean;
  hasContext: boolean;
  hasVerification: boolean;
  hasReviews: boolean;
} {
  const files = fs.readdirSync(phaseDir);
  const nestedDir = path.join(phaseDir, 'plans');
  let nestedFiles: string[] = [];
  try {
    nestedFiles = fs.existsSync(nestedDir) ? fs.readdirSync(nestedDir) : [];
  } catch {
    nestedFiles = [];
  }
  return {
    plans: files.filter(isRootPlanFile).concat(nestedFiles.filter(isNestedPlanFile)),
    summaries: files.filter(isRootSummaryFile).concat(nestedFiles.filter(isNestedSummaryFile)),
    hasResearch: files.some((f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
    hasContext: files.some((f) => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md'),
    hasVerification: files.some((f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md'),
    hasReviews: files.some((f) => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md'),
  };
}

function searchPhaseInDir(baseDir: string, relBase: string, normalized: string): Record<string, unknown> | null {
  try {
    const dirs = readSubdirectories(baseDir, true);
    const match = dirs.find((dir) => phaseTokenMatches(dir, normalized));
    if (!match) return null;
    const dirMatch = match.match(/^(?:[A-Z]{1,6}-)(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i)
      || match.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i)
      || match.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)-(.+)/i)
      || [null, match, null];
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
    const phaseDir = path.join(baseDir, match);
    const { plans: unsortedPlans, summaries: unsortedSummaries, hasResearch, hasContext, hasVerification, hasReviews } = getPhaseFileStats(phaseDir);
    const plans = unsortedPlans.sort();
    const summaries = unsortedSummaries.sort();
    const completedPlanIds = new Set(
      summaries.flatMap((summary) => {
        const exact = summary.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
        const canonical = extractCanonicalPlanId(summary);
        return canonical === exact ? [exact] : [exact, canonical];
      }),
    );
    const incompletePlans = plans.filter((plan) => {
      const planId = plan.replace('-PLAN.md', '').replace('PLAN.md', '');
      const canonical = extractCanonicalPlanId(plan);
      return !completedPlanIds.has(planId) && !completedPlanIds.has(canonical);
    });

    return {
      found: true,
      directory: toPosixPath(path.join(relBase, match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
      has_reviews: hasReviews,
    };
  } catch {
    return null;
  }
}

export function findPhaseInternal(cwd: string, phase: string): Record<string, unknown> | null {
  if (!phase) return null;
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);
  const current = searchPhaseInDir(phasesDir, toPosixPath(path.relative(cwd, phasesDir)), normalized);
  if (current) return current;

  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  if (!fs.existsSync(milestonesDir)) return null;
  try {
    const archiveDirs = fs.readdirSync(milestonesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v[\d.]+-phases$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const archiveName of archiveDirs) {
      const archivePath = path.join(milestonesDir, archiveName);
      const result = searchPhaseInDir(archivePath, `.planning/milestones/${archiveName}`, normalized);
      if (result) {
        result.archived = archiveName.match(/^(v[\d.]+)-phases$/)?.[1] ?? null;
        return result;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export const GTD_TEMP_DIR = path.join(os.tmpdir(), 'gtd');

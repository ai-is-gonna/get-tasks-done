import * as fs from 'node:fs';
import * as path from 'node:path';

const PLAN_OUTLINE_RE = /-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /\.pre-bounce\.md$/i;

export function isRootPlanFile(file: string): boolean {
  if (PLAN_OUTLINE_RE.test(file)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(file)) return false;
  if (file.endsWith('-PLAN.md') || file === 'PLAN.md') return true;
  return /\.md$/i.test(file) && /PLAN/i.test(file);
}

export function isNestedPlanFile(file: string): boolean {
  if (PLAN_OUTLINE_RE.test(file)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(file)) return false;
  return /^PLAN-\d+.*\.md$/i.test(file) || /-PLAN-\d+.*\.md$/i.test(file);
}

export function isRootSummaryFile(file: string): boolean {
  return file.endsWith('-SUMMARY.md') || file === 'SUMMARY.md';
}

export function isNestedSummaryFile(file: string): boolean {
  return /^SUMMARY-\d+.*\.md$/i.test(file) || /-SUMMARY-\d+.*\.md$/i.test(file);
}

export function scanPhasePlans(phaseDir: string): {
  planCount: number;
  summaryCount: number;
  completed: boolean;
  hasNestedPlans: boolean;
  planFiles: string[];
  summaryFiles: string[];
} {
  let rootFiles: string[];
  try {
    rootFiles = fs.readdirSync(phaseDir);
  } catch {
    return {
      planCount: 0,
      summaryCount: 0,
      completed: false,
      hasNestedPlans: false,
      planFiles: [],
      summaryFiles: [],
    };
  }

  const rootPlanFiles = rootFiles.filter(isRootPlanFile);
  const rootSummaryFiles = rootFiles.filter(isRootSummaryFile);
  let nestedPlanFiles: string[] = [];
  let nestedSummaryFiles: string[] = [];
  let hasNestedPlans = false;

  const nestedDir = path.join(phaseDir, 'plans');
  if (fs.existsSync(nestedDir)) {
    try {
      const nested = fs.readdirSync(nestedDir);
      nestedPlanFiles = nested.filter(isNestedPlanFile);
      nestedSummaryFiles = nested.filter(isNestedSummaryFile);
      hasNestedPlans = nestedPlanFiles.length > 0;
    } catch {
      // Ignore unreadable nested plan directories.
    }
  }

  const planFiles = rootPlanFiles.concat(nestedPlanFiles);
  const summaryFiles = rootSummaryFiles.concat(nestedSummaryFiles);
  return {
    planCount: planFiles.length,
    summaryCount: summaryFiles.length,
    completed: planFiles.length > 0 && summaryFiles.length >= planFiles.length,
    hasNestedPlans,
    planFiles,
    summaryFiles,
  };
}

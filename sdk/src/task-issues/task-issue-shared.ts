import * as fs from 'node:fs';

import { toPosixPath } from './core.js';

export const TASK_ID_RE = /^\d+[A-Z]?(?:\.\d+)*-\d+[A-Z]?(?:\.\d+)*-T\d{2}$/i;
export const PLAN_ID_RE = /^\d+[A-Z]?(?:\.\d+)*-\d+[A-Z]?(?:\.\d+)*$/i;
export const TASK_EXPORT_STATUSES = new Set(['pending', 'exported', 'source_drift', 'complete']);
export const CHECKPOINT_RESOLVED_STATUS = 'checkpoint_resolved';

export function normalizeTaskType(type: unknown): string {
  return String(type || 'auto').trim().toLowerCase();
}

export function isCheckpointTaskType(type: unknown): boolean {
  return normalizeTaskType(type).startsWith('checkpoint:');
}

export function issueLabels(issue: { labels?: Array<string | { name?: string }> } | null | undefined): string[] {
  return (issue?.labels || [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean) as string[];
}

export function isIssueOpen(issue: { state?: string } | null | undefined): boolean {
  return String(issue?.state || 'open').toLowerCase() === 'open';
}

export function mergeLabelSet(currentLabels: string[] = [], add: string[] = [], remove: string[] = []): string[] {
  const labels = new Set(currentLabels || []);
  for (const label of remove || []) labels.delete(label);
  for (const label of add || []) labels.add(label);
  return [...labels].sort();
}

export function normalizeRepoPath(filePath: unknown): string {
  return toPosixPath(String(filePath || '').trim())
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function readJsonIfExists(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

'use strict';

const fs = require('fs');

const { toPosixPath } = require('./core.cjs');

const TASK_ID_RE = /^\d+[A-Z]?(?:\.\d+)*-\d+[A-Z]?(?:\.\d+)*-T\d{2}$/i;
const PLAN_ID_RE = /^\d+[A-Z]?(?:\.\d+)*-\d+[A-Z]?(?:\.\d+)*$/i;
const TASK_EXPORT_STATUSES = new Set(['pending', 'exported', 'source_drift', 'complete']);
const CHECKPOINT_RESOLVED_STATUS = 'checkpoint_resolved';

function normalizeTaskType(type) {
  return String(type || 'auto').trim().toLowerCase();
}

function isCheckpointTaskType(type) {
  return normalizeTaskType(type).startsWith('checkpoint:');
}

function issueLabels(issue) {
  return (issue?.labels || [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean);
}

function isIssueOpen(issue) {
  return String(issue?.state || 'open').toLowerCase() === 'open';
}

function mergeLabelSet(currentLabels, add = [], remove = []) {
  const labels = new Set(currentLabels || []);
  for (const label of remove || []) labels.delete(label);
  for (const label of add || []) labels.add(label);
  return [...labels].sort();
}

function normalizeRepoPath(filePath) {
  return toPosixPath(String(filePath || '').trim())
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
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
  readJsonIfExists,
};

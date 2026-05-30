import type { PlanTask } from './types.js';

const EXECUTABLE_TASK_TYPES = new Set(['auto', 'tdd']);

export interface TaskAtomicityIssue {
  task: string;
  index: number;
  type: string;
  code: string;
  message: string;
}

export interface TaskAtomicityTaskResult {
  name: string;
  index: number;
  type: string;
  executable: boolean;
  checkpoint: boolean;
  file_count: number;
  blockers: TaskAtomicityIssue[];
  warnings: TaskAtomicityIssue[];
}

export interface TaskAtomicityResult {
  ok: boolean;
  blockers: TaskAtomicityIssue[];
  warnings: TaskAtomicityIssue[];
  tasks: TaskAtomicityTaskResult[];
}

function normalizedTaskType(type: string | undefined): string {
  return String(type || 'auto').toLowerCase();
}

function isExecutableTaskType(type: string | undefined): boolean {
  return EXECUTABLE_TASK_TYPES.has(normalizedTaskType(type));
}

function isCheckpointTaskType(type: string | undefined): boolean {
  return normalizedTaskType(type).startsWith('checkpoint:');
}

function isVagueDoneCriteria(done: string): boolean {
  const normalized = done.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length < 12) return true;
  if (/^(done|complete|completed|working|works|implemented|ready|thing is done)$/.test(normalized)) {
    return true;
  }
  return /\b(working|works|complete|completed|implemented|ready|done)\b/.test(normalized)
    && normalized.split(/\s+/).length <= 5;
}

function hasMultiConcernAction(action: string): boolean {
  return /\b(and also|also\s+(?:implement|create|update|add|set up)|and\s+(?:implement|create|update|add|set up))\b/i.test(action);
}

function hasPlaceholderBoundaries(boundaries: string): boolean {
  const normalized = boundaries.trim().toLowerCase().replace(/[.\s]+$/g, '');
  return /^(no boundaries|none|n\/a|na|not applicable)(?:\b|$)/.test(normalized);
}

function hasStructuredBoundaryClause(boundaries: string): boolean {
  return /\b(?:allowed|forbidden|forbidden paths|out of scope):/i.test(boundaries)
    || /\bdo not modify:/i.test(boundaries);
}

function normalizedFiles(task: PlanTask): string[] {
  return task.files
    .flatMap((file) => file.split(/\n/))
    .map((file) => file.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

function makeIssue(
  task: PlanTask,
  index: number,
  code: string,
  message: string,
): TaskAtomicityIssue {
  return {
    task: task.name || 'unnamed',
    index,
    type: task.type || 'auto',
    code,
    message,
  };
}

export function validateTaskAtomicity(tasks: PlanTask[]): TaskAtomicityResult {
  const blockers: TaskAtomicityIssue[] = [];
  const warnings: TaskAtomicityIssue[] = [];
  const taskResults: TaskAtomicityTaskResult[] = [];

  tasks.forEach((task, position) => {
    const index = position + 1;
    const executable = isExecutableTaskType(task.type);
    const files = normalizedFiles(task);
    const taskBlockers: TaskAtomicityIssue[] = [];
    const taskWarnings: TaskAtomicityIssue[] = [];

    if (executable) {
      if (!task.boundaries || !task.boundaries.trim()) {
        taskBlockers.push(makeIssue(task, index, 'missing_boundaries', `Task '${task.name || 'unnamed'}' missing non-empty <boundaries>`));
      } else if (hasPlaceholderBoundaries(task.boundaries)) {
        taskBlockers.push(makeIssue(task, index, 'placeholder_boundaries', `Task '${task.name || 'unnamed'}' has placeholder <boundaries>`));
      } else if (!hasStructuredBoundaryClause(task.boundaries)) {
        taskWarnings.push(makeIssue(task, index, 'unstructured_boundaries', `Task '${task.name || 'unnamed'}' <boundaries> should include Allowed, Forbidden, DO NOT modify, or Out of scope clauses`));
      }

      if (files.length === 0) {
        taskBlockers.push(makeIssue(task, index, 'empty_files', `Task '${task.name || 'unnamed'}' has empty <files>`));
      } else if (files.length >= 6) {
        taskBlockers.push(makeIssue(task, index, 'too_many_files', `Task '${task.name || 'unnamed'}' modifies ${files.length} files; maximum is 5`));
      } else if (files.length >= 4) {
        taskWarnings.push(makeIssue(task, index, 'borderline_file_count', `Task '${task.name || 'unnamed'}' modifies ${files.length} files; target is 1-3`));
      }

      if (!task.done || !task.done.trim()) {
        taskBlockers.push(makeIssue(task, index, 'missing_done', `Task '${task.name || 'unnamed'}' missing <done>`));
      } else if (isVagueDoneCriteria(task.done)) {
        taskWarnings.push(makeIssue(task, index, 'vague_done', `Task '${task.name || 'unnamed'}' has vague <done> criteria`));
      }

      if (hasMultiConcernAction(task.action)) {
        taskWarnings.push(makeIssue(task, index, 'possible_multi_concern_action', `Task '${task.name || 'unnamed'}' action may combine multiple concerns`));
      }

      tasks.slice(position + 1).forEach((laterTask) => {
        if (!isExecutableTaskType(laterTask.type)) return;
        const referencedFile = normalizedFiles(laterTask).find((file) => file && task.verify.includes(file));
        if (!referencedFile) return;
        taskBlockers.push(makeIssue(
          task,
          index,
          'verify_references_later_task_file',
          `Task '${task.name || 'unnamed'}' <verify> references '${referencedFile}' from later task '${laterTask.name || 'unnamed'}'`,
        ));
      });
    }

    blockers.push(...taskBlockers);
    warnings.push(...taskWarnings);
    taskResults.push({
      name: task.name || 'unnamed',
      index,
      type: task.type || 'auto',
      executable,
      checkpoint: isCheckpointTaskType(task.type),
      file_count: files.length,
      blockers: taskBlockers,
      warnings: taskWarnings,
    });
  });

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    tasks: taskResults,
  };
}

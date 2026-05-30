import { GTDError, ErrorClassification } from '../errors.js';
import type { QueryHandler } from './utils.js';
import {
  buildDryRun as buildExportDryRun,
  buildWriteMode as buildExportWriteMode,
  parseArgs as parseExportPhaseIssuesArgs,
} from '../task-issues/export-phase-issues.js';
import {
  buildExecution as buildWorkExecution,
  buildReadOnly as buildWorkReadOnly,
  parseArgs as parseWorkTaskIssueArgs,
} from '../task-issues/work-task-issue.js';
import {
  buildDryRun as buildOrchestrateDryRun,
  buildExecution as buildOrchestrateExecution,
  parseArgs as parseOrchestrateTasksArgs,
} from '../task-issues/orchestrate-tasks.js';
import { ERROR_REASON, TaskIssueCommandError } from '../task-issues/core.js';

function sdkCommandMessage(message: string): string {
  return String(message || '')
    .replace(/gtd-tools (export-phase-issues|work-task-issue|orchestrate-tasks)/g, 'gtd-sdk query $1')
    .replace(/Safe rerun: gtd-tools /g, 'Safe rerun: gtd-sdk query ');
}

function toGtdError(err: unknown): GTDError {
  if (err instanceof GTDError) return err;
  if (err instanceof TaskIssueCommandError) {
    const classification = err.reason === ERROR_REASON.USAGE
      ? ErrorClassification.Validation
      : ErrorClassification.Execution;
    return new GTDError(sdkCommandMessage(err.message), classification);
  }
  if (err instanceof Error) {
    return new GTDError(sdkCommandMessage(err.message), ErrorClassification.Execution);
  }
  return new GTDError(sdkCommandMessage(String(err)), ErrorClassification.Execution);
}

function withWorkstream<T>(workstream: string | undefined, work: () => T): T {
  if (!workstream) return work();
  const previous = process.env.GTD_WORKSTREAM;
  process.env.GTD_WORKSTREAM = workstream;
  try {
    return work();
  } finally {
    if (previous === undefined) {
      delete process.env.GTD_WORKSTREAM;
    } else {
      process.env.GTD_WORKSTREAM = previous;
    }
  }
}

export const exportPhaseIssues: QueryHandler = async (args, projectDir, workstream) => {
  try {
    const opts = parseExportPhaseIssuesArgs(['export-phase-issues', ...args]);
    const data = withWorkstream(workstream, () =>
      opts.dryRun ? buildExportDryRun(projectDir, opts) : buildExportWriteMode(projectDir, opts));
    return { data };
  } catch (err) {
    throw toGtdError(err);
  }
};

export const workTaskIssue: QueryHandler = async (args, projectDir, workstream) => {
  try {
    const opts = parseWorkTaskIssueArgs(['work-task-issue', ...args]);
    const data = withWorkstream(workstream, () =>
      opts.mode === 'execute' ? buildWorkExecution(projectDir, opts) : buildWorkReadOnly(projectDir, opts));
    return { data };
  } catch (err) {
    throw toGtdError(err);
  }
};

export const orchestrateTasks: QueryHandler = async (args, projectDir, workstream) => {
  try {
    const opts = parseOrchestrateTasksArgs(['orchestrate-tasks', ...args]);
    const data = withWorkstream(workstream, () =>
      opts.dryRun ? buildOrchestrateDryRun(projectDir, opts) : buildOrchestrateExecution(projectDir, opts));
    return { data };
  } catch (err) {
    throw toGtdError(err);
  }
};

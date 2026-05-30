import { ErrorClassification, GTDError, exitCodeFor } from '../errors.js';
import { GTDToolsError } from '../gtd-tools-error.js';
import type { QueryDispatchResult } from './query-dispatch-contract.js';

export interface QueryCliAdapterOutput {
  exitCode: number;
  stdoutChunks: string[];
  stderrLines: string[];
}

function jsonErrorsEnabled(): boolean {
  return process.env.GTD_JSON_ERRORS === '1';
}

function dispatchReason(kind: string): string {
  if (kind === 'validation_error') return 'usage';
  if (kind === 'unknown_command') return 'sdk_unknown_command';
  return 'unknown';
}

function errorReason(err: GTDError): string {
  return err.classification === ErrorClassification.Validation ? 'usage' : 'unknown';
}

function structuredErrorLine(reason: string, message: string): string {
  return JSON.stringify({ ok: false, reason, message });
}

export function buildQueryCliOutputFromDispatch(out: QueryDispatchResult): QueryCliAdapterOutput {
  const stderrLines = [...out.stderr];
  const stdoutChunks: string[] = [];
  if (!out.ok) {
    if (jsonErrorsEnabled()) {
      stderrLines.push(structuredErrorLine(dispatchReason(out.error.kind), out.error.message));
      return { exitCode: out.exit_code, stdoutChunks, stderrLines };
    }
    stderrLines.push(out.error.message);
    return { exitCode: out.exit_code, stdoutChunks, stderrLines };
  }
  if (out.stdout) stdoutChunks.push(out.stdout);
  return { exitCode: 0, stdoutChunks, stderrLines };
}

export function buildQueryCliOutputFromError(err: unknown): QueryCliAdapterOutput {
  const stdoutChunks: string[] = [];
  if (err instanceof GTDError) {
    if (jsonErrorsEnabled()) {
      return { stderrLines: [structuredErrorLine(errorReason(err), err.message)], exitCode: exitCodeFor(err.classification), stdoutChunks };
    }
    return { stderrLines: [`Error: ${err.message}`], exitCode: exitCodeFor(err.classification), stdoutChunks };
  }
  if (err instanceof GTDToolsError) {
    if (jsonErrorsEnabled()) {
      return { stderrLines: [structuredErrorLine('unknown', err.message)], exitCode: err.exitCode ?? 1, stdoutChunks };
    }
    // Prefer raw subprocess stderr when available so users see the original tool diagnostics.
    const stderrLines = err.stderr && err.stderr.trim().length > 0
      ? err.stderr.split(/\r?\n/).filter(line => line.length > 0)
      : [`Error: ${err.message}`];
    return { stderrLines, exitCode: err.exitCode ?? 1, stdoutChunks };
  }
  return { stderrLines: [`Error: ${err instanceof Error ? err.message : String(err)}`], exitCode: 1, stdoutChunks };
}

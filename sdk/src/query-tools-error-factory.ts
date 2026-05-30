import { GTDError, exitCodeFor } from './errors.js';
import { GTDToolsError } from './gtd-tools-error.js';
import { errorMessage, toFailureSignal } from './query-failure-classification.js';

export interface QueryTimeoutErrorFactory {
  createTimeoutError: (
    message: string,
    command: string,
    args: string[],
    stderr: string,
    timeoutMs: number,
  ) => GTDToolsError;
}

export interface QueryFailureErrorFactory {
  createFailureError: (
    message: string,
    command: string,
    args: string[],
    exitCode: number | null,
    stderr: string,
  ) => GTDToolsError;
}

export type QueryToolsErrorFactory = QueryTimeoutErrorFactory & QueryFailureErrorFactory;

export interface QueryNativeErrorFactory {
  createNativeTimeoutError: (message: string, command: string, args: string[]) => GTDToolsError;
  createNativeFailureError: (message: string, command: string, args: string[], cause: unknown) => GTDToolsError;
}

function timeoutToolsError(message: string, command: string, args: string[], stderr = '', timeoutMs?: number): GTDToolsError {
  return GTDToolsError.timeout(message, command, args, stderr, timeoutMs);
}

function failureToolsError(
  message: string,
  command: string,
  args: string[],
  exitCode: number | null,
  stderr = '',
  cause?: unknown,
): GTDToolsError {
  return GTDToolsError.failure(message, command, args, exitCode, stderr, cause === undefined ? undefined : { cause });
}

export function toToolsErrorFromUnknown(command: string, args: string[], err: unknown): GTDToolsError {
  if (err instanceof GTDError) {
    return failureToolsError(err.message, command, args, exitCodeFor(err.classification), '', err);
  }

  const msg = errorMessage(err);
  const signal = toFailureSignal(err);
  if (signal.kind === 'timeout') {
    return timeoutToolsError(msg, command, args, '', signal.timeoutMs);
  }
  return failureToolsError(msg, command, args, 1, '', err instanceof Error ? err : undefined);
}

export function createQueryToolsErrorFactory(): QueryToolsErrorFactory {
  return {
    createTimeoutError: (message, command, args, stderr, timeoutMs) =>
      timeoutToolsError(message, command, args, stderr, timeoutMs),
    createFailureError: (message, command, args, exitCode, stderr) =>
      failureToolsError(message, command, args, exitCode, stderr),
  };
}

export function createQueryNativeErrorFactory(defaultTimeoutMs: number): QueryNativeErrorFactory {
  return {
    createNativeTimeoutError: (message, command, args) =>
      timeoutToolsError(message, command, args, '', defaultTimeoutMs),
    createNativeFailureError: (message, command, args, cause) =>
      failureToolsError(message, command, args, 1, '', cause),
  };
}

import { describe, expect, it } from 'vitest';
import { GTDToolsError } from '../gtd-tools-error.js';
import { buildQueryCliOutputFromError } from './query-cli-output.js';

describe('query-cli-output', () => {
  it('prefers raw gtd-tools stderr when present', () => {
    const err = GTDToolsError.failure('failed', 'list', ['json'], 2, 'line one\nline two\n');
    const out = buildQueryCliOutputFromError(err);
    expect(out.exitCode).toBe(2);
    expect(out.stderrLines).toEqual(['line one', 'line two']);
  });

  it('falls back to Error: message when gtd-tools stderr is empty', () => {
    const err = GTDToolsError.failure('failed', 'list', ['json'], null, '');
    const out = buildQueryCliOutputFromError(err);
    expect(out.exitCode).toBe(1);
    expect(out.stderrLines).toEqual(['Error: failed']);
  });

  it('falls back to Error: message when gtd-tools stderr is whitespace-only', () => {
    const err = GTDToolsError.failure('failed', 'build', ['json'], null, '   \n');
    const out = buildQueryCliOutputFromError(err);
    expect(out.exitCode).toBe(1);
    expect(out.stderrLines).toEqual(['Error: failed']);
  });

  it('uses exitCode 1 when gtd-tools exitCode is null and stderr is non-empty', () => {
    const err = GTDToolsError.failure('failed', 'build', ['json'], null, 'line');
    const out = buildQueryCliOutputFromError(err);
    expect(out.exitCode).toBe(1);
    expect(out.stderrLines).toEqual(['line']);
  });
});

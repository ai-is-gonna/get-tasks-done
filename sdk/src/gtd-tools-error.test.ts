import { describe, expect, it } from 'vitest';
import { GTDToolsError } from './gtd-tools-error.js';

describe('GTDToolsError constructors', () => {
  it('builds timeout-classified errors', () => {
    const err = GTDToolsError.timeout('timeout', 'state', ['load'], '', 1000);
    expect(err.classification).toEqual({ kind: 'timeout', timeoutMs: 1000 });
    expect(err.exitCode).toBeNull();
  });

  it('builds failure-classified errors', () => {
    const err = GTDToolsError.failure('boom', 'state', ['load'], 1);
    expect(err.classification).toEqual({ kind: 'failure' });
    expect(err.exitCode).toBe(1);
  });

  it('defaults direct constructor to failure classification', () => {
    const err = new GTDToolsError('boom', 'state', ['load'], 1, 'stderr');
    expect(err.classification).toEqual({ kind: 'failure' });
  });
});

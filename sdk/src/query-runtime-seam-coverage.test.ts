import { describe, it, expect, vi } from 'vitest';
import { createGTDToolsRuntime } from './query-gtd-tools-runtime.js';

describe('SDK Runtime Bridge seam coverage', () => {
  it('exposes bridge as the single runtime seam', () => {
    const runtime = createGTDToolsRuntime({
      projectDir: '/tmp/project',
      gtdToolsPath: '/tmp/gtd-tools.cjs',
      timeoutMs: 1_000,
      shouldUseNativeQuery: () => true,
      execJsonFallback: vi.fn(async () => ({})),
      execRawFallback: vi.fn(async () => ''),
    });

    expect(Object.keys(runtime)).toEqual(['bridge']);
    expect(typeof runtime.bridge.resolve).toBe('function');
    expect(typeof runtime.bridge.execute).toBe('function');
    expect(typeof runtime.bridge.dispatchHotpath).toBe('function');
  });
});

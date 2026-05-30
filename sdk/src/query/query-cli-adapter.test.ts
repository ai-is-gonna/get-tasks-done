import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchSpy = vi.hoisted(() => vi.fn());
const runQueryDispatchSpy = vi.hoisted(() => vi.fn());
const resolveGtdToolsPathSeamSpy = vi.hoisted(() => vi.fn(() => '/mock/gtd-tools.cjs'));

vi.mock('./helpers.js', () => ({
  findProjectRoot: (projectDir: string) => projectDir,
}));

vi.mock('./index.js', () => ({
  createRegistry: () => ({ dispatch: dispatchSpy }),
}));

vi.mock('./query-dispatch.js', () => ({
  runQueryDispatch: (...args: unknown[]) => runQueryDispatchSpy(...args),
}));

vi.mock('../query-gtd-tools-path.js', () => ({
  resolveGtdToolsPath: (...args: unknown[]) => resolveGtdToolsPathSeamSpy(...args),
}));

import { runQueryCliCommand } from './query-cli-adapter.js';

describe('query-cli-adapter', () => {
  beforeEach(() => {
    dispatchSpy.mockReset();
    runQueryDispatchSpy.mockReset();
    resolveGtdToolsPathSeamSpy.mockReset();
    resolveGtdToolsPathSeamSpy.mockReturnValue('/mock/gtd-tools.cjs');
  });

  it('returns validation failure for missing query command', async () => {
    runQueryDispatchSpy.mockResolvedValueOnce({
      ok: false,
      exit_code: 10,
      stdout: '',
      stderr: [],
      error: { kind: 'validation_error', message: 'query requires a command', details: {} },
    });

    const out = await runQueryCliCommand({
      projectDir: process.cwd(),
      queryArgv: [],
    });

    expect(out.exitCode).toBe(10);
    expect(out.stderrLines.join('\n')).toContain('requires a command');
  });

  it('passes ws and topology to dispatch without native adapter', async () => {
    runQueryDispatchSpy.mockImplementationOnce(async (input: any) => {
      expect(input.ws).toBe('alpha');
      expect(input.topology).toBeDefined();
      expect(input.nativeAdapter).toBeUndefined();
      return { ok: true, exit_code: 0, stdout: '', stderr: [] };
    });

    await runQueryCliCommand({
      projectDir: process.cwd(),
      ws: 'alpha',
      queryArgv: ['state', 'show'],
    });
  });

  it('wires resolveGtdToolsPath from the query seam module', async () => {
    runQueryDispatchSpy.mockImplementationOnce(async (input: any) => {
      expect(typeof input.resolveGtdToolsPath).toBe('function');
      expect(input.resolveGtdToolsPath('/tmp/project')).toBe('/mock/gtd-tools.cjs');
      expect(resolveGtdToolsPathSeamSpy).toHaveBeenCalledWith('/tmp/project');
      return { ok: true, exit_code: 0, stdout: '', stderr: [] };
    });

    await runQueryCliCommand({
      projectDir: process.cwd(),
      queryArgv: ['state', 'show'],
    });
  });
});

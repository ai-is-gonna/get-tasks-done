import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  gitExecutableCandidates,
  gitNotFoundMessage,
  runGitCommand,
} from './git-runner.js';
import {
  runGit as runWorkTaskIssueGit,
  TaskExecutionError,
} from './work-task-issue.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function enoent(program: string) {
  const error = new Error(`spawnSync ${program} ENOENT`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return { status: null, stdout: '', stderr: '', signal: null, error };
}

describe('task issue git runner', () => {
  it('prefers GTD_GIT over GIT and PATH git', () => {
    expect(gitExecutableCandidates({
      GTD_GIT: '/custom/gtd/git',
      GIT: '/custom/git',
      PATH: '/bin',
    }, [])).toEqual(['/custom/gtd/git', '/custom/git', 'git']);
  });

  it('falls back to GIT when GTD_GIT is absent', () => {
    expect(gitExecutableCandidates({
      GIT: '/custom/git',
      PATH: '/bin',
    }, [])).toEqual(['/custom/git', 'git']);
  });

  it('falls back to plain git when no override is set', () => {
    expect(gitExecutableCandidates({ PATH: '/bin' }, [])).toEqual(['git']);
  });

  it('tries later candidates when an earlier executable is missing', () => {
    const spawnSync = vi.fn((program: string) => {
      if (program === '/missing/git') return enoent(program);
      return { status: 0, stdout: 'ok\n', stderr: '', signal: null, error: undefined };
    });

    const result = runGitCommand(['--version'], {
      env: { GTD_GIT: '/missing/git', PATH: '/bin' },
      commonGitPaths: [],
      spawnSync: spawnSync as never,
    });

    expect(result).toMatchObject({ ok: true, status: 0, stdout: 'ok', executable: 'git' });
    expect(spawnSync).toHaveBeenNthCalledWith(1, '/missing/git', ['--version'], expect.any(Object));
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'git', ['--version'], expect.any(Object));
  });

  it('returns an actionable diagnostic when git cannot be spawned', () => {
    const result = runGitCommand(['status'], {
      env: { PATH: '/restricted/bin' },
      commonGitPaths: [],
      spawnSync: vi.fn((program: string) => enoent(program)) as never,
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('Git executable not found');
    expect(result.stderr).toContain('PATH seen by gtd-sdk: /restricted/bin');
    expect(result.stderr).toContain('GTD_GIT=/opt/homebrew/bin/git');
    expect(result.stderr).not.toContain('spawnSync git ENOENT');
  });

  it('formats the same diagnostic for direct callers', () => {
    expect(gitNotFoundMessage(['git'], { PATH: '' })).toContain('PATH seen by gtd-sdk: (empty)');
  });

  it('surfaces the actionable diagnostic through work-task-issue git failures', () => {
    let caught: unknown = null;
    try {
      runWorkTaskIssueGit('/tmp', ['status'], {
        env: { PATH: '/restricted/bin' },
        commonGitPaths: [],
        spawnSync: vi.fn((program: string) => enoent(program)) as never,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TaskExecutionError);
    expect(String((caught as Error).message)).toContain('Git executable not found');
    expect(String((caught as Error).message)).not.toContain('spawnSync git ENOENT');
  });
});

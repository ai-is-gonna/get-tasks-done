import * as childProcess from 'node:child_process';

type SpawnSync = typeof childProcess.spawnSync;

type GitRunnerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  spawnSync?: SpawnSync;
  commonGitPaths?: string[];
};

type GitRunnerResult = {
  ok: boolean;
  status: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
  executable: string;
};

const DEFAULT_COMMON_GIT_PATHS = Object.freeze([
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/usr/bin/git',
]);

function nonEmpty(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

export function gitExecutableCandidates(env: NodeJS.ProcessEnv = process.env, commonGitPaths = DEFAULT_COMMON_GIT_PATHS): string[] {
  return [
    nonEmpty(env.GTD_GIT),
    nonEmpty(env.GIT),
    ...commonGitPaths,
    'git',
  ].filter((candidate, index, candidates): candidate is string =>
    Boolean(candidate) && candidates.indexOf(candidate) === index);
}

export function gitNotFoundMessage(executables: string[], env: NodeJS.ProcessEnv = process.env): string {
  return [
    `Git executable not found. Tried: ${executables.join(', ')}.`,
    `PATH seen by gtd-sdk: ${env.PATH || '(empty)'}.`,
    'Set GTD_GIT=/opt/homebrew/bin/git or add git to PATH before running gtd-sdk.',
  ].join(' ');
}

export function runGitCommand(args: string[], opts: GitRunnerOptions = {}): GitRunnerResult {
  const env = { ...process.env, ...(opts.env || {}) };
  const spawnSync = opts.spawnSync || childProcess.spawnSync;
  const candidates = gitExecutableCandidates(env, opts.commonGitPaths);
  let lastExecutable = candidates[candidates.length - 1] || 'git';
  let lastError: Error | null = null;

  for (const executable of candidates) {
    lastExecutable = executable;
    const result = spawnSync(executable, args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout,
    });

    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      lastError = result.error;
      continue;
    }

    const status = result.status ?? 1;
    return {
      ok: status === 0,
      status,
      exitCode: status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || result.error?.message || '').trim(),
      signal: result.signal ?? null,
      error: result.error || null,
      executable,
    };
  }

  const stderr = gitNotFoundMessage(candidates, env);
  return {
    ok: false,
    status: 127,
    exitCode: 127,
    stdout: '',
    stderr,
    signal: null,
    error: lastError,
    executable: lastExecutable,
  };
}

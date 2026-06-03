'use strict';

const childProcess = require('child_process');

const DEFAULT_COMMON_GIT_PATHS = Object.freeze([
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/usr/bin/git',
]);

function nonEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

function gitExecutableCandidates(env = process.env, commonGitPaths = DEFAULT_COMMON_GIT_PATHS) {
  return [
    nonEmpty(env.GTD_GIT),
    nonEmpty(env.GIT),
    ...commonGitPaths,
    'git',
  ].filter((candidate, index, candidates) => Boolean(candidate) && candidates.indexOf(candidate) === index);
}

function gitNotFoundMessage(executables, env = process.env) {
  return [
    `Git executable not found. Tried: ${executables.join(', ')}.`,
    `PATH seen by gtd-sdk: ${env.PATH || '(empty)'}.`,
    'Set GTD_GIT=/opt/homebrew/bin/git or add git to PATH before running gtd-sdk.',
  ].join(' ');
}

function runGitCommand(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const spawnSync = opts.spawnSync || childProcess.spawnSync;
  const candidates = gitExecutableCandidates(env, opts.commonGitPaths);
  let lastExecutable = candidates[candidates.length - 1] || 'git';
  let lastError = null;

  for (const executable of candidates) {
    lastExecutable = executable;
    const result = spawnSync(executable, args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout,
    });

    if (result.error && result.error.code === 'ENOENT') {
      lastError = result.error;
      continue;
    }

    const status = result.status ?? 1;
    return {
      ok: status === 0,
      status,
      exitCode: status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || (result.error && result.error.message) || '').trim(),
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

module.exports = {
  gitExecutableCandidates,
  gitNotFoundMessage,
  runGitCommand,
};

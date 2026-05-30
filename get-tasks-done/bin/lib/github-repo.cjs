'use strict';

const childProcess = require('child_process');

function normalizeGitHubRepo(repo) {
  const value = String(repo || '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(value) ? value : null;
}

function stripGitSuffix(value) {
  return String(value || '').replace(/\.git$/i, '');
}

function repoFromParts(owner, name) {
  const repo = normalizeGitHubRepo(`${owner || ''}/${stripGitSuffix(name || '')}`);
  return repo || null;
}

function parseGitHubRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;

  const value = raw.replace(/^git\+/, '');
  const scpLike = value.match(/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (scpLike) return repoFromParts(scpLike[1], scpLike[2]);

  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return repoFromParts(parts[0], parts[1]);
  } catch {
    return null;
  }
}

function runGit(cwd, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function gitRemoteUrls(cwd, remote) {
  const urls = [];
  for (const args of [
    ['remote', 'get-url', '--push', '--all', remote],
    ['remote', 'get-url', '--all', remote],
  ]) {
    const result = runGit(cwd, args);
    if (!result.ok || !result.stdout) continue;
    urls.push(...result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  return [...new Set(urls)];
}

function formatCandidate(candidate) {
  return `${candidate.repo} (${candidate.remote})`;
}

function resolveGitHubRepoFromGit(cwd) {
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok || !root.stdout) {
    return {
      ok: false,
      reason: 'not_git_repo',
      message: 'not inside a git repository',
    };
  }

  const remotesResult = runGit(root.stdout, ['remote']);
  const remotes = remotesResult.ok
    ? remotesResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (remotes.length === 0) {
    return {
      ok: false,
      reason: 'no_git_remotes',
      git_root: root.stdout,
      message: 'no git remotes are configured',
    };
  }

  const candidates = [];
  for (const remote of remotes) {
    for (const url of gitRemoteUrls(root.stdout, remote)) {
      const repo = parseGitHubRemoteUrl(url);
      if (repo) candidates.push({ remote, url, repo });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_github_remote',
      git_root: root.stdout,
      message: 'no GitHub remote is configured',
    };
  }

  const originCandidates = candidates.filter((candidate) => candidate.remote === 'origin');
  if (originCandidates.length > 0) {
    const originRepos = [...new Set(originCandidates.map((candidate) => candidate.repo))];
    if (originRepos.length === 1) {
      return {
        ok: true,
        repo: originRepos[0],
        source: 'git_remote:origin',
        remote: 'origin',
        git_root: root.stdout,
      };
    }
    return {
      ok: false,
      reason: 'ambiguous_origin_remote',
      git_root: root.stdout,
      message: `origin points at multiple GitHub repositories: ${originRepos.join(', ')}`,
    };
  }

  const repos = [...new Set(candidates.map((candidate) => candidate.repo))];
  if (repos.length === 1) {
    const candidate = candidates.find((item) => item.repo === repos[0]);
    return {
      ok: true,
      repo: repos[0],
      source: `git_remote:${candidate.remote}`,
      remote: candidate.remote,
      git_root: root.stdout,
    };
  }

  return {
    ok: false,
    reason: 'ambiguous_github_remotes',
    git_root: root.stdout,
    message: `multiple GitHub remotes are configured: ${candidates.map(formatCandidate).join(', ')}`,
  };
}

module.exports = {
  normalizeGitHubRepo,
  parseGitHubRemoteUrl,
  resolveGitHubRepoFromGit,
};

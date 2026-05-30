'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const {
  parseGitHubRemoteUrl,
  resolveGitHubRepoFromGit,
} = require('../get-tasks-done/bin/lib/github-repo.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

function git(cwd, args) {
  childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('GitHub repository resolution from git config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gtd-gh-repo-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('parses common GitHub remote URL forms', () => {
    assert.equal(parseGitHubRemoteUrl('https://github.com/owner/repo.git'), 'owner/repo');
    assert.equal(parseGitHubRemoteUrl('git@github.com:owner/repo.git'), 'owner/repo');
    assert.equal(parseGitHubRemoteUrl('ssh://git@github.com/owner/repo.git'), 'owner/repo');
    assert.equal(parseGitHubRemoteUrl('git+https://github.com/owner/repo.git'), 'owner/repo');
    assert.equal(parseGitHubRemoteUrl('https://example.com/owner/repo.git'), null);
  });

  test('prefers origin when multiple GitHub remotes are configured', () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'origin', 'https://github.com/davide-troiani/my-project.git']);
    git(tmpDir, ['remote', 'add', 'upstream', 'https://github.com/ai-is-gonna/get-tasks-done.git']);

    const resolved = resolveGitHubRepoFromGit(tmpDir);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.repo, 'davide-troiani/my-project');
    assert.equal(resolved.source, 'git_remote:origin');
  });

  test('uses the single GitHub remote when origin is absent', () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'github', 'git@github.com:owner/single.git']);

    const resolved = resolveGitHubRepoFromGit(tmpDir);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.repo, 'owner/single');
    assert.equal(resolved.source, 'git_remote:github');
  });

  test('fails closed for ambiguous non-origin GitHub remotes', () => {
    git(tmpDir, ['init']);
    git(tmpDir, ['remote', 'add', 'fork', 'https://github.com/owner/fork.git']);
    git(tmpDir, ['remote', 'add', 'upstream', 'https://github.com/owner/upstream.git']);

    const resolved = resolveGitHubRepoFromGit(tmpDir);

    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'ambiguous_github_remotes');
    assert.match(resolved.message, /multiple GitHub remotes/);
  });

  test('fails closed outside git repositories', () => {
    const resolved = resolveGitHubRepoFromGit(tmpDir);

    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'not_git_repo');
  });
});

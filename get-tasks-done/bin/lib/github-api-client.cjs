'use strict';

const childProcess = require('child_process');

const DEFAULT_API_VERSION = '2026-03-10';

function makeError(defaultErrorClass, message, operation) {
  return new defaultErrorClass(message, operation);
}

function runGhCommand({
  cwd,
  args,
  input = null,
  operation = null,
  allow404 = false,
  ErrorClass,
  missingGhMessage,
}) {
  const result = childProcess.spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error) {
    const message = result.error.code === 'ENOENT'
      ? missingGhMessage
      : result.error.message;
    throw makeError(ErrorClass, message, operation);
  }

  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    if (allow404 && /HTTP 404|status code 404|Not Found/i.test(stderr)) return null;
    throw makeError(ErrorClass, stderr || `gh exited with status ${result.status}`, operation);
  }

  return String(result.stdout || '').trim();
}

function parseGhJson(stdout, operation, endpoint, ErrorClass) {
  if (stdout === null || stdout === '') return stdout === null ? null : {};
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw makeError(ErrorClass, `Could not parse gh JSON response for ${operation || endpoint}: ${err.message}`, operation);
  }
}

function api({
  cwd,
  repo,
  method,
  endpoint,
  body = null,
  operation = null,
  allow404 = false,
  ErrorClass,
  missingGhMessage,
  apiVersion = DEFAULT_API_VERSION,
}) {
  const args = [
    'api',
    '--method',
    method,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    `X-GitHub-Api-Version: ${apiVersion}`,
    endpoint,
  ];
  const input = body === null ? null : `${JSON.stringify(body)}\n`;
  if (body !== null) args.push('--input', '-');
  const stdout = runGhCommand({
    cwd,
    args,
    input,
    operation,
    allow404,
    ErrorClass,
    missingGhMessage,
  });
  return parseGhJson(stdout, operation, endpoint, ErrorClass);
}

function repoEndpoint(repo, suffix) {
  return `repos/${repo}/${suffix}`;
}

module.exports = {
  api,
  repoEndpoint,
  runGhCommand,
};

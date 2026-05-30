import * as childProcess from 'node:child_process';

const DEFAULT_API_VERSION = '2026-03-10';

function makeError(ErrorClass: new (message: string, operation?: string | null) => Error, message: string, operation?: string | null): Error {
  return new ErrorClass(message, operation);
}

export function runGhCommand({
  cwd,
  args,
  input = null,
  operation = null,
  allow404 = false,
  ErrorClass,
  missingGhMessage,
}: {
  cwd: string;
  args: string[];
  input?: string | null;
  operation?: string | null;
  allow404?: boolean;
  ErrorClass: new (message: string, operation?: string | null) => Error;
  missingGhMessage: string;
}): string | null {
  const result = childProcess.spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    input: input ?? undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error) {
    const message = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
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

function parseGhJson(stdout: string | null, operation: string | null, endpoint: string, ErrorClass: new (message: string, operation?: string | null) => Error): unknown {
  if (stdout === null || stdout === '') return stdout === null ? null : {};
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw makeError(ErrorClass, `Could not parse gh JSON response for ${operation || endpoint}: ${err instanceof Error ? err.message : String(err)}`, operation);
  }
}

export function api({
  cwd,
  method,
  endpoint,
  body = null,
  operation = null,
  allow404 = false,
  ErrorClass,
  missingGhMessage,
  apiVersion = DEFAULT_API_VERSION,
}: {
  cwd: string;
  repo?: string;
  method: string;
  endpoint: string;
  body?: unknown;
  operation?: string | null;
  allow404?: boolean;
  ErrorClass: new (message: string, operation?: string | null) => Error;
  missingGhMessage: string;
  apiVersion?: string;
}): unknown {
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

export function repoEndpoint(repo: string, suffix: string): string {
  return `repos/${repo}/${suffix}`;
}

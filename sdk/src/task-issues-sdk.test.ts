import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GTDTools } from './gtd-tools.js';
import { GTDEventType } from './types.js';
import { createRegistry } from './query/index.js';
import { runQueryCliCommand } from './query/query-cli-adapter.js';
import { runGtdSdkQuery } from './task-issues/work-task-issue.js';

const SAMPLE_PLAN = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/index.ts]
autonomous: true
requirements: []
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Build foundation.
</objective>

<tasks>
<task type="auto">
  <name>Update index</name>
  <files>src/index.ts</files>
  <read_first>src/index.ts</read_first>
  <boundaries>Only src/index.ts.</boundaries>
  <action>Update it.</action>
  <verify>npm test</verify>
  <done>Tests pass.</done>
  <acceptance_criteria>
    - Works
  </acceptance_criteria>
</task>
</tasks>

<verification>
- [ ] npm test
</verification>

<success_criteria>
- Works.
</success_criteria>
`;

function makeProject(workstream?: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'gtd-sdk-task-issues-'));
  const phaseDir = workstream
    ? join(projectDir, '.planning', 'workstreams', workstream, 'phases', '01-alpha')
    : join(projectDir, '.planning', 'phases', '01-alpha');
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, '01-01-PLAN.md'), SAMPLE_PLAN, 'utf8');
  return projectDir;
}

describe('SDK task issue workflow', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it('registers the task issue commands and runs export dry-run natively', async () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);
    const registry = createRegistry();

    expect(registry.commands()).toEqual(expect.arrayContaining([
      'export-phase-issues',
      'work-task-issue',
      'orchestrate-tasks',
    ]));

    const result = await registry.dispatch(
      'export-phase-issues',
      ['01', '--dry-run', '--repo', 'owner/repo'],
      projectDir,
    );

    expect(result.data).toMatchObject({
      ok: true,
      mode: 'dry-run',
      writes: false,
      repo: 'owner/repo',
      manifest: {
        path: '.planning/github/phase-01-alpha-issues.json',
      },
    });
  });

  it('routes workstream manifests under the workstream planning tree', async () => {
    const projectDir = makeProject('alpha');
    cleanup.push(projectDir);
    const registry = createRegistry();

    const result = await registry.dispatch(
      'export-phase-issues',
      ['01', '--dry-run', '--repo', 'owner/repo'],
      projectDir,
      'alpha',
    );

    expect(result.data).toMatchObject({
      phase: {
        directory: '.planning/workstreams/alpha/phases/01-alpha',
      },
      manifest: {
        path: '.planning/workstreams/alpha/github/phase-01-alpha-issues.json',
      },
    });
  });

  it('exposes GTDTools typed methods without subprocess fallback and emits mutation events', async () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);
    const eventStream = { emitEvent: vi.fn() };
    const tools = new GTDTools({
      projectDir,
      eventStream: eventStream as never,
      sessionId: 'task-session',
      strictSdk: true,
      allowFallbackToSubprocess: false,
    });

    const result = await tools.exportPhaseIssues({
      phase: '01',
      dryRun: true,
      repo: 'owner/repo',
    });

    expect(result).toMatchObject({ ok: true, mode: 'dry-run' });
    expect(eventStream.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: GTDEventType.StateMutation,
      sessionId: 'task-session',
      command: 'export-phase-issues',
    }));
  });

  it('runs gtd-sdk query task commands with CJS fallback disabled', async () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);
    vi.stubEnv('GTD_QUERY_FALLBACK', 'off');

    const result = await runQueryCliCommand({
      projectDir,
      queryArgv: ['export-phase-issues', '01', '--dry-run', '--repo', 'owner/repo'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderrLines).toEqual([]);
    expect(JSON.parse(result.stdoutChunks.join(''))).toMatchObject({
      ok: true,
      mode: 'dry-run',
    });
  });

  it('runs canonical state updates through the bundled gtd-sdk shim when present', () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);
    const spawnSync = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));
    const existsSync = vi.fn((candidate: string) => {
      expect(candidate).toMatch(/bin\/gtd-sdk\.js$/);
      return true;
    });

    const result = runGtdSdkQuery(projectDir, ['state.advance-plan', '01-01'], {
      existsSync,
      spawnSync,
      execPath: '/test/node',
    });

    expect(result).toMatchObject({ ok: true, status: 0, stdout: '{}', stderr: '' });
    expect(spawnSync).toHaveBeenCalledWith(
      '/test/node',
      [expect.stringMatching(/bin\/gtd-sdk\.js$/), 'query', 'state.advance-plan', '01-01'],
      expect.objectContaining({
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('falls back to PATH gtd-sdk when the bundled parent shim is absent', () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);
    const spawnSync = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));

    const result = runGtdSdkQuery(projectDir, ['roadmap.update-plan-progress', '01-01'], {
      existsSync: vi.fn(() => false),
      spawnSync,
      execPath: '/test/node',
    });

    expect(result).toMatchObject({ ok: true, status: 0, stdout: '{}', stderr: '' });
    expect(spawnSync).toHaveBeenCalledWith(
      'gtd-sdk',
      ['query', 'roadmap.update-plan-progress', '01-01'],
      expect.objectContaining({
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('fails removed task workflow commands with migration guidance even when fallback is enabled', async () => {
    const projectDir = makeProject();
    cleanup.push(projectDir);

    const result = await runQueryCliCommand({
      projectDir,
      queryArgv: ['execute-phase', '01'],
    });

    expect(result.exitCode).toBe(10);
    expect(result.stderrLines.join('\n')).toContain('execute-phase has been removed');
    expect(result.stderrLines.join('\n')).toContain('work-task-issue --complete-phase <phase> --execute');
  });
});

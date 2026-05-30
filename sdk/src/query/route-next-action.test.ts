import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { routeNextAction } from './route-next-action.js';

describe('routeNextAction', () => {
  it('suggests new-project when STATE.md is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning'), { recursive: true });
    const { data } = await routeNextAction([], dir);
    expect(data).toMatchObject({
      command: '/gtd-new-project',
      reason: expect.stringContaining('STATE.md'),
    });
  });

  it('routes to resume-work when paused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning'), { recursive: true });
    await writeFile(
      join(dir, '.planning', 'STATE.md'),
      `---
milestone: v1.0
---

**Paused At:** Phase 2

`,
      'utf-8',
    );
    await writeFile(join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n', 'utf-8');
    const { data } = await routeNextAction([], dir);
    expect(data).toMatchObject({
      command: '/gtd-resume-work',
    });
  });

  it('blocks when .continue-here.md exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning'), { recursive: true });
    await writeFile(join(dir, '.planning', '.continue-here.md'), 'checkpoint\n', 'utf-8');
    await writeFile(
      join(dir, '.planning', 'STATE.md'),
      `---
milestone: v1.0
---

**Current Phase:** 3

`,
      'utf-8',
    );
    await writeFile(join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n', 'utf-8');
    const { data } = await routeNextAction([], dir);
    expect(data).toMatchObject({
      command: '',
      gates: expect.objectContaining({ continue_here: true }),
    });
  });

  it('routes incomplete planned phases to export-phase-issues before a task manifest exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
    await writeFile(
      join(dir, '.planning', 'STATE.md'),
      `---
current_phase: 1
---

`,
      'utf-8',
    );
    await writeFile(join(dir, '.planning', 'ROADMAP.md'), '### Phase 1: Foundation\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'CONTEXT.md'), '# Context\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'RESEARCH.md'), '# Research\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-01-PLAN.md'), '# Plan\n', 'utf-8');

    const { data } = await routeNextAction([], dir);

    expect(data).toMatchObject({
      command: '/gtd-export-phase-issues',
      args: '01',
      reason: expect.stringContaining('exported task issues'),
    });
  });

  it('routes incomplete planned phases to work-task-issue when a task manifest exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
    await mkdir(join(dir, '.planning', 'github'), { recursive: true });
    await writeFile(
      join(dir, '.planning', 'STATE.md'),
      `---
current_phase: 1
---

`,
      'utf-8',
    );
    await writeFile(join(dir, '.planning', 'ROADMAP.md'), '### Phase 1: Foundation\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'CONTEXT.md'), '# Context\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'RESEARCH.md'), '# Research\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-01-PLAN.md'), '# Plan\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'github', 'phase-01-foundation-issues.json'), '{}\n', 'utf-8');

    const { data } = await routeNextAction([], dir);

    expect(data).toMatchObject({
      command: '/gtd-work-task-issue',
      args: '--phase 01',
      reason: expect.stringContaining('task issue execution or reconciliation'),
    });
  });

  it('routes summarized phases to work-task-issue complete-phase before verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gtd-rna-'));
    await mkdir(join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
    await writeFile(
      join(dir, '.planning', 'STATE.md'),
      `---
current_phase: 1
---

`,
      'utf-8',
    );
    await writeFile(join(dir, '.planning', 'ROADMAP.md'), '### Phase 1: Foundation\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'CONTEXT.md'), '# Context\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', 'RESEARCH.md'), '# Research\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-01-PLAN.md'), '# Plan\n', 'utf-8');
    await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md'), '# Summary\n', 'utf-8');

    const { data } = await routeNextAction([], dir);

    expect(data).toMatchObject({
      command: '/gtd-work-task-issue',
      args: '--complete-phase 01 --execute',
      reason: expect.stringContaining('task-flow phase finalization'),
    });
  });
});

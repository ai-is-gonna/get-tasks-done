import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import {
  BUNDLED_CORE_CJS_PATH,
  BUNDLED_GTD_AGENTS_DIR,
  BUNDLED_GTD_TEMPLATES_DIR,
  BUNDLED_GTD_TOOLS_PATH,
  BUNDLED_GTD_WORKFLOWS_DIR,
  loadLegacyCoreConfig,
  probeLegacySdkAsset,
  resolveBundledAgentsDir,
  resolveBundledTemplatesDir,
  resolveBundledWorkflowsDir,
  resolveGtdToolsPath,
  resolveLegacyInstallDir,
  resolveLegacyUserProfilePath,
  resolveLegacyTemplatesDir,
  resolveLegacyWorkflowsDir,
} from './sdk-package-compatibility.js';
import { GTDError } from './errors.js';

describe('SDK Package Seam Module', () => {
  const projectDir = '/work/project';
  const homeDir = '/users/tester';

  it('resolves legacy install-relative directories through one seam', () => {
    expect(resolveLegacyInstallDir(homeDir)).toBe(join(homeDir, '.claude', 'get-tasks-done'));
    expect(resolveLegacyTemplatesDir(homeDir)).toBe(join(homeDir, '.claude', 'get-tasks-done', 'templates'));
    expect(resolveLegacyWorkflowsDir(homeDir)).toBe(join(homeDir, '.claude', 'get-tasks-done', 'workflows'));
    expect(resolveLegacyUserProfilePath(homeDir)).toBe(join(homeDir, '.claude', 'get-tasks-done', 'USER-PROFILE.md'));
    expect(resolveBundledTemplatesDir()).toBe(BUNDLED_GTD_TEMPLATES_DIR);
    expect(resolveBundledWorkflowsDir()).toBe(BUNDLED_GTD_WORKFLOWS_DIR);
    expect(resolveBundledAgentsDir()).toBe(BUNDLED_GTD_AGENTS_DIR);
  });

  it('probes legacy gtd-tools locations in bundled -> project -> home order', () => {
    const resolution = probeLegacySdkAsset('gtd-tools', projectDir, {
      homeDir,
      existsSync: path => path === join(projectDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'),
    });

    expect(resolution.probes).toEqual([
      BUNDLED_GTD_TOOLS_PATH,
      join(projectDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'),
      join(homeDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'),
    ]);
    expect(resolution.path).toBe(join(projectDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'));
    expect(resolution.fallbackPath).toBe(join(homeDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'));
  });

  it('returns concrete fallback gtd-tools path when no legacy probe exists', () => {
    const path = resolveGtdToolsPath(projectDir, {
      homeDir,
      existsSync: () => false,
    });

    expect(path).toBe(join(homeDir, '.claude', 'get-tasks-done', 'bin', 'gtd-tools.cjs'));
  });

  it('loads legacy core.cjs through one compatibility adapter', () => {
    const loadConfig = vi.fn((cwd: string) => ({ cwd, source: 'legacy-core' }));
    const requireFn = vi.fn(() => ({ loadConfig }));
    const createRequire = vi.fn(() => requireFn as unknown as NodeJS.Require);

    const result = loadLegacyCoreConfig(projectDir, {
      homeDir,
      existsSync: path => path === BUNDLED_CORE_CJS_PATH,
      createRequire,
    });

    expect(createRequire).toHaveBeenCalledOnce();
    expect(requireFn).toHaveBeenCalledWith(BUNDLED_CORE_CJS_PATH);
    expect(loadConfig).toHaveBeenCalledWith(projectDir);
    expect(result).toEqual({ cwd: projectDir, source: 'legacy-core' });
  });

  it('reports checked core.cjs probes when legacy asset missing', () => {
    expect(() => loadLegacyCoreConfig(projectDir, {
      homeDir,
      existsSync: () => false,
    })).toThrow(GTDError);

    try {
      loadLegacyCoreConfig(projectDir, {
        homeDir,
        existsSync: () => false,
      });
      expect.fail('expected GTDError');
    } catch (error) {
      expect(error).toBeInstanceOf(GTDError);
      const message = (error as Error).message;
      expect(message).toContain('state load: get-tasks-done/bin/lib/core.cjs not found.');
      expect(message).toContain('Checked:');
      expect(message).toContain(BUNDLED_CORE_CJS_PATH);
      expect(message).toContain(join(projectDir, '.claude', 'get-tasks-done', 'bin', 'lib', 'core.cjs'));
      expect(message).toContain(join(homeDir, '.claude', 'get-tasks-done', 'bin', 'lib', 'core.cjs'));
    }
  });
});

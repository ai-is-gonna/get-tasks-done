/**
 * Detect user-added files under GTD-managed install dirs not listed in the manifest.
 *
 * Port of `detect-custom-files` from `get-tasks-done/bin/gtd-tools.cjs` (lines 1161–1239).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { QueryHandler } from './utils.js';

const GTD_MANAGED_DIRS = [
  'get-tasks-done',
  'agents',
  join('commands', 'gtd'),
  'hooks',
  'skills',
];

function walkDir(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else {
      const relPath = relative(baseDir, fullPath).split('\\').join('/');
      results.push(relPath);
    }
  }
  return results;
}

/**
 * Args: `--config-dir <path>` (required) — runtime config directory to scan.
 */
export const detectCustomFiles: QueryHandler = async (args) => {
  const configDirIdx = args.indexOf('--config-dir');
  const configDir = configDirIdx !== -1 ? args[configDirIdx + 1] : null;
  if (!configDir) {
    return { data: { error: 'Usage: detect-custom-files --config-dir <path>' } };
  }

  const resolvedConfigDir = resolve(configDir);
  if (!existsSync(resolvedConfigDir)) {
    return { data: { error: `Config directory not found: ${resolvedConfigDir}` } };
  }

  const manifestPath = join(resolvedConfigDir, 'gtd-file-manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      data: {
        custom_files: [] as string[],
        custom_count: 0,
        manifest_found: false,
      },
    };
  }

  let manifest: { version?: string; files?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string; files?: Record<string, unknown> };
  } catch {
    return {
      data: {
        custom_files: [] as string[],
        custom_count: 0,
        manifest_found: false,
        error: 'manifest parse error',
      },
    };
  }

  const manifestKeys = new Set(Object.keys(manifest.files || {}));

  const customFiles: string[] = [];
  for (const managedDir of GTD_MANAGED_DIRS) {
    const absDir = join(resolvedConfigDir, managedDir);
    if (!existsSync(absDir)) continue;
    for (const relPath of walkDir(absDir, resolvedConfigDir)) {
      if (!manifestKeys.has(relPath)) {
        customFiles.push(relPath);
      }
    }
  }

  return {
    data: {
      custom_files: customFiles,
      custom_count: customFiles.length,
      manifest_found: true,
      manifest_version: manifest.version ?? null,
    },
  };
};

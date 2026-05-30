import * as fs from 'node:fs';
import * as path from 'node:path';

export function formatGtdSlash(commandName: string, runtime?: string | null): string {
  if (typeof commandName !== 'string' || commandName === '') return commandName;
  const stripped = commandName.replace(/^[/$]?gtd[-:]/i, '');
  const bare = stripped === commandName ? commandName : stripped;
  if (bare === '' || bare.trim() === '') return '';
  const wsMatch = bare.match(/^(\S+)(\s[\s\S]*)?$/);
  const token = wsMatch ? wsMatch[1] : bare;
  const tail = wsMatch && wsMatch[2] ? wsMatch[2] : '';
  const rt = String(runtime || 'claude').toLowerCase();
  if (rt === 'codex') return `$gtd-${token.toLowerCase()}${tail}`;
  return `/gtd-${token}${tail}`;
}

export function resolveRuntime(projectDir?: string | null): string {
  if (process.env.GTD_RUNTIME) return String(process.env.GTD_RUNTIME).toLowerCase();
  if (projectDir) {
    try {
      const configPath = path.join(projectDir, '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.runtime) {
          return String(parsed.runtime).toLowerCase();
        }
      }
    } catch {
      // Fall through.
    }
  }
  return 'claude';
}

export function formatGtdSlashFor(projectDir: string, commandName: string): string {
  return formatGtdSlash(commandName, resolveRuntime(projectDir));
}

'use strict';
/**
 * One-shot script: replace retired /gtd-<cmd> with /gtd:<cmd> for known command names.
 * Only replaces when followed by a word boundary (space, newline, quote, backtick, ), end).
 *
 * The transform is exported as a pure function so it can be unit-tested directly
 * (see tests/bug-2543-gtd-slash-namespace.test.cjs) without needing fixture files.
 */

const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gtd');
const SEARCH_DIRS = [
  path.join(__dirname, '..', 'get-tasks-done', 'bin', 'lib'),
  path.join(__dirname, '..', 'get-tasks-done', 'workflows'),
  path.join(__dirname, '..', 'get-tasks-done', 'references'),
  path.join(__dirname, '..', 'get-tasks-done', 'templates'),
  path.join(__dirname, '..', 'get-tasks-done', 'contexts'),
  path.join(__dirname, '..', 'commands', 'gtd'),
  path.join(__dirname, '..', 'agents'),
  path.join(__dirname, '..', 'hooks'),
];

const TOP_LEVEL_FILES = [
  path.join(__dirname, '..', '.clinerules'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);
const EXTENSIONS = new Set(['.md', '.cjs', '.js', '.ts', '.tsx']);

// Test files contain intentional fixture strings (e.g. inputs the sanitizer
// is expected to strip). Rewriting them changes test semantics.
function isTestFile(name) {
  return /\.test\.(c?js|tsx?)$/.test(name);
}

function buildPattern(cmdNames) {
  // Empty input would compile `/gtd-()(?=[^a-zA-Z0-9_-]|$)/g`, which the regex
  // engine still matches at any `/gtd-` token followed by a non-word boundary
  // (e.g. EOL, whitespace, punctuation) — rewriting it to a stray `/gtd:`.
  // Short-circuit so the caller can no-op on a missing/empty registry rather
  // than perform an unintended broad rewrite.
  if (!Array.isArray(cmdNames) || cmdNames.length === 0) return null;
  const sorted = [...cmdNames].sort((a, b) => b.length - a.length); // longest first to avoid partial matches
  return new RegExp(`/gtd-(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`, 'g');
}

/**
 * Pure transform: rewrite retired `/gtd-<cmd>` to `/gtd:<cmd>` for the given command names.
 * Returns the rewritten string. Identifiers not in `cmdNames` (e.g. `/gtd-sdk`,
 * `/gtd-tools`) are left untouched.
 */
function transformContent(src, cmdNames) {
  const pattern = buildPattern(cmdNames);
  if (!pattern) return src;
  return src.replace(pattern, (_, cmd) => `/gtd:${cmd}`);
}

function readCmdNames() {
  return fs.readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));
}

function processFile(file, cmdNames) {
  const pattern = buildPattern(cmdNames);
  if (!pattern) return;
  let src;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return; }
  const replaced = transformContent(src, cmdNames);
  if (replaced !== src) {
    fs.writeFileSync(file, replaced, 'utf-8');
    const count = (src.match(pattern) || []).length;
    console.log(`  ${count} replacements: ${path.relative(path.join(__dirname, '..'), file)}`);
  }
}

function processDir(dir, cmdNames) {
  const pattern = buildPattern(cmdNames);
  if (!pattern) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      processDir(full, cmdNames);
    } else if (EXTENSIONS.has(path.extname(e.name)) && !isTestFile(e.name)) {
      processFile(full, cmdNames);
    }
  }
}

if (require.main === module) {
  const cmdNames = readCmdNames();
  for (const dir of SEARCH_DIRS) {
    processDir(dir, cmdNames);
  }
  for (const file of TOP_LEVEL_FILES) {
    processFile(file, cmdNames);
  }
  console.log('Done.');
}

module.exports = { transformContent, buildPattern, SKIP_DIRS };

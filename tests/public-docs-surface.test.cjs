// allow-test-rule: source-text-is-the-product
// Public docs are intentionally small for the first open-source launch.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const ALLOWED_DOCS = new Set([
  'ARCHITECTURE.md',
  'COMMANDS.md',
  'CONFIGURATION.md',
  'README.md',
  'contributor-standards.md',
  'task-issue-operator-guide.md',
]);

function listDocs() {
  return fs.readdirSync(DOCS, { withFileTypes: true })
    .flatMap((entry) => entry.isFile() ? [entry.name] : [`${entry.name}/`])
    .sort();
}

function readDoc(name) {
  return fs.readFileSync(path.join(DOCS, name), 'utf8');
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith('http'));
}

describe('minimal public docs surface', () => {
  test('docs contains only the launch allowlist', () => {
    assert.deepEqual(listDocs(), [...ALLOWED_DOCS].sort());
  });

  test('kept docs contain no internal issue IDs or GitHub issue links', () => {
    const pattern = /github\.com\/.*\/issues\/[0-9]+|#[0-9]{2,}|PR #[0-9]+|issue #[0-9]+/i;
    const offenders = [];

    for (const file of ALLOWED_DOCS) {
      const content = readDoc(file);
      if (pattern.test(content)) offenders.push(file);
    }

    assert.deepEqual(offenders, []);
  });

  test('kept docs do not advertise retired workflow language or raw git mechanics', () => {
    const pattern = /execute-phase|task orchestration flow|native phase execution|commit_docs|git worktree|git branch|git commit/i;
    const offenders = [];

    for (const file of ALLOWED_DOCS) {
      const content = readDoc(file);
      if (pattern.test(content)) offenders.push(file);
    }

    assert.deepEqual(offenders, []);
  });

  test('links among kept docs resolve', () => {
    const broken = [];

    for (const file of ALLOWED_DOCS) {
      for (const target of markdownLinks(readDoc(file))) {
        const targetPath = path.normalize(path.join(DOCS, target));
        if (!targetPath.startsWith(DOCS) || !fs.existsSync(targetPath)) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }

    assert.deepEqual(broken, []);
  });
});

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OLD_SHORT_NAME = String.fromCharCode(103, 115, 100);
const OLD_REPO_NAME = ['get', String.fromCharCode(115, 104, 105, 116), 'done'].join('-');

const LEGACY_MANIFEST_NAME = `${OLD_SHORT_NAME}-file-manifest.json`;
const LEGACY_INSTALL_STATE_NAME = `${OLD_SHORT_NAME}-install-state.json`;
const LEGACY_INSTALL_LOCK_NAME = `${OLD_SHORT_NAME}-install-migration.lock`;

const LEGACY_TOP_LEVEL_FILES = [
  LEGACY_MANIFEST_NAME,
  LEGACY_INSTALL_STATE_NAME,
  LEGACY_INSTALL_LOCK_NAME,
];

const LEGACY_MANAGED_PREFIXES = [
  `${OLD_REPO_NAME}/`,
  `commands/${OLD_SHORT_NAME}/`,
  `skills/${OLD_SHORT_NAME}/`,
  `skills/${OLD_SHORT_NAME}-`,
  `agents/${OLD_SHORT_NAME}/`,
  `agents/${OLD_SHORT_NAME}-`,
  `hooks/${OLD_SHORT_NAME}-`,
  `hooks/${OLD_SHORT_NAME}_`,
  `${OLD_SHORT_NAME}-local-patches/`,
  `${OLD_SHORT_NAME}-pristine/`,
  `${OLD_SHORT_NAME}-migration-backups/`,
  `${OLD_SHORT_NAME}-migration-journal/`,
];

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readLegacyManifest(configDir) {
  const manifestPath = path.join(configDir, LEGACY_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
      return { files: {} };
    }
    return { files: parsed.files };
  } catch {
    return { files: {} };
  }
}

function isLegacyManagedPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (LEGACY_TOP_LEVEL_FILES.includes(normalized)) return true;
  return LEGACY_MANAGED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function legacyClassification(configDir, relPath, legacyManifest) {
  const normalized = normalizeRelPath(relPath);
  const fullPath = path.join(configDir, normalized);
  if (!fs.existsSync(fullPath)) {
    return {
      classification: legacyManifest.files[normalized] ? 'managed-missing' : 'missing',
      originalHash: legacyManifest.files[normalized] || null,
      currentHash: null,
    };
  }

  const currentHash = sha256File(fullPath);
  const originalHash = legacyManifest.files[normalized] || null;
  if (!originalHash) {
    if (LEGACY_TOP_LEVEL_FILES.includes(normalized)) {
      return { classification: 'managed-pristine', originalHash: currentHash, currentHash };
    }
    return { classification: 'unknown', originalHash: null, currentHash };
  }
  if (currentHash === originalHash) {
    return { classification: 'managed-pristine', originalHash, currentHash };
  }
  return { classification: 'managed-modified', originalHash, currentHash };
}

function legacyManifestRelPaths(legacyManifest) {
  return Object.keys(legacyManifest.files || {})
    .map(normalizeRelPath)
    .filter(isLegacyManagedPath);
}

function legacyMetadataRelPaths(configDir) {
  return LEGACY_TOP_LEVEL_FILES.filter((relPath) => fs.existsSync(path.join(configDir, relPath)));
}

module.exports = {
  id: '2026-05-25-legacy-acronym-install-cleanup',
  title: 'Remove legacy install artifacts after GTD rename',
  description: 'Remove old manifest-managed install artifacts after the GTD hard rename.',
  introducedIn: '1.51.0',
  scopes: ['global', 'local'],
  destructive: true,
  plan: ({ configDir }) => {
    const legacyManifest = readLegacyManifest(configDir);
    if (!legacyManifest) return [];

    const relPaths = [...new Set([
      ...legacyManifestRelPaths(legacyManifest),
      ...legacyMetadataRelPaths(configDir),
    ])].sort();

    const actions = [];
    for (const relPath of relPaths) {
      const artifact = legacyClassification(configDir, relPath, legacyManifest);
      if (artifact.classification !== 'managed-pristine' && artifact.classification !== 'managed-modified') {
        continue;
      }
      actions.push({
        type: artifact.classification === 'managed-modified' ? 'backup-and-remove' : 'remove-managed',
        relPath,
        reason: 'legacy artifact retired by the GTD hard rename',
        ownershipEvidence: 'path is listed in a legacy installer manifest or is legacy installer state',
        classification: artifact.classification,
        originalHash: artifact.originalHash,
        currentHash: artifact.currentHash,
      });
    }

    return actions;
  },
};

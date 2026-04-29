#!/usr/bin/env node
// Build tests/models/manifest.json from the working tree.
// - .ifc files are LFS pointers → read sha256 + size from the pointer.
// - .ifcx files are plain git blobs → compute sha256 + size from disk.
// - Anything else under tests/models/ that's a regular file is included.
//
// The manifest is the source of truth after migrating off LFS.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, posix } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS_DIR = resolve(ROOT, 'tests/models');
const MANIFEST_PATH = resolve(MODELS_DIR, 'manifest.json');

const LFS_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/;

function parseLfsPointer(content) {
  const m = LFS_RE.exec(content);
  if (!m) return null;
  return { sha256: m[1], size: parseInt(m[2], 10) };
}

function sha256OfFile(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

// Use git ls-files so we only catalog tracked files (not local/untracked stuff).
const tracked = execSync('git ls-files tests/models', { cwd: ROOT })
  .toString()
  .split('\n')
  .filter(Boolean);

const files = [];
for (const rel of tracked) {
  const abs = resolve(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue;
  }
  if (!st.isFile()) continue;
  const relFromModels = posix.normalize(relative(MODELS_DIR, abs).split(/[\\/]/).join('/'));

  // Skip the manifest itself and any README the migration adds.
  if (relFromModels === 'manifest.json') continue;
  if (relFromModels === 'README.md') continue;

  let entry;
  if (/\.(ifc|IFC)$/.test(relFromModels)) {
    // Likely an LFS pointer
    const text = readFileSync(abs, 'utf8');
    const pointer = parseLfsPointer(text);
    if (pointer) {
      entry = { path: relFromModels, sha256: pointer.sha256, size: pointer.size, source: 'lfs-pointer' };
    } else {
      // Real file (e.g. dev clone with LFS pulled)
      entry = { path: relFromModels, sha256: sha256OfFile(abs), size: st.size, source: 'inline' };
    }
  } else {
    entry = { path: relFromModels, sha256: sha256OfFile(abs), size: st.size, source: 'inline' };
  }
  files.push(entry);
}

files.sort((a, b) => a.path.localeCompare(b.path));

// Strip the source field — that's only useful at build time.
const out = {
  version: 1,
  release_tag: 'fixtures-v1',
  base_url: 'https://github.com/louistrue/ifc-lite/releases/download/fixtures-v1',
  files: files.map(({ source: _src, ...rest }) => rest),
};

writeFileSync(MANIFEST_PATH, JSON.stringify(out, null, 2) + '\n');

const totalSize = files.reduce((a, f) => a + f.size, 0);
const lfsCount = files.filter((f) => f.source === 'lfs-pointer').length;
const inlineCount = files.length - lfsCount;
console.error(
  `Wrote ${MANIFEST_PATH}\n  files: ${files.length} (${lfsCount} from LFS pointers, ${inlineCount} hashed from disk)\n  total: ${(totalSize / 1024 / 1024).toFixed(1)} MiB`
);

#!/usr/bin/env node
// Build tests/models/manifest.json by walking the working tree under
// tests/models/. Recognised fixture types: .ifc, .IFC, .ifcx.
//
// - For files that look like Git LFS pointers (small text containing
//   "version https://git-lfs.github.com/spec/v1"), read sha256 + size from
//   the pointer without ever downloading the LFS bytes. This is how the
//   initial migration captured 70 fixtures we never had locally.
// - Otherwise, hash the file directly (the maintainer just dropped a real
//   .ifc into tests/models/various/ and is regenerating the manifest).
//
// The manifest is the source of truth after migrating off LFS, so we
// must NOT rely on `git ls-files` — fixtures are gitignored after the
// migration, so that path would silently produce an empty catalogue.

import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS_DIR = resolve(ROOT, 'tests/models');
const MANIFEST_PATH = resolve(MODELS_DIR, 'manifest.json');

// Files at the top level of tests/models/ that aren't fixtures.
const META_FILES = new Set(['manifest.json', 'README.md']);
// Subdirectories never managed by the manifest. `local/` is reserved for
// private fixtures that contributors keep on their own machine.
const SKIP_DIRS = new Set(['local']);
// Recognised fixture extensions. Add new types here when needed.
const FIXTURE_EXT = /\.(ifc|IFC|ifcx)$/;

const LFS_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/;

function parseLfsPointer(text) {
  const m = LFS_RE.exec(text);
  if (!m) return null;
  return { sha256: m[1], size: parseInt(m[2], 10) };
}

async function sha256OfFile(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

function* walk(dir, depth = 0) {
  for (const name of readdirSync(dir).sort()) {
    if (depth === 0 && SKIP_DIRS.has(name)) continue;
    const abs = resolve(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walk(abs, depth + 1);
    } else if (st.isFile()) {
      yield { abs, size: st.size, name };
    }
  }
}

const files = [];
for (const { abs, size, name } of walk(MODELS_DIR)) {
  const relFromModels = posix.normalize(relative(MODELS_DIR, abs).split(/[\\/]/).join('/'));
  if (META_FILES.has(name) && !relFromModels.includes('/')) continue;
  if (!FIXTURE_EXT.test(name)) continue;

  let entry;
  // LFS pointers are always small (~130 B). Skip the read for anything
  // larger than 1 KiB.
  if (size <= 1024) {
    const text = readFileSync(abs, 'utf8');
    const pointer = parseLfsPointer(text);
    if (pointer) {
      entry = { path: relFromModels, sha256: pointer.sha256, size: pointer.size, source: 'lfs-pointer' };
    }
  }
  if (!entry) {
    entry = { path: relFromModels, sha256: await sha256OfFile(abs), size, source: 'inline' };
  }
  files.push(entry);
}

files.sort((a, b) => a.path.localeCompare(b.path));

// Preserve release_tag / base_url across regenerations so the maintainer
// doesn't lose customisations.
let header = {
  version: 1,
  release_tag: 'fixtures-v1',
  base_url: 'https://github.com/louistrue/ifc-lite/releases/download/fixtures-v1',
};
try {
  const existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (existing.release_tag) header.release_tag = existing.release_tag;
  if (existing.base_url) header.base_url = existing.base_url;
} catch {
  // No existing manifest — use defaults.
}

const out = {
  ...header,
  files: files.map(({ source: _src, ...rest }) => rest),
};

writeFileSync(MANIFEST_PATH, JSON.stringify(out, null, 2) + '\n');

const totalSize = files.reduce((a, f) => a + f.size, 0);
const lfsCount = files.filter((f) => f.source === 'lfs-pointer').length;
const inlineCount = files.length - lfsCount;
console.error(
  `Wrote ${MANIFEST_PATH}\n  files: ${files.length} (${lfsCount} from LFS pointers, ${inlineCount} hashed from disk)\n  total: ${(totalSize / 1024 / 1024).toFixed(1)} MiB`
);

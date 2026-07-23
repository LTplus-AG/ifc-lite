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
const IGNORE_PATH = resolve(MODELS_DIR, '.manifest-ignore');

// `.manifest-ignore` is the redistribution guard: fixtures whose paths match a
// pattern here are NEVER written to the manifest, so `fixtures:upload` can never
// push them to the public release bucket — even though they sit on disk and look
// like ordinary fixtures. Use it for models that are referenced by a test at a
// fixed path (so `local/` won't do) but are NOT cleared for public redistribution
// (client models, un-licensed sample files, anything with a name that must not
// enter git). Syntax: one glob per line, `#` comments, blank lines ignored.
// Globs match the manifest-relative posix path (e.g. `various/ClientTower.ifc`,
// `**/*_private.ifc`).
function loadIgnorePatterns() {
  let text;
  try {
    text = readFileSync(IGNORE_PATH, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

// Minimal glob → RegExp: supports `**` (any depth), `*` (one segment), `?`.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const IGNORE_PATTERNS = loadIgnorePatterns();
const IGNORE_RES = IGNORE_PATTERNS.map(globToRegExp);
const isIgnored = (relPath) => IGNORE_RES.some((re) => re.test(relPath));

// Previous manifest's path set — used to flag NEW fixtures (silent-add guard).
let prevPaths = new Set();
try {
  const prev = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (Array.isArray(prev.files)) prevPaths = new Set(prev.files.map((f) => f.path));
} catch {
  // No prior manifest — every fixture is "new"; the warning below still fires.
}

// Files at the top level of tests/models/ that aren't fixtures.
const META_FILES = new Set(['manifest.json', 'README.md']);
// Subdirectories never managed by the manifest. `local/` is reserved for
// private fixtures that contributors keep on their own machine.
const SKIP_DIRS = new Set(['local']);
// Recognised fixture extensions. Add new types here when needed.
// .ifczip: zip container fixtures (textured models ship images as siblings
// of the .ifc inside the archive, #1781).
const FIXTURE_EXT = /\.(ifc|IFC|ifcx|ifczip)$/;

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
const ignoredFiles = [];
const newFiles = [];
for (const { abs, size, name } of walk(MODELS_DIR)) {
  const relFromModels = posix.normalize(relative(MODELS_DIR, abs).split(/[\\/]/).join('/'));
  if (META_FILES.has(name) && !relFromModels.includes('/')) continue;
  if (!FIXTURE_EXT.test(name)) continue;

  // Redistribution guard: never manifest (and thus never upload) an ignored file.
  if (isIgnored(relFromModels)) {
    ignoredFiles.push(relFromModels);
    continue;
  }
  if (!prevPaths.has(relFromModels)) newFiles.push(relFromModels);

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
  base_url: 'https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1',
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

if (ignoredFiles.length) {
  console.error(
    `\n  excluded by .manifest-ignore (NOT published): ${ignoredFiles.length}\n` +
      ignoredFiles.map((p) => `    - ${p}`).join('\n')
  );
}

// Silent-add guard: publishing a fixture is a redistribution decision, so a
// file that wasn't in the previous manifest must be seen, not slipped in. This
// is advisory (regeneration is often exactly to add a legit new public fixture),
// but it forces a conscious "is this cleared for the public bucket?" check.
if (newFiles.length) {
  console.error(
    `\n  ⚠️  NEW fixtures added to the manifest — \`fixtures:upload\` will publish these to the PUBLIC release bucket.\n` +
      `      Confirm each is cleared for public redistribution; if not, add it to tests/models/.manifest-ignore\n` +
      `      (or move it under tests/models/local/):\n` +
      newFiles.map((p) => `    + ${p}`).join('\n')
  );
}

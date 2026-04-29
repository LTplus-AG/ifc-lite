#!/usr/bin/env node
// One-time / on-demand uploader for fixture assets.
//
// Usage:
//   node scripts/fixtures/upload-fixtures.mjs
//
// What it does:
//   1. Reads tests/models/manifest.json.
//   2. For each entry: requires the real file content to be present at
//      tests/models/<path> and to match the manifest sha256. (i.e. the
//      maintainer must have a working LFS clone first.)
//   3. Creates the GitHub release `<release_tag>` if it doesn't exist.
//   4. For each manifest entry, uploads the real file as an asset whose
//      name is its sha256 (no extension, no path), unless an asset with
//      that name already exists on the release.
//
// Requires: `gh` CLI logged in with write access to the repo.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS_DIR = resolve(ROOT, 'tests/models');
const MANIFEST_PATH = resolve(MODELS_DIR, 'manifest.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const TAG = manifest.release_tag;
const REPO = process.env.IFC_LITE_FIXTURE_REPO || 'louistrue/ifc-lite';

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function sha256OfFile(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

// Verify every file is present locally and matches the manifest.
console.error(`Verifying local copies against manifest (${manifest.files.length} files)...`);
const missing = [];
const wrong = [];
for (const entry of manifest.files) {
  const abs = resolve(MODELS_DIR, entry.path);
  if (!existsSync(abs)) {
    missing.push(entry);
    continue;
  }
  const st = statSync(abs);
  if (st.size !== entry.size) {
    wrong.push({ entry, why: `size ${st.size} != ${entry.size}` });
    continue;
  }
  const got = await sha256OfFile(abs);
  if (got !== entry.sha256) {
    wrong.push({ entry, why: `sha256 ${got} != ${entry.sha256}` });
  }
}
if (missing.length || wrong.length) {
  console.error('Cannot upload — local fixtures don\'t match manifest:');
  for (const e of missing) console.error(`  missing: ${e.path}`);
  for (const w of wrong) console.error(`  ${w.why}: ${w.entry.path}`);
  console.error('\nFix: run `git lfs pull` and ensure all files in tests/models/ are real, not pointers.');
  process.exit(2);
}
console.error('  all files match.');

// Ensure the release exists.
let releaseExists = true;
try {
  gh('release', 'view', TAG, '--repo', REPO);
} catch {
  releaseExists = false;
}
if (!releaseExists) {
  console.error(`Creating release ${TAG} on ${REPO}...`);
  gh(
    'release', 'create', TAG,
    '--repo', REPO,
    '--title', `Test fixtures (${TAG})`,
    '--notes',
    `Test fixtures for ifc-lite. Each asset is named after its sha256.\n\nSee \`tests/models/manifest.json\` for the catalogue and \`scripts/fixtures/fetch-fixtures.mjs\` for the fetcher.`,
    '--latest=false',
    '--prerelease=false',
  );
} else {
  console.error(`Release ${TAG} exists.`);
}

// List existing assets so we don't re-upload.
const existing = new Set();
try {
  const json = gh('release', 'view', TAG, '--repo', REPO, '--json', 'assets');
  for (const a of JSON.parse(json).assets || []) existing.add(a.name);
} catch (err) {
  console.error(`warning: couldn't list assets (${err.message}); will attempt all uploads`);
}

let uploaded = 0;
let skipped = 0;
const failed = [];
for (const entry of manifest.files) {
  const assetName = entry.sha256;
  if (existing.has(assetName)) {
    skipped++;
    continue;
  }
  const abs = resolve(MODELS_DIR, entry.path);
  console.error(`  uploading ${entry.path} as ${assetName} (${(entry.size / 1024 / 1024).toFixed(1)} MiB)...`);
  try {
    gh(
      'release', 'upload', TAG,
      `${abs}#${assetName}`,
      '--repo', REPO,
      '--clobber',
    );
    uploaded++;
  } catch (err) {
    failed.push({ entry, err });
    console.error(`    FAILED: ${err.message}`);
  }
}

console.error(`done: uploaded=${uploaded} skipped=${skipped} failed=${failed.length}`);
process.exit(failed.length ? 1 : 0);

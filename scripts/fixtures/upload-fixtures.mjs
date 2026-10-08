#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One-time / on-demand uploader for fixture assets.
//
// Usage:
//   node scripts/fixtures/upload-fixtures.mjs
//
// What it does:
//   1. Reads tests/models/manifest.json.
//   2. Skips every entry the fetcher takes from its pinned upstream source
//      (`upstreamBlobUrl` in download-url.mjs: upstream archives and reviewed,
//      unmodified LandXML source bytes). Those are redistributed by their
//      authors, never by this project's public release.
//   3. For each remaining entry: requires the real file content to be present
//      at tests/models/<path> and to match the manifest sha256.
//   4. Creates the GitHub release `<release_tag>` if it doesn't exist.
//   5. Uploads each release-hosted file as an asset whose name is its sha256
//      (no extension, no path), unless an asset with that name already exists.
//
// Requires: `gh` CLI logged in with write access to the repo.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { upstreamBlobUrl } from './download-url.mjs';
import { validateManifest } from './manifest-validation.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Thrown for a refusal the maintainer must fix; the CLI exits 2 on it. */
export class UploadRefused extends Error {}

/** Resolve a manifest-relative path, refusing anything that would escape
 *  `modelsDir`. Defends against a tampered manifest causing the upload
 *  script to read/upload arbitrary files on the maintainer's machine. */
function resolveFixturePath(modelsDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`invalid manifest entry path: ${JSON.stringify(relPath)}`);
  }
  const abs = resolve(modelsDir, relPath);
  const rel = relative(modelsDir, abs);
  if (rel === '' || rel.startsWith('..')) {
    throw new Error(`manifest path escapes tests/models/: ${relPath}`);
  }
  return abs;
}

async function sha256OfFile(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/**
 * Refuse to publish an entry the fetcher takes from upstream. The filter in
 * `uploadFixtures` already drops these; this guard sits on the upload call
 * itself so no future caller can route one to the public release.
 */
export function assertReleaseHosted(entry) {
  const blobUrl = upstreamBlobUrl(entry);
  if (blobUrl !== null) {
    throw new UploadRefused(
      `refusing to upload ${entry.path}: its manifest entry is fetched from its pinned upstream source ` +
        `(${blobUrl}), so it must never be published to this project's fixture release.`,
    );
  }
}

/**
 * Upload one release-hosted fixture as the asset `<sha256>`.
 *
 * `gh release upload PATH#TEXT` sets the asset's display *label*; it does NOT
 * rename the asset, whose name is always the file's basename. So to upload
 * each fixture as `<sha256>` (how fetch-fixtures.mjs reads them), the file is
 * staged under that name. Hard link first to avoid copying; fall back to a
 * copy if the staging dir is on a different filesystem.
 */
export async function uploadEntry(entry, { modelsDir, stagingDir, release }) {
  assertReleaseHosted(entry);
  const abs = resolveFixturePath(modelsDir, entry.path);
  const stagedPath = join(stagingDir, entry.sha256);
  try {
    linkSync(abs, stagedPath);
  } catch {
    copyFileSync(abs, stagedPath);
  }
  try {
    await release.upload(stagedPath);
  } finally {
    try {
      unlinkSync(stagedPath);
    } catch (err) {
      // Best-effort: the staging dir is removed as a whole afterwards anyway.
      console.error(`    warning: could not unlink staged ${entry.sha256}: ${err.message}`);
    }
  }
}

/**
 * Upload every release-hosted fixture in `manifest` that the release lacks.
 *
 * `release` is the only side-effecting dependency: `{ tag, exists(),
 * create(), listAssets(), upload(stagedPath) }`. The CLI binds it to `gh`;
 * tests pass a stub.
 */
export async function uploadFixtures(manifest, { modelsDir, release }) {
  const errors = validateManifest(manifest);
  if (typeof manifest?.release_tag !== 'string' || manifest.release_tag.length === 0) {
    errors.push('manifest.release_tag: must be a non-empty string for upload');
  }
  if (errors.length) throw new UploadRefused(errors.map((error) => `manifest: ${error}`).join('\n'));

  const releaseEntries = manifest.files.filter((entry) => upstreamBlobUrl(entry) === null);
  const upstreamCount = manifest.files.length - releaseEntries.length;
  if (upstreamCount) {
    console.error(`Skipping ${upstreamCount} upstream-fetched fixture(s); they stay with their authors.`);
  }
  if (releaseEntries.length === 0) {
    console.error('No release-hosted fixtures to upload; upstream-only fixtures remain with their authors.');
    return { uploaded: 0, skipped: 0, failed: [] };
  }

  console.error(`Verifying local release fixtures against manifest (${releaseEntries.length} files)...`);
  const problems = [];
  for (const entry of releaseEntries) {
    let abs;
    try {
      abs = resolveFixturePath(modelsDir, entry.path);
    } catch (err) {
      problems.push(`${err.message}: ${entry.path}`);
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(`missing: ${entry.path}`);
      continue;
    }
    const size = statSync(abs).size;
    if (size !== entry.size) {
      problems.push(`size ${size} != ${entry.size}: ${entry.path}`);
      continue;
    }
    const got = await sha256OfFile(abs);
    if (got !== entry.sha256) problems.push(`sha256 ${got} != ${entry.sha256}: ${entry.path}`);
  }
  if (problems.length) {
    throw new UploadRefused(
      "Cannot upload — local fixtures don't match manifest:\n" +
        problems.map((line) => `  ${line}`).join('\n') +
        '\n\nFix: place the real bytes for each fixture under tests/models/ and re-run.\n' +
        '     (See tests/models/README.md for the full runbook.)',
    );
  }
  console.error('  all files match.');

  if (await release.exists()) {
    console.error(`Release ${release.tag} exists.`);
  } else {
    console.error(`Creating release ${release.tag}...`);
    await release.create();
  }

  let existing = new Set();
  try {
    existing = new Set(await release.listAssets());
  } catch (err) {
    console.error(`warning: couldn't list assets (${err.message}); will attempt all uploads`);
  }

  const stagingDir = mkdtempSync(join(tmpdir(), 'ifc-lite-fixtures-staging-'));
  let uploaded = 0;
  let skipped = 0;
  const failed = [];
  try {
    for (const entry of releaseEntries) {
      if (existing.has(entry.sha256)) {
        skipped++;
        continue;
      }
      console.error(`  uploading ${entry.path} as ${entry.sha256} (${(entry.size / 1024 / 1024).toFixed(1)} MiB)...`);
      try {
        await uploadEntry(entry, { modelsDir, stagingDir, release });
        uploaded++;
      } catch (err) {
        failed.push({ entry, err });
        console.error(`    FAILED: ${err.message}`);
      }
    }
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort: the tempdir is the OS's to reap. Say where it was left.
      console.error(`  warning: could not remove staging dir ${stagingDir}: ${err.message}`);
    }
  }
  console.error(`done: uploaded=${uploaded} skipped=${skipped} failed=${failed.length}`);
  return { uploaded, skipped, failed };
}

/** The real release client: the `gh` CLI against `repo`. */
function ghRelease(tag, repo) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    tag,
    exists() {
      try {
        gh('release', 'view', tag, '--repo', repo);
        return true;
      } catch {
        return false;
      }
    },
    create() {
      gh(
        'release', 'create', tag,
        '--repo', repo,
        '--title', `Test fixtures (${tag})`,
        '--notes',
        `Test fixtures for ifc-lite. Each asset is named after its sha256.\n\nSee \`tests/models/manifest.json\` for the catalogue and \`scripts/fixtures/fetch-fixtures.mjs\` for the fetcher.`,
        '--latest=false',
        '--prerelease=false',
      );
    },
    listAssets() {
      const json = gh('release', 'view', tag, '--repo', repo, '--json', 'assets');
      return (JSON.parse(json).assets || []).map((asset) => asset.name);
    },
    upload(stagedPath) {
      gh('release', 'upload', tag, stagedPath, '--repo', repo, '--clobber');
    },
  };
}

async function main() {
  const modelsDir = resolve(import.meta.dirname, '../../tests/models');
  const manifestPath = resolve(modelsDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const repo = process.env.IFC_LITE_FIXTURE_REPO || 'LTplus-AG/ifc-lite';
  try {
    const { failed } = await uploadFixtures(manifest, {
      modelsDir,
      release: ghRelease(manifest?.release_tag, repo),
    });
    process.exit(failed.length ? 1 : 0);
  } catch (err) {
    if (!(err instanceof UploadRefused)) throw err;
    console.error(`error: ${manifestPath}: ${err.message}`);
    process.exit(2);
  }
}

if (isMainEntry(import.meta.url)) {
  await main();
}

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pack one staged retained engine (stage-cli-retained-engine.mjs output) as the
// production release artifact (#7955) and write the lock that pins it.
//
//   node scripts/pack-retained-engine.mjs --engine /abs/engine --source-tag vX.Y.Z \
//     --source-commit SHA --out /abs/ifc-lite-retained-engine-vX.Y.Z.tar.gz --lock-out /abs/lock.json
//
// Refuses an engine whose inventory does not verify, that lacks a notice, or whose
// IFC-Lite notices do not name the exact covered-source tag. The archive is
// deterministic for the same engine bytes and tool versions: sorted names, zero
// mtimes, numeric root ownership, normalised modes, gzip without name or time.
// Needs GNU tar. Packaging only: it never builds, uploads or publishes.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { gzipSync, constants as zlib } from 'node:zlib';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { verifyEngine } from './build-retained-preview.mjs';
import { SOURCE_URL_NOTICES, missingNotices, noticeSourceProblems } from './lib/retained-preview.mjs';
import { LOCK_SCHEMA, archiveName, archiveUrl, lockProblems, sha256 } from './lib/retained-engine-artifact.mjs';

/** Every check a published engine must pass; shared with the fetcher. */
export function verifyPublishableEngine(engine, sourceTag) {
  const { manifest, manifestSha256 } = verifyEngine(engine);
  const missing = missingNotices(manifest.assets);
  if (missing.length) throw new Error(`engine lacks notices that must be served with it: ${missing.join(', ')}`);
  for (const path of SOURCE_URL_NOTICES) {
    const problems = noticeSourceProblems(readFileSync(join(engine, path), 'utf8'), sourceTag);
    if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sdk?.revision ?? '')) throw new Error('engine manifest has no SDK revision');
  return { manifest, manifestSha256 };
}

export function deterministicTar(engine) {
  const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--mode=u=rwX,go=rX', '--format=gnu', '--no-acls', '--no-xattrs', '-C', engine, '-cf', '-', '.'],
  { maxBuffer: 1 << 30 });
  if (result.error || result.status !== 0) throw new Error(`tar failed (GNU tar required): ${result.error?.message ?? result.stderr}`);
  return gzipSync(result.stdout, { level: zlib.Z_BEST_COMPRESSION });
}

export function packRetainedEngine({ engine, sourceTag, sourceCommit, out, lockOut }) {
  for (const [name, value] of Object.entries({ engine, out, lockOut })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  if (basename(out) !== archiveName(sourceTag)) throw new Error(`--out must be named ${archiveName(sourceTag)}`);
  for (const path of [out, lockOut]) if (existsSync(path)) throw new Error(`Output already exists: ${path}`);
  const { manifest, manifestSha256 } = verifyPublishableEngine(engine, sourceTag);
  const archive = deterministicTar(engine);
  const lock = {
    schema: LOCK_SCHEMA,
    sourceTag,
    sourceCommit,
    url: archiveUrl(sourceTag),
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    engineManifestSha256: manifestSha256,
    sdkRevision: manifest.sdk.revision,
  };
  const problems = lockProblems(lock);
  if (problems.length) throw new Error(problems.join('; '));
  writeFileSync(out, archive, { flag: 'wx' });
  writeFileSync(lockOut, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  return lock;
}

if (isMainEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const lock = packRetainedEngine({ engine: get('--engine'), sourceTag: get('--source-tag'), sourceCommit: get('--source-commit'),
      out: get('--out'), lockOut: get('--lock-out') });
    console.log(`${archiveName(lock.sourceTag)}: ${lock.archiveBytes} bytes, sha256 ${lock.archiveSha256}, engine ${lock.engineManifestSha256}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The production retained engine artifact (#7955): one staged engine, built by
// .github/workflows/retained-engine.yml from a root release tag, packed as a
// deterministic tar.gz and attached to that tag's GitHub Release. The repository
// pins it in apps/viewer/retained-engine.lock.json; the Vercel build fetches it,
// verifies it against the lock and installs it beside the viewer. Pure helpers;
// the scripts own the I/O.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_SCHEMA = 'ifc-lite.retained-engine-lock/1';
export const LOCK_PATH = 'apps/viewer/retained-engine.lock.json';
export const DEPLOYMENT_SCHEMA = 'ifc-lite.retained-deployment/1';
/** Served beside the engine; the URL smoke reads it as the deployment's identity. */
export const DEPLOYMENT_PATH = 'retained-engine/deployment.json';
/**
 * The viewer's saved Settings choice (GEOMETRY_KERNEL_SETTING_KEY in
 * apps/viewer/src/store/geometryKernel.ts). The production smoke chooses retained
 * through it; if the two drift, its retained-frame step loads exact and fails.
 */
export const GEOMETRY_KERNEL_SETTING_KEY = 'ifc-lite:geometry-kernel-setting';
export const RELEASE_DOWNLOAD = 'https://github.com/LTplus-AG/ifc-lite/releases/download/';
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const HEX = length => new RegExp(`^[a-f0-9]{${length}}$`);

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const archiveName = tag => `ifc-lite-retained-engine-${tag}.tar.gz`;
export const archiveUrl = tag => `${RELEASE_DOWNLOAD}${tag}/${archiveName(tag)}`;

/**
 * The viewer <-> engine contract: the viewer is built from the deploying commit
 * and the engine from a release tag, so they must agree on the retained engine's
 * JavaScript API. `pkg-retained/ifc-lite.d.ts` types it completely (session,
 * run options, every event); CI keeps the committed copy equal to the build.
 */
export const CONTRACT_FILES = [
  { engine: 'pkg-retained/ifc-lite.d.ts', repo: 'packages/wasm/pkg-retained/ifc-lite.d.ts' },
];

/** Problems with a parsed lock (empty = well formed). */
export function lockProblems(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return ['lock is not an object'];
  const problems = [];
  if (lock.schema !== LOCK_SCHEMA) problems.push(`schema ${JSON.stringify(lock.schema)} is not ${LOCK_SCHEMA}`);
  if (!RELEASE_TAG.test(lock.sourceTag ?? '')) problems.push('sourceTag is not a root vX.Y.Z tag');
  if (!HEX(40).test(lock.sourceCommit ?? '')) problems.push('sourceCommit is not a full commit sha');
  if (RELEASE_TAG.test(lock.sourceTag ?? '') && lock.url !== archiveUrl(lock.sourceTag)) {
    problems.push(`url must be the tag's release asset ${archiveUrl(lock.sourceTag)}`);
  }
  for (const key of ['archiveSha256', 'engineManifestSha256']) if (!HEX(64).test(lock[key] ?? '')) problems.push(`${key} is not a sha256`);
  if (!Number.isSafeInteger(lock.archiveBytes) || lock.archiveBytes <= 0) problems.push('archiveBytes is not a positive integer');
  if (!HEX(40).test(lock.sdkRevision ?? '')) problems.push('sdkRevision is not a full commit sha');
  return problems;
}

export function readLock(path) {
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const problems = lockProblems(lock);
  if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
  return lock;
}

/** Where the engine's API differs from the checkout's (empty = compatible). */
export function contractProblems(engineDir, repoRoot) {
  return CONTRACT_FILES.flatMap(({ engine, repo }) => {
    let built, committed;
    try { built = sha256(readFileSync(join(engineDir, engine))); } catch { return [`engine has no ${engine}`]; }
    try { committed = sha256(readFileSync(join(repoRoot, repo))); } catch { return [`checkout has no ${repo}`]; }
    return built === committed ? [] : [`${engine} (${built.slice(0, 12)}) differs from the checkout's ${repo} (${committed.slice(0, 12)})`];
  });
}

/** The identity served at /retained-engine/deployment.json. */
export function deploymentIdentity(lock, builderCommit) {
  return {
    schema: DEPLOYMENT_SCHEMA,
    sourceTag: lock.sourceTag,
    sourceCommit: lock.sourceCommit,
    archiveSha256: lock.archiveSha256,
    engineManifestSha256: lock.engineManifestSha256,
    sdkRevision: lock.sdkRevision,
    builderCommit: builderCommit ?? null,
    note: 'Retained geometry engine for the opt-in Settings choice; the default kernel is exact.',
  };
}

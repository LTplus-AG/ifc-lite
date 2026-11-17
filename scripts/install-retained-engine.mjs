#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Install a verified retained engine (fetch-retained-engine.mjs output) into a
// `VITE_RETAINED_GEOMETRY=lazy` viewer dist (#7955): engine files at the driver
// contract URLs (/smlib/, /retained-engine/), the notices beside them, and
// /retained-engine/deployment.json naming the source tag and hashes.
//
//   node scripts/install-retained-engine.mjs --dist /abs/apps/viewer/dist \
//     --engine /abs/verified-engine --lock /abs/apps/viewer/retained-engine.lock.json
//
// Refuses, before copying anything, a dist whose startup graph carries retained
// code (check-viewer-retained-free.mjs --lazy), a dist that is not a lazy
// retained build, an engine that no longer matches the lock, or a dist that
// already holds engine files.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { checkRetainedLazy } from './check-viewer-retained-free.mjs';
import { verifyPublishableEngine } from './pack-retained-engine.mjs';
import { servedEngineFiles } from './lib/retained-preview.mjs';
import { DEPLOYMENT_PATH, deploymentIdentity, readLock } from './lib/retained-engine-artifact.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function builderCommit() {
  if (/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? '')) return process.env.VERCEL_GIT_COMMIT_SHA;
  const result = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function installRetainedEngine({ dist, engine, lock: lockPath }) {
  for (const [name, value] of Object.entries({ dist, engine, lock: lockPath })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  const lock = readLock(lockPath);
  for (const prefix of ['smlib', 'retained-engine']) {
    if (existsSync(join(dist, prefix))) throw new Error(`${dist}/${prefix} already exists; install into a fresh viewer build`);
  }
  const graph = await checkRetainedLazy(dist);
  const { manifest, manifestSha256 } = verifyPublishableEngine(engine, lock.sourceTag);
  if (manifestSha256 !== lock.engineManifestSha256) throw new Error(`engine manifest ${manifestSha256} != lock ${lock.engineManifestSha256}`);
  const served = servedEngineFiles(manifest.assets);
  for (const { source, url } of served) {
    const target = join(dist, url.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(engine, source), target, { errorOnExist: true, force: false });
  }
  const identity = deploymentIdentity(lock, builderCommit());
  writeFileSync(join(dist, DEPLOYMENT_PATH), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
  return { identity, servedFiles: served.length, startupChunks: graph.eager.length, lazyRetainedChunks: graph.lazy.length };
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const result = await installRetainedEngine({ dist: get('--dist'), engine: get('--engine'), lock: get('--lock') });
    console.log(`Retained engine ${result.identity.sourceTag} installed: ${result.servedFiles} files; `
      + `${result.startupChunks} startup chunks retained-free, retained code in ${result.lazyRetainedChunks} lazy chunk(s)`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

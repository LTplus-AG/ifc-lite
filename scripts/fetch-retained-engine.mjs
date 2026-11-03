#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fetch the pinned production retained engine and verify it (#7955). Run by
// scripts/vercel-build.sh when apps/viewer/retained-engine.lock.json exists.
//
//   node scripts/fetch-retained-engine.mjs --lock /abs/lock.json --out /abs/new-dir \
//     [--archive /abs/local.tar.gz] [--repo /abs/checkout]
//
// Verifies, in order: the lock's shape and URL; the archive's byte count and
// SHA-256 against the lock; that it unpacks to regular files only; the engine
// inventory (every file listed with its hash, nothing else); the manifest's
// SHA-256 and SDK revision against the lock; every required notice, with the
// IFC-Lite notices naming the lock's exact source tag. Then the API contract
// against the checkout (lib/retained-engine-artifact.mjs).
//
// Exit 0: verified engine in --out. Exit 3: verified, but its API differs from
// this checkout; nothing is written and the caller builds exact-only. Exit 1:
// anything else, including a hash mismatch; never ignore it.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { verifyPublishableEngine } from './pack-retained-engine.mjs';
import { contractProblems, readLock, sha256 } from './lib/retained-engine-artifact.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_MISMATCH = 3;

export class ContractMismatch extends Error {}

async function download(url, timeoutMs = 300_000) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function assertRegularTree(root, prefix = '') {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name), stat = lstatSync(join(root, path));
    if (stat.isDirectory()) assertRegularTree(root, path);
    else if (!stat.isFile()) throw new Error(`archive holds a non-regular entry: ${path}`);
  }
}

export async function fetchRetainedEngine({ lock: lockPath, out, archive, repo = REPO, get = download }) {
  for (const [name, value] of Object.entries({ lock: lockPath, out })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
  const lock = readLock(lockPath);
  const bytes = archive ? readFileSync(archive) : await get(lock.url);
  if (bytes.length !== lock.archiveBytes || sha256(bytes) !== lock.archiveSha256) {
    throw new Error(`archive ${archive ?? lock.url} does not match the lock (${bytes.length} bytes, sha256 ${sha256(bytes)})`);
  }
  const scratch = mkdtempSync(join(dirname(out), '.retained-engine-'));
  try {
    const file = join(scratch, 'engine.tar.gz'), engine = join(scratch, 'engine');
    writeFileSync(file, bytes);
    mkdirSync(engine);
    const untar = spawnSync('tar', ['-xzf', file, '-C', engine, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
    if (untar.error || untar.status !== 0) throw new Error(`tar -x failed: ${untar.error?.message ?? untar.stderr}`);
    assertRegularTree(engine);
    const { manifest, manifestSha256 } = verifyPublishableEngine(engine, lock.sourceTag);
    if (manifestSha256 !== lock.engineManifestSha256) throw new Error(`engine manifest ${manifestSha256} != lock ${lock.engineManifestSha256}`);
    if (manifest.sdk.revision !== lock.sdkRevision) throw new Error(`engine SDK ${manifest.sdk.revision} != lock ${lock.sdkRevision}`);
    const mismatch = contractProblems(engine, repo);
    if (mismatch.length) throw new ContractMismatch(mismatch.join('; '));
    renameSync(engine, out);
    return { lock, engine: out, manifestSha256 };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const { lock, engine } = await fetchRetainedEngine({ lock: get('--lock'), out: get('--out'),
      archive: get('--archive') && resolve(get('--archive')), repo: get('--repo') && resolve(get('--repo')) });
    console.log(`Retained engine ${lock.sourceTag} verified (archive ${lock.archiveSha256}) in ${engine}`);
  } catch (error) {
    console.error(error instanceof ContractMismatch
      ? `Retained engine API differs from this checkout: ${error.message}. Re-pin apps/viewer/retained-engine.lock.json to a release built from compatible source.`
      : error.message);
    process.exitCode = error instanceof ContractMismatch ? CONTRACT_MISMATCH : 1;
  }
}

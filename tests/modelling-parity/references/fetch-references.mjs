#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fetch the external reference models listed in manifest.json (lane L5, #9296).
//
// Usage:
//   node tests/modelling-parity/references/fetch-references.mjs            # fetch all
//   node tests/modelling-parity/references/fetch-references.mjs --check    # verify only, no network
//   node tests/modelling-parity/references/fetch-references.mjs --list     # print the table
//   node tests/modelling-parity/references/fetch-references.mjs <id> ...   # fetch some
//
// Behaviour:
//   - URL entries download into tests/modelling-parity/references/.cache/<id>/<file>
//     (git-ignored through the repo-wide `**/.cache/` rule). The download goes to a
//     `.part` file and is renamed only after size and SHA-256 both match, so a
//     truncated or tampered download is never left in the cache.
//   - `fixture` entries (bytes that tests/models/manifest.json already catalogues)
//     are verified in place and, when missing, fetched through the repo's own
//     `scripts/fixtures/fetch-fixtures.mjs`. Nothing is duplicated.
//   - Nothing downloaded is ever executed; files are only hashed and later parsed as data.
//   - Idempotent. Exit 1 on any mismatch or failure.
//   - No third-party dependencies.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { MANIFEST_PATH, ROOT, resolveReferencePath } from './lib.mjs';

const RETRIES = 4;
const TIMEOUT_MS = 90_000;

export async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/** 'ok' | 'missing' | 'mismatch' for the bytes currently on disk. */
export async function verify(entry) {
  return verifyPath(resolveReferencePath(entry), entry);
}

export async function verifyPath(path, entry) {
  if (!existsSync(path)) return { state: 'missing', path };
  const size = statSync(path).size;
  if (size !== entry.bytes) return { state: 'mismatch', path, detail: `size ${size} != ${entry.bytes}` };
  const sha = await sha256File(path);
  if (sha !== entry.sha256) return { state: 'mismatch', path, detail: `sha256 ${sha} != ${entry.sha256}` };
  return { state: 'ok', path };
}

async function download(entry) {
  const url = entry.source?.url;
  if (!url) throw new Error(`${entry.id}: no downloadable source URL (see manifest source.officialDownloadStatus)`);
  if (!url.startsWith('https://')) throw new Error(`${entry.id}: refusing non-https URL ${url}`);
  const path = resolveReferencePath(entry);
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { 'user-agent': 'ifc-lite-parity-fixtures' } });
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!retryable) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true });
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const hash = createHash('sha256');
      let bytes = 0;
      const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
      await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(part));
      const sha = hash.digest('hex');
      if (bytes !== entry.bytes || sha !== entry.sha256) {
        unlinkSync(part);
        throw Object.assign(new Error(`${entry.id}: downloaded ${bytes} bytes sha256 ${sha}; manifest expects ${entry.bytes} bytes sha256 ${entry.sha256}`), { fatal: true });
      }
      renameSync(part, path);
      return;
    } catch (err) {
      lastError = err;
      if (existsSync(part)) unlinkSync(part);
      if (err.fatal || attempt === RETRIES) break;
      await sleep(Math.min(500 * 2 ** attempt, 8000));
    }
  }
  throw lastError;
}

function fetchFixture(entry) {
  execFileSync(process.execPath, [`${ROOT}/scripts/fixtures/fetch-fixtures.mjs`, entry.fixture.path], { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const list = args.includes('--list');
  const ids = args.filter((a) => !a.startsWith('--'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const unknown = ids.filter((id) => !manifest.references.some((r) => r.id === id));
  if (unknown.length) { console.error(`unknown reference id(s): ${unknown.join(', ')}`); process.exit(2); }
  const entries = manifest.references.filter((r) => ids.length === 0 || ids.includes(r.id));

  let failed = 0;
  for (const entry of entries) {
    let v = await verify(entry);
    if (list) {
      console.log(`${entry.id.padEnd(48)} ${v.state.padEnd(8)} ${String(entry.bytes).padStart(9)}  licence=${entry.licence.status}  redistributable=${entry.licence.redistributable}`);
      continue;
    }
    if (v.state === 'ok') { console.log(`ok       ${entry.id}`); continue; }
    if (check) { console.error(`${v.state.toUpperCase().padEnd(8)} ${entry.id}${v.detail ? ` (${v.detail})` : ''}`); failed++; continue; }
    try {
      if (entry.fixture) fetchFixture(entry); else await download(entry);
      v = await verify(entry);
      if (v.state !== 'ok') throw new Error(`${entry.id}: ${v.state} after fetch${v.detail ? ` (${v.detail})` : ''}`);
      console.log(`fetched  ${entry.id}`);
    } catch (err) {
      console.error(`FAILED   ${entry.id}: ${err.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

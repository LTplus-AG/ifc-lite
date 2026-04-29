#!/usr/bin/env node
// Fetch test fixtures listed in tests/models/manifest.json.
//
// Usage:
//   node scripts/fixtures/fetch-fixtures.mjs            # fetch all
//   node scripts/fixtures/fetch-fixtures.mjs --check    # verify only, no download
//   node scripts/fixtures/fetch-fixtures.mjs --list     # print missing/changed paths
//   node scripts/fixtures/fetch-fixtures.mjs path/to/a.ifc path/to/b.ifc
//
// Behaviour:
//   - For each manifest entry, hash the on-disk file and compare to the
//     manifest's sha256. If the hash matches, do nothing.
//   - Otherwise, download <base_url>/<sha256> and verify the hash.
//   - Idempotent: safe to re-run; skips work it already did.
//   - Override the base URL with IFC_LITE_FIXTURE_BASE_URL=... (e.g. for a
//     mirror or a local cache server).
//   - Concurrency is bounded (default 6, override with FIXTURE_CONCURRENCY).
//   - No third-party dependencies.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS_DIR = resolve(ROOT, 'tests/models');
const MANIFEST_PATH = resolve(MODELS_DIR, 'manifest.json');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const LIST_ONLY = args.includes('--list');
const ONLY = args.filter((a) => !a.startsWith('--'));
const CONCURRENCY = Math.max(1, parseInt(process.env.FIXTURE_CONCURRENCY || '6', 10));
const RETRIES = 4;

if (!existsSync(MANIFEST_PATH)) {
  console.error(`error: ${MANIFEST_PATH} not found`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
if (manifest.version !== 1) {
  console.error(`error: unsupported manifest.version ${manifest.version}`);
  process.exit(2);
}

const baseUrl = (process.env.IFC_LITE_FIXTURE_BASE_URL || manifest.base_url).replace(/\/+$/, '');

let entries = manifest.files;
if (ONLY.length) {
  const wanted = new Set(ONLY.map((p) => p.replace(/^tests\/models\//, '')));
  entries = entries.filter((f) => wanted.has(f.path));
  if (!entries.length) {
    console.error(`error: none of the requested paths are in the manifest`);
    process.exit(2);
  }
}

async function sha256OfFile(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

function classify(entry) {
  const abs = resolve(MODELS_DIR, entry.path);
  if (!existsSync(abs)) return { state: 'missing', abs };
  const st = statSync(abs);
  // LFS pointer files are always small; skip the hash if size mismatches.
  if (st.size !== entry.size) return { state: 'mismatch', abs };
  return { state: 'unchecked', abs };
}

async function fetchOne(entry) {
  const { abs, state } = classify(entry);
  if (state === 'unchecked') {
    const got = await sha256OfFile(abs);
    if (got === entry.sha256) {
      return { entry, action: 'skip' };
    }
  }

  if (CHECK_ONLY || LIST_ONLY) {
    return { entry, action: 'needed' };
  }

  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + '.part';

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/${entry.sha256}`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('empty response body');
      await pipeline(res.body, createWriteStream(tmp));
      const got = await sha256OfFile(tmp);
      if (got !== entry.sha256) {
        unlinkSync(tmp);
        throw new Error(`hash mismatch: expected ${entry.sha256}, got ${got}`);
      }
      renameSync(tmp, abs);
      return { entry, action: 'fetched' };
    } catch (err) {
      lastErr = err;
      try { unlinkSync(tmp); } catch {}
      if (attempt < RETRIES) {
        const wait = 500 * 2 ** (attempt - 1);
        await sleep(wait);
      }
    }
  }
  return { entry, action: 'error', error: lastErr };
}

async function runWithConcurrency(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const start = Date.now();
const results = await runWithConcurrency(entries, CONCURRENCY, fetchOne);

let fetched = 0;
let skipped = 0;
let needed = 0;
const errors = [];
for (const r of results) {
  if (r.action === 'fetched') fetched++;
  else if (r.action === 'skip') skipped++;
  else if (r.action === 'needed') needed++;
  else if (r.action === 'error') errors.push(r);
}

if (LIST_ONLY) {
  for (const r of results) {
    if (r.action === 'needed') console.log(r.entry.path);
  }
  process.exit(needed === 0 ? 0 : 1);
}

if (CHECK_ONLY) {
  if (needed) {
    console.error(`fixtures missing or out of date: ${needed} of ${entries.length}`);
    console.error('run: pnpm fixtures');
    process.exit(1);
  }
  console.error(`all ${entries.length} fixtures present and verified`);
  process.exit(0);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.error(
  `fixtures: fetched=${fetched} skipped=${skipped} errors=${errors.length} in ${elapsed}s`,
);
if (errors.length) {
  for (const e of errors) {
    console.error(`  ${e.entry.path}: ${e.error?.message || e.error}`);
  }
  process.exit(1);
}

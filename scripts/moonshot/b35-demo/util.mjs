/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared plumbing for the B3.5 integrated compounding demo.
 *
 * Everything substantive is imported from the proven moonshot pieces
 * (tools/world-gym, packages/provenance dist, scripts/moonshot/diff-spike);
 * this module only carries paths, output helpers and hashing.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');

/** Large artifacts (IFC files, certificate bundles) go OUTSIDE the repo.
 *  Override with B35_OUT_DIR (the orchestrated runs point this at the
 *  session scratchpad). */
export const OUT_DIR = process.env.B35_OUT_DIR ?? path.join(tmpdir(), 'ifc-lite-b35-demo');
mkdirSync(OUT_DIR, { recursive: true });

/** Demo-wide master seed. Every act derives its seeds from this one value. */
export const MASTER_SEED = Number(process.env.B35_SEED ?? 20260724);
if (!Number.isInteger(MASTER_SEED) || MASTER_SEED < 0) {
  throw new Error(`B35_SEED must be a non-negative integer, got ${JSON.stringify(process.env.B35_SEED)}`);
}

/** Narrative output. NOTE: world-gym's initChecks() permanently reroutes
 *  console.log to stderr (wasm print-binding hygiene), so the demo narrative
 *  must write to stdout directly, never via console.log. */
export function say(line = '') {
  process.stdout.write(`${line}\n`);
}

export function banner(actNo, title, tagline) {
  say('');
  say('='.repeat(74));
  say(`  ACT ${actNo} -- ${title}`);
  say(`  ${tagline}`);
  say('='.repeat(74));
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function short(hash, n = 16) {
  return typeof hash === 'string' ? hash.slice(0, n) : String(hash);
}

export function round(v, decimals = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function pct(x, decimals = 2) {
  return `${(x * 100).toFixed(decimals)}%`;
}

/** Time an async act body; returns { result, ms }. */
export async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - t0) };
}

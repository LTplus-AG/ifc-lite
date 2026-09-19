/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Building one corpus pair, with the mapped-donor regeneration loop (#4995)
 * and the merged-role base-text fingerprinting (#4989) composed: the
 * regeneration must re-fingerprint whatever base text THIS attempt's
 * `merged` role produced, never the pristine file it may have diverged
 * from. Split out of `run.mjs` for the module-size house rule (AGENTS.md).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintFile } from './fingerprints.mjs';
import { mutateModel } from './mutate.mjs';
import { donorPairKey, incomparableSwaps } from './successor-mutations.mjs';
import { runGuards } from './guards.mjs';
import { sameContentGroups } from './run-matcher.mjs';

/**
 * Build one pair and everything the guards need to judge it.
 *
 * @param entry              one `CORPUS` entry (`{ model, seed, plan }`)
 * @param api                the shared `IfcAPI`
 * @param opts               `{ root, outDir, maxAttempts, fail }` — `fail`
 *                           is `run.mjs`'s own (exits the process), threaded
 *                           through rather than duplicated here.
 */
export async function buildPair(entry, api, { root, outDir, maxAttempts, fail }) {
  const modelPath = join(root, entry.model);
  if (!existsSync(modelPath)) {
    fail(`fixture missing: ${entry.model} — run \`pnpm fixtures\` first`);
  }
  const sourceText = readFileSync(modelPath, 'utf-8');
  // Preliminary only: population / meshedIds / same-content groups for role
  // ASSIGNMENT. The `merged` role (#4989) needs the actual BASE fingerprints
  // to come from a possibly-mutated base text (see below) — this pass is not
  // published as the pair's `base`.
  const prelim = await fingerprintFile(modelPath, api);

  mkdirSync(outDir, { recursive: true });
  const headPath = join(outDir, `${entry.seed}-${entry.model.replaceAll('/', '_')}`);
  const geometryAabbs = new Map(
    prelim.fingerprints
      .filter((fingerprint) => fingerprint.aabb)
      .map((fingerprint) => [fingerprint.ref, fingerprint.aabb]),
  );
  const excludedDonors = new Set();
  // Base occurrence bounds are a cheap fail-closed prefilter (#4995). The
  // generated head is still authoritative: mapping targets and placements
  // can make the same map a different size at its recipient. Reject such a
  // pair and replay the seeded mutation without it; every retry excludes at
  // least one finite product/map pair, and the cap turns unexpected corpus
  // drift into a loud fixture failure rather than a false-positive answer
  // key. The regeneration re-fingerprints the MUTATED base text too (#4989):
  // `merged` can produce one, and `incomparableSwaps` must compare against
  // what was actually scored, not the pristine file it may have diverged from.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: headText, baseText, key } = mutateModel(sourceText, {
      seed: entry.seed,
      meshedIds: prelim.meshedIds,
      population: prelim.fingerprints.map((fingerprint) => fingerprint.ref),
      geometryAabbs,
      excludedDonors,
      sameContentGroups: sameContentGroups(prelim),
      unitScale: prelim.unitScale,
      sourcePath: entry.model,
      plan: entry.plan,
    });
    writeFileSync(headPath, headText);
    const head = await fingerprintFile(headPath, api);

    // `merged` (#4989) is the ONLY thing that ever touches base: for every
    // other model (and every model with no `merged` role) `baseText` is
    // `sourceText` verbatim, and `prelim` already IS the correct base — no
    // second wasm pass. Only when it differs do we re-fingerprint the
    // mutated base text, which is the actual pair being compared and scored.
    let base = prelim;
    let basePath;
    if (baseText !== sourceText) {
      basePath = join(outDir, `${entry.seed}-base-${entry.model.replaceAll('/', '_')}`);
      writeFileSync(basePath, baseText);
      base = await fingerprintFile(basePath, api);
    }

    const invalid = incomparableSwaps(key, base.fingerprints, head.fingerprints);
    if (invalid.length === 0) {
      const guards = runGuards(baseText, headText, base, head, key);
      return { key, base, head, guards, headPath, basePath };
    }
    let added = 0;
    for (const swap of invalid) {
      if (!Number.isInteger(swap.donorMap)) continue;
      const size = excludedDonors.size;
      excludedDonors.add(donorPairKey(swap.base, swap.donorMap));
      if (excludedDonors.size > size) added++;
    }
    if (added === 0) fail(`swapped geometry has unusable bounds in ${entry.model}`);
    process.stdout.write(`  retrying ${entry.model}: rejected ${added} incomparable mapped donor(s)\n`);
  }
  fail(`no comparable mapped donors remained in ${entry.model} after ${maxAttempts} attempts`);
}

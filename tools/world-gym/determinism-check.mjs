#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Determinism proof for the World Gym generator.
 *
 * For each of N seeds, generates the model twice — with a real wall-clock
 * delay between the two generations, so a naive implementation that leaks
 * Date.now()/crypto.randomUUID() would be caught — and asserts the two IFC
 * files are byte-identical (compared by SHA-256, not just length).
 *
 * Usage: node determinism-check.mjs [--seeds 20] [--delay-ms 50]
 */

import { createHash } from 'node:crypto';
import { generateModel } from './generator.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const seedCount = Number(getFlag(args, '--seeds') ?? 20);
  const delayMs = Number(getFlag(args, '--delay-ms') ?? 50);

  const results = [];
  for (let seed = 0; seed < seedCount; seed++) {
    const first = generateModel(seed, 'auto');
    const hashA = sha256(first.content);
    // Real wall-clock gap between the two generations of the same seed —
    // this is what actually exercises the Date-freeze half of the shim.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delayMs));
    const second = generateModel(seed, 'auto');
    const hashB = sha256(second.content);

    const identical = hashA === hashB && first.content === second.content;
    results.push({
      seed,
      family: first.family,
      identical,
      byteLength: first.content.length,
      hashA,
      hashB,
    });
  }

  const failures = results.filter((r) => !r.identical);
  const summary = {
    seedsChecked: seedCount,
    delayMsBetweenRuns: delayMs,
    allIdentical: failures.length === 0,
    failureCount: failures.length,
    failures,
    perSeed: results.map(({ seed, family, identical, byteLength }) => ({ seed, family, identical, byteLength })),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures.length > 0) {
    process.stderr.write(`DETERMINISM CHECK FAILED: ${failures.length}/${seedCount} seeds produced non-identical output across two runs.\n`);
    process.exit(1);
  } else {
    process.stderr.write(`DETERMINISM CHECK PASSED: ${seedCount}/${seedCount} seeds byte-identical across two runs (${delayMs}ms apart).\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

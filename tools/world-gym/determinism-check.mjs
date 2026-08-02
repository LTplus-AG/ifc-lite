#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Determinism proof for the World Gym generator.
 *
 * For each of N seeds, generates the model twice - with a real wall-clock
 * delay between the two generations, so a naive implementation that leaks
 * Date.now()/crypto.randomUUID() would be caught - and asserts the two IFC
 * files are byte-identical (compared by SHA-256, not just length).
 *
 * It also asserts the B4.3 salt invariants over the same seeds: a salt changes
 * the bytes, a salted generation is still deterministic, two salts disagree,
 * and no non-reporting split can be salted whatever the environment says.
 *
 * Usage: node determinism-check.mjs [--seeds 20] [--delay-ms 50]
 */

import { createHash } from 'node:crypto';
import { generateModel } from './generator.mjs';
import { numberFlag } from './lib/flags.mjs';
import { saltForSplit, SALT_ENV_VAR, REPORTING_SPLIT } from './benchmark/splits.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const seedCount = numberFlag(args, '--seeds', { def: 20, min: 1, integer: true });
  const delayMs = numberFlag(args, '--delay-ms', { def: 50, min: 0 });

  const results = [];
  for (let seed = 0; seed < seedCount; seed++) {
    const first = generateModel(seed, 'auto');
    const hashA = sha256(first.content);
    // Real wall-clock gap between the two generations of the same seed -
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

  // Salt invariants (B4.3). Determinism is the property the salt must not
  // break, so this is the cheapest place to keep it honest, and it costs one
  // extra generation per checked seed rather than a CI step of its own.
  const saltFailures = [];
  const SALT_ONE = 'determinism-check-salt-one-0123456789abcdef';
  const SALT_TWO = 'determinism-check-salt-two-fedcba9876543210';
  for (const { seed } of results) {
    const plain = generateModel(seed, 'auto').content;
    const saltedA = generateModel(seed, 'auto', { salt: SALT_ONE }).content;
    const saltedB = generateModel(seed, 'auto', { salt: SALT_ONE }).content;
    const otherSalt = generateModel(seed, 'auto', { salt: SALT_TWO }).content;
    // A salt that left the bytes alone would be decorative; a salt that made
    // them nondeterministic would break scoring; two salts that agreed would
    // make rotation meaningless.
    if (saltedA === plain) saltFailures.push({ seed, why: 'salted output equals unsalted output' });
    if (saltedA !== saltedB) saltFailures.push({ seed, why: 'salted output is not deterministic' });
    if (saltedA === otherSalt) saltFailures.push({ seed, why: 'two different salts produced the same output' });
  }
  // Dev must be unsaltable, in code, whatever the environment says.
  if (saltForSplit('dev', { [SALT_ENV_VAR]: SALT_ONE }) !== '') {
    saltFailures.push({ seed: null, why: 'saltForSplit salted a non-reporting split' });
  }
  if (saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: SALT_ONE }) !== SALT_ONE) {
    saltFailures.push({ seed: null, why: 'saltForSplit did not apply the configured salt to the reporting split' });
  }

  const summary = {
    seedsChecked: seedCount,
    delayMsBetweenRuns: delayMs,
    allIdentical: failures.length === 0,
    failureCount: failures.length,
    failures,
    saltInvariantsHeld: saltFailures.length === 0,
    saltInvariantFailures: saltFailures,
    perSeed: results.map(({ seed, family, identical, byteLength }) => ({ seed, family, identical, byteLength })),
  };

  if (saltFailures.length > 0) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.stderr.write(`SALT INVARIANTS FAILED: ${saltFailures.map((f) => f.why).join('; ')}\n`);
    process.exit(1);
  }

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

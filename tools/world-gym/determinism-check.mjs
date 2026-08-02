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
 * And it asserts the salt HANDLING invariants, which are security properties
 * rather than determinism ones and are otherwise only claimed in prose: a salt
 * is never accepted from argv, a weak or misformatted salt is refused at every
 * boundary, and no refusal message contains the material it refused.
 *
 * Usage: node determinism-check.mjs [--seeds 20] [--delay-ms 50]
 */

import { createHash, randomBytes } from 'node:crypto';
import { generateModel } from './generator.mjs';
import { numberFlag } from './lib/flags.mjs';
import { saltForSplit, SALT_ENV_VAR, REPORTING_SPLIT } from './benchmark/splits.mjs';
import { normalizeSalt, resolveSaltFromArgs, saltFingerprint, describeSalt } from './lib/salt.mjs';

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
  // Deployment-format salts (64 lowercase hex), because these are also fed to
  // `saltForSplit`, which is the boundary that enforces that format.
  const SALT_ONE = '5d2f8c1a04b7e693f8c25a1d70b4e836c9f10d5a2e6b83c47f09a1d6b2e85c34';
  const SALT_TWO = 'e3b70c1a95d84f26b0c7e51a3d98f402c6b17e5a0d43f89b2c60e7a19d5f3b84';
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

  // ---------------------------------------------------------------------------
  // HANDLING invariants. These are the security half: a salt that is correct
  // but reachable is not a secret. Each one is a thing the code claims in a
  // comment, checked here so the claim cannot quietly stop being true.
  // ---------------------------------------------------------------------------
  const refuses = (why, fn) => {
    try {
      fn();
      saltFailures.push({ seed: null, why: `${why} was ACCEPTED (it must be refused)` });
      return null;
    } catch (err) {
      if (err?.name !== 'SaltFormatError') {
        saltFailures.push({ seed: null, why: `${why} threw ${err?.name ?? 'a non-Error'}, expected SaltFormatError` });
      }
      return err;
    }
  };

  // 1. A salt is never taken from argv, and the refusal is loud (an error, not
  //    a silently-unsalted run, which would be the worst outcome of the three).
  const argvErr = refuses('--salt <value> in argv', () => resolveSaltFromArgs(['--salt', SALT_ONE]));
  // 2. No refusal repeats the material back into the log line it is refusing.
  if (argvErr && String(argvErr.message).includes(SALT_ONE)) {
    saltFailures.push({ seed: null, why: 'the --salt refusal message contains the salt it refused' });
  }
  // 3. A human-chosen salt is refused everywhere: at the generic boundary...
  const weakErr = refuses('a human-chosen salt ("benchmark-secret")', () => normalizeSalt('benchmark-secret'));
  if (weakErr && String(weakErr.message).includes('benchmark-secret')) {
    saltFailures.push({ seed: null, why: 'the weak-salt refusal message contains the salt it refused' });
  }
  //    ...and at the deployment boundary, which additionally refuses anything
  //    that is not the documented 64-hex format (this is what stops a PUBLISHED
  //    exam salt from becoming a production universe).
  refuses('a human-chosen salt in the environment', () => saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: 'benchmark-secret' }));
  refuses('a published exam salt in the environment', () => saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: 'b43-exam-salt-A-4f7c0b1e9d2a48c65e81b0f4a7c93d26' }));
  refuses('a zero-entropy 64-char salt', () => saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: '0'.repeat(64) }));
  // 4. The env-var form works and yields the same salt (the safe path must not
  //    be broken by the unsafe one being closed).
  if (resolveSaltFromArgs(['--salt-env', 'WG_CHECK_SALT'], { WG_CHECK_SALT: SALT_ONE }) !== SALT_ONE) {
    saltFailures.push({ seed: null, why: '--salt-env did not resolve the salt from the environment' });
  }
  // 5. A freshly minted salt (the documented command's output) is accepted by
  //    every boundary. A validator that rejects the value the docs tell you to
  //    generate is a check that cannot pass, which is as bad as one that cannot
  //    fail.
  const minted = randomBytes(32).toString('hex');
  try {
    if (saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: minted }) !== minted) {
      saltFailures.push({ seed: null, why: 'a freshly minted 32-byte hex salt was not applied' });
    }
  } catch (err) {
    saltFailures.push({ seed: null, why: `a freshly minted 32-byte hex salt was REFUSED: ${err.message}` });
  }
  // 6. The publishable identity is a fingerprint, not the salt.
  const fp = saltFingerprint(SALT_ONE);
  if (fp === null || fp.includes(SALT_ONE) || describeSalt(SALT_ONE).includes(SALT_ONE)) {
    saltFailures.push({ seed: null, why: 'the salt fingerprint / log label leaks the salt' });
  }
  // 7. An Rng carries its salt privately: no enumerable property, nothing a
  //    JSON dump of an object graph holding one could pick up.
  const saltedModel = generateModel(0, 'auto', { salt: SALT_ONE });
  if (JSON.stringify(saltedModel).includes(SALT_ONE)) {
    saltFailures.push({ seed: null, why: 'a serialized salted model contains the salt' });
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 32-bit stream-recovery probe, split out of run.mjs (AGENTS.md: no module
 * over ~400 non-generated lines).
 *
 * This measures the design that is NOT shipped: if the salted path had merely
 * concatenated the salt into the existing 32-bit hashed key, an attacker could
 * sweep the whole stream space per seed and confirm candidates against the
 * bytes they were served. The cost of that sweep is what makes the keyed
 * HMAC construction necessary rather than decorative.
 */

import { Rng, mulberry32, hashSeed } from '../../../../tools/world-gym/lib/rng.mjs';
import { generateModel, FAMILIES } from '../../../../tools/world-gym/generator.mjs';
import { CORRUPT_RATE, FAMILY } from '../../../../tools/world-gym/benchmark/splits.mjs';
import { round } from './stats.mjs';


/**
 * BRUTE-FORCE PROBE: what a salt bolted onto the EXISTING 32-bit stream would
 * have been worth.
 *
 * The unsalted engine is mulberry32 over an FNV-1a hash: 32 bits of state,
 * whatever you concatenate into the key. A salted-by-concatenation stream is
 * therefore one of 2^32 streams, and the served bytes are a free verification
 * oracle - the parameter draws become dimensions in the file. This measures how
 * fast an attacker can test candidates against that oracle, so the cost of the
 * full sweep is a number rather than an assertion. The shipped salted path is
 * keyed into a 128-bit sfc32 state precisely so this sweep does not exist.
 *
 * Honesty about what is measured: the sweep is not run to completion (that is
 * the point - it is measured, then extrapolated). A window that CONTAINS the
 * true key is swept, so the oracle is shown to actually identify it, and the
 * throughput over that window drives the extrapolation.
 */
export function bruteForce32Probe(seed) {
  // A real unsalted model of this seed: the attacker's target.
  const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });
  const streamKey = `${seed}:params:${model.family}`;
  const trueKey = hashSeed(streamKey);
  const targetParams = JSON.stringify(model.params);
  const paramSpace = FAMILIES[model.family].paramSpace;

  // One candidate test: seed mulberry32 with the candidate state, redraw the
  // parameter set, compare. Exactly what an attacker holding the bytes does.
  const probe = new Rng(0);
  const test = (candidate) => {
    probe._next = mulberry32(candidate);
    probe.draws = 0;
    try {
      return JSON.stringify(paramSpace(probe)) === targetParams;
    } catch {
      return false;
    }
  };

  const SAMPLE = 2_000_000;
  const start = (trueKey - Math.floor(SAMPLE / 2)) >>> 0;
  let hits = 0;
  let foundTrueKey = false;
  const t0 = performance.now();
  for (let i = 0; i < SAMPLE; i++) {
    const candidate = (start + i) >>> 0;
    if (test(candidate)) {
      hits++;
      if (candidate === trueKey) foundTrueKey = true;
    }
  }
  const elapsedS = (performance.now() - t0) / 1000;
  const candidatesPerSecond = SAMPLE / elapsedS;
  const fullSweepSeconds = 2 ** 32 / candidatesPerSecond;
  return {
    note: 'Cost of defeating a salt CONCATENATED into the existing 32-bit stream. Not the shipped design - the shipped salted stream is a 128-bit keyed sfc32, where this sweep is 2^96 times larger.',
    seed,
    family: model.family,
    streamKey,
    sampledCandidates: SAMPLE,
    oracleIdentifiedTrueKey: foundTrueKey,
    candidatesMatchingOracleInSample: hits,
    candidatesPerSecond: Math.round(candidatesPerSecond),
    fullSweepSecondsPerSeed: round(fullSweepSeconds, 1),
    fullSweepCoreHoursPerSeed: round(fullSweepSeconds / 3600, 3),
    fullSweepCoreHoursForSplit: round((fullSweepSeconds * 1000) / 3600, 1),
    unsaltedPathStateBits: 32,
    saltedPathStateBits: 128,
  };
}

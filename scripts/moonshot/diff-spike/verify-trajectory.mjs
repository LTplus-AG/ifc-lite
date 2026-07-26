/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: the independent verifier (CLI entry).
 *
 * Input: a trajectory certificate chain and nothing else - the start
 * parameters live IN the chain header. The verifier never trusts a number
 * the optimizer wrote; it re-derives every state, hash, objective value
 * and acceptance decision from the start parameters alone. The checks
 * themselves live in focused modules:
 *
 *   verify-common.mjs      failure shape, header/kernel-identity pins
 *   verify-v1.mjs          format v1: one certificate per accepted step
 *   verify-v2.mjs          format v2: checkpointed segments (skeleton pass)
 *   verify-v2-segment.mjs  format v2: sampling, certificate shape, replay
 *   verify-endpoint.mjs    endpoint grounding shared by both formats
 *
 * This file only dispatches on the chain's version tag and maps CLI flags
 * onto those entry points, and re-exports them so importers (tamper-test)
 * have one place to reach for verification.
 *
 * Usage:
 *   node scripts/moonshot/diff-spike/verify-trajectory.mjs CHAIN.json \
 *     [--skip-kernel] [--recheck-cli] \
 *     [--mode full|spot] [--spot-k K] [--seed S] [--sidecar PATH]   (v2 only)
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { CHAIN_VERSION } from './trajectory.mjs';
import { CHAIN_VERSION_V2 } from './chain-v2.mjs';
import { verifyChain } from './verify-v1.mjs';
import { verifyChainV2 } from './verify-v2.mjs';
import { sampleSegments } from './verify-v2-segment.mjs';

export { verifyChain, verifyChainV2, sampleSegments };

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const VALUE_FLAGS = new Set(['--mode', '--spot-k', '--seed', '--sidecar']);

async function main() {
  const argv = process.argv.slice(2);
  let chainPath;
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { i += 1; continue; }
    if (!argv[i].startsWith('-')) { chainPath = argv[i]; break; }
  }
  if (!chainPath) {
    console.error('usage: node verify-trajectory.mjs CHAIN.json [--skip-kernel] [--recheck-cli]');
    console.error('  v2 chains additionally: [--mode full|spot] [--spot-k K] [--seed S] [--sidecar PATH]');
    process.exit(2);
  }
  const chain = JSON.parse(readFileSync(chainPath, 'utf8'));
  const common = {
    skipKernel: argv.includes('--skip-kernel'),
    recheckCli: argv.includes('--recheck-cli'),
    log: console.log,
  };

  let res;
  if (chain.version === CHAIN_VERSION_V2) {
    const mode = argValue(argv, '--mode') ?? 'full';
    if (mode !== 'full' && mode !== 'spot') {
      console.error(`--mode must be "full" or "spot", got "${mode}"`);
      process.exit(2);
    }
    // A typo'd --spot-k (0, -1, 1.5, "nope") must not silently degrade SPOT
    // into a skeleton-only check that still prints VERIFIED.
    const spotKArg = argValue(argv, '--spot-k');
    const spotK = spotKArg === undefined ? 8 : Number(spotKArg);
    if (!Number.isInteger(spotK) || spotK < 1) {
      console.error(`--spot-k must be a positive integer, got "${spotKArg}"`);
      process.exit(2);
    }
    // SPOT soundness lives in the seed being the VERIFIER's choice: draw a
    // fresh random one unless --seed reproduces an earlier run.
    const seedArg = argValue(argv, '--seed');
    if (seedArg !== undefined && !Number.isInteger(Number(seedArg))) {
      console.error(`--seed must be an integer, got "${seedArg}"`);
      process.exit(2);
    }
    const seed = seedArg !== undefined
      ? Number(seedArg) >>> 0
      : crypto.getRandomValues(new Uint32Array(1))[0];
    const sidecarPath = argValue(argv, '--sidecar')
      ?? path.join(path.dirname(chainPath), chain.sidecar?.file ?? 'trajectory-steps-v2.jsonl');
    let sidecarText;
    try {
      sidecarText = readFileSync(sidecarPath, 'utf8');
    } catch (err) {
      console.error(`cannot read sidecar ${sidecarPath}: ${err.message}`);
      process.exit(2);
    }
    if (mode === 'spot') console.log(`spot mode: sampling with seed ${seed} (reproduce with --seed ${seed})`);
    res = await verifyChainV2(chain, { ...common, sidecarText, mode, spotK, seed });
  } else if (chain.version === CHAIN_VERSION) {
    for (const flag of ['--mode', '--spot-k', '--seed', '--sidecar']) {
      if (argv.includes(flag)) {
        console.error(`${flag} applies only to ${CHAIN_VERSION_V2} chains (this chain is ${chain.version})`);
        process.exit(2);
      }
    }
    res = await verifyChain(chain, common);
  } else {
    console.error(`unsupported chain version "${chain.version}" (know: ${CHAIN_VERSION}, ${CHAIN_VERSION_V2})`);
    process.exit(1);
  }

  if (res.ok) {
    const s = res.stats;
    const shape = s.segments !== undefined
      ? `${s.steps} steps in ${s.segments} segments (${s.mode.toUpperCase()}: ${s.replayedSegments} replayed)`
      : `${s.steps} steps, ${s.records} records`;
    console.log(`VERIFIED: ${shape}, ${(s.totalMs / 1000).toFixed(1)}s total` +
      (s.endpointKernelChecked ? ' (endpoint kernel-grounded)' : ' (endpoint kernel check SKIPPED)'));
    process.exit(0);
  } else {
    console.error(`TAMPERED or INVALID at ${res.failure.where}: ${res.failure.reason}`);
    console.error(JSON.stringify(res.failure.details ?? {}, null, 2));
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

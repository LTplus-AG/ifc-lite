/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: tamper detection test.
 *
 * Loads a real certificate chain, then verifies that (a) the untampered
 * chain passes and (b) a battery of adversarial mutations - each applied
 * to a fresh copy, mid-chain where possible - is DETECTED by
 * verify-trajectory.mjs with a sensible machine-readable reason:
 *
 *   flip-parameter     a mid-chain design parameter is nudged (with the
 *                      parameter delta kept consistent, as a lazy forger
 *                      would) -> the projected-gradient replay cannot
 *                      reproduce the recorded iterate
 *   fake-objective     the recorded post-step carbon is lowered (and the
 *                      step certificate's scalar-delta claim adjusted to
 *                      match) -> re-derived objective disagrees
 *   break-linkage      a mid-chain prevRoot is swapped -> Merkle chain
 *                      linkage broken
 *   forge-root         a mid-chain newRoot is replaced -> recommitted
 *                      state root disagrees
 *   tamper-endpoint    the bound kernel carbon is changed -> the endpoint
 *                      property-set hash no longer matches
 *   consistent-endpoint (--full only) the bound kernel carbon is changed
 *                      AND all downstream hashes + the endpoint
 *                      certificate are honestly recomputed - only the
 *                      kernel RE-MEASUREMENT catches it
 *
 * v2 (checkpointed) chains get the equivalent battery against segment
 * records and the JSONL sidecar, run under SPOT mode where the skeleton
 * pass alone must catch it and under FULL mode where only replay can,
 * plus an explicit demonstration of the SPOT sampling tradeoff: an
 * interior forgery made fully self-consistent is caught by a seed whose
 * sample hits the tampered segment and MISSED by one that avoids it.
 *
 * Usage: node scripts/moonshot/diff-spike/tamper-test.mjs CHAIN.json [--full]
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { verifyChain, verifyChainV2, sampleSegments } from './verify-trajectory.mjs';
import {
  CHAIN_VERSION, CHAIN_VERSION_V2, endpointKernelPayload, endpointRootPayload,
  sha256hex,
} from './trajectory.mjs';
import { REPO_ROOT } from './build-ifc.mjs';

const { computeNodeHash, createCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

function midStepIndex(chain) {
  const stepPositions = chain.records
    .map((r, i) => (r.kind === 'step' ? i : -1))
    .filter((i) => i >= 0);
  return stepPositions[Math.floor(stepPositions.length / 2)];
}

/** Each tamper mutates a structuredClone of the chain and names the
 *  failure reasons it would accept as detection. */
const TAMPERS = [
  {
    name: 'flip-parameter',
    expect: ['step-not-reproducible', 'armijo-violation', 'line-search-replay-divergence'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      const j = 5; // exterior wall thickness
      const prev = i === 0 ? chain.startParams : findPrevParams(chain, i);
      rec.newParams[j] += 0.001;
      rec.parameterDelta[j] = rec.newParams[j] - prev[j]; // lazy-forger consistency
      return `step ${rec.index}: newParams[tw] += 1 mm (delta kept consistent)`;
    },
  },
  {
    name: 'fake-objective',
    expect: ['objective-after-mismatch'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.carbonAfter -= 500;
      const claim = rec.certificate.claims.find((c) => c.type === 'scalar-delta');
      claim.after = rec.carbonAfter;
      claim.delta = claim.after - claim.before;
      return `step ${rec.index}: carbonAfter -= 500 kgCO2e (certificate claim adjusted to match)`;
    },
  },
  {
    name: 'break-linkage',
    expect: ['chain-linkage-broken'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.prevRoot = chain.startRoot; // a real hash, just the wrong one
      return `step ${rec.index}: prevRoot replaced with the chain start root`;
    },
  },
  {
    name: 'forge-root',
    expect: ['state-root-mismatch'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.newRoot = chain.finalState.root; // a real hash, just the wrong one
      return `step ${rec.index}: newRoot replaced with the final state root`;
    },
  },
  {
    name: 'tamper-endpoint',
    expect: ['kernel-pset-hash-mismatch'],
    apply(chain) {
      chain.endpoint.kernel.carbon -= 1000;
      return 'endpoint: bound kernel carbon -= 1000 kgCO2e (hashes left as-is)';
    },
  },
];

function findPrevParams(chain, recIdx) {
  for (let i = recIdx - 1; i >= 0; i--) {
    if (chain.records[i].kind === 'step') return chain.records[i].newParams;
  }
  return chain.startParams;
}

/** The hard case: fake the kernel numbers and recompute every hash and the
 *  endpoint certificate honestly. Only re-measurement can catch this. */
async function consistentEndpointTamper(chain) {
  const ep = chain.endpoint;
  ep.kernel.carbon -= 1000;
  ep.kernelHash = await computeNodeHash('property-set', endpointKernelPayload(ep));
  ep.endpointRoot = await computeNodeHash(
    'element', endpointRootPayload(ep.stateRoot, ep.kernelHash));
  ep.certificate = createCertificate({
    kernelVersion: chain.kernelVersion,
    trustRoot: chain.trustRoot,
    reads: ep.certificate.reads,
    writes: [
      { nodeId: 'endpoint/kernel', hash: ep.kernelHash },
      { nodeId: 'endpoint/root', hash: ep.endpointRoot },
    ],
    claims: ep.certificate.claims,
  });
  return 'endpoint: kernel carbon -= 1000 kgCO2e with ALL hashes + certificate recomputed consistently';
}

/* ------------------------------------------------------------------ */
/* v2 (checkpointed) battery                                            */
/* ------------------------------------------------------------------ */

function midSegment(chain) {
  return chain.segments[Math.floor(chain.segments.length / 2)];
}

function reseal(ctx) {
  // A forger who controls the artifact bundle can trivially keep the
  // header's sidecar hash consistent; tampers that model that forger call
  // this after mutating sidecar lines.
  const text = ctx.lines.join('\n') + '\n';
  ctx.chain.sidecar.sha256 = `sha256:${sha256hex(text)}`;
}

/** Flip one step's backtrack count inside `seg` (staying within btMax). */
function flipBacktracks(ctx, seg) {
  const btMax = ctx.chain.optimizer?.btMax ?? 60;
  for (let i = seg.recordStart; i < seg.recordEnd; i++) {
    const line = JSON.parse(ctx.lines[i]);
    if (Number.isInteger(line.b)) {
      line.b = line.b < btMax ? line.b + 1 : line.b - 1;
      ctx.lines[i] = JSON.stringify(line);
      return i;
    }
  }
  throw new Error('no step line found in segment');
}

/**
 * Each v2 tamper mutates a fresh { chain, lines } context and declares the
 * verification mode that must catch it:
 *   'spot' - the skeleton pass alone detects it (any SPOT run, any seed)
 *   'full' - only a replay of the tampered segment detects it
 */
const TAMPERS_V2 = [
  {
    name: 'v2-flip-boundary-param',
    mode: 'spot',
    expect: ['segment-state-root-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      seg.endParams[5] += 0.001; // exterior wall thickness
      return `segment ${seg.index}: endParams[tw] += 1 mm`;
    },
  },
  {
    name: 'v2-fake-objective',
    mode: 'spot',
    expect: ['segment-carbon-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      seg.carbonEnd -= 500;
      const claim = seg.certificate.claims.find((c) => c.type === 'scalar-delta');
      claim.after = seg.carbonEnd;
      claim.delta = claim.after - claim.before;
      return `segment ${seg.index}: carbonEnd -= 500 kgCO2e (certificate claim adjusted to match)`;
    },
  },
  {
    name: 'v2-break-linkage',
    mode: 'spot',
    expect: ['segment-linkage-broken'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      seg.startRoot = ctx.chain.startRoot; // a real hash, just the wrong one
      return `segment ${seg.index}: startRoot replaced with the chain start root`;
    },
  },
  {
    name: 'v2-forge-endroot',
    mode: 'spot',
    expect: ['segment-state-root-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      seg.endRoot = ctx.chain.finalState.root; // a real hash, just the wrong one
      return `segment ${seg.index}: endRoot replaced with the final state root`;
    },
  },
  {
    name: 'v2-tamper-sidecar',
    mode: 'spot',
    expect: ['sidecar-hash-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      const i = flipBacktracks(ctx, seg);
      return `sidecar record ${i}: backtracks flipped (header hash left as-is)`;
    },
  },
  {
    name: 'v2-tamper-sidecar-consistent',
    mode: 'full',
    expect: ['line-search-replay-divergence', 'armijo-violation'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      const i = flipBacktracks(ctx, seg);
      reseal(ctx);
      return `sidecar record ${i}: backtracks flipped, header sidecar hash recomputed consistently`;
    },
  },
  {
    name: 'v2-forge-steps-root',
    mode: 'full',
    expect: ['segment-merkle-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      const other = ctx.chain.segments[0];
      seg.stepsRoot = other.stepsRoot; // a real Merkle root, just the wrong one
      return `segment ${seg.index}: stepsRoot replaced with segment 0's`;
    },
  },
  {
    name: 'v2-tamper-endpoint',
    mode: 'spot',
    expect: ['kernel-pset-hash-mismatch'],
    apply(ctx) {
      ctx.chain.endpoint.kernel.carbon -= 1000;
      return 'endpoint: bound kernel carbon -= 1000 kgCO2e (hashes left as-is)';
    },
  },
];

function findSeed(total, k, target, include) {
  for (let seed = 1; seed < 100000; seed++) {
    const hit = sampleSegments(total, k, seed).includes(target);
    if (hit === include) return seed;
  }
  throw new Error(`no seed found with include=${include} (total=${total}, k=${k})`);
}

async function runV2Battery(original, sidecarLines, full) {
  let failures = 0;
  const spotK = Math.min(4, original.segments.length);
  const makeCtx = () => ({
    chain: structuredClone(original),
    lines: sidecarLines.slice(),
  });
  const verify = (ctx, mode, seed = 1) => verifyChainV2(ctx.chain, {
    sidecarText: ctx.lines.join('\n') + '\n',
    mode,
    spotK,
    seed,
    skipKernel: true,
  });

  // Controls: the untampered chain must verify in both modes.
  for (const mode of ['full', 'spot']) {
    const t0 = performance.now();
    const control = await verify(makeCtx(), mode);
    const ms = performance.now() - t0;
    if (control.ok) {
      console.log(`control (${mode.toUpperCase()}): untampered v2 chain VERIFIED ` +
        `(${control.stats.steps} steps, ${control.stats.segments} segments, ${(ms / 1000).toFixed(1)}s)`);
    } else {
      failures += 1;
      console.error(`control (${mode}): untampered v2 chain FAILED verification:`, JSON.stringify(control.failure));
    }
  }

  for (const tamper of TAMPERS_V2) {
    const ctx = makeCtx();
    const desc = tamper.apply(ctx);
    const res = await verify(ctx, tamper.mode);
    if (res.ok) {
      failures += 1;
      console.error(`${tamper.name}: NOT DETECTED in ${tamper.mode.toUpperCase()} mode (${desc})`);
    } else if (!tamper.expect.includes(res.failure.reason)) {
      failures += 1;
      console.error(`${tamper.name}: detected but with unexpected reason ` +
        `"${res.failure.reason}" at ${res.failure.where} (${desc}; expected one of ${tamper.expect.join('|')})`);
    } else {
      console.log(`${tamper.name}: DETECTED in ${tamper.mode.toUpperCase()} mode as ` +
        `"${res.failure.reason}" at ${res.failure.where}`);
      console.log(`  (${desc})`);
    }
  }

  // The SPOT sampling tradeoff, demonstrated rather than asserted away: a
  // fully self-consistent interior forgery (flipped backtracks, header hash
  // resealed - the skeleton has nothing to object to) is caught exactly when
  // the sample hits the tampered segment.
  const total = original.segments.length;
  const target = midSegment(original).index;
  const ctx = makeCtx();
  const desc = TAMPERS_V2.find((t) => t.name === 'v2-tamper-sidecar-consistent').apply(ctx);
  const seedHit = findSeed(total, spotK, target, true);
  const hit = await verify(ctx, 'spot', seedHit);
  if (!hit.ok && ['line-search-replay-divergence', 'armijo-violation'].includes(hit.failure.reason)) {
    console.log(`v2-spot-sampling-hit: DETECTED with seed ${seedHit} (sample includes segment ${target})`);
  } else {
    failures += 1;
    console.error(`v2-spot-sampling-hit: expected replay detection with seed ${seedHit}, got ` +
      (hit.ok ? 'PASS' : JSON.stringify(hit.failure)));
  }
  if (total > spotK) {
    const seedMiss = findSeed(total, spotK, target, false);
    const miss = await verify(ctx, 'spot', seedMiss);
    if (miss.ok) {
      console.log(`v2-spot-sampling-miss: NOT detected with seed ${seedMiss} (sample avoids segment ${target}) - ` +
        `the documented SPOT tradeoff (${desc})`);
    } else {
      failures += 1;
      console.error(`v2-spot-sampling-miss: expected the documented miss with seed ${seedMiss}, got`, JSON.stringify(miss.failure));
    }
  }

  if (full) {
    const fullCtx = makeCtx();
    const fullDesc = await consistentEndpointTamper(fullCtx.chain);
    const res = await verifyChainV2(fullCtx.chain, {
      sidecarText: fullCtx.lines.join('\n') + '\n',
      mode: 'spot',
      spotK,
      seed: 1,
      skipKernel: false,
    });
    if (res.ok) {
      failures += 1;
      console.error(`v2-consistent-endpoint: NOT DETECTED (${fullDesc})`);
    } else if (res.failure.reason !== 'kernel-carbon-mismatch') {
      failures += 1;
      console.error(`v2-consistent-endpoint: detected but with unexpected reason "${res.failure.reason}" (${fullDesc})`);
    } else {
      console.log('v2-consistent-endpoint: DETECTED as "kernel-carbon-mismatch" by re-measurement');
      console.log(`  (${fullDesc})`);
    }
  }

  return { failures, tampers: TAMPERS_V2.length + (total > spotK ? 2 : 1) + (full ? 1 : 0) };
}

async function main() {
  const argv = process.argv.slice(2);
  const chainPath = argv.find((a) => !a.startsWith('-'));
  const full = argv.includes('--full');
  if (!chainPath) {
    console.error('usage: node tamper-test.mjs CHAIN.json [--full]');
    process.exit(2);
  }
  const original = JSON.parse(readFileSync(chainPath, 'utf8'));

  if (original.version === CHAIN_VERSION_V2) {
    const sidecarPath = path.join(path.dirname(chainPath), original.sidecar.file);
    const sidecarLines = readFileSync(sidecarPath, 'utf8').split('\n').filter((l) => l.length > 0);
    const { failures, tampers } = await runV2Battery(original, sidecarLines, full);
    console.log('---');
    if (failures === 0) {
      console.log(`tamper test PASS (v2): controls verified, ${tampers} tamper cases behaved as specified`);
      process.exit(0);
    }
    console.error(`tamper test FAIL (v2): ${failures} problem(s)`);
    process.exit(1);
  }
  if (original.version !== CHAIN_VERSION) {
    console.error(`unsupported chain version "${original.version}"`);
    process.exit(2);
  }
  let failures = 0;

  // Control: the untampered chain must verify (fast mode: endpoint hashes
  // and certificates checked, kernel re-measurement exercised separately by
  // verify-trajectory.mjs runs and the --full case below).
  const t0 = performance.now();
  const control = await verifyChain(structuredClone(original), { skipKernel: true });
  const controlMs = performance.now() - t0;
  if (control.ok) {
    console.log(`control: untampered chain VERIFIED (${control.stats.steps} steps, ${(controlMs / 1000).toFixed(1)}s)`);
  } else {
    failures += 1;
    console.error('control: untampered chain FAILED verification:', JSON.stringify(control.failure));
  }

  for (const tamper of TAMPERS) {
    const chain = structuredClone(original);
    const desc = tamper.apply(chain);
    const res = await verifyChain(chain, { skipKernel: true });
    if (res.ok) {
      failures += 1;
      console.error(`${tamper.name}: NOT DETECTED (${desc})`);
    } else if (!tamper.expect.includes(res.failure.reason)) {
      failures += 1;
      console.error(`${tamper.name}: detected but with unexpected reason ` +
        `"${res.failure.reason}" at ${res.failure.where} (${desc}; expected one of ${tamper.expect.join('|')})`);
    } else {
      console.log(`${tamper.name}: DETECTED as "${res.failure.reason}" at ${res.failure.where}`);
      console.log(`  (${desc})`);
    }
  }

  if (full) {
    const chain = structuredClone(original);
    const desc = await consistentEndpointTamper(chain);
    const res = await verifyChain(chain, { skipKernel: false, chainPath });
    if (res.ok) {
      failures += 1;
      console.error(`consistent-endpoint: NOT DETECTED (${desc})`);
    } else if (res.failure.reason !== 'kernel-carbon-mismatch') {
      failures += 1;
      console.error(`consistent-endpoint: detected but with unexpected reason "${res.failure.reason}" (${desc})`);
    } else {
      console.log(`consistent-endpoint: DETECTED as "kernel-carbon-mismatch" by re-measurement`);
      console.log(`  (${desc})`);
    }
  }

  console.log('---');
  if (failures === 0) {
    console.log(`tamper test PASS: control verified, ${TAMPERS.length + (full ? 1 : 0)} tampers detected`);
    process.exit(0);
  }
  console.error(`tamper test FAIL: ${failures} problem(s)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

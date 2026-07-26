/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 tamper battery: the v2 (checkpointed) chain cases.
 *
 * Every case declares the verification mode that MUST catch it:
 *   'spot' - the skeleton pass alone detects it (any SPOT run, any seed)
 *   'full' - only a replay of the tampered segment detects it
 * plus the degenerate-sample guards and an explicit demonstration of the
 * SPOT sampling tradeoff (same forgery, hit seed vs miss seed).
 */

import { verifyChainV2, sampleSegments } from './verify-trajectory.mjs';
import { sha256hex } from './trajectory.mjs';
import { consistentEndpointTamper } from './tamper-common.mjs';

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
  // ---- externally supplied chains: shape, not just hashes ----
  // verifyCertificate checks whatever a certificate asserts; an emptied
  // certificate asserts almost nothing and would pass on its own terms.
  {
    name: 'v2-hollow-certificate',
    mode: 'spot',
    expect: ['segment-certificate-incomplete'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      const endRootWrite = seg.certificate.writes.find(
        (w) => w.nodeId === `state/${seg.stepEnd}/root`);
      seg.certificate.reads = [];
      seg.certificate.claims = [];
      seg.certificate.writes = [endRootWrite];
      return `segment ${seg.index}: certificate hollowed to reads=[], claims=[], one honest end-root write`;
    },
  },
  {
    name: 'v2-swapped-aggregate-claim',
    mode: 'spot',
    expect: ['segment-certificate-claim-mismatch'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      const claim = seg.certificate.claims.find((c) => c.type === 'scalar-delta');
      // Internally consistent (before/after/delta agree) but about a
      // different aggregate than the segment record states.
      claim.before -= 500;
      claim.after -= 500;
      return `segment ${seg.index}: aggregate claim shifted by -500 kgCO2e, arithmetic kept consistent`;
    },
  },
  {
    name: 'v2-malformed-certificate',
    mode: 'spot',
    expect: ['segment-certificate-malformed'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      seg.certificate.reads = 'not-an-array';
      return `segment ${seg.index}: certificate.reads replaced with a string (must fail cleanly, not throw)`;
    },
  },
  {
    name: 'v2-missing-certificate',
    mode: 'spot',
    expect: ['segment-certificate-missing'],
    apply(ctx) {
      const seg = midSegment(ctx.chain);
      delete seg.certificate;
      return `segment ${seg.index}: certificate removed entirely`;
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

export async function runV2Battery(original, sidecarLines, full) {
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
    const snapshot = () => `${JSON.stringify(ctx.chain)} ${ctx.lines.join('\n')}`;
    const before = snapshot();
    const desc = tamper.apply(ctx);
    // A forgery that mutates nothing cannot be "not detected", and scoring it
    // as a failure is misleading. On short chains some cases collapse into
    // no-ops - e.g. replacing the *last* segment's endRoot with the final
    // state root, which it already equals on a 2-segment chain. Report the
    // vacuity instead of a false failure.
    if (snapshot() === before) {
      console.log(`${tamper.name}: SKIPPED - vacuous on this chain (${desc}); needs more segments to be meaningful`);
      continue;
    }
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

  // Degenerate SPOT sample counts must be REFUSED, not silently honoured:
  // sampling zero segments would report `ok` while replaying nothing, i.e.
  // quietly downgrade SPOT to a skeleton-only check.
  for (const badK of [0, -1, 1.5, Number.NaN]) {
    const res = await verifyChainV2(structuredClone(original), {
      sidecarText: sidecarLines.join('\n') + '\n',
      mode: 'spot',
      spotK: badK,
      seed: 1,
      skipKernel: true,
    });
    if (!res.ok && res.failure.reason === 'invalid-spot-k') {
      console.log(`v2-spot-k-guard(${String(badK)}): REFUSED as "invalid-spot-k"`);
    } else {
      failures += 1;
      console.error(`v2-spot-k-guard(${String(badK)}): expected refusal, got ` +
        (res.ok ? `PASS with ${res.stats.replayedSegments} replayed segments` : JSON.stringify(res.failure)));
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

  // TAMPERS_V2 + 4 spot-k guards + sampling hit (+ miss when S > K) + endpoint.
  return { failures, tampers: TAMPERS_V2.length + 4 + (total > spotK ? 2 : 1) + (full ? 1 : 0) };
}
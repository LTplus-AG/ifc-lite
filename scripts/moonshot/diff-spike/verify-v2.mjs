/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 trajectory verification: the v2 (checkpointed) chain verifier -
 * header, sidecar, and the skeleton pass over the segment lattice, plus
 * mode dispatch onto the per-segment replay (verify-v2-segment.mjs).
 *
 * Format and rationale: DESIGN.md section 8, "Chain format v2".
 */

import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { commitState, makeStateResolver, sha256hex } from './trajectory.mjs';
import { CHAIN_VERSION_V2 } from './chain-v2.mjs';
import { fail, checkHeader, verifyCertificate } from './verify-common.mjs';
import { verifyEndpointSection } from './verify-endpoint.mjs';
import { sampleSegments, replaySegment, checkSegmentCertificateShape } from './verify-v2-segment.mjs';

/**
 * Verify a v2 (checkpointed) chain. Two modes:
 *
 *   FULL  - skeleton pass over every segment (linkage, mu schedule,
 *           boundary-state recommits, segment certificates against
 *           re-derived payloads, aggregate carbon claims) PLUS a full
 *           replay of EVERY segment. Exactly as strong as v1 verification.
 *   SPOT  - the same skeleton pass over every segment, plus a full replay
 *           of K seeded-randomly sampled segments. Tampering that changes
 *           any segment boundary, certificate, aggregate claim, mu
 *           schedule, or the sidecar bytes is still always caught; a
 *           consistent forgery strictly INSIDE unsampled segments (a fake
 *           interior descent path reconnecting genuine boundary states plus
 *           a matching Merkle root) escapes with probability
 *           C(S-t, K) / C(S, K) for t tampered segments out of S.
 *
 * Both modes verify the endpoint exactly as v1 does (kernel re-measurement
 * unless skipKernel).
 */
export async function verifyChainV2(chain, opts = {}) {
  const {
    sidecarText, mode = 'full', spotK = 8, seed = 0,
    skipKernel = false, recheckCli = false, log = () => {},
  } = opts;
  const t0 = performance.now();

  // ---- header ----
  const headerFailure = checkHeader(chain, CHAIN_VERSION_V2);
  if (headerFailure) return headerFailure;
  if (mode !== 'full' && mode !== 'spot') {
    return fail('header', 'unknown-verification-mode', { mode });
  }
  // A zero, negative, fractional or NaN spotK would sample no segments and
  // still report `ok` - silently downgrading SPOT to a skeleton-only check
  // after a CLI typo. Refuse instead of quietly weakening the guarantee.
  if (mode === 'spot' && (!Number.isInteger(spotK) || spotK < 1)) {
    return fail('header', 'invalid-spot-k', {
      spotK,
      note: 'spot mode needs a positive integer sample count',
    });
  }
  const scenario = chain.scenario;
  const optz = chain.optimizer ?? {};
  const stepInit = optz.stepInit ?? 0.1;
  const armijoC = optz.armijoC ?? 1e-4;
  const btMax = Number.isInteger(optz.btMax) && optz.btMax > 0 ? optz.btMax : 60;
  const muFactor = optz.muFactor ?? 4;
  const startMu = optz.startMu ?? 10;

  // ---- sidecar ----
  if (typeof sidecarText !== 'string') {
    return fail('sidecar', 'sidecar-missing', { note: 'v2 chains need their JSONL sidecar' });
  }
  if (`sha256:${sha256hex(sidecarText)}` !== chain.sidecar?.sha256) {
    return fail('sidecar', 'sidecar-hash-mismatch', { recorded: chain.sidecar?.sha256 });
  }
  let sidecar;
  try {
    sidecar = sidecarText.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch (err) {
    return fail('sidecar', 'sidecar-parse-error', { message: err.message });
  }
  if (sidecar.length !== chain.sidecar.records) {
    return fail('sidecar', 'sidecar-record-count-mismatch', { recorded: chain.sidecar.records, actual: sidecar.length });
  }
  if (!Array.isArray(chain.segments) || chain.segments.length === 0) {
    return fail('chain', 'no-segments');
  }
  if (!Number.isInteger(chain.segmentSize) || chain.segmentSize < 1) {
    return fail('header', 'bad-segment-size', { segmentSize: chain.segmentSize });
  }

  // ---- state 0 ----
  const startCommitted = await commitState(chain.startParams, scenario);
  if (startCommitted.root !== chain.startRoot) {
    return fail('state-0', 'start-root-mismatch', { expected: chain.startRoot, recomputed: startCommitted.root });
  }

  // ---- skeleton pass over ALL segments ----
  // boundary[s] describes the re-derived state ENTERING segment s. Only the
  // rolling prevEnd keeps the full committed object (the next segment's
  // certificate reads resolve against it); boundary[] stores just what the
  // replay pass needs (root + params), so 5k steps of committed payloads
  // are not held live across the whole verification.
  let mu = startMu;
  let prevEnd = {
    stepEnd: 0,
    recordEnd: 0,
    endRoot: chain.startRoot,
    endParams: chain.startParams,
    carbonEnd: startCommitted.numeric.carbon,
    committed: startCommitted,
  };
  const boundary = [{ endRoot: prevEnd.endRoot, endParams: prevEnd.endParams }];
  for (let s = 0; s < chain.segments.length; s++) {
    const seg = chain.segments[s];
    const where = `segment ${s}`;
    if (seg.index !== s) return fail(where, 'segment-index-mismatch', { recorded: seg.index });
    if (seg.stepStart !== prevEnd.stepEnd || seg.recordStart !== prevEnd.recordEnd) {
      return fail(where, 'segment-range-broken', { stepStart: seg.stepStart, recordStart: seg.recordStart, expected: { stepStart: prevEnd.stepEnd, recordStart: prevEnd.recordEnd } });
    }
    if (!Number.isInteger(seg.stepEnd) || seg.stepEnd <= seg.stepStart
      || seg.stepEnd - seg.stepStart > chain.segmentSize) {
      return fail(where, 'segment-bad-step-range', { stepStart: seg.stepStart, stepEnd: seg.stepEnd, segmentSize: chain.segmentSize });
    }
    if (!Number.isInteger(seg.recordEnd) || seg.recordEnd <= seg.recordStart || seg.recordEnd > sidecar.length) {
      return fail(where, 'segment-range-broken', { recordStart: seg.recordStart, recordEnd: seg.recordEnd, sidecarRecords: sidecar.length });
    }
    if (seg.startRoot !== prevEnd.endRoot) {
      return fail(where, 'segment-linkage-broken', { expected: prevEnd.endRoot, recorded: seg.startRoot });
    }
    if (seg.muStart !== mu) {
      return fail(where, 'segment-mu-mismatch', { recorded: seg.muStart, expected: mu });
    }
    if (seg.carbonStart !== prevEnd.carbonEnd) {
      return fail(where, 'segment-carbon-mismatch', { field: 'carbonStart', recorded: seg.carbonStart, expected: prevEnd.carbonEnd });
    }
    // Walk the segment's sidecar lines: step count and mu schedule.
    let stepsInSeg = 0;
    for (let i = seg.recordStart; i < seg.recordEnd; i++) {
      const line = sidecar[i];
      if (line !== null && typeof line === 'object' && Number.isInteger(line.b)) {
        if (line.b < 0 || line.b > btMax) {
          return fail(where, 'invalid-backtracks', { record: i, backtracks: line.b, btMax });
        }
        stepsInSeg += 1;
      } else if (line !== null && typeof line === 'object' && Array.isArray(line.mu) && line.mu.length === 2) {
        if (line.mu[0] !== mu || line.mu[1] !== mu * muFactor) {
          return fail(where, 'mu-schedule-violation', { record: i, line, expected: { muBefore: mu, muAfter: mu * muFactor } });
        }
        mu = line.mu[1];
      } else {
        return fail(where, 'sidecar-parse-error', { record: i, line });
      }
    }
    if (stepsInSeg !== seg.stepEnd - seg.stepStart) {
      return fail(where, 'segment-step-count-mismatch', { sidecarSteps: stepsInSeg, recorded: seg.stepEnd - seg.stepStart });
    }
    if (seg.muEnd !== mu) {
      return fail(where, 'segment-mu-mismatch', { field: 'muEnd', recorded: seg.muEnd, expected: mu });
    }
    // Boundary state: recommit from the recorded end parameters.
    const xEnd = seg.endParams;
    if (!Array.isArray(xEnd) || xEnd.length !== NPARAMS || xEnd.some((v) => !Number.isFinite(v))) {
      return fail(where, 'segment-bad-end-params', { endParams: xEnd });
    }
    for (let d = 0; d < NPARAMS; d++) {
      if (xEnd[d] < PARAMS[d].lo || xEnd[d] > PARAMS[d].hi) {
        return fail(where, 'segment-params-out-of-box', { param: PARAMS[d].name, value: xEnd[d] });
      }
    }
    const committed = await commitState(xEnd, scenario);
    if (committed.root !== seg.endRoot) {
      return fail(where, 'segment-state-root-mismatch', { recorded: seg.endRoot, recomputed: committed.root });
    }
    if (committed.numeric.carbon !== seg.carbonEnd) {
      return fail(where, 'segment-carbon-mismatch', { field: 'carbonEnd', recorded: seg.carbonEnd, recomputed: committed.numeric.carbon });
    }
    // The segment certificate: first the v2 SHAPE contract (an externally
    // supplied certificate must actually commit the entry state, the exit
    // state and the aggregate claim - verifyCertificate would happily
    // accept an emptied one), then the hashes, against re-derived payloads
    // only.
    const shapeFailure = checkSegmentCertificateShape(seg, where);
    if (shapeFailure) return shapeFailure;
    const resolver = makeStateResolver([
      { k: seg.stepStart, committed: prevEnd.committed },
      { k: seg.stepEnd, committed },
    ]);
    const res = await verifyCertificate(seg.certificate, resolver, {
      expectedTrustRoot: chain.trustRoot,
      expectedKernelVersion: chain.kernelVersion,
    });
    if (!res.ok) return fail(where, `certificate-invalid:${res.reason}`, res.details);
    prevEnd = {
      stepEnd: seg.stepEnd,
      recordEnd: seg.recordEnd,
      endRoot: seg.endRoot,
      endParams: xEnd,
      carbonEnd: seg.carbonEnd,
      committed,
    };
    boundary.push({ endRoot: seg.endRoot, endParams: xEnd });
  }
  const lastSeg = chain.segments[chain.segments.length - 1];
  if (lastSeg.stepEnd !== chain.steps) {
    return fail('chain', 'step-count-mismatch', { recorded: chain.steps, segments: lastSeg.stepEnd });
  }
  if (lastSeg.recordEnd !== sidecar.length) {
    return fail('chain', 'record-count-mismatch', { recorded: sidecar.length, segments: lastSeg.recordEnd });
  }
  if (chain.finalState.root !== lastSeg.endRoot) {
    return fail('chain', 'final-root-mismatch', { recorded: chain.finalState.root, recomputed: lastSeg.endRoot });
  }
  const skeletonMs = performance.now() - t0;
  log(`skeleton verified: ${chain.segments.length} segments, ${chain.steps} steps committed, ${(skeletonMs / 1000).toFixed(1)}s`);

  // ---- replay ----
  const tReplay = performance.now();
  const total = chain.segments.length;
  const replayIdx = mode === 'full'
    ? Array.from({ length: total }, (_, i) => i)
    : sampleSegments(total, spotK, seed);
  let replayedSteps = 0;
  for (const s of replayIdx) {
    const seg = chain.segments[s];
    const entry = boundary[s];
    const res = await replaySegment(chain, seg, entry.endRoot, entry.endParams, sidecar, { stepInit, armijoC });
    if (!res.ok) return res;
    replayedSteps += res.steps;
  }
  const replayMs = performance.now() - tReplay;
  log(mode === 'full'
    ? `replay verified: all ${total} segments (${replayedSteps} steps) in ${(replayMs / 1000).toFixed(1)}s`
    : `replay verified: ${replayIdx.length}/${total} sampled segments (${replayedSteps} steps, seed ${seed}) in ${(replayMs / 1000).toFixed(1)}s`);

  // ---- endpoint ----
  // prevEnd still holds the last segment's committed state.
  const epResult = await verifyEndpointSection(
    chain, prevEnd.endParams, prevEnd.committed, chain.steps,
    { skipKernel, recheckCli, log });
  if (epResult.failure) return { ok: false, failure: epResult.failure };

  return {
    ok: true,
    stats: {
      mode,
      steps: chain.steps,
      segments: total,
      replayedSegments: replayIdx.length,
      replayedSteps,
      seed: mode === 'spot' ? seed : undefined,
      skeletonMs,
      replayMs,
      kernelMs: epResult.kernelMs,
      totalMs: performance.now() - t0,
      endpointKernelChecked: !skipKernel,
      cliRechecked: recheckCli && !skipKernel,
    },
  };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 trajectory verification: v2 segment-level machinery - seeded
 * sampling, the segment-certificate shape contract, and the per-segment
 * replay.
 *
 * The replay is the part that carries the actual cryptographic weight: it
 * re-derives every step inside a segment from the entry state and the
 * sidecar's backtrack counts alone, and must land on the segment's
 * committed end root AND Merkle root. The skeleton pass in verify-v2.mjs
 * checks the segment lattice; only this file proves an individual
 * segment's interior.
 */

import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { meritDual, projectBox } from './optimize.mjs';
import { mulberry32 } from './dual.mjs';
import { commitState, nodeIds } from './trajectory.mjs';
import { stepCommitHash, merkleRoot } from './chain-v2.mjs';
import { fail, norm2 } from './verify-common.mjs';

/**
 * Deterministic seeded sample of `count` distinct segment indices out of
 * `total` (partial Fisher-Yates over mulberry32). Exported so tamper-test
 * can predict which segments a given seed replays.
 *
 * SOUNDNESS: the sample is only meaningful if the PROVER cannot predict the
 * seed. A verifier must draw the seed itself (the CLI draws a fresh random
 * one unless --seed is given for reproduction); accepting a seed suggested
 * by the chain's author voids the sampling guarantee.
 */
export function sampleSegments(total, count, seed) {
  const rand = mulberry32(seed >>> 0);
  const idx = Array.from({ length: total }, (_, i) => i);
  const n = Math.min(count, total);
  const picked = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (total - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
    picked.push(idx[i]);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * The v2 segment-certificate CONTRACT, enforced before `verifyCertificate`
 * ever runs.
 *
 * `verifyCertificate` is a faithful checker of whatever a certificate
 * happens to assert: it re-derives the hashes of the refs and claims that
 * are PRESENT, and an empty `reads`/`claims` array is vacuously fine by
 * its own semantics. That is correct for a general-purpose primitive and
 * wrong as a chain contract - an externally supplied chain could ship a
 * segment certificate with `reads: []`, `claims: []` and a single honest
 * end-root write, and the segment would "verify" while committing none of
 * the things v2 says a segment commits. So the shape is required here:
 *
 *   reads   = the entry state's params/quantities/root nodes,
 *   writes  = the exit state's params/quantities/root nodes,
 *   claims  = exactly one scalar-delta on EmbodiedCarbon bound to the
 *             entry and exit quantities nodes, with before/after equal to
 *             the segment's own recorded carbon endpoints.
 *
 * Hash CORRECTNESS is still `verifyCertificate`'s job (against re-derived
 * payloads); this function only fixes what must be there to be checked.
 * Every access is defensive: a malformed chain must fail with a reason,
 * never a TypeError.
 */
export function checkSegmentCertificateShape(seg, where) {
  const cert = seg.certificate;
  if (!cert || typeof cert !== 'object') {
    return fail(where, 'segment-certificate-missing', { certificate: cert });
  }
  for (const field of ['reads', 'writes', 'claims']) {
    if (!Array.isArray(cert[field])) {
      return fail(where, 'segment-certificate-malformed', { field, value: cert[field] });
    }
  }
  const expectRefs = (refs, k, roots, field) => {
    const ids = nodeIds(k);
    const want = [
      { nodeId: ids.params, hash: roots.paramsHash },
      { nodeId: ids.quantities, hash: roots.qHash },
      { nodeId: ids.root, hash: roots.root },
    ];
    for (const w of want) {
      // The hash a ref must carry is only pinned where the segment record
      // itself pins it (the state roots); params/quantities hashes are
      // pinned transitively by the element root, which verifyCertificate
      // recomputes from the re-derived payloads.
      const got = refs.find((r) => r && r.nodeId === w.nodeId);
      if (!got) {
        return fail(where, 'segment-certificate-incomplete', { field, missingNodeId: w.nodeId });
      }
      if (typeof got.hash !== 'string' || got.hash.length === 0) {
        return fail(where, 'segment-certificate-malformed', { field, nodeId: w.nodeId, hash: got.hash });
      }
      if (w.hash !== undefined && got.hash !== w.hash) {
        return fail(where, 'segment-certificate-detached', { field, nodeId: w.nodeId, recorded: got.hash, expected: w.hash });
      }
    }
    return null;
  };
  const readFailure = expectRefs(cert.reads, seg.stepStart, { root: seg.startRoot }, 'reads');
  if (readFailure) return readFailure;
  const writeFailure = expectRefs(cert.writes, seg.stepEnd, { root: seg.endRoot }, 'writes');
  if (writeFailure) return writeFailure;

  const scalar = cert.claims.filter((c) => c && c.type === 'scalar-delta');
  if (scalar.length !== 1) {
    return fail(where, 'segment-certificate-incomplete', {
      note: 'expected exactly one scalar-delta claim on EmbodiedCarbon',
      claimTypes: cert.claims.map((c) => c?.type),
    });
  }
  const claim = scalar[0];
  if (claim.metric !== 'property-numeric' || claim.property !== 'EmbodiedCarbon') {
    return fail(where, 'segment-certificate-claim-mismatch', { metric: claim.metric, property: claim.property });
  }
  if (claim.beforeNodeId !== nodeIds(seg.stepStart).quantities
    || claim.afterNodeId !== nodeIds(seg.stepEnd).quantities) {
    return fail(where, 'segment-certificate-claim-mismatch', {
      beforeNodeId: claim.beforeNodeId,
      afterNodeId: claim.afterNodeId,
      expected: { before: nodeIds(seg.stepStart).quantities, after: nodeIds(seg.stepEnd).quantities },
    });
  }
  // The aggregate claim must be about the carbon the SEGMENT RECORD states
  // (which the skeleton pass independently recomputes from the parameters),
  // so a certificate cannot quietly claim a different aggregate than the
  // segment it belongs to.
  if (claim.before !== seg.carbonStart || claim.after !== seg.carbonEnd) {
    return fail(where, 'segment-certificate-claim-mismatch', {
      claim: { before: claim.before, after: claim.after },
      segment: { carbonStart: seg.carbonStart, carbonEnd: seg.carbonEnd },
    });
  }
  return null;
}

/**
 * Fully replay one segment from its (already re-derived) entry state: the
 * same per-step discipline as the v1 verifier - Armijo line-search replay
 * (recorded-failed trials must fail, the accepted trial must pass),
 * monotone merit descent, per-step state recommits - ending in bitwise
 * end-parameter agreement and the segment's Merkle root over the re-derived
 * per-step commitment hashes.
 */
export async function replaySegment(chain, seg, entryRoot, startX, sidecar, knobs) {
  const { stepInit, armijoC } = knobs;
  const scenario = chain.scenario;
  let mu = seg.muStart;
  let x = startX;
  // Only the ROOT of each intermediate state is needed here (for the
  // step-commitment hashes); retaining whole committed-state object graphs
  // across 256 steps promotes them into V8's old generation and the
  // resulting major-GC churn measurably slows the merit re-evaluations
  // (~25% wall clock on a 5k-step chain), so keep just the string.
  let curRoot = entryRoot;
  let mCur = meritDual(x, mu, scenario);
  let k = seg.stepStart;
  const stepCommits = [];
  for (let i = seg.recordStart; i < seg.recordEnd; i++) {
    const line = sidecar[i];
    if (Array.isArray(line.mu)) {
      // Schedule already checked by the skeleton pass; re-evaluate the
      // merit under the new mu (the v1 verifier does the same).
      mu = line.mu[1];
      mCur = meritDual(x, mu, scenario);
      continue;
    }
    const backtracks = line.b;
    k += 1;
    const where = `segment ${seg.index}:step ${k}`;
    const stepSize = stepInit * 0.5 ** backtracks;
    const pg = x.map((v, d) =>
      v - Math.min(PARAMS[d].hi, Math.max(PARAMS[d].lo, v - mCur.gradF[d])));
    const gradientNormBefore = norm2(pg);
    let mNext = null;
    let cand = null;
    for (let bt = 0; bt <= backtracks; bt++) {
      const step = stepInit * 0.5 ** bt;
      const c = projectBox(x.map((v, d) => v - step * mCur.gradF[d]));
      const m = meritDual(c, mu, scenario);
      const decrease = mCur.F - m.F;
      const moveSq = c.reduce((a, v, d) => a + (v - x[d]) ** 2, 0);
      const accepted = decrease > armijoC * moveSq / Math.max(step, 1e-12);
      if (bt < backtracks) {
        if (accepted) {
          return fail(where, 'line-search-replay-divergence', { trial: bt, note: 'recorded as failed but re-derivation accepts it' });
        }
        continue;
      }
      if (!accepted) {
        return fail(where, 'armijo-violation', { trial: bt, decrease, moveSq, step });
      }
      cand = c;
      mNext = m;
    }
    if (!(mNext.F < mCur.F)) {
      return fail(where, 'non-monotone-merit', { before: mCur.F, after: mNext.F });
    }
    const nextRoot = (await commitState(cand, scenario)).root;
    stepCommits.push(stepCommitHash({
      k,
      mu,
      prevRoot: curRoot,
      newRoot: nextRoot,
      newParams: cand,
      backtracks,
      stepSize,
      carbonBefore: mCur.carbon,
      carbonAfter: mNext.carbon,
      meritBefore: mCur.F,
      meritAfter: mNext.F,
      gradientNormBefore,
    }));
    x = cand;
    curRoot = nextRoot;
    mCur = mNext;
  }
  const where = `segment ${seg.index}`;
  if (k !== seg.stepEnd) {
    return fail(where, 'segment-step-count-mismatch', { replayed: k - seg.stepStart, recorded: seg.stepEnd - seg.stepStart });
  }
  for (let d = 0; d < NPARAMS; d++) {
    if (x[d] !== seg.endParams[d]) {
      return fail(where, 'segment-end-params-mismatch', { param: PARAMS[d].name, recorded: seg.endParams[d], replayed: x[d] });
    }
  }
  if (curRoot !== seg.endRoot) {
    return fail(where, 'segment-state-root-mismatch', { recorded: seg.endRoot, replayed: curRoot });
  }
  if (`sha256:${merkleRoot(stepCommits)}` !== seg.stepsRoot) {
    return fail(where, 'segment-merkle-mismatch', { recorded: seg.stepsRoot, replayed: `sha256:${merkleRoot(stepCommits)}` });
  }
  return { ok: true, steps: stepCommits.length };
}

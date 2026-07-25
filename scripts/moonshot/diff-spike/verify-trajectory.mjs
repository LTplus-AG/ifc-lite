/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: the independent verifier.
 *
 * Input: a trajectory certificate chain (trajectory-chain.json) and nothing
 * else - the start parameters live IN the chain header. The verifier never
 * trusts a number the optimizer wrote; it re-derives everything:
 *
 *  per step k-1 -> k:
 *   - re-evaluates the model (battery-validated closed forms) at the
 *     previous state: merit, carbon and gradient must match the recorded
 *     values BITWISE (the whole pipeline is deterministic f64),
 *   - replays the Armijo line search: every recorded backtrack trial must
 *     FAIL the acceptance test, the accepted trial must PASS it, and the
 *     accepted candidate (projected gradient step, box-projected) must
 *     reproduce the recorded new parameters bit for bit - so a "step" is
 *     only accepted if it IS the projected-gradient step the published
 *     algorithm produces, not an arbitrary descent move,
 *   - checks monotone merit descent and the parameter delta,
 *   - recommits the new state (params + re-derived quantities -> DAG root)
 *     and checks the chain linkage (prevRoot/newRoot),
 *   - verifies the step's @ifc-lite/provenance certificate against a
 *     resolver seeded ONLY with the verifier's own re-derived payloads.
 *
 *  at the endpoint (skippable with --skip-kernel):
 *   - rebuilds the IFC from the final parameters and checks its SHA-256
 *     against the endpoint certificate,
 *   - re-runs the real wasm geometry pipeline and compares kernel-measured
 *     carbon/deviation against the bound values (tolerance 1e-9 relative:
 *     mesh-order float accumulation, see DESIGN.md),
 *   - optionally (--recheck-cli) re-runs `ifc-lite validate` and
 *     `ifc-lite clash --mode hard` and compares the bound outcomes.
 *
 * Any tampered step - flipped parameter, faked objective, broken linkage,
 * forged hash - fails with a machine-readable reason. See tamper-test.mjs.
 *
 * v2 (checkpointed) chains - see DESIGN.md section 8 "Chain format v2" -
 * verify through the same re-derivation discipline: a skeleton pass over
 * every segment (boundary recommits, certificates, mu schedule, aggregate
 * claims) plus per-step replay of all segments (FULL) or K seeded-sampled
 * segments (SPOT).
 *
 * Usage:
 *   node scripts/moonshot/diff-spike/verify-trajectory.mjs CHAIN.json \
 *     [--skip-kernel] [--recheck-cli] \
 *     [--mode full|spot] [--spot-k K] [--seed S] [--sidecar PATH]   (v2 only)
 */

import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { meritDual, projectBox } from './optimize.mjs';
import { mulberry32 } from './dual.mjs';
import { buildIfc, REPO_ROOT } from './build-ifc.mjs';
import { kernelVolumes } from './kernel-check.mjs';
import { CARBON_FACTORS } from './carbon-model.mjs';
import {
  CHAIN_VERSION, CHAIN_VERSION_V2, commitState, getKernelIdentity,
  makeStateResolver, nodeIds, endpointKernelPayload, endpointRootPayload,
  sha256hex, canonicalIfc, statePayloads, stepCommitHash, merkleRoot,
} from './trajectory.mjs';

const { computeNodeHash, verifyCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

function norm2(v) {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

function fail(where, reason, details) {
  return { ok: false, failure: { where, reason, details } };
}

/** Shared header checks: chain format version, kernel identity pins, start
 *  parameters finite and inside the box. Returns a failure or null. */
function checkHeader(chain, expectedVersion) {
  if (chain.version !== expectedVersion) {
    return fail('header', 'unsupported-chain-version', { version: chain.version, expected: expectedVersion });
  }
  const local = getKernelIdentity();
  if (chain.kernelVersion !== local.kernelVersion || chain.trustRoot !== local.trustRoot) {
    return fail('header', 'kernel-identity-mismatch', { chain: { kernelVersion: chain.kernelVersion, trustRoot: chain.trustRoot }, local });
  }
  const x = chain.startParams;
  if (!Array.isArray(x) || x.length !== NPARAMS || x.some((v) => !Number.isFinite(v))) {
    return fail('header', 'bad-start-params', { startParams: x });
  }
  for (let i = 0; i < NPARAMS; i++) {
    if (x[i] < PARAMS[i].lo || x[i] > PARAMS[i].hi) {
      return fail('header', 'start-params-out-of-box', { param: PARAMS[i].name, value: x[i] });
    }
  }
  return null;
}

/**
 * Verify a v1 chain object. Returns { ok, failure?, stats }.
 * Fails fast at the first broken record (its index is in `failure.where`).
 */
export async function verifyChain(chain, opts = {}) {
  const { skipKernel = false, recheckCli = false, log = () => {} } = opts;
  const t0 = performance.now();

  // ---- header ----
  const headerFailure = checkHeader(chain, CHAIN_VERSION);
  if (headerFailure) return headerFailure;
  const scenario = chain.scenario;
  const optz = chain.optimizer ?? {};
  const stepInit = optz.stepInit ?? 0.1;
  const armijoC = optz.armijoC ?? 1e-4;
  const btMax = Number.isInteger(optz.btMax) && optz.btMax > 0 ? optz.btMax : 60;
  let currentMu = optz.startMu ?? 10;
  const muFactor = optz.muFactor ?? 4;

  let x = chain.startParams;

  // ---- state 0 ----
  let cur = await commitState(x, scenario);
  if (cur.root !== chain.startRoot) {
    return fail('state-0', 'start-root-mismatch', { expected: chain.startRoot, recomputed: cur.root });
  }

  // Cache the merit evaluation at the current state under the current mu
  // (the accepted eval of step k is the "before" eval of step k+1).
  let mCur = meritDual(x, currentMu, scenario);
  let k = 0;
  let certMs = 0;

  for (const rec of chain.records) {
    if (rec.kind === 'mu-ramp') {
      const where = `record[after step ${k}]:mu-ramp`;
      if (rec.root !== cur.root) {
        return fail(where, 'mu-ramp-root-mismatch', { expected: cur.root, recorded: rec.root });
      }
      if (rec.muBefore !== currentMu || rec.muAfter !== currentMu * muFactor) {
        return fail(where, 'mu-schedule-violation', { rec, currentMu, muFactor });
      }
      currentMu = rec.muAfter;
      mCur = meritDual(x, currentMu, scenario);
      continue;
    }
    if (rec.kind !== 'step') {
      return fail(`record[${k}]`, 'unknown-record-kind', { kind: rec.kind });
    }
    k += 1;
    const where = `step ${k}`;
    if (rec.index !== k) return fail(where, 'step-index-mismatch', { recorded: rec.index });
    if (rec.mu !== currentMu) return fail(where, 'mu-mismatch', { recorded: rec.mu, expected: currentMu });

    // 1. Recomputed "before" values must match bitwise.
    if (mCur.F !== rec.meritBefore) {
      return fail(where, 'merit-before-mismatch', { recorded: rec.meritBefore, recomputed: mCur.F });
    }
    if (mCur.carbon !== rec.carbonBefore) {
      return fail(where, 'objective-before-mismatch', { recorded: rec.carbonBefore, recomputed: mCur.carbon });
    }
    const pg = x.map((v, i) =>
      v - Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v - mCur.gradF[i])));
    const pgNorm = norm2(pg);
    if (pgNorm !== rec.gradientNormBefore) {
      return fail(where, 'gradient-norm-mismatch', { recorded: rec.gradientNormBefore, recomputed: pgNorm });
    }

    // 2. Step-size discipline: geometric halving from stepInit.
    // rec.backtracks is attacker-controlled chain data: a negative, fractional,
    // non-finite, or absurdly large value would skip (or explode) the replay
    // loop below, leaving mNext null or burning unbounded CPU.
    if (!Number.isInteger(rec.backtracks) || rec.backtracks < 0 || rec.backtracks > btMax) {
      return fail(where, 'invalid-backtracks', { recorded: rec.backtracks, btMax });
    }
    const expectedStep = stepInit * 0.5 ** rec.backtracks;
    if (rec.stepSize !== expectedStep) {
      return fail(where, 'step-size-schedule-violation', { recorded: rec.stepSize, expected: expectedStep });
    }

    // 3. Replay the line search: trials before `backtracks` must fail the
    // Armijo test, the recorded trial must pass AND reproduce newParams.
    let mNext = null;
    for (let bt = 0; bt <= rec.backtracks; bt++) {
      const step = stepInit * 0.5 ** bt;
      const cand = projectBox(x.map((v, i) => v - step * mCur.gradF[i]));
      const m = meritDual(cand, currentMu, scenario);
      const decrease = mCur.F - m.F;
      const moveSq = cand.reduce((a, v, i) => a + (v - x[i]) ** 2, 0);
      const accepted = decrease > armijoC * moveSq / Math.max(step, 1e-12);
      if (bt < rec.backtracks) {
        if (accepted) {
          return fail(where, 'line-search-replay-divergence', { trial: bt, note: 'recorded as failed but re-derivation accepts it' });
        }
        continue;
      }
      if (!accepted) {
        return fail(where, 'armijo-violation', { trial: bt, decrease, moveSq, step });
      }
      for (let i = 0; i < NPARAMS; i++) {
        if (cand[i] !== rec.newParams[i]) {
          return fail(where, 'step-not-reproducible', {
            param: PARAMS[i].name, recorded: rec.newParams[i], recomputed: cand[i],
          });
        }
      }
      mNext = m;
    }

    // 4. Delta and monotone descent.
    for (let i = 0; i < NPARAMS; i++) {
      if (rec.newParams[i] - x[i] !== rec.parameterDelta[i]) {
        return fail(where, 'parameter-delta-mismatch', { param: PARAMS[i].name });
      }
    }
    if (mNext.F !== rec.meritAfter) {
      return fail(where, 'merit-after-mismatch', { recorded: rec.meritAfter, recomputed: mNext.F });
    }
    if (mNext.carbon !== rec.carbonAfter) {
      return fail(where, 'objective-after-mismatch', { recorded: rec.carbonAfter, recomputed: mNext.carbon });
    }
    if (!(rec.meritAfter < rec.meritBefore)) {
      return fail(where, 'non-monotone-merit', { before: rec.meritBefore, after: rec.meritAfter });
    }

    // 5. Chain linkage + state commitment.
    if (rec.prevRoot !== cur.root) {
      return fail(where, 'chain-linkage-broken', { expected: cur.root, recorded: rec.prevRoot });
    }
    const next = await commitState(rec.newParams, scenario);
    if (next.root !== rec.newRoot) {
      return fail(where, 'state-root-mismatch', { recorded: rec.newRoot, recomputed: next.root });
    }

    // 6. The provenance certificate, against re-derived payloads only.
    const tCert = performance.now();
    const resolver = makeStateResolver([
      { k: k - 1, committed: cur },
      { k, committed: next },
    ]);
    const res = await verifyCertificate(rec.certificate, resolver, {
      expectedTrustRoot: chain.trustRoot,
      expectedKernelVersion: chain.kernelVersion,
    });
    certMs += performance.now() - tCert;
    if (!res.ok) {
      return fail(where, `certificate-invalid:${res.reason}`, res.details);
    }
    // The certificate must be about THESE states, not merely valid.
    const wroteRoot = rec.certificate.writes.find((w) => w.nodeId === nodeIds(k).root);
    if (!wroteRoot || wroteRoot.hash !== rec.newRoot) {
      return fail(where, 'certificate-detached-from-record', { wroteRoot });
    }

    x = rec.newParams;
    cur = next;
    mCur = mNext;
  }

  if (k !== chain.steps) {
    return fail('chain', 'step-count-mismatch', { recorded: chain.steps, counted: k });
  }
  if (chain.finalState.root !== cur.root) {
    return fail('chain', 'final-root-mismatch', { recorded: chain.finalState.root, recomputed: cur.root });
  }
  const stepsMs = performance.now() - t0;
  log(`steps verified: ${k} in ${(stepsMs / 1000).toFixed(1)}s (certificates: ${(certMs / 1000).toFixed(1)}s)`);

  // ---- endpoint ----
  const epResult = await verifyEndpointSection(chain, x, cur, k, { skipKernel, recheckCli, log });
  if (epResult.failure) return { ok: false, failure: epResult.failure };

  return {
    ok: true,
    stats: {
      steps: k,
      records: chain.records.length,
      stepsMs,
      certMs,
      kernelMs: epResult.kernelMs,
      totalMs: performance.now() - t0,
      endpointKernelChecked: !skipKernel,
      cliRechecked: recheckCli && !skipKernel,
    },
  };
}

/**
 * Endpoint verification shared by the v1 and v2 paths: `x` is the final
 * design vector the (skeleton or replay) walk arrived at, `cur` its
 * committed state, `k` the final step index. Returns `{ kernelMs }` on
 * success, or a fail()-shaped result (whose `.failure` the caller
 * propagates) on any endpoint check failing.
 */
async function verifyEndpointSection(chain, x, cur, k, { skipKernel, recheckCli, log }) {
  const scenario = chain.scenario;
  const ep = chain.endpoint;
  if (!ep) return fail('endpoint', 'missing-endpoint');
  // The bound outcome must itself be kernel-acceptable: hash/certificate
  // checks below only prove the numbers are the ones that were bound, not
  // that they describe an ACCEPTED end state. Sentinels (-1 from unparsed
  // CLI output), non-finite depths, validation errors, or real clashes must
  // fail verification here.
  if (!Number.isInteger(ep.validate?.errors) || ep.validate.errors < 0
    || !Number.isInteger(ep.clash?.real) || ep.clash.real < 0
    || !Number.isFinite(ep.clash?.worstDepth)) {
    return fail('endpoint', 'unmeasured-endpoint', { validate: ep.validate, clash: ep.clash });
  }
  if (ep.validate.errors > 0 || ep.clash.real > 0) {
    return fail('endpoint', 'endpoint-not-acceptable', { validateErrors: ep.validate.errors, realClashes: ep.clash.real });
  }
  if (ep.stateIndex !== k || ep.stateRoot !== cur.root) {
    return fail('endpoint', 'endpoint-state-mismatch', { stateIndex: ep.stateIndex, stateRoot: ep.stateRoot, expected: cur.root });
  }
  // Hash commitments over the bound kernel numbers (exact, from recorded
  // values - the values themselves are re-measured below).
  const kernelHash = await computeNodeHash('property-set', endpointKernelPayload(ep));
  if (kernelHash !== ep.kernelHash) {
    return fail('endpoint', 'kernel-pset-hash-mismatch', { recorded: ep.kernelHash, recomputed: kernelHash });
  }
  const endpointRoot = await computeNodeHash('element', endpointRootPayload(cur.root, kernelHash));
  if (endpointRoot !== ep.endpointRoot) {
    return fail('endpoint', 'endpoint-root-mismatch', { recorded: ep.endpointRoot, recomputed: endpointRoot });
  }
  const resolver = makeStateResolver([{ k, committed: cur }]);
  const epResolver = async (nodeId) => {
    if (nodeId === 'endpoint/kernel') {
      return { kind: 'property-set', payload: endpointKernelPayload(ep) };
    }
    if (nodeId === 'endpoint/root') {
      return { kind: 'element', payload: endpointRootPayload(cur.root, kernelHash) };
    }
    return resolver(nodeId);
  };
  const certRes = await verifyCertificate(ep.certificate, epResolver, {
    expectedTrustRoot: chain.trustRoot,
    expectedKernelVersion: chain.kernelVersion,
  });
  if (!certRes.ok) {
    return fail('endpoint', `certificate-invalid:${certRes.reason}`, certRes.details);
  }

  let kernelMs = 0;
  if (!skipKernel) {
    const tk = performance.now();
    // Rebuild the IFC from the final parameters and pin it to the CANONICAL
    // hash (GlobalIds and two header timestamps are run-local randomness a
    // rebuild cannot reproduce; canonicalIfc() strips exactly those - see
    // trajectory.mjs. The raw ifcSha256 is the on-disk artifact label and
    // is not re-derivable, so it is not checked here.)
    const { content, mapping } = buildIfc(x);
    const sha = `sha256:${sha256hex(canonicalIfc(content))}`;
    if (sha !== ep.ifcCanonicalSha256 || content.length !== ep.ifcBytes) {
      return fail('endpoint', 'ifc-rebuild-mismatch', { recorded: { canonicalSha: ep.ifcCanonicalSha256, bytes: ep.ifcBytes }, recomputed: { canonicalSha: sha, bytes: content.length } });
    }
    // Re-run the real kernel and re-measure.
    const { GeometryProcessor } = await import(
      path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
    );
    const processor = new GeometryProcessor();
    await processor.init();
    const rows = await kernelVolumes(processor, content, mapping);
    const paramVols = new Map(
      statePayloads(x, scenario).numeric.model.elements.map((e) => [e.key, e.volume.v ?? e.volume]));
    let kernelCarbon = 0;
    let worstRel = 0;
    let missing = 0;
    for (const row of rows) {
      if (row.kernelVolume === undefined) { missing += 1; continue; }
      kernelCarbon += row.kernelVolume * CARBON_FACTORS[row.material];
      const pv = paramVols.get(row.key);
      const rel = Math.abs(row.kernelVolume - pv) / Math.max(pv, 1e-12);
      if (rel > worstRel) worstRel = rel;
    }
    // Tolerance rationale: mesh iteration order inside the wasm pipeline is
    // not contractually stable, so float accumulation of per-mesh volumes
    // can differ in the last ulps between runs. 1e-9 relative is ~5 orders
    // looser than ulp noise and ~2 orders tighter than the f32 mesh floor.
    const carbonRel = Math.abs(kernelCarbon - ep.kernel.carbon) / Math.max(ep.kernel.carbon, 1e-12);
    if (carbonRel > 1e-9) {
      return fail('endpoint', 'kernel-carbon-mismatch', { recorded: ep.kernel.carbon, remeasured: kernelCarbon, rel: carbonRel });
    }
    if (Math.abs(worstRel - ep.kernel.worstRelDev) > 1e-9 || missing !== ep.kernel.missingMeshes) {
      return fail('endpoint', 'kernel-deviation-mismatch', { recorded: ep.kernel, remeasured: { worstRel, missing } });
    }
    if (recheckCli) {
      // The chain file's directory may be read-only for the verifier; the
      // rebuilt IFC goes to a temp dir. CLI or parse failures return the
      // machine-readable 'cli-recheck-unavailable' instead of an uncaught
      // rejection tearing down the whole verification.
      try {
        const { runCli, parseCliJson } = await import('./optimize.mjs');
        const tmpIfc = path.join(mkdtempSync(path.join(tmpdir(), 'ifc-lite-verify-')), 'verify-rebuilt.ifc');
        writeFileSync(tmpIfc, content);
        const val = parseCliJson(runCli(['validate', tmpIfc, '--json']).stdout);
        const valErrors = (val.issues ?? []).filter((i) => i.severity === 'error').length;
        if (valErrors !== ep.validate.errors) {
          return fail('endpoint', 'validate-recheck-mismatch', { recorded: ep.validate.errors, remeasured: valErrors });
        }
        const clash = parseCliJson(runCli(['clash', tmpIfc, '--mode', 'hard', '--json']).stdout);
        const real = (clash.clashes ?? []).filter((c) => c.distance < -1e-4).length;
        if (real !== ep.clash.real) {
          return fail('endpoint', 'clash-recheck-mismatch', { recorded: ep.clash.real, remeasured: real });
        }
      } catch (err) {
        return fail('endpoint', 'cli-recheck-unavailable', { message: err.message });
      }
    }
    kernelMs = performance.now() - tk;
    log(`endpoint kernel re-measurement: carbon ${kernelCarbon.toFixed(1)} kgCO2e ` +
      `(rel dev vs bound ${carbonRel.toExponential(2)}), ifc hash pinned, ${(kernelMs / 1000).toFixed(1)}s` +
      (recheckCli ? ', validate+clash rechecked' : ''));
  }

  return { kernelMs };
}

/* ------------------------------------------------------------------ */
/* Chain format v2: checkpointed segments                               */
/* ------------------------------------------------------------------ */

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
 * Fully replay one segment from its (already re-derived) entry state: the
 * same per-step discipline as the v1 verifier - Armijo line-search replay
 * (recorded-failed trials must fail, the accepted trial must pass),
 * monotone merit descent, per-step state recommits - ending in bitwise
 * end-parameter agreement and the segment's Merkle root over the re-derived
 * per-step commitment hashes.
 */
async function replaySegment(chain, seg, entryRoot, startX, sidecar, knobs) {
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
    // The segment certificate, against re-derived payloads only.
    const resolver = makeStateResolver([
      { k: seg.stepStart, committed: prevEnd.committed },
      { k: seg.stepEnd, committed },
    ]);
    const res = await verifyCertificate(seg.certificate, resolver, {
      expectedTrustRoot: chain.trustRoot,
      expectedKernelVersion: chain.kernelVersion,
    });
    if (!res.ok) return fail(where, `certificate-invalid:${res.reason}`, res.details);
    const wroteRoot = seg.certificate.writes.find((w) => w.nodeId === nodeIds(seg.stepEnd).root);
    if (!wroteRoot || wroteRoot.hash !== seg.endRoot) {
      return fail(where, 'certificate-detached-from-segment', { wroteRoot });
    }
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
    const spotK = Number(argValue(argv, '--spot-k') ?? 8);
    // SPOT soundness lives in the seed being the VERIFIER's choice: draw a
    // fresh random one unless --seed reproduces an earlier run.
    const seedArg = argValue(argv, '--seed');
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

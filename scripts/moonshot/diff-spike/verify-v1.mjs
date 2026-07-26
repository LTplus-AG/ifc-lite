/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 trajectory verification: the v1 (one certificate per step) chain
 * verifier. Format v1 is frozen - committed v1 artifacts must keep
 * verifying byte for byte - so this module is intentionally closed to new
 * behaviour; v2 work lands in verify-v2*.mjs.
 *
 * Per step k-1 -> k it re-derives merit/carbon/gradient at the previous
 * state (bitwise), replays the Armijo line search (recorded backtrack
 * trials must fail, the accepted trial must pass AND reproduce the
 * recorded iterate), checks monotone descent, recommits the state DAG,
 * checks linkage, and verifies the step certificate against a resolver
 * seeded only with the verifier's own re-derived payloads.
 */

import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { meritDual, projectBox } from './optimize.mjs';
import { CHAIN_VERSION, commitState, makeStateResolver, nodeIds } from './trajectory.mjs';
import { fail, norm2, checkHeader, verifyCertificate } from './verify-common.mjs';
import { verifyEndpointSection } from './verify-endpoint.mjs';

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

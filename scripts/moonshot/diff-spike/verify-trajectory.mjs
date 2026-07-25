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
 * Usage:
 *   node scripts/moonshot/diff-spike/verify-trajectory.mjs CHAIN.json \
 *     [--skip-kernel] [--recheck-cli]
 */

import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { meritDual, projectBox } from './optimize.mjs';
import { buildIfc, REPO_ROOT } from './build-ifc.mjs';
import { kernelVolumes } from './kernel-check.mjs';
import { CARBON_FACTORS } from './carbon-model.mjs';
import {
  CHAIN_VERSION, commitState, getKernelIdentity, makeStateResolver, nodeIds,
  endpointKernelPayload, endpointRootPayload, sha256hex, canonicalIfc,
  statePayloads,
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

/**
 * Verify a chain object. Returns { ok, failure?, stats }.
 * Fails fast at the first broken record (its index is in `failure.where`).
 */
export async function verifyChain(chain, opts = {}) {
  const { skipKernel = false, recheckCli = false, log = () => {} } = opts;
  const t0 = performance.now();

  // ---- header ----
  if (chain.version !== CHAIN_VERSION) {
    return fail('header', 'unsupported-chain-version', { version: chain.version });
  }
  const local = getKernelIdentity();
  if (chain.kernelVersion !== local.kernelVersion || chain.trustRoot !== local.trustRoot) {
    return fail('header', 'kernel-identity-mismatch', { chain: { kernelVersion: chain.kernelVersion, trustRoot: chain.trustRoot }, local });
  }
  const scenario = chain.scenario;
  const optz = chain.optimizer ?? {};
  const stepInit = optz.stepInit ?? 0.1;
  const armijoC = optz.armijoC ?? 1e-4;
  let currentMu = optz.startMu ?? 10;
  const muFactor = optz.muFactor ?? 4;

  let x = chain.startParams;
  if (!Array.isArray(x) || x.length !== NPARAMS || x.some((v) => !Number.isFinite(v))) {
    return fail('header', 'bad-start-params', { startParams: x });
  }
  for (let i = 0; i < NPARAMS; i++) {
    if (x[i] < PARAMS[i].lo || x[i] > PARAMS[i].hi) {
      return fail('header', 'start-params-out-of-box', { param: PARAMS[i].name, value: x[i] });
    }
  }

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
  const ep = chain.endpoint;
  if (!ep) return fail('endpoint', 'missing-endpoint');
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
      const { runCli, parseCliJson } = await import('./optimize.mjs');
      const tmpIfc = path.join(path.dirname(opts.chainPath ?? '.'), 'verify-rebuilt.ifc');
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
    }
    kernelMs = performance.now() - tk;
    log(`endpoint kernel re-measurement: carbon ${kernelCarbon.toFixed(1)} kgCO2e ` +
      `(rel dev vs bound ${carbonRel.toExponential(2)}), ifc hash pinned, ${(kernelMs / 1000).toFixed(1)}s` +
      (recheckCli ? ', validate+clash rechecked' : ''));
  }

  return {
    ok: true,
    stats: {
      steps: k,
      records: chain.records.length,
      stepsMs,
      certMs,
      kernelMs,
      totalMs: performance.now() - t0,
      endpointKernelChecked: !skipKernel,
      cliRechecked: recheckCli && !skipKernel,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const chainPath = argv.find((a) => !a.startsWith('-'));
  if (!chainPath) {
    console.error('usage: node verify-trajectory.mjs CHAIN.json [--skip-kernel] [--recheck-cli]');
    process.exit(2);
  }
  const chain = JSON.parse(readFileSync(chainPath, 'utf8'));
  const res = await verifyChain(chain, {
    skipKernel: argv.includes('--skip-kernel'),
    recheckCli: argv.includes('--recheck-cli'),
    chainPath,
    log: console.log,
  });
  if (res.ok) {
    const s = res.stats;
    console.log(`VERIFIED: ${s.steps} steps, ${s.records} records, ` +
      `${(s.totalMs / 1000).toFixed(1)}s total` +
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

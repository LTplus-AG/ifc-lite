/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The finite-difference-vs-analytic gradient battery (M3 spike gate a).
 *
 * Protocol (seeded, deterministic):
 *   - NPOINTS random parameter points drawn uniformly from the full
 *     24-dimensional parameter box (mulberry32, seed 42). The full box is
 *     used deliberately: it includes regions where the opening-clip
 *     min/max branches switch, i.e. the piecewise seams of the CSG path.
 *   - At each point, the analytic gradient of two scalar outputs
 *     (embodied carbon [kgCO2e] and total net volume [m3]) is computed
 *     via forward-mode duals, and compared per component against central
 *     finite differences:
 *         fd_i = (f(x + h_i e_i) - f(x - h_i e_i)) / (2 h_i)
 *     with h_i = 1e-5 * max(1, |x_i|) (near-optimal for central
 *     differences in double precision: truncation O(h^2) ~ 1e-10,
 *     cancellation O(eps |f| / h) ~ 1e-9 relative at f ~ 1e5).
 *   - Error metric per component:
 *         relErr_i = |ad_i - fd_i| / max(|ad_i|, |fd_i|, 1e-6)
 *     The absolute floor 1e-6 only matters for identically-zero
 *     components (inactive clip branches), where both sides agree at
 *     the noise level anyway.
 *   - A point PASSES iff every component of every tested output has
 *     relErr <= 1e-6. The gate requires >= 95% of points to pass.
 *
 * Usage: node scripts/moonshot/diff-spike/battery.mjs [NPOINTS]
 */

import { setDim, variable, mulberry32, value, grad } from './dual.mjs';
import { PARAMS, NPARAMS, evaluateModel } from './carbon-model.mjs';

const TOL = 1e-6;
const ABS_FLOOR = 1e-6;
const SEED = 42;

function outputs(x) {
  const model = evaluateModel(x);
  return { carbon: model.carbon, totalVolume: model.totalVolume };
}

function numericOutputs(x) {
  setDim(0);
  const o = outputs(x);
  return { carbon: value(o.carbon), totalVolume: value(o.totalVolume) };
}

export function runBattery(npoints, seed = SEED) {
  const rand = mulberry32(seed);
  let passed = 0;
  const failures = [];
  let maxRelErr = 0;
  let maxRelErrInfo = null;

  for (let k = 0; k < npoints; k++) {
    const x = PARAMS.map((p) => p.lo + rand() * (p.hi - p.lo));

    // Analytic gradients via duals.
    setDim(NPARAMS);
    const dualX = x.map((v, i) => variable(v, i));
    const o = outputs(dualX);
    const ad = {
      carbon: Array.from(grad(o.carbon)),
      totalVolume: Array.from(grad(o.totalVolume)),
    };

    // Central finite differences, component by component.
    let pointOk = true;
    let pointWorst = 0;
    let pointWorstInfo = null;
    for (let i = 0; i < NPARAMS; i++) {
      const h = 1e-5 * Math.max(1, Math.abs(x[i]));
      const xp = x.slice(); xp[i] += h;
      const xm = x.slice(); xm[i] -= h;
      const fp = numericOutputs(xp);
      const fm = numericOutputs(xm);
      for (const key of ['carbon', 'totalVolume']) {
        const fd = (fp[key] - fm[key]) / (2 * h);
        const a = ad[key][i];
        const relErr = Math.abs(a - fd) / Math.max(Math.abs(a), Math.abs(fd), ABS_FLOOR);
        if (relErr > pointWorst) {
          pointWorst = relErr;
          pointWorstInfo = { output: key, param: PARAMS[i].name, ad: a, fd };
        }
        if (relErr > TOL) pointOk = false;
      }
    }
    if (pointWorst > maxRelErr) {
      maxRelErr = pointWorst;
      maxRelErrInfo = { point: k, ...pointWorstInfo };
    }
    if (pointOk) {
      passed += 1;
    } else if (failures.length < 20) {
      failures.push({ point: k, worst: pointWorst, ...pointWorstInfo, x });
    }
  }

  return { npoints, passed, fraction: passed / npoints, failures, maxRelErr, maxRelErrInfo };
}

const isMain = process.argv[1] && import.meta.url.endsWith('battery.mjs') &&
  process.argv[1].endsWith('battery.mjs');
if (isMain) {
  const npoints = Number(process.argv[2] ?? 1000);
  const t0 = performance.now();
  const r = runBattery(npoints);
  const dt = performance.now() - t0;
  console.log(`battery: ${r.passed}/${r.npoints} points passed (${(r.fraction * 100).toFixed(2)}%)`);
  console.log(`tolerance ${TOL} relative (abs floor ${ABS_FLOOR}), seed ${SEED}, ${NPARAMS} params, outputs: carbon + totalVolume`);
  console.log(`max relative error observed: ${r.maxRelErr.toExponential(3)} at`, r.maxRelErrInfo);
  console.log(`gate (>= 95%): ${r.fraction >= 0.95 ? 'PASS' : 'FAIL'}`);
  if (r.failures.length > 0) {
    console.log(`first ${r.failures.length} failing points:`);
    for (const f of r.failures) {
      console.log(`  point ${f.point}: worst relErr ${f.worst.toExponential(3)} on ${f.output}/${f.param} (ad ${f.ad}, fd ${f.fd})`);
    }
  }
  console.log(`elapsed ${(dt / 1000).toFixed(1)}s`);
}

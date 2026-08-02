/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ACT 5 -- DESCENT.
 *
 * Carbon optimization over the M3 diff-spike's differentiable building
 * (scripts/moonshot/diff-spike: 24 parameters, exact dual-number gradients,
 * kgCO2e objective), shortened for the demo: fewer penalty rounds and a
 * smaller PGD iteration budget than the spike's full run, same math. The
 * descent loop below mirrors diff-spike/optimize.mjs's meritDual/pgd
 * verbatim (those internals are not exported; the imported carbon model,
 * autodiff and constraint set ARE the spike's own modules).
 *
 * The optimum is then made REAL and validated by the kernel:
 *   - buildIfc() authors the optimum as IFC (deterministic bytes via
 *     IfcCreator's Timestamp/GuidSource options, seeded through
 *     world-gym's deterministic-create helpers so the file hash is
 *     seed-stable and byte-compatible with the old runtime-shim output);
 *   - the geometry kernel meshes it and per-element mesh volumes are
 *     compared against the parametric model's claimed volumes;
 *   - the world-gym schema check (the literal `ifc-lite validate` code
 *     path) passes judgment on the bytes.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  add, grad, mul, relu, scale, setDim, value, variable,
} from '../diff-spike/dual.mjs';
import {
  CARBON_FACTORS, NPARAMS, PARAMS, constraints, evaluateModel, evaluateNumeric,
} from '../diff-spike/carbon-model.mjs';
import { buildIfc } from '../diff-spike/build-ifc.mjs';
import { kernelVolumes } from '../diff-spike/kernel-check.mjs';
import { FIXED_EPOCH_MS, seededGuidSource } from '../../../tools/world-gym/lib/deterministic-create.mjs';
import { initChecks, parseStore, schemaCheckInProcess } from '../../../tools/world-gym/lib/checks.mjs';
import { OUT_DIR, banner, round, say, sha256, short } from './util.mjs';

const G_SCALE = { 'floor-area': 100 };

function meritDual(x, mu) {
  setDim(NPARAMS);
  const dualX = x.map((v, i) => variable(v, i));
  const model = evaluateModel(dualX);
  const gs = constraints(dualX, model);
  let F = scale(model.carbon, 1e-3); // tonnes, keeps the objective O(100)
  for (const c of gs) {
    const s = G_SCALE[c.name] ?? 1;
    const viol = relu(scale(c.g, 1 / s));
    F = add(F, scale(mul(viol, viol), mu));
  }
  return { F: value(F), gradF: Array.from(grad(F)) };
}

function projectBox(x) {
  return x.map((v, i) => Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v)));
}

function norm2(v) {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

/** diff-spike optimize.mjs's projected-gradient descent, reduced budget. */
function pgd(x0, mu, maxIter, tol = 1e-9) {
  let x = x0.slice();
  let { F, gradF } = meritDual(x, mu);
  let iters = 0;
  for (; iters < maxIter; iters++) {
    let step = 0.1;
    let improved = false;
    for (let bt = 0; bt < 40; bt++) {
      const cand = projectBox(x.map((v, i) => v - step * gradF[i]));
      const m = meritDual(cand, mu);
      const decrease = F - m.F;
      const moveSq = cand.reduce((a, v, i) => a + (v - x[i]) ** 2, 0);
      if (decrease > 1e-4 * moveSq / Math.max(step, 1e-12)) {
        x = cand;
        F = m.F;
        gradF = m.gradF;
        improved = true;
        break;
      }
      step *= 0.5;
    }
    if (!improved) break;
    const pg = x.map((v, i) => v - Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v - gradF[i])));
    if (norm2(pg) < tol) break;
  }
  return { x, iters };
}

export async function runAct5({ seed, rounds = 6, maxIter = 400 }) {
  banner(5, 'DESCENT', 'exact gradients push carbon downhill; the kernel confirms the optimum is real');

  // Shortened penalty loop (spike: 12 rounds x 2000 iters; demo: fewer, same math).
  let x = PARAMS.map((p) => (p.lo + p.hi) / 2);
  const startCarbon = evaluateNumeric(x).carbon;
  say(`  start (box centre): ${startCarbon.toFixed(1)} kgCO2e embodied carbon`);

  const history = [];
  let mu = 10;
  for (let r = 0; r < rounds; r++) {
    const res = pgd(x, mu, maxIter);
    x = res.x;
    const n = evaluateNumeric(x);
    const maxViol = Math.max(0, ...n.constraints.map((c) => c.g / (G_SCALE[c.name] ?? 1)));
    history.push({ round: r, mu, carbon: round(n.carbon, 3), maxViol: round(maxViol, 9), iters: res.iters });
    say(`  round ${r}: mu=${mu} carbon=${n.carbon.toFixed(1)} kgCO2e maxViol=${maxViol.toExponential(2)} (${res.iters} pgd iters)`);
    if (maxViol < 1e-6 && r >= 2) break;
    mu *= 4;
  }

  const n = evaluateNumeric(x);
  const reductionPct = (1 - n.carbon / startCarbon) * 100;
  const finalMaxViol = history.at(-1).maxViol;
  const residuals = n.constraints
    .filter((c) => c.g / (G_SCALE[c.name] ?? 1) > 1e-6)
    .map((c) => ({ name: c.name, g: round(c.g, 9) }));
  say(`  optimum: ${n.carbon.toFixed(1)} kgCO2e (-${reductionPct.toFixed(1)}% vs start); ` +
    `residual penalty slack ${finalMaxViol.toExponential(2)} scaled ` +
    `(${residuals.length} constraint(s) not yet fully tight -- the full spike run drives this below 1e-6; the demo keeps the descent short)`);

  // Materialize the optimum deterministically and validate with the kernel.
  const { content, mapping } = buildIfc(x, {
    Timestamp: FIXED_EPOCH_MS,
    GuidSource: seededGuidSource(`b35-act5:${seed}`),
  });
  const contentSha = sha256(content);
  const ifcPath = path.join(OUT_DIR, 'act5-optimum.ifc');
  await writeFile(ifcPath, content, 'utf-8');
  say(`  optimum authored as IFC: ${content.length} bytes, ${mapping.length} mapped elements, sha256 ${short(contentSha)}...`);

  const processor = await initChecks(); // same warm GeometryProcessor as acts 1 and 3
  const rows = await kernelVolumes(processor, content, mapping);
  const paramVols = new Map(n.model.elements.map((e) => [e.key, value(e.volume)]));
  let worstRel = 0;
  let worstKey = null;
  let kernelCarbon = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.kernelVolume === undefined) { missing += 1; continue; }
    const factor = CARBON_FACTORS[row.material];
    if (factor === undefined) {
      throw new Error(`act5: unknown material "${row.material}" for ${row.key} -- NaN would silently poison carbonRelDev`);
    }
    kernelCarbon += row.kernelVolume * factor;
    const pv = paramVols.get(row.key);
    const rel = Math.abs(row.kernelVolume - pv) / Math.max(pv, 1e-12);
    if (rel > worstRel) { worstRel = rel; worstKey = row.key; }
  }
  const carbonRelDev = Math.abs(kernelCarbon - n.carbon) / n.carbon;
  say(`  kernel re-measured every element: worst volume deviation ${worstRel.toExponential(2)} (${worstKey}), missing meshes: ${missing}`);
  say(`  kernel-derived carbon: ${kernelCarbon.toFixed(1)} kgCO2e vs parametric ${n.carbon.toFixed(1)} (rel dev ${carbonRelDev.toExponential(2)})`);

  const schema = schemaCheckInProcess(await parseStore(content, 'act5-optimum.ifc'));
  say(`  ifc-lite validate (in-process): valid=${schema.valid} (${schema.errors} errors, ${schema.warnings} warnings)`);

  say('');
  say(`  HEADLINE: carbon ${startCarbon.toFixed(0)} -> ${n.carbon.toFixed(0)} kgCO2e (-${reductionPct.toFixed(1)}%), ` +
    `kernel agrees within ${(carbonRelDev * 100).toFixed(3)}%`);

  return {
    deterministic: {
      params: Object.fromEntries(PARAMS.map((p, i) => [p.name, round(x[i], 6)])),
      startCarbonKg: round(startCarbon, 3),
      optimumCarbonKg: round(n.carbon, 3),
      reductionPct: round(reductionPct, 3),
      penaltyRounds: history,
      residualScaledViolation: round(finalMaxViol, 9),
      residualConstraints: residuals,
      optimumIfc: {
        bytes: content.length,
        mappedElements: mapping.length,
        sha256: contentSha,
      },
      kernelValidation: {
        worstElementRelDev: round(worstRel, 9),
        worstElementKey: worstKey,
        missingMeshes: missing,
        kernelCarbonKg: round(kernelCarbon, 3),
        carbonRelDev: round(carbonRelDev, 9),
      },
      schema: { valid: schema.valid, errors: schema.errors, warnings: schema.warnings },
    },
  };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * M3 spike gate (b): a 24-parameter embodied-carbon minimization that
 * must converge to a state the kernel accepts.
 *
 * Method: quadratic-penalty + projected gradient descent.
 *   minimize  carbon(x) + mu * sum_j max(0, g_j(x))^2
 *   subject to box bounds (exact projection).
 * Gradients come from the forward-mode duals (the same analytic path the
 * battery validated). mu is ramped geometrically; each mu level runs
 * projected gradient with backtracking line search until the projected
 * gradient norm stalls.
 *
 * After convergence the optimum is materialized as a real IFC model via
 * @ifc-lite/create and pushed through the kernel as the validity
 * projection:
 *   - the wasm geometry pipeline must mesh every element with zero CSG
 *     failures,
 *   - `ifc-lite validate` must report no structural errors,
 *   - `ifc-lite clash --mode hard` must report zero hard clashes,
 *   - kernel mesh volumes must reproduce the parametric quantities the
 *     optimizer descended on.
 *
 * Usage: node scripts/moonshot/diff-spike/optimize.mjs [--out DIR]
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setDim, variable, value, grad, konst, add, mul, relu, scale } from './dual.mjs';
import { PARAMS, NPARAMS, evaluateModel, constraints, evaluateNumeric, CARBON_FACTORS } from './carbon-model.mjs';
import { buildIfc, REPO_ROOT } from './build-ifc.mjs';
import { kernelVolumes } from './kernel-check.mjs';

const { GeometryProcessor } = await import(
  path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
);

/** Constraint scales to normalize penalty terms to O(1). */
const G_SCALE = {
  'floor-area': 100, // m2-sized constraint
};

function meritDual(x, mu) {
  setDim(NPARAMS);
  const dualX = x.map((v, i) => variable(v, i));
  const model = evaluateModel(dualX);
  const gs = constraints(dualX, model);
  // Carbon in tonnes to keep the objective O(100).
  let F = scale(model.carbon, 1e-3);
  for (const c of gs) {
    const s = G_SCALE[c.name] ?? 1;
    const viol = relu(scale(c.g, 1 / s));
    F = add(F, scale(mul(viol, viol), mu));
  }
  return { F: value(F), gradF: Array.from(grad(F)), carbon: value(model.carbon) };
}

function projectBox(x) {
  return x.map((v, i) => Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v)));
}

function norm2(v) {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

/**
 * Projected gradient with backtracking Armijo line search at fixed mu.
 */
function pgd(x0, mu, maxIter = 2000, tol = 1e-9) {
  let x = x0.slice();
  let { F, gradF } = meritDual(x, mu);
  let iters = 0;
  for (; iters < maxIter; iters++) {
    // Projected-gradient step with backtracking.
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
    // Projected gradient norm (measure of stationarity within the box).
    const pg = x.map((v, i) =>
      v - Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v - gradF[i])));
    if (norm2(pg) < tol) break;
  }
  return { x, F, iters };
}

export function optimize() {
  // Start from the box centre.
  let x = PARAMS.map((p) => (p.lo + p.hi) / 2);
  const history = [];
  let mu = 10;
  for (let round = 0; round < 12; round++) {
    const r = pgd(x, mu);
    x = r.x;
    const n = evaluateNumeric(x);
    const maxViol = Math.max(0, ...n.constraints.map((c) => c.g / (G_SCALE[c.name] ?? 1)));
    history.push({ round, mu, carbon: n.carbon, maxViol, iters: r.iters });
    if (maxViol < 1e-6 && round >= 3) break;
    mu *= 4;
  }
  return { x, history };
}

function runCli(args) {
  const res = spawnSync('node', [path.join(REPO_ROOT, 'packages/cli/dist/index.js'), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

/**
 * The wasm pipeline writes "[IFC-LITE] ..." progress lines to stdout ahead
 * of the JSON payload; strip everything before the payload. Both validate
 * and clash emit a JSON OBJECT, so anchor on a line-initial "{" (a "["
 * anchor would false-match the "[IFC-LITE]" log prefix).
 */
function parseCliJson(stdout) {
  const start = stdout.search(/^\{/m);
  if (start < 0) throw new Error('no JSON in CLI output');
  return JSON.parse(stdout.slice(start));
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0
    ? process.argv[outIdx + 1]
    : path.join(tmpdir(), 'ifc-lite-diff-spike');
  mkdirSync(outDir, { recursive: true });

  const t0 = performance.now();
  const { x, history } = optimize();
  const optMs = performance.now() - t0;

  console.log('penalty rounds:');
  for (const h of history) {
    console.log(
      `  round ${h.round}: mu=${h.mu} carbon=${h.carbon.toFixed(1)} kgCO2e ` +
      `maxViol=${h.maxViol.toExponential(2)} pgd-iters=${h.iters}`,
    );
  }

  const n = evaluateNumeric(x);
  console.log('---');
  console.log(`optimum after ${(optMs / 1000).toFixed(1)}s:`);
  for (let i = 0; i < NPARAMS; i++) {
    const p = PARAMS[i];
    const atLo = Math.abs(x[i] - p.lo) < 1e-9 ? ' [at lower bound]' : '';
    const atHi = Math.abs(x[i] - p.hi) < 1e-9 ? ' [at upper bound]' : '';
    console.log(`  ${p.name.padEnd(5)} = ${x[i].toFixed(4)}${atLo}${atHi}`);
  }
  console.log(`  carbon = ${n.carbon.toFixed(1)} kgCO2e (${(n.carbon / 1000).toFixed(2)} t)`);
  const active = n.constraints.filter((c) => c.g > -1e-3);
  console.log(`  active/near-active constraints: ${active.map((c) => `${c.name} (g=${c.g.toExponential(2)})`).join(', ') || 'none'}`);
  const violated = n.constraints.filter((c) => c.g > 1e-6);
  console.log(`  violated constraints: ${violated.length === 0 ? 'none' : JSON.stringify(violated)}`);

  // Baseline for context: carbon at the box-centre start point.
  const start = PARAMS.map((p) => (p.lo + p.hi) / 2);
  const nStart = evaluateNumeric(start);
  console.log(`  start-point carbon (box centre): ${nStart.carbon.toFixed(1)} kgCO2e`);

  // ---- Kernel validity projection at the optimum ----
  const { content, mapping } = buildIfc(x);
  const ifcPath = path.join(outDir, 'optimum.ifc');
  writeFileSync(ifcPath, content);
  console.log('---');
  console.log(`optimum IFC written: ${ifcPath} (${content.length} bytes, ${mapping.length} mapped elements)`);

  // 1. Mesh with the kernel and compare quantities.
  const processor = new GeometryProcessor();
  await processor.init();
  const rows = await kernelVolumes(processor, content, mapping);
  const paramVols = new Map(n.model.elements.map((e) => [e.key, value(e.volume)]));
  let worstRel = 0;
  let worstKey = null;
  let kernelCarbon = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.kernelVolume === undefined) { missing += 1; continue; }
    kernelCarbon += row.kernelVolume * CARBON_FACTORS[row.material];
    const pv = paramVols.get(row.key);
    const rel = Math.abs(row.kernelVolume - pv) / Math.max(pv, 1e-12);
    if (rel > worstRel) { worstRel = rel; worstKey = row.key; }
  }
  console.log(`kernel quantities: worst element rel dev ${worstRel.toExponential(3)} (${worstKey}), missing meshes: ${missing}`);
  console.log(`kernel-derived carbon: ${kernelCarbon.toFixed(1)} kgCO2e vs parametric ${n.carbon.toFixed(1)} (rel dev ${(Math.abs(kernelCarbon - n.carbon) / n.carbon).toExponential(3)})`);

  // 2. ifc-lite validate.
  const val = runCli(['validate', ifcPath, '--json']);
  let valSummary = 'validate: could not parse output';
  try {
    const parsed = parseCliJson(val.stdout);
    const errors = (parsed.issues ?? []).filter((i) => i.severity === 'error');
    valSummary = `validate: ${errors.length} error(s), ${(parsed.issues ?? []).length} issue(s) total (exit ${val.status})`;
    if (errors.length > 0) console.log(JSON.stringify(errors, null, 2));
  } catch {
    console.log(val.stdout, val.stderr);
  }
  console.log(valSummary);

  // 3. ifc-lite clash, hard mode, whole model against itself.
  // The model contains INTENTIONAL face-to-face contacts (walls sitting
  // on slabs, columns under slabs, roof on top-storey walls, corner
  // joints, door leaves on the floor). Meshes are f32, so coincident
  // contact faces cross by a few microns and the exact narrow phase
  // reports them as `hard` findings with micrometre depths. We apply
  // the clash package's own published contact band
  // (TOUCHING_EPSILON = 1e-4 m in packages/clash/src/analysis.ts,
  // `isTouching`): findings at or below it are face contacts, not
  // interpenetrations. Anything deeper is reported as a REAL clash.
  const clash = runCli(['clash', ifcPath, '--mode', 'hard', '--json']);
  let clashSummary = 'clash: could not parse output';
  try {
    const parsed = parseCliJson(clash.stdout);
    const all = parsed.clashes ?? [];
    const TOUCHING_EPSILON = 1e-4;
    const real = all.filter((c) => c.distance < -TOUCHING_EPSILON);
    const worstPen = all.reduce((a, c) => Math.min(a, c.distance), 0);
    clashSummary =
      `clash: ${real.length} real hard clash(es) deeper than the ${TOUCHING_EPSILON} m contact band; ` +
      `${all.length - real.length} face contact(s), worst depth ${Math.abs(worstPen).toExponential(2)} m`;
    for (const c of real.slice(0, 10)) {
      console.log(`  REAL clash: ${c.a?.tag} "${c.a?.name}" x ${c.b?.tag} "${c.b?.name}" depth ${(-c.distance).toFixed(4)} m`);
    }
  } catch {
    console.log(clash.stdout?.slice(0, 2000), clash.stderr?.slice(0, 2000));
  }
  console.log(clashSummary);

  writeFileSync(path.join(outDir, 'optimum.json'), JSON.stringify({
    x: Object.fromEntries(PARAMS.map((p, i) => [p.name, x[i]])),
    carbon: n.carbon,
    kernelCarbon,
    history,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});

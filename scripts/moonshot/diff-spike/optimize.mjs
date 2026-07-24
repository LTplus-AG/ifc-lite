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
export const G_SCALE = {
  'floor-area': 100, // m2-sized constraint
};

/**
 * Named optimization scenarios (B3.3 proof-carrying optimization).
 * `baseline` is bit-identical to the original spike run; `strict` tightens
 * the programme (more floor area, more daylight, taller clear height) to
 * show the certification machinery is not single-run.
 */
export const SCENARIOS = {
  baseline: { name: 'baseline', floorAreaMin: 600, daylightFrac: 0.12, headroomMin: 2.5 },
  strict: { name: 'strict', floorAreaMin: 720, daylightFrac: 0.15, headroomMin: 2.7 },
};

export function meritDual(x, mu, scenario = {}) {
  setDim(NPARAMS);
  const dualX = x.map((v, i) => variable(v, i));
  const model = evaluateModel(dualX);
  const gs = constraints(dualX, model, scenario);
  // Carbon in tonnes to keep the objective O(100).
  let F = scale(model.carbon, 1e-3);
  for (const c of gs) {
    const s = G_SCALE[c.name] ?? 1;
    const viol = relu(scale(c.g, 1 / s));
    F = add(F, scale(mul(viol, viol), mu));
  }
  return { F: value(F), gradF: Array.from(grad(F)), carbon: value(model.carbon) };
}

export function projectBox(x) {
  return x.map((v, i) => Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v)));
}

function norm2(v) {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

/**
 * Projected gradient with backtracking Armijo line search at fixed mu.
 *
 * `opts.onAccept`, when supplied, is called synchronously after every
 * ACCEPTED iterate with everything a trajectory certificate needs to
 * re-derive and re-check the step:
 *   { prevX, newX, mu, meritBefore, meritAfter, carbonBefore, carbonAfter,
 *     gradientNormBefore, stepSize, backtracks }
 * The callback observes only; it cannot change the iteration.
 */
export function pgd(x0, mu, opts = {}) {
  const { maxIter = 2000, tol = 1e-9, scenario = {}, onAccept } = opts;
  let x = x0.slice();
  let { F, gradF, carbon } = meritDual(x, mu, scenario);
  let iters = 0;
  for (; iters < maxIter; iters++) {
    // Projected gradient norm at the CURRENT iterate (recorded per step as
    // gradientNormBefore; also the stationarity measure after acceptance).
    const pgBefore = x.map((v, i) =>
      v - Math.min(PARAMS[i].hi, Math.max(PARAMS[i].lo, v - gradF[i])));
    const pgNormBefore = norm2(pgBefore);
    // Projected-gradient step with backtracking.
    let step = 0.1;
    let improved = false;
    for (let bt = 0; bt < 40; bt++) {
      const cand = projectBox(x.map((v, i) => v - step * gradF[i]));
      const m = meritDual(cand, mu, scenario);
      const decrease = F - m.F;
      const moveSq = cand.reduce((a, v, i) => a + (v - x[i]) ** 2, 0);
      if (decrease > 1e-4 * moveSq / Math.max(step, 1e-12)) {
        onAccept?.({
          prevX: x.slice(),
          newX: cand.slice(),
          mu,
          meritBefore: F,
          meritAfter: m.F,
          carbonBefore: carbon,
          carbonAfter: m.carbon,
          gradientNormBefore: pgNormBefore,
          stepSize: step,
          backtracks: bt,
        });
        x = cand;
        F = m.F;
        gradF = m.gradF;
        carbon = m.carbon;
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

export function optimize(opts = {}) {
  const { scenario = {}, onAccept, onMuRamp } = opts;
  // Start from the box centre.
  let x = PARAMS.map((p) => (p.lo + p.hi) / 2);
  const history = [];
  let mu = 10;
  for (let round = 0; round < 12; round++) {
    const r = pgd(x, mu, { scenario, onAccept });
    x = r.x;
    const n = evaluateNumeric(x, scenario);
    const maxViol = Math.max(0, ...n.constraints.map((c) => c.g / (G_SCALE[c.name] ?? 1)));
    history.push({ round, mu, carbon: n.carbon, maxViol, iters: r.iters });
    if (maxViol < 1e-6 && round >= 3) break;
    onMuRamp?.({ round, muBefore: mu, muAfter: mu * 4, x: x.slice() });
    mu *= 4;
  }
  return { x, history };
}

export function runCli(args) {
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
export function parseCliJson(stdout) {
  const start = stdout.search(/^\{/m);
  if (start < 0) throw new Error('no JSON in CLI output');
  return JSON.parse(stdout.slice(start));
}

/**
 * Kernel validity projection at a design point (extracted from main() so the
 * certified runs in optimize-certified.mjs reuse the identical code path):
 * materialize the IFC, mesh it with the real wasm pipeline, compare kernel
 * mesh volumes against the parametric quantities, then run `ifc-lite
 * validate` and `ifc-lite clash --mode hard`.
 *
 * Returns a structured summary; prints the same lines main() always printed
 * via `log` (pass a no-op to silence).
 */
export async function endpointChecks({ x, outDir, fileBase = 'optimum', scenario = {}, log = console.log }) {
  const n = evaluateNumeric(x, scenario);
  const { content, mapping } = buildIfc(x);
  const ifcPath = path.join(outDir, `${fileBase}.ifc`);
  writeFileSync(ifcPath, content);
  log('---');
  log(`optimum IFC written: ${ifcPath} (${content.length} bytes, ${mapping.length} mapped elements)`);

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
  log(`kernel quantities: worst element rel dev ${worstRel.toExponential(3)} (${worstKey}), missing meshes: ${missing}`);
  log(`kernel-derived carbon: ${kernelCarbon.toFixed(1)} kgCO2e vs parametric ${n.carbon.toFixed(1)} (rel dev ${(Math.abs(kernelCarbon - n.carbon) / n.carbon).toExponential(3)})`);

  // 2. ifc-lite validate.
  const val = runCli(['validate', ifcPath, '--json']);
  let validate = { parsed: false, errors: -1, issues: -1, exit: val.status };
  try {
    const parsed = parseCliJson(val.stdout);
    const errors = (parsed.issues ?? []).filter((i) => i.severity === 'error');
    validate = { parsed: true, errors: errors.length, issues: (parsed.issues ?? []).length, exit: val.status };
    if (errors.length > 0) log(JSON.stringify(errors, null, 2));
    log(`validate: ${validate.errors} error(s), ${validate.issues} issue(s) total (exit ${val.status})`);
  } catch {
    log(val.stdout, val.stderr);
    log('validate: could not parse output');
  }

  // 3. ifc-lite clash, hard mode, whole model against itself. See main()'s
  // long comment: findings within the clash package's own published contact
  // band (TOUCHING_EPSILON = 1e-4 m, packages/clash/src/analysis.ts) are
  // face contacts of f32 meshes, not interpenetrations.
  const clashRes = runCli(['clash', ifcPath, '--mode', 'hard', '--json']);
  let clash = { parsed: false, real: -1, contacts: -1, worstDepth: NaN };
  try {
    const parsed = parseCliJson(clashRes.stdout);
    const all = parsed.clashes ?? [];
    const TOUCHING_EPSILON = 1e-4;
    const real = all.filter((c) => c.distance < -TOUCHING_EPSILON);
    const worstPen = all.reduce((a, c) => Math.min(a, c.distance), 0);
    clash = { parsed: true, real: real.length, contacts: all.length - real.length, worstDepth: Math.abs(worstPen) };
    for (const c of real.slice(0, 10)) {
      log(`  REAL clash: ${c.a?.tag} "${c.a?.name}" x ${c.b?.tag} "${c.b?.name}" depth ${(-c.distance).toFixed(4)} m`);
    }
    log(`clash: ${clash.real} real hard clash(es) deeper than the ${TOUCHING_EPSILON} m contact band; ` +
      `${clash.contacts} face contact(s), worst depth ${clash.worstDepth.toExponential(2)} m`);
  } catch {
    log(clashRes.stdout?.slice(0, 2000), clashRes.stderr?.slice(0, 2000));
    log('clash: could not parse output');
  }

  return {
    ifcPath,
    content,
    mapping,
    numeric: n,
    kernel: { carbon: kernelCarbon, worstRelDev: worstRel, worstKey, missingMeshes: missing, meshedElements: mapping.length - missing },
    validate,
    clash,
  };
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
  // (Model comment lives in endpointChecks; the model contains INTENTIONAL
  // face-to-face contacts - walls sitting on slabs, columns under slabs,
  // roof on top-storey walls, corner joints, door leaves on the floor -
  // which f32 meshes turn into micrometre-deep "hard" findings inside the
  // clash package's own published contact band.)
  const ep = await endpointChecks({ x, outDir });

  writeFileSync(path.join(outDir, 'optimum.json'), JSON.stringify({
    x: Object.fromEntries(PARAMS.map((p, i) => [p.name, x[i]])),
    carbon: n.carbon,
    kernelCarbon: ep.kernel.carbon,
    history,
  }, null, 2));
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

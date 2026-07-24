/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parametric-vs-kernel quantity validation for the M3 spike.
 *
 * For K seeded random parameter points (drawn from the buildable
 * subregion where windows fit inside their walls), this script:
 *   1. evaluates the closed-form parametric element volumes,
 *   2. generates the actual IFC via @ifc-lite/create,
 *   3. runs the real wasm geometry pipeline (GeometryProcessor, the same
 *      path the viewer and the clash CLI use, including CSG void cuts),
 *   4. computes each element's mesh volume by the divergence theorem
 *      (sum of signed tetrahedron volumes over the index triangles,
 *      absolute value per mesh), and
 *   5. reports per-element and aggregate relative deviation.
 *
 * Usage: node scripts/moonshot/diff-spike/kernel-check.mjs [K] [--keep-dir DIR]
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setDim, mulberry32, value } from './dual.mjs';
import { PARAMS, evaluateModel } from './carbon-model.mjs';
import { buildIfc, REPO_ROOT } from './build-ifc.mjs';

const { GeometryProcessor } = await import(
  path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
);

/** Sample a buildable point: uniform in bounds, then window fit enforced. */
export function sampleBuildable(rand) {
  const x = PARAMS.map((p) => p.lo + rand() * (p.hi - p.lo));
  const idx = Object.fromEntries(PARAMS.map((p, i) => [p.name, i]));
  // Window must fit: sill + wh + 0.1 <= min(h) - ts.
  const minH = Math.min(x[idx.h1], x[idx.h2], x[idx.h3]);
  const clear = minH - x[idx.ts] - 0.1;
  if (x[idx.sill] + x[idx.wh] > clear) {
    // Rescale sill and wh into the available band, keeping their ratio.
    const s = clear / (x[idx.sill] + x[idx.wh]);
    x[idx.sill] = Math.max(PARAMS[idx.sill].lo, x[idx.sill] * s);
    x[idx.wh] = Math.max(PARAMS[idx.wh].lo, x[idx.wh] * s);
  }
  // Door leaf must be thinner than the partition.
  if (x[idx.dt] >= x[idx.tp]) x[idx.dt] = x[idx.tp] * 0.5;
  return x;
}

/** Signed volume of a triangle mesh via the divergence theorem. */
function meshVolume(positions, indices) {
  let six = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    six += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

export async function kernelVolumes(processor, content, mapping) {
  const bytes = new TextEncoder().encode(content);
  const result = await processor.process(bytes);
  const byId = new Map();
  for (const mesh of result.meshes) {
    const v = Math.abs(meshVolume(mesh.positions, mesh.indices));
    byId.set(mesh.expressId, (byId.get(mesh.expressId) ?? 0) + v);
  }
  const rows = [];
  for (const m of mapping) {
    rows.push({ ...m, kernelVolume: byId.get(m.expressId) });
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const K = Number(args.find((a) => !a.startsWith('-')) ?? 8);
  const keepIdx = args.indexOf('--keep-dir');
  const keepDir = keepIdx >= 0 ? args[keepIdx + 1] : null;

  setDim(0); // numeric-only evaluation, no gradient payload
  const rand = mulberry32(1337);
  const processor = new GeometryProcessor();
  await processor.init();

  const summary = [];
  for (let k = 0; k < K; k++) {
    const x = sampleBuildable(rand);
    const model = evaluateModel(x);
    const paramVols = new Map(model.elements.map((e) => [e.key, value(e.volume)]));
    const { content, mapping } = buildIfc(x);
    if (keepDir) {
      mkdirSync(keepDir, { recursive: true });
      writeFileSync(path.join(keepDir, `kernel-check-${k}.ifc`), content);
    }
    const rows = await kernelVolumes(processor, content, mapping);

    let worst = { relDev: 0 };
    let sumAbsDev = 0;
    let sumVol = 0;
    let missing = 0;
    for (const row of rows) {
      const pv = paramVols.get(row.key);
      if (pv === undefined) throw new Error(`no parametric volume for ${row.key}`);
      if (row.kernelVolume === undefined) {
        missing += 1;
        continue;
      }
      const dev = Math.abs(row.kernelVolume - pv);
      const rel = dev / Math.max(pv, 1e-12);
      sumAbsDev += dev;
      sumVol += pv;
      if (rel > worst.relDev) {
        worst = { relDev: rel, key: row.key, parametric: pv, kernel: row.kernelVolume };
      }
    }
    const point = {
      point: k,
      elements: rows.length,
      missingMeshes: missing,
      aggregateRelDev: sumAbsDev / sumVol,
      worst,
    };
    summary.push(point);
    console.log(
      `point ${k}: ${rows.length} elements, missing ${missing}, ` +
      `aggregate rel dev ${point.aggregateRelDev.toExponential(3)}, ` +
      `worst ${worst.relDev.toExponential(3)} (${worst.key}: parametric ${worst.parametric?.toFixed(6)} vs kernel ${worst.kernel?.toFixed(6)})`,
    );
  }

  const worstAll = summary.reduce((a, b) => (b.worst.relDev > a.worst.relDev ? b : a));
  const meanAgg = summary.reduce((a, b) => a + b.aggregateRelDev, 0) / summary.length;
  console.log('---');
  console.log(`points: ${K}`);
  console.log(`mean aggregate relative deviation: ${meanAgg.toExponential(3)}`);
  console.log(`worst element relative deviation: ${worstAll.worst.relDev.toExponential(3)} (${worstAll.worst.key} at point ${worstAll.point})`);
  const anyMissing = summary.some((s) => s.missingMeshes > 0);
  if (anyMissing) console.log('WARNING: some elements produced no mesh');
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

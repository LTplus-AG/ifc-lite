#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 pass 4 of 4: the only quantity-estimation measurement a foreign model
 * can honestly support.
 *
 * The benchmark's quantity task compares a submission's five totals against
 * plant-time ground truth. Foreign models have no plant time, so that exact
 * comparison is impossible. What a real file DOES carry is authored
 * `IfcElementQuantity` - the quantities the authoring tool itself published -
 * and that is a genuine, externally-authored reference the kernel can be
 * scored against.
 *
 * So: TRUTH = the file's authored Qto values (converted to SI via the file's
 * own `IfcUnitAssignment`). PREDICTION = the volume of the mesh ifc-lite's
 * geometry kernel produces for the same element. The agreement number is
 * computed with the benchmark's OWN formula, unchanged, copied here as one
 * expression so the comparison to the committed 0.977655 is like-for-like:
 *
 *     score = max(0, 1 - |pred - truth| / truth)          [score.mjs]
 *
 * This is NOT the benchmark's quantity-estimation task and its number is not a
 * leaderboard row - the truth source is different (authored Qto, not plant
 * time) and so is the granularity option (per element as well as per model
 * total). It is reported as its own metric, next to the benchmark's, and the
 * report says which is which.
 *
 * KNOWN LIMITS, stated because they bound the number:
 *  - authored NetVolume is the honest target for a kernel mesh, because the
 *    kernel cuts openings; GrossVolume is harvested too but is expected to sit
 *    above the mesh by the volume of the voids.
 *  - GPU-instanced-only entities never appear in `meshes` (see GeometryResult
 *    docs), so per-type mesh coverage is emitted alongside every total.
 *  - mesh volume assumes each submesh is a closed solid. Both the
 *    sum-of-absolute and absolute-of-sum aggregations are emitted, and their
 *    disagreement rate is the openness proxy.
 *  - IfcSpace NetFloorArea has no mesh-side estimator in the kernel's output,
 *    so the benchmark's fifth quantity key is NOT measured here. Said plainly
 *    rather than approximated.
 *
 * Usage:
 *   node --max-old-space-size=10240 run-qto-pass.mjs \
 *     --model <abs path> --alias model-a --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStore, initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { modelId, round } from './lib/model-id.mjs';

const { EntityNode } = await import('../../../packages/query/dist/index.js');
const { extractProjectUnits } = await import('../../../packages/parser/dist/index.js');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelPath = flag('--model');
const alias = flag('--alias');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-qto-pass.mjs --model <path> --alias <id> --out <dir>\n');
  process.exit(2);
}

const bytes = await readFile(modelPath);
const id = modelId(bytes);

const processor = await initChecks();
process.stderr.write('parsing...\n');
const store = await parseStore(bytes, `${alias}.ifc`);

const units = extractProjectUnits(store.source, store.entityIndex);
const volumeUnit = units.unitForMeasure('IfcVolumeMeasure');
const lengthUnit = units.unitForMeasure('IfcLengthMeasure');
// A file that declares no IfcVolumeMeasure unit falls back to a scale of 1,
// i.e. authored quantities are treated as cubic metres on faith. That
// assumption silently decides every score in this pass, so it is emitted as
// its own boolean rather than left to be inferred from a null symbol.
//
// The boolean must come from `resolvedForUnitType`, NOT from the resolved
// unit's scale. `unitForMeasure()` never returns null for a measure it knows:
// it falls back to `{ symbol: <SI default>, siScale: 1.0 }`, so
// `volumeUnit?.siScale != null` was true for every file ever handed to this
// pass, declared or not. Verified by construction on an IFC4 file declaring
// only LENGTHUNIT: the old form reports `true`, `resolvedForUnitType(
// 'VOLUMEUNIT')` reports `undefined`. A flag with one reachable value is not
// evidence, and this one guards every score in the pass.
const volumeUnitResolved = units.resolvedForUnitType('VOLUMEUNIT');
const volumeUnitDeclared = volumeUnitResolved !== undefined;
// The scale still comes from the resolved measure unit (which is the declared
// one when there is one, and the SI identity when there is not). It is NOT
// derived from lengthUnit: IFC declares VOLUMEUNIT in its own right, and
// cubing a length scale would invent a conversion the file never stated.
const volumeToSi = volumeUnit?.siScale ?? 1;

process.stderr.write('geometry...\n');
const tGeom = performance.now();
const result = await processor.process(bytes);
const geomMs = performance.now() - tGeom;

// --- mesh volume, per element ----------------------------------------------
// Signed volume of a triangle soup: sum (1/6) * a . (b x c). Winding is
// documented as unreliable, so both aggregations are kept (see header).
function signedVolume(positions, indices) {
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

const perElement = new Map(); // expressId -> { sumAbs, absSum, meshes }
let skippedInstancedTemplates = 0;
// A single NaN or Infinity would propagate through sumAbs into every total
// this pass reports, and `NaN > 0` is false everywhere downstream, so it would
// vanish rather than fail. Counted and skipped instead.
let nonFiniteMeshVolumes = 0;
for (const m of result.meshes) {
  if ((m.geometryClass ?? 0) === 2) { skippedInstancedTemplates += 1; continue; }
  const v = signedVolume(m.positions, m.indices);
  if (!Number.isFinite(v)) { nonFiniteMeshVolumes += 1; continue; }
  const slot = perElement.get(m.expressId) ?? { sumAbs: 0, absSum: 0, meshes: 0 };
  slot.sumAbs += Math.abs(v);
  slot.absSum += v;
  slot.meshes += 1;
  perElement.set(m.expressId, slot);
}

// --- authored Qto, per element ---------------------------------------------
const TYPE_GROUPS = {
  wall: ['IFCWALL', 'IFCWALLSTANDARDCASE'],
  slab: ['IFCSLAB', 'IFCSLABSTANDARDCASE'],
  column: ['IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE'],
  beam: ['IFCBEAM', 'IFCBEAMSTANDARDCASE'],
  covering: ['IFCCOVERING'],
  footing: ['IFCFOOTING'],
  member: ['IFCMEMBER'],
  roof: ['IFCROOF'],
  door: ['IFCDOOR'],
  window: ['IFCWINDOW'],
};

/** The benchmark's per-value quantity score, verbatim from score.mjs. */
const benchScore = (pred, truth) => Math.max(0, 1 - Math.abs(pred - truth) / truth);

function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const groups = {};
const allElementScores = [];
let openMeshElements = 0;
let closedMeshElements = 0;

for (const [group, types] of Object.entries(TYPE_GROUPS)) {
  let elements = 0;
  let withMesh = 0;
  let withNet = 0;
  let withGross = 0;
  let authoredNetTotal = 0;
  let authoredGrossTotal = 0;
  let kernelTotalOverNetPaired = 0;
  // The model-total comparison MUST be taken over the paired subset only.
  // Summing every authored NetVolume against a kernel total that can only
  // include elements which produced a mesh would charge the kernel for the
  // elements it was never given, which is a different (and much larger)
  // finding about mesh coverage, reported separately as meshCoveragePct.
  let authoredNetTotalOverPaired = 0;
  const scores = [];
  const relErrors = [];

  for (const type of types) {
    for (const eid of store.entityIndex.byType.get(type) ?? []) {
      elements += 1;
      const mesh = perElement.get(eid);
      if (mesh) {
        withMesh += 1;
        const disagreement = mesh.sumAbs > 0 ? Math.abs(mesh.sumAbs - Math.abs(mesh.absSum)) / mesh.sumAbs : 0;
        if (disagreement > 0.01) openMeshElements += 1; else closedMeshElements += 1;
      }
      const node = new EntityNode(store, eid);
      let net = null;
      let gross = null;
      for (const qs of node.quantities()) {
        for (const q of qs.quantities) {
          if (q.name === 'NetVolume' && Number.isFinite(q.value)) net ??= q.value * volumeToSi;
          else if (q.name === 'GrossVolume' && Number.isFinite(q.value)) gross ??= q.value * volumeToSi;
        }
      }
      if (net !== null && net > 0) { withNet += 1; authoredNetTotal += net; }
      if (gross !== null && gross > 0) { withGross += 1; authoredGrossTotal += gross; }

      if (mesh && net !== null && net > 0) {
        const pred = mesh.sumAbs;
        kernelTotalOverNetPaired += pred;
        authoredNetTotalOverPaired += net;
        const s = benchScore(pred, net);
        scores.push(s);
        allElementScores.push(s);
        relErrors.push((pred - net) / net);
      }
    }
  }

  groups[group] = {
    elements,
    withMesh,
    meshCoveragePct: elements > 0 ? round((withMesh / elements) * 100, 4) : null,
    withAuthoredNetVolume: withNet,
    withAuthoredGrossVolume: withGross,
    pairedElements: scores.length,
    authoredNetVolumeTotalAllElementsM3: round(authoredNetTotal, 4),
    authoredGrossVolumeTotalAllElementsM3: round(authoredGrossTotal, 4),
    authoredNetVolumeTotalOverPairedM3: round(authoredNetTotalOverPaired, 4),
    kernelMeshVolumeTotalOverPairedM3: round(kernelTotalOverNetPaired, 4),
    // Model-total agreement, the granularity the benchmark's own task uses,
    // over the paired subset (see the comment where authoredNetTotalOverPaired
    // is declared for why the all-elements total is not the denominator).
    modelTotalBenchScore: authoredNetTotalOverPaired > 0
      ? round(benchScore(kernelTotalOverNetPaired, authoredNetTotalOverPaired), 6) : null,
    // What fraction of the model's authored NetVolume the paired subset covers.
    authoredNetVolumeCoveredByPairingPct: authoredNetTotal > 0
      ? round((authoredNetTotalOverPaired / authoredNetTotal) * 100, 4) : null,
    // Per-element agreement, the granularity that shows the distribution.
    meanElementBenchScore: scores.length > 0 ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 6) : null,
    medianElementBenchScore: scores.length > 0 ? round(median(scores), 6) : null,
    medianRelativeError: relErrors.length > 0 ? round(median(relErrors), 6) : null,
    within1PctCount: scores.filter((s) => s >= 0.99).length,
    within5PctCount: scores.filter((s) => s >= 0.95).length,
    within10PctCount: scores.filter((s) => s >= 0.9).length,
  };
}

// Composite elements are frequently exported with their body geometry on
// IfcBuildingElementPart children rather than on the element itself, which is
// the usual reason a group's mesh coverage is far below 100%. Counting the
// parts (and how many of them meshed) is what separates "the kernel dropped
// this element" from "this element never carried a body".
const partIds = store.entityIndex.byType.get('IFCBUILDINGELEMENTPART') ?? [];
const partsWithMesh = partIds.filter((eid) => perElement.has(eid)).length;

const totalPaired = allElementScores.length;
const pairedAuthoredTotal = Object.values(groups).reduce((a, g) => a + (g.authoredNetVolumeTotalOverPairedM3 ?? 0), 0);
const pairedKernelTotal = Object.values(groups).reduce((a, g) => a + (g.kernelMeshVolumeTotalOverPairedM3 ?? 0), 0);
const out = {
  bet: 'B5.2',
  pass: 'qto',
  alias,
  modelSha256Prefix: id,
  bytes: bytes.byteLength,
  geometryMs: round(geomMs, 1),
  // Sampled once, here, at the end of the pass - not a high-water mark over
  // the parse and geometry stages. Named for what it is.
  rssAtExitMb: round(process.memoryUsage().rss / 1e6, 1),
  units: {
    declaredUnitCount: units.declaredCount,
    lengthSymbol: lengthUnit?.symbol ?? null,
    lengthSiScale: lengthUnit?.siScale ?? null,
    // The symbol is the RESOLVED one, which falls back to the SI default when
    // the file declared nothing; `volumeUnitDeclared` is what says which.
    volumeSymbol: volumeUnit?.symbol ?? null,
    volumeUnitDeclared,
    volumeSiScale: volumeToSi,
  },
  meshes: {
    total: result.meshes.length,
    distinctElements: perElement.size,
    skippedInstancedTemplates,
    nonFiniteMeshVolumes,
    totalTriangles: result.totalTriangles,
    totalVertices: result.totalVertices,
    elementsWithClosedMeshSet: closedMeshElements,
    elementsWithOpenMeshSet: openMeshElements,
    openMeshSetPct: (closedMeshElements + openMeshElements) > 0
      ? round((openMeshElements / (closedMeshElements + openMeshElements)) * 100, 4) : null,
    buildingElementParts: partIds.length,
    buildingElementPartsWithMesh: partsWithMesh,
  },
  groups,
  overall: {
    pairedElements: totalPaired,
    meanElementBenchScore: totalPaired > 0 ? round(allElementScores.reduce((a, b) => a + b, 0) / totalPaired, 6) : null,
    medianElementBenchScore: totalPaired > 0 ? round(median(allElementScores), 6) : null,
    within1PctCount: allElementScores.filter((s) => s >= 0.99).length,
    within5PctCount: allElementScores.filter((s) => s >= 0.95).length,
    within10PctCount: allElementScores.filter((s) => s >= 0.9).length,
    within1PctOfPairedPct: totalPaired > 0 ? round((allElementScores.filter((s) => s >= 0.99).length / totalPaired) * 100, 4) : null,
    within5PctOfPairedPct: totalPaired > 0 ? round((allElementScores.filter((s) => s >= 0.95).length / totalPaired) * 100, 4) : null,
    zeroScoreCount: allElementScores.filter((s) => s === 0).length,
    authoredNetVolumeTotalOverPairedM3: round(pairedAuthoredTotal, 4),
    kernelMeshVolumeTotalOverPairedM3: round(pairedKernelTotal, 4),
    modelTotalBenchScore: pairedAuthoredTotal > 0 ? round(benchScore(pairedKernelTotal, pairedAuthoredTotal), 6) : null,
  },
  notMeasured: {
    roomNetFloorArea: 'no mesh-side estimator in the kernel geometry output; the benchmark key is left unmeasured rather than approximated',
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `qto-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

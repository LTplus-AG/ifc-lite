#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * G2 tightness benchmark for Bet B1.4 (docs/vision/moonshots-execution-plan.md,
 * Phase 1, "Region footprints (M1 to M4 handoff): affected-region hashes
 * computed per op, measured for tightness on collab traces"), measuring
 * exactly what M4's kill criterion (docs/vision/moonshots-execution-plan.md
 * §5) asks: "if footprint tightening cannot get false-conflict rate below
 * 20% on realistic traces, provable auto-merge is impractical." The
 * measurement is the deliverable, not an afterthought — this script IS that
 * measurement, run against real mesh-bearing geometry from duplex.ifc (same
 * fixture and DAG-building convention as g1-memoized-recompute.mjs / B1.1).
 *
 * Builds a real `ProvenanceDag` over duplex.ifc (leaf -> element -> storey
 * relationship -> root layer, identical shape to g1), computes each
 * candidate element's world-space AABB from its OWN geometry-mesh leaves via
 * `@ifc-lite/provenance`'s `aabbFromMesh`/`unionAabb`, then generates 200
 * randomized op PAIRS (seeded PRNG, reproducible) across three classes whose
 * ground truth is known BY CONSTRUCTION, not asserted after the fact:
 *
 * - (a) truly-independent: two DIFFERENT, UNIFORMLY RANDOM candidate
 *   elements — no spatial pre-filtering at all. Ground truth "no conflict"
 *   comes from op semantics, not geometry: neither op declares any
 *   relationship to the other, so by construction they are independent
 *   edits (the M4 scenario this class models is exactly "two collaborators
 *   editing different, unrelated elements of a large model concurrently").
 *   Deliberately NOT filtered to be geometrically far apart — filtering by
 *   `maxAxisGap > k * epsilon` would make `falseConflictRate` tautological
 *   (the predicate's own spatial test IS `maxAxisGap <= 2 * epsilon`, so
 *   excluding small gaps by construction guarantees zero false conflicts by
 *   definition, measuring nothing). Leaving the sample unfiltered means
 *   whatever AABB-coarseness effects are actually present in duplex.ifc
 *   (e.g. a slab's AABB spanning most of a storey's footprint, overlapping
 *   unrelated furniture below it) surface honestly in the measured rate.
 *   `falseConflictRate` on this class is the headline tightness number and
 *   the exact quantity M4's kill criterion (docs/vision/
 *   moonshots-execution-plan.md §5) is stated in terms of.
 * - (b) truly-conflicting: either the SAME element edited via two different
 *   targets (a pset leaf + a mesh leaf — different edit kinds, same
 *   element), or two ops that target the literal SAME pset node id. Both
 *   are guaranteed structural conflicts under footprint.ts's own crux rule
 *   (the target/element node is shared, never filtered as a container).
 *   `soundness.missed` must be 0 — the point is the predicate can never
 *   report "no conflict" for these BY CONSTRUCTION, checked here for real,
 *   not just asserted.
 * - (c) near-miss: two DIFFERENT elements whose AABB gap is within
 *   `(0, 2 * epsilonMm]` on the tightest axis — literally "adjacent within
 *   2x epsilon" per the task brief. These are NOT scored pass/fail (ground
 *   truth is genuinely ambiguous: adjacent-but-distinct elements, e.g. two
 *   walls meeting at a corner, are legitimately independent edits that
 *   happen to sit right at the epsilon boundary) — `nearMissConflictRate`
 *   is reported purely informationally, exactly per the task brief.
 *
 * `maxAxisGap(boxA, boxB)`: for each axis, `gap = max(aMin - bMax, bMin -
 * aMax)` (positive = separated on this axis, <=0 = overlapping on this
 * axis); the pair's `maxAxisGap` is the max over the 3 axes — the SAME
 * quantity `conflictPredicate`'s epsilon-inflated AABB intersection test
 * implicitly evaluates (two boxes, each inflated by `epsilonMm` per side,
 * intersect iff `maxAxisGap(rawA, rawB) <= 2 * epsilonMm`). Classes (a) and
 * (c) are defined directly in terms of this quantity so the ground-truth
 * labels are geometric facts about the real fixture, not a restatement of
 * the predicate under test.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { loadIfcFile } = await import(path.join(REPO_ROOT, 'packages/cli/dist/loader.js'));
const { RelationshipType } = await import(path.join(REPO_ROOT, 'packages/data/dist/index.js'));
const { GeometryProcessor } = await import(path.join(REPO_ROOT, 'packages/geometry/dist/index.js'));
const {
  ProvenanceDag,
  computeFootprint,
  conflictPredicate,
  aabbFromMesh,
  unionAabb,
  DEFAULT_EPSILON_MM,
} = await import(path.join(REPO_ROOT, 'packages/provenance/dist/index.js'));

const FIXTURE = path.resolve(REPO_ROOT, process.argv[2] ?? 'tests/models/ara3d/duplex.ifc');
const EPSILON_MM = Number(process.argv[3] ?? DEFAULT_EPSILON_MM);
const EPSILON_M = EPSILON_MM / 1000;

const TOTAL_PAIRS = 200;
const CLASS_COUNTS = { independent: 80, conflicting: 60, nearMiss: 60 }; // sums to TOTAL_PAIRS
if (CLASS_COUNTS.independent + CLASS_COUNTS.conflicting + CLASS_COUNTS.nearMiss !== TOTAL_PAIRS) {
  throw new Error('[g2] CLASS_COUNTS must sum to TOTAL_PAIRS');
}
const SEED = Number(process.argv[4] ?? 20260724);
const MAX_ATTEMPTS_PER_PAIR = 200_000;

/* ------------------------------------------------------------------ */
/* Deterministic PRNG (mulberry32) — same generator as dag-engine.test.ts */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* DAG structure — same convention as g1-memoized-recompute.mjs's         */
/* buildDagStructure (leaf -> element -> storey relationship -> root)     */
/* ------------------------------------------------------------------ */

function normalizePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function buildDagStructure(store, meshes) {
  const storeyEntities = store.getEntitiesByType('IfcBuildingStorey');
  const storeys = storeyEntities.map((s) => ({
    expressId: s.expressId,
    elementIds: store.relationships.getRelated(s.expressId, RelationshipType.ContainsElements, 'forward'),
  }));

  const elementMeta = new Map();
  const initialLeafPayloads = new Map();
  const elementChildren = new Map();

  for (const storey of storeys) {
    for (const expressId of storey.elementIds) {
      if (elementMeta.has(expressId)) continue;

      const psets = store.getProperties(expressId);
      const psetNodeIds = [];
      for (let i = 0; i < psets.length; i++) {
        const pset = psets[i];
        const nodeId = `pset:${expressId}:${i}`;
        const payload = {
          name: pset.name,
          properties: pset.properties.map((p) => ({ name: p.name, value: normalizePropertyValue(p.value) })),
        };
        initialLeafPayloads.set(nodeId, payload);
        psetNodeIds.push({ nodeId, name: pset.name });
      }

      const elementMeshes = meshes.filter((m) => m.expressId === expressId && (m.geometryClass ?? 0) !== 2);
      const meshNodeIds = elementMeshes.map((_, i) => `mesh:${expressId}:${i}`);
      const meshPayloads = elementMeshes.map((mesh, i) => {
        const payload = {
          expressId: mesh.expressId,
          geometryClass: mesh.geometryClass ?? 0,
          positions: Float32Array.from(mesh.positions),
          normals: Float32Array.from(mesh.normals),
          indices: Uint32Array.from(mesh.indices),
          origin: mesh.origin ?? [0, 0, 0],
        };
        initialLeafPayloads.set(meshNodeIds[i], payload);
        return payload;
      });

      const ifcType = store.entities.getTypeName(expressId) || 'Unknown';
      const globalId = store.entities.getGlobalId(expressId) || String(expressId);
      elementMeta.set(expressId, { storeyId: storey.expressId, ifcType, globalId, psetNodeIds, meshNodeIds, meshPayloads });
      elementChildren.set(expressId, {
        childIds: [...meshNodeIds, ...psetNodeIds.map((p) => p.nodeId)],
        componentKeys: [
          ...meshNodeIds.map((id, i) => ({ id, key: `geometry-mesh#${i}` })),
          ...psetNodeIds.map((p, i) => ({ id: p.nodeId, key: `pset:${p.name}#${i}` })),
        ],
      });
    }
  }

  function buildSpecs(leafPayloads) {
    const specs = [];
    for (const [nodeId, payload] of leafPayloads) {
      const kind = nodeId.startsWith('mesh:') ? 'geometry-mesh' : 'property-set';
      specs.push({ id: nodeId, kind, payload });
    }
    for (const [expressId, meta] of elementMeta) {
      const { childIds, componentKeys } = elementChildren.get(expressId);
      specs.push({
        id: `element:${expressId}`,
        kind: 'element',
        children: childIds,
        buildPayload: (h) => ({
          key: meta.globalId,
          ifcType: meta.ifcType,
          components: componentKeys.map(({ id, key }) => ({ componentKey: key, hash: h.get(id) })),
        }),
      });
    }
    for (const storey of storeys) {
      const elementIds = storey.elementIds.filter((id) => elementMeta.has(id)).map((id) => `element:${id}`);
      specs.push({
        id: `storey:${storey.expressId}`,
        kind: 'relationship',
        children: elementIds,
        buildPayload: (h) => ({
          relType: 'IfcRelContainedInSpatialStructure',
          roles: [{ roleName: 'RelatedElements', refs: elementIds.map((id) => h.get(id)) }],
        }),
      });
    }
    const storeyNodeIds = storeys.map((s) => `storey:${s.expressId}`);
    specs.push({
      id: 'root',
      kind: 'layer',
      children: storeyNodeIds,
      buildPayload: (h) => ({ layerId: 'blake3:g2-demo-root-layer-placeholder', childHashes: storeyNodeIds.map((id) => h.get(id)) }),
    });
    return specs;
  }

  return { storeys, elementMeta, initialLeafPayloads, buildSpecs };
}

/* ------------------------------------------------------------------ */
/* maxAxisGap — see module docstring                                     */
/* ------------------------------------------------------------------ */

function axisGap(aMin, aMax, bMin, bMax) {
  return Math.max(aMin - bMax, bMin - aMax);
}

function maxAxisGap(boxA, boxB) {
  let m = -Infinity;
  for (let i = 0; i < 3; i++) {
    const g = axisGap(boxA.min[i], boxA.max[i], boxB.min[i], boxB.max[i]);
    if (g > m) m = g;
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Main                                                                  */
/* ------------------------------------------------------------------ */

async function main() {
  console.error(`[g2] fixture: ${FIXTURE}`);
  console.error(`[g2] epsilonMm: ${EPSILON_MM} (${EPSILON_M} m)`);

  const store = await loadIfcFile(FIXTURE);
  console.error(`[g2] parsed (${store.entityCount} entities, ${store.fileSize} bytes)`);

  const processor = new GeometryProcessor();
  await processor.init();
  const bytes =
    store.source && store.source.byteLength > 0
      // `store.source` is an IfcSourceBytes ACCESSOR since #2339, not a
      // Uint8Array. It still answers `byteLength`, so this guard passes --
      // but `GeometryProcessor.process(buffer: Uint8Array)` then meshes
      // nothing and returns 0 entries. Materialize the whole file.
      ? store.source.materialize()
      : new Uint8Array(await (await import('node:fs/promises')).readFile(FIXTURE));
  const geomResult = await processor.process(bytes);
  console.error(`[g2] meshed (${geomResult.meshes.length} MeshData entries, ${geomResult.totalTriangles} triangles)`);

  const struct = await buildDagStructure(store, geomResult.meshes);
  const leafPayloads = new Map(struct.initialLeafPayloads);

  const dag = new ProvenanceDag();
  for (const spec of struct.buildSpecs(leafPayloads)) dag.addNode(spec);
  await dag.build();
  console.error(`[g2] DAG built: ${dag.size} nodes`);

  // Candidate elements: at least one populated pset AND at least one
  // geometry-mesh leaf, so every op-pair class below can build either a
  // property-edit or a geometry-edit target for it.
  const candidates = [];
  for (const [expressId, meta] of struct.elementMeta) {
    const hasPset = meta.psetNodeIds.length > 0 && leafPayloads.get(meta.psetNodeIds[0].nodeId).properties.length > 0;
    if (!hasPset || meta.meshNodeIds.length === 0) continue;
    let aabb;
    try {
      aabb = unionAabb(meta.meshPayloads.map((p) => aabbFromMesh(p)));
    } catch {
      continue; // degenerate (empty positions) mesh leaf — skip as a spatial candidate
    }
    candidates.push({
      expressId,
      elementNodeId: `element:${expressId}`,
      psetNodeId: meta.psetNodeIds[0].nodeId,
      meshNodeId: meta.meshNodeIds[0],
      ifcType: meta.ifcType,
      aabb,
    });
  }
  console.error(`[g2] candidate elements (pset + mesh + valid AABB): ${candidates.length}`);
  if (candidates.length < 2) throw new Error('[g2] fewer than 2 candidate elements found — cannot build pairs');

  const rng = mulberry32(SEED);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  /* --- Class (a): truly-independent (different, uniformly random elements, --- */
  /* NO spatial pre-filtering — see module docstring for why filtering here  */
  /* would make falseConflictRate tautological).                             */
  const independentPairs = [];
  {
    let attempts = 0;
    while (independentPairs.length < CLASS_COUNTS.independent) {
      if (++attempts > MAX_ATTEMPTS_PER_PAIR) {
        throw new Error(
          `[g2] could not find ${CLASS_COUNTS.independent} truly-independent pairs after ${attempts} attempts ` +
            `(found ${independentPairs.length})`,
        );
      }
      const a = pick(candidates);
      const b = pick(candidates);
      if (a.expressId === b.expressId) continue;
      independentPairs.push({ a, b, gap: maxAxisGap(a.aabb, b.aabb) });
    }
  }

  /* --- Class (b): truly-conflicting (same element, or same pset node) --- */
  const conflictingPairs = [];
  {
    let attempts = 0;
    while (conflictingPairs.length < CLASS_COUNTS.conflicting) {
      if (++attempts > MAX_ATTEMPTS_PER_PAIR) {
        throw new Error(`[g2] could not find ${CLASS_COUNTS.conflicting} truly-conflicting pairs`);
      }
      const a = pick(candidates);
      const samePsetVariant = conflictingPairs.length % 4 === 0; // 1-in-4: identical pset target
      conflictingPairs.push({ a, samePsetVariant });
    }
  }

  /* --- Class (c): near-miss (different elements, AABB gap in (0, 2*eps]) --- */
  const nearMissPairs = [];
  {
    let attempts = 0;
    while (nearMissPairs.length < CLASS_COUNTS.nearMiss) {
      if (++attempts > MAX_ATTEMPTS_PER_PAIR) {
        throw new Error(
          `[g2] could not find ${CLASS_COUNTS.nearMiss} near-miss pairs after ${attempts} attempts ` +
            `(found ${nearMissPairs.length}) — fixture may not have enough adjacent geometry at this epsilon`,
        );
      }
      const a = pick(candidates);
      const b = pick(candidates);
      if (a.expressId === b.expressId) continue;
      const gap = maxAxisGap(a.aabb, b.aabb);
      if (gap > 0 && gap <= 2 * EPSILON_M) nearMissPairs.push({ a, b, gap });
    }
  }

  console.error(
    `[g2] pairs generated: independent=${independentPairs.length} conflicting=${conflictingPairs.length} nearMiss=${nearMissPairs.length}`,
  );

  /* --- Evaluate --- */

  let opCounter = 0;
  function nextOpId() {
    return `g2-op-${opCounter++}`;
  }

  function evalPair(opA, opB) {
    const fpA = computeFootprint(dag, opA);
    const fpB = computeFootprint(dag, opB);
    return conflictPredicate(fpA, fpB, { epsilonMm: EPSILON_MM });
  }

  // Class (a): ground truth = no conflict.
  let independentFalseConflicts = 0;
  for (const { a, b } of independentPairs) {
    const opA = { opId: nextOpId(), kind: 'geometry-edit', targetNodeIds: [a.elementNodeId], region: a.aabb };
    const opB = { opId: nextOpId(), kind: 'geometry-edit', targetNodeIds: [b.elementNodeId], region: b.aabb };
    const result = evalPair(opA, opB);
    if (result.conflict) independentFalseConflicts++;
  }

  // Class (b): ground truth = conflict. Track detected/missed for soundness.
  let conflictingDetected = 0;
  for (const { a, samePsetVariant } of conflictingPairs) {
    let opA;
    let opB;
    if (samePsetVariant) {
      opA = { opId: nextOpId(), kind: 'property-edit', targetNodeIds: [a.psetNodeId], region: undefined };
      opB = { opId: nextOpId(), kind: 'property-edit', targetNodeIds: [a.psetNodeId], region: undefined };
    } else {
      opA = { opId: nextOpId(), kind: 'property-edit', targetNodeIds: [a.psetNodeId], region: undefined };
      opB = { opId: nextOpId(), kind: 'geometry-edit', targetNodeIds: [a.meshNodeId], region: a.aabb };
    }
    const result = evalPair(opA, opB);
    if (result.conflict) conflictingDetected++;
  }
  const conflictingMissed = conflictingPairs.length - conflictingDetected;

  // Class (c): informational only.
  let nearMissConflicts = 0;
  for (const { a, b } of nearMissPairs) {
    const opA = { opId: nextOpId(), kind: 'geometry-edit', targetNodeIds: [a.elementNodeId], region: a.aabb };
    const opB = { opId: nextOpId(), kind: 'geometry-edit', targetNodeIds: [b.elementNodeId], region: b.aabb };
    const result = evalPair(opA, opB);
    if (result.conflict) nearMissConflicts++;
  }

  const pairs = independentPairs.length + conflictingPairs.length + nearMissPairs.length;
  const falseConflictRate = Number((independentFalseConflicts / independentPairs.length).toFixed(6));
  const nearMissConflictRate = Number((nearMissConflicts / nearMissPairs.length).toFixed(6));

  const independentGaps = independentPairs.map((p) => p.gap).sort((x, y) => x - y);
  console.error(
    `[g2] class (a) truly-independent: ${independentPairs.length} pairs, ` +
      `falseConflicts=${independentFalseConflicts}, falseConflictRate=${(falseConflictRate * 100).toFixed(2)}%, ` +
      `gap range [min=${independentGaps[0]?.toFixed(4)}m, max=${independentGaps[independentGaps.length - 1]?.toFixed(4)}m] ` +
      `(unfiltered random sample — some pairs may have small/negative gaps by chance, which is the point)`,
  );
  console.error(
    `[g2] class (b) truly-conflicting: ${conflictingPairs.length} pairs, ` +
      `detected=${conflictingDetected}, missed=${conflictingMissed}`,
  );
  console.error(
    `[g2] class (c) near-miss: ${nearMissPairs.length} pairs, ` +
      `conflicts=${nearMissConflicts}, nearMissConflictRate=${(nearMissConflictRate * 100).toFixed(2)}% (informational)`,
  );

  const killCriterionPass = falseConflictRate < 0.2;
  console.error(
    `[g2] M4 kill criterion (false-conflict rate < 20% on class (a)): ${killCriterionPass ? 'PASS' : 'FAIL'}`,
  );
  if (conflictingMissed !== 0) {
    throw new Error(
      `[g2] SOUNDNESS FAILURE: ${conflictingMissed} truly-conflicting pair(s) were NOT detected — ` +
        'this must never happen; conflictPredicate is unsound',
    );
  }

  const scorecard = {
    pairs,
    soundness: { trueConflictsDetected: conflictingDetected, missed: conflictingMissed },
    falseConflictRate,
    nearMissConflictRate,
    epsilonMm: EPSILON_MM,
    // Supporting detail, not part of the minimal required shape:
    fixture: path.relative(REPO_ROOT, FIXTURE),
    seed: SEED,
    classCounts: {
      independent: independentPairs.length,
      conflicting: conflictingPairs.length,
      nearMiss: nearMissPairs.length,
    },
    killCriterionPass,
  };

  console.log(JSON.stringify(scorecard));
  return scorecard;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * G1 demo for Bet B1.1 (docs/vision/moonshots-execution-plan.md, Phase 1,
 * M1 midterm, second half): "dependency-tracked memoized recomputation
 * through the void-router graph; cache-hit telemetry on real edit traces."
 * Exam: a single-wall edit achieves > 90% node-level cache hits on
 * recompute.
 *
 * Extends G0 (`g0-certificate-demo.mjs`, which SKIPPED geometry-mesh leaves
 * and had no memoization) two ways:
 *
 * 1. Uses `@ifc-lite/provenance`'s new `ProvenanceDag` engine (dag-engine.ts)
 *    instead of G0's hand-rolled `propagateStoreyAndRoot`/`applyElementEdit`
 *    ancestor-cascade code — `invalidate()` + `recompute()` do that
 *    generically, over any DAG shape.
 * 2. Includes REAL `geometry-mesh` leaves: the model is meshed headlessly
 *    the same way `packages/cli`'s clash command does (`GeometryProcessor`
 *    from `@ifc-lite/geometry`, wasm-backed, `pkg/` already built at
 *    `packages/wasm/pkg`), and one edit in the trace mutates a mesh leaf's
 *    payload directly (a "simulated geometry change") to prove mesh nodes
 *    participate in the same invalidate/recompute machinery as pset nodes.
 *
 * Two runs, honestly scoped per the task brief ("if meshing the full 169MB
 * Holter Tower is too slow/heavy for iteration, use duplex.ifc/
 * advanced_model.ifc for the mesh-bearing run and Holter for the data-plane
 * scale run"):
 *
 * - MESH RUN (default fixture: tests/models/ara3d/duplex.ifc): full DAG with
 *   real geometry-mesh leaves. Runs the 20-edit trace (19 property edits +
 *   1 simulated geometry edit), reports per-edit telemetry, the aggregate
 *   scorecard, and the correctness cross-check (full rebuild from scratch
 *   over the final leaf-payload state must match the incrementally
 *   recomputed DAG's root hash byte-for-byte).
 * - DATA-PLANE SCALE RUN (tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc,
 *   169 MB, same fixture G0 used): geometry-mesh leaves SKIPPED (meshing the
 *   whole tower headlessly is a multi-minute operation not worth paying on
 *   every iteration of this script) — property-set/element/storey/root DAG
 *   only, at real ~100k-node scale, to show the M1 midterm's >90% cache-hit
 *   claim holds at the scale G0 already proved cheap verification at, not
 *   just on a toy fixture.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { loadIfcFile } = await import(path.join(REPO_ROOT, 'packages/cli/dist/loader.js'));
const { RelationshipType } = await import(path.join(REPO_ROOT, 'packages/data/dist/index.js'));
const { ProvenanceDag } = await import(path.join(REPO_ROOT, 'packages/provenance/dist/index.js'));
const { GeometryProcessor } = await import(path.join(REPO_ROOT, 'packages/geometry/dist/index.js'));

// NOTE: the wasm geometry pipeline (opening-cut classifier, layer slicing)
// prints its own progress diagnostics straight to stdout ("[ifc-lite
// layers]", "[IFC-LITE] ..."), bypassing console.log entirely (unaffected by
// overriding it here or in packages/cli's loader). Harmless and unrelated to
// this script's correctness — this script's own output is the `[g1] ...`
// stderr trace plus exactly one JSON object per run printed via
// `console.log`; a consumer can isolate the scorecards with `grep '^{'`.

const MESH_FIXTURE = path.resolve(REPO_ROOT, process.argv[2] ?? 'tests/models/ara3d/duplex.ifc');
const SCALE_FIXTURE = path.join(
  REPO_ROOT,
  'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
);

const ROOT_LAYER_ID = 'blake3:g1-demo-root-layer-placeholder';
const EDIT_COUNT = 20;
const GEOMETRY_EDIT_AT = 10; // 1-indexed position in the 20-edit trace (one simulated geometry change)

/* ------------------------------------------------------------------ */
/* Shared helpers (same normalization rules as g0-certificate-demo.mjs) */
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

function mutatedValue(value) {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}__EDITED`;
  return 'EDITED_FROM_NULL';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ------------------------------------------------------------------ */
/* Structure: parsed store (+ optional meshes) -> a NodeSpec factory      */
/* parameterized only by leaf payload VALUES, plus the initial leaf      */
/* payload map derived straight from the parse/mesh pass. Structure      */
/* (which leaf belongs to which element, which element to which storey)  */
/* is fixed once; only payload VALUES vary across edits and the          */
/* from-scratch cross-check rebuild.                                    */
/* ------------------------------------------------------------------ */

async function buildDagStructure(store, meshes) {
  const storeyEntities = store.getEntitiesByType('IfcBuildingStorey');
  const storeys = storeyEntities.map((s) => ({
    expressId: s.expressId,
    globalId: store.entities.getGlobalId(s.expressId) || String(s.expressId),
    elementIds: store.relationships.getRelated(s.expressId, RelationshipType.ContainsElements, 'forward'),
  }));

  const elementMeta = new Map(); // expressId -> { storeyId, ifcType, globalId, psetNodeIds: [{nodeId,name}], meshNodeIds: [] }
  const initialLeafPayloads = new Map(); // nodeId -> payload (property-set or geometry-mesh)
  const elementChildren = new Map(); // expressId -> { psetIds: string[], meshIds: string[] }
  let psetCount = 0;
  let meshLeafCount = 0;
  let elementCount = 0;

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
        psetCount++;
      }

      const elementMeshes = meshes.length
        ? meshes.filter((m) => m.expressId === expressId && (m.geometryClass ?? 0) !== 2)
        : [];
      const meshNodeIds = elementMeshes.map((_, i) => `mesh:${expressId}:${i}`);
      elementMeshes.forEach((mesh, i) => {
        const payload = {
          expressId: mesh.expressId,
          geometryClass: mesh.geometryClass ?? 0,
          positions: Float32Array.from(mesh.positions),
          normals: Float32Array.from(mesh.normals),
          indices: Uint32Array.from(mesh.indices),
          origin: mesh.origin ?? [0, 0, 0],
        };
        initialLeafPayloads.set(meshNodeIds[i], payload);
        meshLeafCount++;
      });

      const ifcType = store.entities.getTypeName(expressId) || 'Unknown';
      const globalId = store.entities.getGlobalId(expressId) || String(expressId);
      elementMeta.set(expressId, { storeyId: storey.expressId, ifcType, globalId, psetNodeIds, meshNodeIds });
      elementChildren.set(expressId, {
        childIds: [...meshNodeIds, ...psetNodeIds.map((p) => p.nodeId)],
        componentKeys: [
          ...meshNodeIds.map((id, i) => ({ id, key: `geometry-mesh#${i}` })),
          ...psetNodeIds.map((p, i) => ({ id: p.nodeId, key: `pset:${p.name}#${i}` })),
        ],
      });
      elementCount++;
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
      // The storey is an ordinary IFC product, so it gets its own `element`
      // node — the referent of the containment relationship's
      // RelatingStructure role. Without that role the storey node is a bare
      // set-of-children hash: two storeys that swap their elements swap their
      // node hashes, and the root `layer` (which sorts its children) comes out
      // unchanged, so re-parenting an element between levels would not move
      // the model root at all. Both EXPRESS roles, per node-hash-v0 spec
      // section 3.2.1 / golden vector rel-contained-many.
      const storeyNodeId = `storey-entity:${storey.expressId}`;
      specs.push({
        id: storeyNodeId,
        kind: 'element',
        payload: { key: storey.globalId, ifcType: 'IfcBuildingStorey', components: [] },
      });
      specs.push({
        id: `storey:${storey.expressId}`,
        kind: 'relationship',
        children: [storeyNodeId, ...elementIds],
        buildPayload: (h) => ({
          relType: 'IfcRelContainedInSpatialStructure',
          roles: [
            { roleName: 'RelatingStructure', refs: [h.get(storeyNodeId)] },
            { roleName: 'RelatedElements', refs: elementIds.map((id) => h.get(id)) },
          ],
        }),
      });
    }
    const storeyNodeIds = storeys.map((s) => `storey:${s.expressId}`);
    specs.push({
      id: 'root',
      kind: 'layer',
      children: storeyNodeIds,
      buildPayload: (h) => ({ layerId: ROOT_LAYER_ID, childHashes: storeyNodeIds.map((id) => h.get(id)) }),
    });
    return specs;
  }

  return { storeys, elementMeta, initialLeafPayloads, buildSpecs, psetCount, meshLeafCount, elementCount };
}

async function buildDag(buildSpecs, leafPayloads) {
  const dag = new ProvenanceDag();
  for (const spec of buildSpecs(leafPayloads)) dag.addNode(spec);
  const t0 = performance.now();
  await dag.build();
  const buildMs = performance.now() - t0;
  return { dag, buildMs, totalNodes: dag.size };
}

/* ------------------------------------------------------------------ */
/* Edits                                                                 */
/* ------------------------------------------------------------------ */

function applyPropertyEdit(dag, leafPayloads, elementMeta, expressId) {
  const meta = elementMeta.get(expressId);
  const target = meta.psetNodeIds[0];
  const oldPayload = leafPayloads.get(target.nodeId);
  const oldProp = oldPayload.properties[0];
  const newValue = mutatedValue(oldProp.value);
  const newPayload = {
    name: oldPayload.name,
    properties: oldPayload.properties.map((p, i) => (i === 0 ? { name: p.name, value: newValue } : p)),
  };
  leafPayloads.set(target.nodeId, newPayload);
  dag.setPayload(target.nodeId, 'property-set', newPayload);
  return {
    kind: 'property',
    expressId,
    ifcType: meta.ifcType,
    globalId: meta.globalId,
    psetName: oldPayload.name,
    propertyName: oldProp.name,
    before: oldProp.value,
    after: newValue,
  };
}

function applyMeshEdit(dag, leafPayloads, elementMeta, expressId, meshIndex) {
  const meta = elementMeta.get(expressId);
  const nodeId = meta.meshNodeIds[meshIndex];
  const oldPayload = leafPayloads.get(nodeId);
  const newPositions = oldPayload.positions.slice();
  const delta = 0.001;
  newPositions[0] = newPositions[0] + delta;
  const newPayload = { ...oldPayload, positions: newPositions };
  leafPayloads.set(nodeId, newPayload);
  dag.setPayload(nodeId, 'geometry-mesh', newPayload);
  return {
    kind: 'geometry',
    expressId,
    ifcType: meta.ifcType,
    globalId: meta.globalId,
    meshIndex,
    delta,
  };
}

/**
 * Runs `editCount` sequential single-element edits against `dag`, recomputing
 * after each and collecting telemetry. `pickEdit(i)` decides, for edit index
 * `i` (0-based), which element/edit-kind to apply — lets the caller mix
 * property edits with one simulated geometry edit at a chosen position.
 */
async function runEditTrace(dag, leafPayloads, elementMeta, editCount, pickEdit) {
  const perEdit = [];
  for (let i = 0; i < editCount; i++) {
    const plan = pickEdit(i);
    const summary =
      plan.kind === 'geometry'
        ? applyMeshEdit(dag, leafPayloads, elementMeta, plan.expressId, plan.meshIndex ?? 0)
        : applyPropertyEdit(dag, leafPayloads, elementMeta, plan.expressId);
    const telemetry = await dag.recompute();
    perEdit.push({ index: i, ...summary, ...telemetry, recomputedNodeIds: undefined });
  }
  return perEdit;
}

/* ------------------------------------------------------------------ */
/* Mesh run                                                             */
/* ------------------------------------------------------------------ */

async function runMeshBearingExam() {
  console.error(`[g1] MESH RUN fixture: ${MESH_FIXTURE}`);

  const parseStart = performance.now();
  const store = await loadIfcFile(MESH_FIXTURE);
  const parseMs = performance.now() - parseStart;
  console.error(`[g1] parsed in ${parseMs.toFixed(1)} ms (${store.entityCount} entities, ${store.fileSize} bytes)`);

  const processor = new GeometryProcessor();
  await processor.init();
  const bytes =
    store.source && store.source.byteLength > 0
      ? store.source
      : new Uint8Array(await (await import('node:fs/promises')).readFile(MESH_FIXTURE));
  const meshStart = performance.now();
  const geomResult = await processor.process(bytes);
  const meshMs = performance.now() - meshStart;
  console.error(`[g1] meshed in ${meshMs.toFixed(1)} ms (${geomResult.meshes.length} MeshData entries, ${geomResult.totalTriangles} triangles)`);

  const structStart = performance.now();
  const struct = await buildDagStructure(store, geomResult.meshes);
  const structMs = performance.now() - structStart;
  console.error(
    `[g1] DAG structure built in ${structMs.toFixed(1)} ms — ${struct.elementCount} elements, ` +
      `${struct.psetCount} property-sets, ${struct.meshLeafCount} geometry-mesh leaves, ${struct.storeys.length} storeys`,
  );

  const leafPayloads = new Map(struct.initialLeafPayloads);
  const { dag, buildMs, totalNodes } = await buildDag(struct.buildSpecs, leafPayloads);
  console.error(`[g1] full build (from scratch) hashed ${totalNodes} nodes in ${buildMs.toFixed(1)} ms`);

  // Candidate elements for edits: populated first-pset, prefer IfcWall for
  // the "single-wall edit" exam framing; also need >=1 candidate with a mesh
  // leaf for the simulated geometry edit.
  const wallCandidates = [];
  const anyCandidates = [];
  const meshCandidates = [];
  for (const [expressId, meta] of struct.elementMeta) {
    const hasPset = meta.psetNodeIds.length > 0 && leafPayloads.get(meta.psetNodeIds[0].nodeId).properties.length > 0;
    if (hasPset) {
      anyCandidates.push(expressId);
      if (/^IfcWall/i.test(meta.ifcType)) wallCandidates.push(expressId);
    }
    if (meta.meshNodeIds.length > 0) meshCandidates.push(expressId);
  }
  if (anyCandidates.length === 0) throw new Error('[g1] no element with a populated property set found in fixture');
  if (meshCandidates.length === 0) throw new Error('[g1] no element with a geometry-mesh leaf found in fixture');

  const editTargets = wallCandidates.length >= anyCandidates.length ? wallCandidates : [...wallCandidates, ...anyCandidates];
  const geometryEditTarget = meshCandidates[0];

  console.error(
    `[g1] single-wall-edit exam target: element ${editTargets[0]} (${struct.elementMeta.get(editTargets[0]).ifcType})`,
  );

  /* --- Standalone single-wall-edit exam (the literal midterm exam check) --- */
  {
    const examLeafPayloads = new Map(struct.initialLeafPayloads);
    const { dag: examDag } = await buildDag(struct.buildSpecs, examLeafPayloads);
    const summary = applyPropertyEdit(examDag, examLeafPayloads, struct.elementMeta, editTargets[0]);
    const telemetry = await examDag.recompute();
    console.error(
      `[g1] EXAM single-wall edit: ${summary.psetName}.${summary.propertyName}: ` +
        `${JSON.stringify(summary.before)} -> ${JSON.stringify(summary.after)}`,
    );
    console.error(
      `[g1] EXAM telemetry: recomputed=${telemetry.recomputed} cacheHits=${telemetry.cacheHits} ` +
        `hitRate=${(telemetry.hitRate * 100).toFixed(2)}% (totalNodes=${telemetry.totalNodes})`,
    );
    const examPass = telemetry.hitRate > 0.9;
    console.error(`[g1] EXAM (single-wall edit hitRate > 90%): ${examPass ? 'PASS' : 'FAIL'}`);
    if (!examPass) throw new Error('[g1] EXAM FAILED: single-wall edit hitRate did not exceed 90%');
  }

  /* --- 20-edit trace (19 property edits + 1 simulated geometry edit) --- */
  let geometryEditDone = false;
  const perEdit = await runEditTrace(dag, leafPayloads, struct.elementMeta, EDIT_COUNT, (i) => {
    if (i === GEOMETRY_EDIT_AT - 1 && !geometryEditDone) {
      geometryEditDone = true;
      return { kind: 'geometry', expressId: geometryEditTarget, meshIndex: 0 };
    }
    const target = editTargets[i % editTargets.length];
    return { kind: 'property', expressId: target };
  });

  for (const e of perEdit) {
    console.error(
      `[g1] edit ${e.index + 1}/${EDIT_COUNT} [${e.kind}] element ${e.expressId} (${e.ifcType}): ` +
        `recomputed=${e.recomputed} cacheHits=${e.cacheHits} hitRate=${(e.hitRate * 100).toFixed(2)}% ` +
        `elapsedMs=${e.elapsedMs.toFixed(3)}`,
    );
  }

  /* --- Correctness cross-check: fresh from-scratch rebuild over the FINAL --- */
  /* leaf-payload state must match the incrementally recomputed DAG exactly. */
  const { dag: freshDag } = await buildDag(struct.buildSpecs, leafPayloads);
  const incrementalSnapshot = dag.snapshot();
  const freshSnapshot = freshDag.snapshot();
  let correctnessCrossCheck = incrementalSnapshot.size === freshSnapshot.size;
  if (correctnessCrossCheck) {
    for (const [id, hash] of incrementalSnapshot) {
      if (freshSnapshot.get(id) !== hash) {
        correctnessCrossCheck = false;
        console.error(`[g1] MISMATCH at node "${id}": incremental=${hash} fresh=${freshSnapshot.get(id)}`);
        break;
      }
    }
  }
  const rootMatch = dag.getHash('root') === freshDag.getHash('root');
  correctnessCrossCheck = correctnessCrossCheck && rootMatch;
  console.error(
    `[g1] correctnessCrossCheck (incremental DAG snapshot === from-scratch rebuild snapshot, root hash equal): ` +
      `${correctnessCrossCheck ? 'PASS' : 'FAIL'}`,
  );
  if (!correctnessCrossCheck) {
    throw new Error('[g1] correctness cross-check FAILED: incremental state diverged from a from-scratch rebuild');
  }

  const hitRates = perEdit.map((e) => e.hitRate);
  const recomputeMs = perEdit.map((e) => e.elapsedMs);

  const scorecard = {
    fixture: path.relative(REPO_ROOT, MESH_FIXTURE),
    nodes: totalNodes,
    meshLeaves: struct.meshLeafCount,
    elements: struct.elementCount,
    propertySets: struct.psetCount,
    storeys: struct.storeys.length,
    edits: EDIT_COUNT,
    meanHitRate: Number(mean(hitRates).toFixed(6)),
    minHitRate: Number(Math.min(...hitRates).toFixed(6)),
    meanRecomputeMs: Number(mean(recomputeMs).toFixed(4)),
    medianRecomputeMs: Number(median(recomputeMs).toFixed(4)),
    fullBuildMs: Number(buildMs.toFixed(1)),
    parseMs: Number(parseMs.toFixed(1)),
    meshMs: Number(meshMs.toFixed(1)),
    correctnessCrossCheck,
  };

  console.log(JSON.stringify(scorecard));
  return scorecard;
}

/* ------------------------------------------------------------------ */
/* Data-plane scale run (no geometry-mesh leaves — see file docstring)   */
/* ------------------------------------------------------------------ */

async function runDataPlaneScaleExam() {
  console.error(`\n[g1] DATA-PLANE SCALE RUN fixture: ${SCALE_FIXTURE}`);
  console.error(
    '[g1] CAVEAT: geometry-mesh leaves are SKIPPED in this run — meshing the full 169MB tower ' +
      'headlessly is a multi-minute operation, not worth paying on every iteration of this script. ' +
      'Mesh leaves ARE exercised in the mesh-bearing run above; this run exists to show the >90% ' +
      "cache-hit exam holds at G0's real ~100k-node data-plane scale, not just on a toy fixture.",
  );

  const parseStart = performance.now();
  const store = await loadIfcFile(SCALE_FIXTURE);
  const parseMs = performance.now() - parseStart;
  console.error(`[g1] parsed in ${parseMs.toFixed(1)} ms (${store.entityCount} entities, ${store.fileSize} bytes)`);

  const struct = await buildDagStructure(store, []);
  const leafPayloads = new Map(struct.initialLeafPayloads);
  const { dag, buildMs, totalNodes } = await buildDag(struct.buildSpecs, leafPayloads);
  console.error(
    `[g1] full build hashed ${totalNodes} nodes in ${buildMs.toFixed(1)} ms ` +
      `(${struct.elementCount} elements, ${struct.psetCount} property-sets, ${struct.storeys.length} storeys, 1 root)`,
  );

  let target;
  for (const [expressId, meta] of struct.elementMeta) {
    if (!/^IfcWall/i.test(meta.ifcType) || meta.psetNodeIds.length === 0) continue;
    if (leafPayloads.get(meta.psetNodeIds[0].nodeId).properties.length === 0) continue;
    target = expressId;
    break;
  }
  if (target === undefined) throw new Error('[g1] no IfcWall-like element with a populated property set found');

  const summary = applyPropertyEdit(dag, leafPayloads, struct.elementMeta, target);
  const telemetry = await dag.recompute();
  console.error(
    `[g1] SCALE EXAM single-wall edit: element ${target} (${summary.ifcType}), ` +
      `${summary.psetName}.${summary.propertyName}: ${JSON.stringify(summary.before)} -> ${JSON.stringify(summary.after)}`,
  );
  console.error(
    `[g1] SCALE EXAM telemetry: recomputed=${telemetry.recomputed} cacheHits=${telemetry.cacheHits} ` +
      `hitRate=${(telemetry.hitRate * 100).toFixed(4)}% (totalNodes=${telemetry.totalNodes}) ` +
      `elapsedMs=${telemetry.elapsedMs.toFixed(3)}`,
  );
  const examPass = telemetry.hitRate > 0.9;
  console.error(`[g1] SCALE EXAM (single-wall edit hitRate > 90%): ${examPass ? 'PASS' : 'FAIL'}`);
  if (!examPass) throw new Error('[g1] SCALE EXAM FAILED: single-wall edit hitRate did not exceed 90%');

  const scorecard = {
    fixture: path.relative(REPO_ROOT, SCALE_FIXTURE),
    nodes: totalNodes,
    meshLeaves: 0,
    elements: struct.elementCount,
    propertySets: struct.psetCount,
    storeys: struct.storeys.length,
    recomputed: telemetry.recomputed,
    cacheHits: telemetry.cacheHits,
    hitRate: Number(telemetry.hitRate.toFixed(6)),
    recomputeMs: Number(telemetry.elapsedMs.toFixed(4)),
    fullBuildMs: Number(buildMs.toFixed(1)),
    parseMs: Number(parseMs.toFixed(1)),
  };
  console.log(JSON.stringify(scorecard));
  return scorecard;
}

/* ------------------------------------------------------------------ */
/* Main                                                                  */
/* ------------------------------------------------------------------ */

async function main() {
  const meshScorecard = await runMeshBearingExam();
  const scaleScorecard = await runDataPlaneScaleExam();
  console.error('\n[g1] SUMMARY');
  console.error(`[g1] mesh-bearing run:      ${JSON.stringify(meshScorecard)}`);
  console.error(`[g1] data-plane scale run:  ${JSON.stringify(scaleScorecard)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

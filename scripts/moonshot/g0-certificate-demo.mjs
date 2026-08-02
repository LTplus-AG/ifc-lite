#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * G0 gate demo for bet B0.1 (docs/vision/moonshots-execution-plan.md, M1 midterm).
 *
 * Gate criterion: a single-element edit on a 100+ MB model yields a
 * certificate that a verifier checks in under 500 ms while re-reading under
 * 5% of DAG nodes.
 *
 * Pipeline:
 *   1. Parse the fixture via the CLI's own parse path (packages/cli/dist/loader.js
 *      -> @ifc-lite/parser's ColumnarParser), data-plane only. NO geometry
 *      meshing is run — this is a property/entity DAG exam, not a render
 *      benchmark. `geometry-mesh` leaf hashes (node-hash-v0 spec 3.1) are
 *      SKIPPED entirely; see the "caveats" block printed at the end.
 *   2. Build a node-hash-v0 DAG with @ifc-lite/provenance:
 *        element (one per IFC product entity)
 *          -> property-set (one per Pset/Qset-like set the entity carries)
 *        storey (`relationship`, IfcRelContainedInSpatialStructure) groups the
 *          elements a storey directly contains
 *        root (`layer`) groups every storey
 *      This is an allowed use of the v0 node-kind vocabulary (spec 2): the
 *      only kinds available are geometry-mesh / property-set / relationship /
 *      layer / element, so grouping uses `relationship` (storey) and `layer`
 *      (root) rather than inventing new kinds.
 *   3. Apply one property edit to one wall-like element in memory, rebuild
 *      ONLY the affected path's hashes (pset -> element -> storey -> root),
 *      and create a certificate: writes for the changed path, reads for the
 *      element's untouched sibling property-sets, and a subtree-untouched
 *      claim covering every OTHER storey in the building.
 *   4. Verify the certificate against a resolver that counts every payload
 *      lookup it performs, timing the verify call (median of 5, 1 warmup).
 *   5. Measure the full-DAG initial hash time, and prove tamper detection by
 *      mutating a sibling's payload (in an untouched storey) after the
 *      certificate was created and re-verifying (must fail).
 *
 * No new dependencies. Imports the ALREADY-BUILT dist output of
 * @ifc-lite/cli (parse path), @ifc-lite/data (RelationshipType), and
 * @ifc-lite/provenance (node-hash-v0) by relative path — this script is not
 * itself a workspace package, so it reaches into sibling packages' `dist/`
 * directly rather than via bare-specifier resolution.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { loadIfcFile } = await import(
  path.join(REPO_ROOT, 'packages/cli/dist/loader.js')
);
const { RelationshipType } = await import(
  path.join(REPO_ROOT, 'packages/data/dist/index.js')
);
const { computeNodeHash, createCertificate, verifyCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

const FIXTURE = path.join(
  REPO_ROOT,
  'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
);

const KERNEL_VERSION = 'g0-demo-kernel-v0';
const TRUST_ROOT = 'g0-demo-trust-root-v0';
// Placeholder tagged layerId for the root `layer` node (spec §3.4 / Q1):
// a real deployment would embed packages/ifcx's `computeLayerId` output here;
// this demo has no ifcx layer document, so it's a fixed stand-in string.
const ROOT_LAYER_ID = 'blake3:g0-demo-root-layer-placeholder';

/* ------------------------------------------------------------------ */
/* Property-value normalization (mirrors packages/cli's                 */
/* normalizePropertyValue): coerce whatever the parser handed back into  */
/* the string|number|boolean|null vocabulary node-hash-v0's              */
/* PropertySetPayload accepts.                                          */
/* ------------------------------------------------------------------ */

function normalizePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Produce a value guaranteed to differ from `value` post-normalization —
 *  used both for the "real" single-element edit and the tamper test. */
function mutatedValue(value) {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}__EDITED`;
  return 'EDITED_FROM_NULL';
}

/* ------------------------------------------------------------------ */
/* DAG construction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the full node-hash-v0 DAG in one bottom-up pass: property-sets,
 * then elements (folding in their property-set hashes), then per-storey
 * `relationship` nodes (folding in their contained elements' hashes), then
 * one root `layer` node (folding in every storey hash).
 *
 * Returns the live backing store (`dagNodes`: nodeId -> ResolvedNode,
 * `dagHashes`: nodeId -> tagged hash string) plus enough bookkeeping
 * (`storeys`, `elementMeta`) to drive the single-element edit and the
 * tamper test afterward. This map IS the "DAG" a resolver reads from —
 * mutating an entry in place is exactly what an in-memory edit does to a
 * real model.
 */
async function buildDag(store) {
  const dagNodes = new Map(); // nodeId -> ResolvedNode ({kind, payload})
  const dagHashes = new Map(); // nodeId -> tagged hash string

  const storeyEntities = store.getEntitiesByType('IfcBuildingStorey');
  const storeys = storeyEntities.map((s) => ({
    expressId: s.expressId,
    name: store.entities.getName(s.expressId) || `Storey #${s.expressId}`,
    elementIds: store.relationships.getRelated(
      s.expressId,
      RelationshipType.ContainsElements,
      'forward',
    ),
  }));

  const elementMeta = new Map(); // expressId -> { storeyId, ifcType, globalId, psetNodeIds: string[] }
  let psetCount = 0;
  let elementCount = 0;

  for (const storey of storeys) {
    for (const expressId of storey.elementIds) {
      if (elementMeta.has(expressId)) continue; // an element contained twice, defensively dedupe

      const psets = store.getProperties(expressId);
      const psetNodeIds = [];
      const components = [];

      for (let i = 0; i < psets.length; i++) {
        const pset = psets[i];
        const nodeId = `pset:${expressId}:${i}`;
        const payload = {
          name: pset.name,
          properties: pset.properties.map((p) => ({
            name: p.name,
            value: normalizePropertyValue(p.value),
          })),
        };
        const hash = await computeNodeHash('property-set', payload);
        dagNodes.set(nodeId, { kind: 'property-set', payload });
        dagHashes.set(nodeId, hash);
        psetNodeIds.push(nodeId);
        components.push({ componentKey: `pset:${pset.name}#${i}`, hash });
        psetCount++;
      }

      const ifcType = store.entities.getTypeName(expressId) || 'Unknown';
      const globalId = store.entities.getGlobalId(expressId) || String(expressId);
      const elementNodeId = `element:${expressId}`;
      const elementPayload = { key: globalId, ifcType, components };
      const elementHash = await computeNodeHash('element', elementPayload);
      dagNodes.set(elementNodeId, { kind: 'element', payload: elementPayload });
      dagHashes.set(elementNodeId, elementHash);
      elementCount++;

      elementMeta.set(expressId, { storeyId: storey.expressId, ifcType, globalId, psetNodeIds });
    }
  }

  for (const storey of storeys) {
    const nodeId = `storey:${storey.expressId}`;
    const refs = storey.elementIds
      .map((id) => dagHashes.get(`element:${id}`))
      .filter((h) => h !== undefined);
    const payload = {
      relType: 'IfcRelContainedInSpatialStructure',
      roles: [{ roleName: 'RelatedElements', refs }],
    };
    const hash = await computeNodeHash('relationship', payload);
    dagNodes.set(nodeId, { kind: 'relationship', payload });
    dagHashes.set(nodeId, hash);
  }

  {
    const childHashes = storeys.map((s) => dagHashes.get(`storey:${s.expressId}`)).filter((h) => h !== undefined);
    // Placeholder tagged layerId: this demo has no real ifcx layer document
    // (packages/ifcx's computeLayerId) behind the root node — data-plane-only
    // scope — so ROOT_LAYER_ID is a fixed stand-in, not a real content hash.
    const payload = { layerId: ROOT_LAYER_ID, childHashes };
    const hash = await computeNodeHash('layer', payload);
    dagNodes.set('root', { kind: 'layer', payload });
    dagHashes.set('root', hash);
  }

  return { dagNodes, dagHashes, storeys, elementMeta, psetCount, elementCount };
}

/** Recompute one storey's `relationship` hash from its CURRENT element
 *  hashes, and the root `layer` hash from its CURRENT storey hashes. Both
 *  mutate `dag.dagNodes`/`dag.dagHashes` in place — this is the "rebuild
 *  only the affected path" step, never touching any other element. */
function propagateStoreyAndRoot(dag, storeyExpressId) {
  const storey = dag.storeys.find((s) => s.expressId === storeyExpressId);
  const storeyNodeId = `storey:${storeyExpressId}`;
  const refs = storey.elementIds
    .map((id) => dag.dagHashes.get(`element:${id}`))
    .filter((h) => h !== undefined);
  const payload = {
    relType: 'IfcRelContainedInSpatialStructure',
    roles: [{ roleName: 'RelatedElements', refs }],
  };
  return computeNodeHash('relationship', payload).then((hash) => {
    dag.dagNodes.set(storeyNodeId, { kind: 'relationship', payload });
    dag.dagHashes.set(storeyNodeId, hash);

    const childHashes = dag.storeys.map((s) => dag.dagHashes.get(`storey:${s.expressId}`)).filter((h) => h !== undefined);
    const rootPayload = { layerId: ROOT_LAYER_ID, childHashes };
    return computeNodeHash('layer', rootPayload).then((rootHash) => {
      dag.dagNodes.set('root', { kind: 'layer', payload: rootPayload });
      dag.dagHashes.set('root', rootHash);
    });
  });
}

/** Mutate one property on one (expressId, psetNodeIndex, propIndex) triple,
 *  recompute that pset's hash, then cascade element -> storey -> root.
 *  Returns the four changed NodeRefs (pset, element, storey, root), the
 *  element's OTHER (untouched) pset NodeRefs, and a human-readable summary
 *  of what changed. */
async function applyElementEdit(dag, expressId, psetIndex, propIndex) {
  const meta = dag.elementMeta.get(expressId);
  const psetNodeId = meta.psetNodeIds[psetIndex];
  const oldResolved = dag.dagNodes.get(psetNodeId);
  const oldProp = oldResolved.payload.properties[propIndex];
  const newValue = mutatedValue(oldProp.value);

  const newPsetPayload = {
    name: oldResolved.payload.name,
    properties: oldResolved.payload.properties.map((p, i) =>
      i === propIndex ? { name: p.name, value: newValue } : p,
    ),
  };
  const newPsetHash = await computeNodeHash('property-set', newPsetPayload);
  dag.dagNodes.set(psetNodeId, { kind: 'property-set', payload: newPsetPayload });
  dag.dagHashes.set(psetNodeId, newPsetHash);

  const elementNodeId = `element:${expressId}`;
  const oldElement = dag.dagNodes.get(elementNodeId);
  const newComponents = oldElement.payload.components.map((c) =>
    c.componentKey === `pset:${newPsetPayload.name}#${psetIndex}` ? { ...c, hash: newPsetHash } : c,
  );
  const newElementPayload = { key: oldElement.payload.key, ifcType: oldElement.payload.ifcType, components: newComponents };
  const newElementHash = await computeNodeHash('element', newElementPayload);
  dag.dagNodes.set(elementNodeId, { kind: 'element', payload: newElementPayload });
  dag.dagHashes.set(elementNodeId, newElementHash);

  await propagateStoreyAndRoot(dag, meta.storeyId);

  const otherPsetRefs = meta.psetNodeIds
    .filter((id) => id !== psetNodeId)
    .map((id) => ({ nodeId: id, hash: dag.dagHashes.get(id) }));

  return {
    writes: [
      { nodeId: psetNodeId, hash: newPsetHash },
      { nodeId: elementNodeId, hash: newElementHash },
      { nodeId: `storey:${meta.storeyId}`, hash: dag.dagHashes.get(`storey:${meta.storeyId}`) },
      { nodeId: 'root', hash: dag.dagHashes.get('root') },
    ],
    reads: otherPsetRefs,
    summary: {
      expressId,
      ifcType: meta.ifcType,
      globalId: meta.globalId,
      psetName: oldResolved.payload.name,
      propertyName: oldProp.name,
      before: oldProp.value,
      after: newValue,
    },
  };
}

/**
 * Tamper test: mutate one property of one sibling element that lives in a
 * DIFFERENT storey than the one the certificate's edit touched, cascade its
 * element + storey hash (but deliberately do NOT touch root — the point is
 * that the certificate's `subtree-untouched` claim for that storey now
 * disagrees with live data), and return the storey id that should now fail
 * re-verification.
 */
async function applySiblingTamper(dag, expressId) {
  const meta = dag.elementMeta.get(expressId);
  const psetNodeId = meta.psetNodeIds[0];
  const oldResolved = dag.dagNodes.get(psetNodeId);
  const oldProp = oldResolved.payload.properties[0];
  const newValue = mutatedValue(oldProp.value);

  const newPsetPayload = {
    name: oldResolved.payload.name,
    properties: oldResolved.payload.properties.map((p, i) => (i === 0 ? { name: p.name, value: newValue } : p)),
  };
  const newPsetHash = await computeNodeHash('property-set', newPsetPayload);
  dag.dagNodes.set(psetNodeId, { kind: 'property-set', payload: newPsetPayload });
  dag.dagHashes.set(psetNodeId, newPsetHash);

  const elementNodeId = `element:${expressId}`;
  const oldElement = dag.dagNodes.get(elementNodeId);
  const newComponents = oldElement.payload.components.map((c, i) => (i === 0 ? { ...c, hash: newPsetHash } : c));
  const newElementPayload = { key: oldElement.payload.key, ifcType: oldElement.payload.ifcType, components: newComponents };
  const newElementHash = await computeNodeHash('element', newElementPayload);
  dag.dagNodes.set(elementNodeId, { kind: 'element', payload: newElementPayload });
  dag.dagHashes.set(elementNodeId, newElementHash);

  // Cascade to the storey only (not root) — see docstring.
  const storey = dag.storeys.find((s) => s.expressId === meta.storeyId);
  const refs = storey.elementIds.map((id) => dag.dagHashes.get(`element:${id}`)).filter((h) => h !== undefined);
  const payload = { relType: 'IfcRelContainedInSpatialStructure', roles: [{ roleName: 'RelatedElements', refs }] };
  const hash = await computeNodeHash('relationship', payload);
  dag.dagNodes.set(`storey:${meta.storeyId}`, { kind: 'relationship', payload });
  dag.dagHashes.set(`storey:${meta.storeyId}`, hash);

  return { storeyId: meta.storeyId, expressId, propertyName: oldProp.name, before: oldProp.value, after: newValue };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/* ------------------------------------------------------------------ */
/* Main                                                                  */
/* ------------------------------------------------------------------ */

async function main() {
  console.error(`[g0] fixture: ${FIXTURE}`);

  const parseStart = performance.now();
  const store = await loadIfcFile(FIXTURE);
  const parseMs = performance.now() - parseStart;
  console.error(`[g0] parsed in ${parseMs.toFixed(1)} ms (${store.entityCount} entities, ${store.fileSize} bytes)`);

  const buildStart = performance.now();
  const dag = await buildDag(store);
  const fullHashMs = performance.now() - buildStart;
  const totalNodes = dag.dagNodes.size;
  console.error(
    `[g0] DAG built + fully hashed in ${fullHashMs.toFixed(1)} ms — ${totalNodes} nodes ` +
      `(${dag.elementCount} elements, ${dag.psetCount} property-sets, ${dag.storeys.length} storeys, 1 root)`,
  );

  // Pick a wall-like element with at least one non-empty property set,
  // preferring one with MULTIPLE property sets so the certificate's `reads`
  // (the element's other, untouched psets) isn't trivially empty.
  let target;
  let bestPsetCount = -1;
  for (const [expressId, meta] of dag.elementMeta) {
    if (!/^IfcWall/i.test(meta.ifcType) || meta.psetNodeIds.length === 0) continue;
    const firstPset = dag.dagNodes.get(meta.psetNodeIds[0]).payload;
    if (firstPset.properties.length === 0) continue;
    if (meta.psetNodeIds.length > bestPsetCount) {
      bestPsetCount = meta.psetNodeIds.length;
      target = { expressId, meta, psetIndex: 0, propIndex: 0 };
      if (bestPsetCount >= 3) break; // good enough, stop scanning
    }
  }
  if (!target) {
    throw new Error('[g0] no IfcWall-like element with a populated property set found in fixture');
  }
  console.error(
    `[g0] editing element ${target.expressId} (${target.meta.ifcType}, ${target.meta.globalId}) in storey ${target.meta.storeyId}`,
  );

  const edit = await applyElementEdit(dag, target.expressId, target.psetIndex, target.propIndex);
  console.error(
    `[g0] edit: ${edit.summary.psetName}.${edit.summary.propertyName}: ` +
      `${JSON.stringify(edit.summary.before)} -> ${JSON.stringify(edit.summary.after)}`,
  );

  // subtree-untouched claim: every OTHER storey, at its CURRENT (unchanged) hash.
  const untouchedStoreyRefs = dag.storeys
    .filter((s) => s.expressId !== target.meta.storeyId)
    .map((s) => ({ nodeId: `storey:${s.expressId}`, hash: dag.dagHashes.get(`storey:${s.expressId}`) }));

  const certificate = createCertificate({
    kernelVersion: KERNEL_VERSION,
    trustRoot: TRUST_ROOT,
    reads: edit.reads,
    writes: edit.writes,
    claims: [{ type: 'subtree-untouched', nodes: untouchedStoreyRefs }],
  });

  console.error(
    `[g0] certificate: ${certificate.writes.length} writes, ${certificate.reads.length} reads, ` +
      `${untouchedStoreyRefs.length} subtree-untouched storey refs`,
  );
  if (certificate.reads.length === 0) {
    console.error(
      '[g0] NOTE: reads=0 because this fixture\'s IfcWall(StandardCase) entities carry exactly one ' +
        'property set (Pset_WallCommon) — there is no "other, untouched pset" to read on this element. ' +
        'Not a certificate-design limitation, just this model\'s data shape.',
    );
  }

  function makeCountingResolver() {
    const counter = { count: 0 };
    const resolver = async (nodeId) => {
      counter.count++;
      return dag.dagNodes.get(nodeId);
    };
    return { resolver, counter };
  }

  // Warm-up (JIT, not timed).
  {
    const { resolver } = makeCountingResolver();
    const result = await verifyCertificate(certificate, resolver, {
      expectedTrustRoot: TRUST_ROOT,
      expectedKernelVersion: KERNEL_VERSION,
    });
    if (!result.ok) throw new Error(`[g0] warm-up verify unexpectedly failed: ${result.reason}`);
  }

  const verifyTimesMs = [];
  let nodesResolved = 0;
  for (let i = 0; i < 5; i++) {
    const { resolver, counter } = makeCountingResolver();
    const t0 = performance.now();
    const result = await verifyCertificate(certificate, resolver, {
      expectedTrustRoot: TRUST_ROOT,
      expectedKernelVersion: KERNEL_VERSION,
    });
    const elapsed = performance.now() - t0;
    if (!result.ok) throw new Error(`[g0] verify run ${i} unexpectedly failed: ${result.reason}`);
    verifyTimesMs.push(elapsed);
    nodesResolved = counter.count; // deterministic across runs (no early exit on success)
  }
  const verifyMedianMs = median(verifyTimesMs);
  console.error(`[g0] verify times (ms): ${verifyTimesMs.map((v) => v.toFixed(3)).join(', ')}`);

  // Tamper test: mutate a sibling element in a DIFFERENT, "untouched" storey
  // after the certificate was created, then re-verify — must fail.
  const otherStorey = dag.storeys.find((s) => s.expressId !== target.meta.storeyId && s.elementIds.length > 0);
  let tamperExpressId;
  // A model whose only populated storey is the edited one has nothing to
  // tamper with; fall through to the existing "skip tamper test" path
  // instead of dereferencing undefined.
  for (const id of otherStorey?.elementIds ?? []) {
    const meta = dag.elementMeta.get(id);
    if (meta && meta.psetNodeIds.length > 0 && dag.dagNodes.get(meta.psetNodeIds[0]).payload.properties.length > 0) {
      tamperExpressId = id;
      break;
    }
  }
  let tamperCaught = false;
  let tamperReason = null;
  if (tamperExpressId === undefined) {
    console.error('[g0] WARNING: no tamperable sibling found in another storey; skipping tamper test');
  } else {
    const tamper = await applySiblingTamper(dag, tamperExpressId);
    console.error(
      `[g0] tamper: element ${tamper.expressId} in storey ${tamper.storeyId} (untouched-claim storey), ` +
        `${tamper.propertyName}: ${JSON.stringify(tamper.before)} -> ${JSON.stringify(tamper.after)}`,
    );
    const { resolver } = makeCountingResolver();
    const result = await verifyCertificate(certificate, resolver, {
      expectedTrustRoot: TRUST_ROOT,
      expectedKernelVersion: KERNEL_VERSION,
    });
    tamperCaught = result.ok === false;
    tamperReason = result.ok ? null : result.reason;
    console.error(`[g0] post-tamper verify: ok=${result.ok}${result.ok ? '' : ` reason=${result.reason}`}`);
  }

  const nodesResolvedPct = (nodesResolved / totalNodes) * 100;

  const scorecard = {
    nodes: totalNodes,
    verifyMedianMs: Number(verifyMedianMs.toFixed(3)),
    nodesResolved,
    nodesResolvedPct: Number(nodesResolvedPct.toFixed(4)),
    tamperCaught,
    fullHashMs: Number(fullHashMs.toFixed(1)),
    parseMs: Number(parseMs.toFixed(1)),
  };

  console.log(JSON.stringify(scorecard));

  const gatePass = scorecard.verifyMedianMs < 500 && scorecard.nodesResolvedPct < 5;
  console.error(
    `[g0] GATE (verify < 500ms AND nodesResolvedPct < 5%): ${gatePass ? 'PASS' : 'FAIL'}` +
      (tamperReason ? ` (tamper caught via: ${tamperReason})` : ''),
  );
  console.error(
    '[g0] CAVEAT: geometry-mesh leaves are SKIPPED — this DAG covers property-set/element/storey/root ' +
      'nodes only (data plane), no mesh tessellation was run and no geometry-mesh hashes were computed.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

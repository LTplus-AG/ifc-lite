/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ACT 2 -- PROOF.
 *
 * The G0 story (scripts/moonshot/g0-certificate-demo.mjs), replayed on the
 * FRESH act-1 building instead of the Holter fixture: build the
 * node-hash-v0 provenance DAG over the parsed bytes, apply one
 * single-element edit, issue a certificate, verify it in a SECOND PROCESS
 * (verify-worker.mjs) that re-derives every referenced hash from the
 * payloads, then hand that process a tampered copy and watch it refuse.
 *
 * The DAG follows g0's shape exactly (property-set/element -> storey
 * `relationship` -> root `layer`), with one world-gym twist: gym elements
 * carry their numbers as IfcElementQuantity sets, so quantity sets are
 * folded in as `property-set` DAG leaves too -- which makes the demo edit
 * literal: "quietly grow one wall's GrossVolume" is exactly the kind of
 * silent change a certificate must expose.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseStore } from '../../../tools/world-gym/lib/checks.mjs';
import { RelationshipType } from '../../../packages/data/dist/index.js';
import { computeNodeHash, createCertificate } from '../../../packages/provenance/dist/index.js';
import { HERE, OUT_DIR, banner, pct, say, short } from './util.mjs';

const execFileAsync = promisify(execFile);

export const KERNEL_VERSION = 'b35-demo-kernel-v0';
export const TRUST_ROOT = 'b35-demo-trust-root-v0';
const ROOT_LAYER_ID = 'blake3:b35-demo-root-layer-placeholder';

function normalizePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Every property-set-like payload an element carries: real psets plus
 *  quantity sets (world-gym elements keep their ground truth in
 *  `GymQuantities` IfcElementQuantity sets). */
function psetPayloadsFor(store, expressId) {
  const payloads = [];
  for (const pset of store.getProperties(expressId)) {
    payloads.push({
      name: pset.name,
      properties: pset.properties.map((p) => ({ name: p.name, value: normalizePropertyValue(p.value) })),
    });
  }
  for (const qset of store.getQuantities(expressId)) {
    payloads.push({
      name: qset.name,
      properties: qset.quantities.map((q) => ({ name: q.name, value: normalizePropertyValue(q.value) })),
    });
  }
  return payloads;
}

/** g0's buildDag, on a parsed world-gym store (see module doc). */
export async function buildDag(store) {
  const dagNodes = new Map();
  const dagHashes = new Map();

  const storeys = store.getEntitiesByType('IfcBuildingStorey')
    .map((s) => ({
      expressId: s.expressId,
      name: store.entities.getName(s.expressId) || `Storey #${s.expressId}`,
      elementIds: store.relationships.getRelated(s.expressId, RelationshipType.ContainsElements, 'forward'),
    }))
    .sort((a, b) => a.expressId - b.expressId);

  const elementMeta = new Map();
  let psetCount = 0;
  let elementCount = 0;

  for (const storey of storeys) {
    for (const expressId of storey.elementIds) {
      if (elementMeta.has(expressId)) continue;

      const psetNodeIds = [];
      const components = [];
      const payloads = psetPayloadsFor(store, expressId);
      for (let i = 0; i < payloads.length; i++) {
        const nodeId = `pset:${expressId}:${i}`;
        const hash = await computeNodeHash('property-set', payloads[i]);
        dagNodes.set(nodeId, { kind: 'property-set', payload: payloads[i] });
        dagHashes.set(nodeId, hash);
        psetNodeIds.push(nodeId);
        components.push({ componentKey: `pset:${payloads[i].name}#${i}`, hash });
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
    const refs = storey.elementIds.map((id) => dagHashes.get(`element:${id}`)).filter((h) => h !== undefined);
    const payload = { relType: 'IfcRelContainedInSpatialStructure', roles: [{ roleName: 'RelatedElements', refs }] };
    const hash = await computeNodeHash('relationship', payload);
    dagNodes.set(`storey:${storey.expressId}`, { kind: 'relationship', payload });
    dagHashes.set(`storey:${storey.expressId}`, hash);
  }

  {
    const childHashes = storeys.map((s) => dagHashes.get(`storey:${s.expressId}`)).filter((h) => h !== undefined);
    const payload = { layerId: ROOT_LAYER_ID, childHashes };
    const hash = await computeNodeHash('layer', payload);
    dagNodes.set('root', { kind: 'layer', payload });
    dagHashes.set('root', hash);
  }

  return { dagNodes, dagHashes, storeys, elementMeta, psetCount, elementCount };
}

/** Set one property in one pset node to `newValue` and cascade
 *  pset -> element (-> storey -> root unless skipped). Mirrors g0's
 *  applyElementEdit/applySiblingTamper cascade discipline. */
async function mutateAndCascade(dag, expressId, propName, newValue, { skipRoot = false, skipStorey = false } = {}) {
  const meta = dag.elementMeta.get(expressId);
  const psetNodeId = meta.psetNodeIds.find((id) => {
    const n = dag.dagNodes.get(id);
    return n.payload.properties.some((p) => p.name === propName);
  }) ?? meta.psetNodeIds[0];

  const old = dag.dagNodes.get(psetNodeId);
  const oldProp = old.payload.properties.find((p) => p.name === propName) ?? old.payload.properties[0];
  const psetIndex = meta.psetNodeIds.indexOf(psetNodeId);

  const newPsetPayload = {
    name: old.payload.name,
    properties: old.payload.properties.map((p) => (p.name === oldProp.name ? { name: p.name, value: newValue } : p)),
  };
  const newPsetHash = await computeNodeHash('property-set', newPsetPayload);
  dag.dagNodes.set(psetNodeId, { kind: 'property-set', payload: newPsetPayload });
  dag.dagHashes.set(psetNodeId, newPsetHash);

  const elementNodeId = `element:${expressId}`;
  const oldElement = dag.dagNodes.get(elementNodeId);
  const key = `pset:${newPsetPayload.name}#${psetIndex}`;
  const newElementPayload = {
    key: oldElement.payload.key,
    ifcType: oldElement.payload.ifcType,
    components: oldElement.payload.components.map((c) => (c.componentKey === key ? { ...c, hash: newPsetHash } : c)),
  };
  const newElementHash = await computeNodeHash('element', newElementPayload);
  dag.dagNodes.set(elementNodeId, { kind: 'element', payload: newElementPayload });
  dag.dagHashes.set(elementNodeId, newElementHash);

  if (!skipStorey) {
    const storey = dag.storeys.find((s) => s.expressId === meta.storeyId);
    const refs = storey.elementIds.map((id) => dag.dagHashes.get(`element:${id}`)).filter((h) => h !== undefined);
    const storeyPayload = { relType: 'IfcRelContainedInSpatialStructure', roles: [{ roleName: 'RelatedElements', refs }] };
    const storeyHash = await computeNodeHash('relationship', storeyPayload);
    dag.dagNodes.set(`storey:${meta.storeyId}`, { kind: 'relationship', payload: storeyPayload });
    dag.dagHashes.set(`storey:${meta.storeyId}`, storeyHash);
  }

  if (!skipRoot) {
    const childHashes = dag.storeys.map((s) => dag.dagHashes.get(`storey:${s.expressId}`)).filter((h) => h !== undefined);
    const rootPayload = { layerId: ROOT_LAYER_ID, childHashes };
    const rootHash = await computeNodeHash('layer', rootPayload);
    dag.dagNodes.set('root', { kind: 'layer', payload: rootPayload });
    dag.dagHashes.set('root', rootHash);
  }

  return {
    psetNodeId,
    elementNodeId,
    storeyNodeId: `storey:${meta.storeyId}`,
    property: oldProp.name,
    before: oldProp.value,
    after: newValue,
  };
}

async function verifyInSecondProcess(bundlePath) {
  const worker = path.join(HERE, 'verify-worker.mjs');
  const { stdout } = await execFileAsync(process.execPath, [worker, bundlePath], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

export async function runAct2({ model }) {
  banner(2, 'PROOF', 'one edit, one certificate; a second process re-derives every hash');

  const store = await parseStore(model.content, `act1-birth-${model.seed}.ifc`);
  const dag = await buildDag(store);
  const totalNodes = dag.dagNodes.size;
  const rootHashBefore = dag.dagHashes.get('root');
  say(`  provenance DAG: ${totalNodes} nodes (${dag.elementCount} elements, ${dag.psetCount} pset/qset leaves, ${dag.storeys.length} storeys, 1 root)`);
  say(`  root hash before edit: ${short(rootHashBefore, 28)}...`);

  // Single-element edit: grow one wall's GrossVolume by exactly 1 m3.
  const target = [...dag.elementMeta.entries()]
    .filter(([, m]) => /^IfcWall/i.test(m.ifcType) && m.psetNodeIds.length > 0)
    .sort(([a], [b]) => a - b)[0];
  if (!target) throw new Error('no wall with a pset/qset found in the act-1 model');
  const [editExpressId, editMeta] = target;

  const grossVolNode = editMeta.psetNodeIds
    .map((id) => dag.dagNodes.get(id).payload.properties.find((p) => p.name === 'GrossVolume'))
    .find(Boolean);
  const before = grossVolNode?.value;
  const edit = await mutateAndCascade(dag, editExpressId, 'GrossVolume', typeof before === 'number' ? before + 1 : 1);
  const rootHashAfter = dag.dagHashes.get('root');
  say(`  edit: ${editMeta.ifcType} #${editExpressId} GrossVolume ${JSON.stringify(edit.before)} -> ${JSON.stringify(edit.after)} m3`);
  say(`  root hash after edit:  ${short(rootHashAfter, 28)}...`);

  // Certificate: writes = the changed path; reads = the element's untouched
  // sibling psets; claim = untouched subtrees. Granularity adapts to the
  // building: multi-storey models claim every OTHER storey (the g0 shape);
  // single-storey models claim every untouched sibling element instead
  // (there is no other storey to point at, so the claim gets finer).
  const multiStorey = dag.storeys.length > 1;
  const untouchedStoreyRefs = multiStorey
    ? dag.storeys
      .filter((s) => s.expressId !== editMeta.storeyId)
      .map((s) => ({ nodeId: `storey:${s.expressId}`, hash: dag.dagHashes.get(`storey:${s.expressId}`) }))
    : dag.storeys[0].elementIds
      .filter((id) => id !== editExpressId)
      .map((id) => ({ nodeId: `element:${id}`, hash: dag.dagHashes.get(`element:${id}`) }))
      .filter((r) => r.hash !== undefined);
  const claimGranularity = multiStorey ? 'storey-subtrees' : 'sibling-element-subtrees';
  const certificate = createCertificate({
    kernelVersion: KERNEL_VERSION,
    trustRoot: TRUST_ROOT,
    reads: editMeta.psetNodeIds
      .filter((id) => id !== edit.psetNodeId)
      .map((id) => ({ nodeId: id, hash: dag.dagHashes.get(id) })),
    writes: [
      { nodeId: edit.psetNodeId, hash: dag.dagHashes.get(edit.psetNodeId) },
      { nodeId: edit.elementNodeId, hash: dag.dagHashes.get(edit.elementNodeId) },
      { nodeId: edit.storeyNodeId, hash: dag.dagHashes.get(edit.storeyNodeId) },
      { nodeId: 'root', hash: rootHashAfter },
    ],
    claims: [{ type: 'subtree-untouched', nodes: untouchedStoreyRefs }],
  });

  const bundle = {
    certificate,
    expectedTrustRoot: TRUST_ROOT,
    expectedKernelVersion: KERNEL_VERSION,
    totalNodes,
    nodes: Object.fromEntries(dag.dagNodes),
  };
  const bundlePath = path.join(OUT_DIR, 'act2-certificate-bundle.json');
  await writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');

  const verdict = await verifyInSecondProcess(bundlePath);
  if (!verdict.ok) throw new Error(`second-process verification unexpectedly failed: ${verdict.reason}`);
  const resolvedPct = verdict.nodesResolved / totalNodes;
  say(`  second-process verify: OK in ${verdict.verifyMs} ms, resolving ${verdict.nodesResolved}/${totalNodes} nodes (${pct(resolvedPct)})`);

  // Tamper: inside claimed-untouched territory, silently shave an element's
  // GrossVolume, cascade honestly up to (but not beyond) the claim boundary,
  // keep the certificate as-is -- and let the second process catch the lie.
  const tamperCandidate = [...dag.elementMeta.entries()]
    .filter(([id, m]) => (multiStorey ? m.storeyId !== editMeta.storeyId : id !== editExpressId) && m.psetNodeIds.length > 0)
    .sort(([a], [b]) => a - b)[0];
  if (!tamperCandidate) throw new Error('no tamperable element inside the untouched claim');
  const [tamperExpressId, tamperMeta] = tamperCandidate;
  const tamper = await mutateAndCascade(dag, tamperExpressId, 'GrossVolume', 0.001, {
    skipRoot: true,
    skipStorey: !multiStorey,
  });
  say(`  tamper: ${tamperMeta.ifcType} #${tamperExpressId} (covered by the untouched claim) ` +
    `${tamper.property} ${JSON.stringify(tamper.before)} -> ${JSON.stringify(tamper.after)}`);

  const tamperedBundle = { ...bundle, nodes: Object.fromEntries(dag.dagNodes) };
  const tamperedPath = path.join(OUT_DIR, 'act2-tampered-bundle.json');
  await writeFile(tamperedPath, JSON.stringify(tamperedBundle), 'utf-8');

  const tamperVerdict = await verifyInSecondProcess(tamperedPath);
  const tamperCaught = tamperVerdict.ok === false;
  say(`  second-process verify of tampered copy: ${tamperCaught ? `REFUSED (${tamperVerdict.reason})` : 'ACCEPTED -- BUG'}`);

  say('');
  say(`  HEADLINE: certificate verified across a process boundary reading ${pct(resolvedPct)} of the DAG; tamper caught: ${tamperCaught}`);

  return {
    deterministic: {
      totalNodes,
      elements: dag.elementCount,
      psetLeaves: dag.psetCount,
      storeys: dag.storeys.length,
      rootHashBefore,
      rootHashAfter,
      edit: {
        expressId: editExpressId,
        ifcType: editMeta.ifcType,
        property: edit.property,
        before: edit.before,
        after: edit.after,
      },
      certificateWrites: certificate.writes.length,
      certificateReads: certificate.reads.length,
      claimGranularity,
      untouchedClaimRefs: untouchedStoreyRefs.length,
      secondProcessVerifyOk: verdict.ok,
      nodesResolved: verdict.nodesResolved,
      nodesResolvedPct: Number((resolvedPct * 100).toFixed(4)),
      tamper: {
        expressId: tamperExpressId,
        ifcType: tamperMeta.ifcType,
        caught: tamperCaught,
        reason: tamperVerdict.ok ? null : tamperVerdict.reason,
      },
    },
    volatile: { verifyMs: verdict.verifyMs, tamperVerifyMs: tamperVerdict.verifyMs },
  };
}

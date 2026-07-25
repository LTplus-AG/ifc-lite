/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Kernel-side checks and measurements for M5 (B2.3). Reuses the World Gym's
 * in-process check module (tools/world-gym/lib/checks.mjs, the M2 bet)
 * verbatim: same warm GeometryProcessor, same computeValidationIssues, same
 * clash engine. On top of that it measures the compiled IFC (element counts,
 * AABB-derived dimensions and areas) so task quality is scored from what an
 * independent reader extracts from the bytes, never from the op list.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const checks = await import(
  path.join(REPO_ROOT, 'tools/world-gym/lib/checks.mjs')
);
const { EntityNode } = await import(
  path.join(REPO_ROOT, 'packages/query/dist/index.js')
);

export const { parseStore, schemaCheckInProcess, clashCheckInProcess, initChecks } = checks;

/**
 * Per-op kernel gate used by the constrained decoder: compile the accepted
 * prefix, parse it back, run schema validation, mesh it, and confirm the
 * newly added element actually produced geometry. Returns
 * { ok, error?, schema? }.
 */
export async function kernelGate(content, newExpressIds = []) {
  let store;
  try {
    store = await parseStore(content);
  } catch (e) {
    return { ok: false, error: `kernel parse failed: ${e.message}` };
  }
  const schema = schemaCheckInProcess(store);
  if (!schema.valid) {
    const first = schema.issues.find((i) => i.severity === 'error');
    return { ok: false, error: `schema validation failed: ${first?.rule}: ${first?.message}`, schema };
  }
  if (newExpressIds.length > 0) {
    const processor = await initChecks();
    const result = await processor.process(store.source);
    const meshed = new Set(result.meshes.map((m) => m.expressId));
    for (const id of newExpressIds) {
      if (!meshed.has(id)) {
        return { ok: false, error: `kernel meshing produced no geometry for the new element (express id ${id}); the op describes a degenerate solid`, schema };
      }
    }
  }
  return { ok: true, schema };
}

function aabbOfMesh(mesh) {
  const p = mesh.positions;
  if (!p || p.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  // Wasm meshes are local-frame; world = origin + position (see
  // packages/clash/dist/adapters/step.js and the local-frame consumer audit).
  const o = mesh.origin ?? [0, 0, 0];
  return {
    min: [minX + o[0], minY + o[1], minZ + o[2]],
    max: [maxX + o[0], maxY + o[1], maxZ + o[2]],
  };
}

const COUNT_TYPES = {
  storeys: 'IFCBUILDINGSTOREY',
  walls: 'IFCWALL',
  slabs: 'IFCSLAB',
  columns: 'IFCCOLUMN',
  beams: 'IFCBEAM',
  windows: 'IFCWINDOW',
  doors: 'IFCDOOR',
  spaces: 'IFCSPACE',
};

/**
 * Measure a compiled model. Returns the full measurement record the scoring
 * rubric consumes plus the raw schema/clash verdicts.
 */
export async function measureModel(content) {
  const store = await parseStore(content);
  const schema = schemaCheckInProcess(store);
  const clash = await clashCheckInProcess(store, 'm5.ifc');

  const counts = {};
  for (const [key, ifcType] of Object.entries(COUNT_TYPES)) {
    counts[key] = (store.entityIndex.byType.get(ifcType) ?? []).length;
  }

  const processor = await initChecks();
  const meshResult = await processor.process(store.source);
  const typeOf = (id) => new EntityNode(store, id).type ?? '';

  let all = null;
  let slabBox = null;
  let windowArea = 0;
  let wallGrossArea = 0;
  const windowAreas = [];
  const spaceAreas = [];
  // Per-type element boxes in the IFC frame (x east, y north, z up), for
  // placement-intent criteria (grid regularity, opening overlaps). Folded
  // from the right-handed Y-up viewer frame: IFC x = mesh x,
  // IFC y = -mesh z, IFC z = mesh y (verified against golden column grids).
  const KIND_BY_TYPE = {
    IfcWall: 'walls', IfcWindow: 'windows', IfcDoor: 'doors',
    IfcColumn: 'columns', IfcBeam: 'beams', IfcSlab: 'slabs', IfcSpace: 'spaces',
  };
  const boxes = { walls: [], windows: [], doors: [], columns: [], beams: [], slabs: [], spaces: [] };

  const merge = (acc, b) => {
    if (!acc) return { min: [...b.min], max: [...b.max] };
    for (let i = 0; i < 3; i++) {
      acc.min[i] = Math.min(acc.min[i], b.min[i]);
      acc.max[i] = Math.max(acc.max[i], b.max[i]);
    }
    return acc;
  };

  // Mesh frame note (verified by selftest): the wasm geometry pipeline
  // emits viewer-frame Y-UP meshes - mesh x = plan X, mesh y = height (IFC
  // z), mesh z = plan Y. All plan/height splits below use that mapping.
  for (const mesh of meshResult.meshes) {
    const box = aabbOfMesh(mesh);
    if (!box) continue;
    const type = typeOf(mesh.expressId);
    const d = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    if (type !== 'IfcOpeningElement') all = merge(all, box);
    if (type === 'IfcSlab') slabBox = merge(slabBox, box);
    if (type === 'IfcWindow') {
      const sorted = [...d].sort((a, b) => b - a);
      windowArea += sorted[0] * sorted[1];
      windowAreas.push(sorted[0] * sorted[1]);
    }
    if (type === 'IfcWall') {
      wallGrossArea += Math.max(d[0], d[2]) * d[1];
    }
    if (type === 'IfcSpace') {
      spaceAreas.push(d[0] * d[2]);
    }
    const kind = KIND_BY_TYPE[type];
    if (kind) {
      const min = [box.min[0], -box.max[2], box.min[1]];
      const max = [box.max[0], -box.min[2], box.max[1]];
      boxes[kind].push({
        min, max,
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      });
    }
  }

  // Report plan extents as dx (plan X) / dy (plan Y) and height as dz,
  // folding the Y-up mesh frame back into IFC axes.
  const dims = (box) => box
    ? { dx: box.max[0] - box.min[0], dy: box.max[2] - box.min[2], dz: box.max[1] - box.min[1] }
    : null;

  /** Fraction of entities of `ifcType` carrying pset/name === value. */
  const propertyFraction = (ifcType, pset, propName, value) => {
    const ids = store.entityIndex.byType.get(ifcType) ?? [];
    if (ids.length === 0) return 0;
    let hits = 0;
    for (const id of ids) {
      const v = new EntityNode(store, id).property(pset, propName);
      if (v === value) hits += 1;
    }
    return hits / ids.length;
  };

  return {
    counts,
    footprint: dims(slabBox),
    overall: dims(all),
    windowArea,
    windowAreas: windowAreas.sort((a, b) => a - b),
    wallGrossArea,
    spaceAreas: spaceAreas.sort((a, b) => a - b),
    spaceArea: spaceAreas.reduce((a, b) => a + b, 0),
    boxes,
    meshedElements: meshResult.meshes.length,
    schema: { valid: schema.valid, errors: schema.errors, warnings: schema.warnings },
    clash: clash.ok ? { total: clash.total } : { total: null, error: clash.error },
    propertyFraction,
  };
}

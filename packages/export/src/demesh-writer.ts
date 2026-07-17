/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Demesher IFC writer: replace product representations with simplified
 * tessellated geometry and prune the orphaned original geometry subgraphs.
 *
 * Per element this authors `IfcCartesianPointList3D` →
 * `IfcTriangulatedFaceSet` → `IfcShapeRepresentation('Body','Tessellation')`
 * → `IfcProductDefinitionShape` in the editor overlay, swaps the product's
 * `Representation` attribute, then runs ONE global reverse-reference
 * mark-and-sweep over the replaced subgraphs: an old geometry entity is
 * tombstoned only when every entity that references it is itself being
 * tombstoned. Shared representations (`IfcMappedItem` sources, a
 * `IfcProductDefinitionShape` shared by several products) survive partial
 * selections by construction. Type-library geometry
 * (`IfcTypeProduct.RepresentationMaps`) is likewise kept — the type object
 * itself still references it.
 *
 * Geometry arrives from the wasm demesher (`simplifyMeshes`) already in the
 * element's object-placement frame in FILE units, so this module does no
 * coordinate math beyond rounding. `IfcTriangulatedFaceSet` requires IFC4+ —
 * callers upconvert IFC2X3 stores before applying (`convert --schema IFC4`
 * path).
 */

import { EntityExtractor, getAllAttributesForEntity, type IfcDataStore } from '@ifc-lite/parser';
import { collectReferencedEntityIds, collectRefsInByteRange } from './reference-collector.js';
import { stepReal } from './step-serialization.js';

/** Attribute value union accepted by the editor (structural, see below). */
type EditorValue = unknown;

/**
 * The three editor primitives this writer needs — structurally satisfied by
 * `@ifc-lite/mutations` `StoreEditor` (kept duck-typed so `@ifc-lite/export`
 * does not grow a package dependency on `@ifc-lite/mutations`).
 */
export interface DemeshEditorLike {
  addEntity(type: string, attributes: EditorValue[]): { expressId: number };
  setPositionalAttribute(expressId: number, index: number, value: EditorValue): void;
  removeEntity(expressId: number): boolean;
}

/** One element's simplified geometry, in its object-placement frame, file units. */
export interface SimplifiedElementGeometry {
  expressId: number;
  /** xyz triplets (f64), element object frame, FILE units, IFC Z-up. */
  positions: ArrayLike<number>;
  /** 0-based triangle indices (converted to 1-based `CoordIndex` here). */
  indices: ArrayLike<number>;
  /** RGBA 0..1 for the replacement's surface style; omit for no style. */
  color?: ArrayLike<number>;
}

export interface ApplySimplifiedGeometryOptions {
  /**
   * Tombstone `IfcRelVoidsElement` / `IfcOpeningElement` attached to replaced
   * products (default true): opening cuts are already baked into the
   * simplified mesh, and a stale void relationship would re-cut it.
   */
  stripOpenings?: boolean;
  /** Coordinate rounding, decimal places in file units (default 6). */
  coordinateDecimals?: number;
}

export interface DemeshApplyReport {
  /** Products whose Representation was swapped. */
  replaced: number[];
  /** Elements left untouched, with a reason slug. */
  skipped: Array<{ expressId: number; reason: string }>;
  /** Original-geometry entities tombstoned by the prune. */
  prunedEntityCount: number;
  /** IfcRelVoidsElement + IfcOpeningElement entities stripped. */
  strippedOpeningCount: number;
  warnings: string[];
}

/**
 * Entity types the sweep must never tombstone even when they fall inside a
 * replaced subgraph's closure: shared model infrastructure that the NEW
 * overlay entities (invisible to the source-byte reverse index) or the rest
 * of the file may reference.
 */
const PROTECTED_TYPES = new Set([
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
  'IFCUNITASSIGNMENT',
  'IFCSIUNIT',
  'IFCCONVERSIONBASEDUNIT',
  'IFCOWNERHISTORY',
  'IFCPERSON',
  'IFCORGANIZATION',
  'IFCPERSONANDORGANIZATION',
  'IFCAPPLICATION',
]);

/**
 * Apply simplified geometry to the store's editor overlay. The store buffer
 * itself is never mutated; changes materialize on the next
 * `StepExporter.export({ applyMutations: true })`.
 */
export function applySimplifiedGeometry(
  store: IfcDataStore,
  editor: DemeshEditorLike,
  elements: SimplifiedElementGeometry[],
  options: ApplySimplifiedGeometryOptions = {},
): DemeshApplyReport {
  const report: DemeshApplyReport = {
    replaced: [],
    skipped: [],
    prunedEntityCount: 0,
    strippedOpeningCount: 0,
    warnings: [],
  };
  if (!store.source) {
    throw new Error('applySimplifiedGeometry: store has no source buffer');
  }
  const source = store.source;
  const byId = store.entityIndex.byId;
  const extractor = new EntityExtractor(source);
  const decimals = options.coordinateDecimals ?? 6;
  const roundFactor = 10 ** decimals;
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * roundFactor) / roundFactor : 0);

  const getEntity = (id: number) => {
    const ref = byId.get(id);
    return ref ? extractor.extractEntity(ref) : null;
  };

  const contextId = findBodyContextId(byId, getEntity);
  if (contextId === null) {
    report.warnings.push('no IfcGeometricRepresentationContext found; nothing applied');
    for (const el of elements) {
      report.skipped.push({ expressId: el.expressId, reason: 'no-context' });
    }
    return report;
  }

  // One IfcSurfaceStyle chain per distinct RGBA across all elements.
  const styleCache = new Map<string, number>();
  const surfaceStyleFor = (color: ArrayLike<number>): number => {
    const r = clamp01(color[0]);
    const g = clamp01(color[1]);
    const b = clamp01(color[2]);
    const a = color.length > 3 ? clamp01(color[3]) : 1;
    const key = `${r},${g},${b},${a}`;
    const cached = styleCache.get(key);
    if (cached !== undefined) return cached;
    const rgb = editor.addEntity('IfcColourRgb', [null, stepReal(r), stepReal(g), stepReal(b)]);
    const shading = editor.addEntity('IfcSurfaceStyleShading', [
      `#${rgb.expressId}`,
      stepReal(roundTo(1 - a, 4)),
    ]);
    const style = editor.addEntity('IfcSurfaceStyle', [
      null,
      '.BOTH.',
      [`#${shading.expressId}`],
    ]);
    styleCache.set(key, style.expressId);
    return style.expressId;
  };

  /** productId -> the old Representation ref it was detached from (if any). */
  const replacedOldRep = new Map<number, number | null>();

  for (const el of elements) {
    const ref = byId.get(el.expressId);
    if (!ref) {
      report.skipped.push({ expressId: el.expressId, reason: 'not-found' });
      continue;
    }
    const repAttrIndex = findAttrIndex(ref.type, 'Representation');
    if (repAttrIndex === null) {
      report.skipped.push({ expressId: el.expressId, reason: 'no-representation-attribute' });
      continue;
    }
    // Malformed geometry is rejected, never repaired: a trailing coordinate
    // silently dropped by flooring, or a NaN/Infinity coerced to 0 by
    // `round()`, would author a subtly wrong tessellation into the file.
    const vertexCount = Math.floor(el.positions.length / 3);
    const triCount = Math.floor(el.indices.length / 3);
    if (
      el.positions.length % 3 !== 0 ||
      el.indices.length % 3 !== 0 ||
      vertexCount < 3 ||
      triCount < 1 ||
      !valuesAreFinite(el.positions) ||
      !indicesInRange(el.indices, vertexCount)
    ) {
      report.skipped.push({ expressId: el.expressId, reason: 'invalid-geometry' });
      continue;
    }

    const entity = getEntity(el.expressId);
    const oldRep = entity && typeof entity.attributes?.[repAttrIndex] === 'number'
      ? (entity.attributes[repAttrIndex] as number)
      : null;

    // CoordList: LIST OF LIST [3:3] OF IfcLengthMeasure — REAL literals.
    const coordList: unknown[] = new Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      coordList[v] = [
        stepReal(round(el.positions[v * 3])),
        stepReal(round(el.positions[v * 3 + 1])),
        stepReal(round(el.positions[v * 3 + 2])),
      ];
    }
    // CoordIndex: LIST OF LIST [3:3] OF IfcPositiveInteger — 1-BASED.
    const coordIndex: unknown[] = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
      coordIndex[t] = [
        Number(el.indices[t * 3]) + 1,
        Number(el.indices[t * 3 + 1]) + 1,
        Number(el.indices[t * 3 + 2]) + 1,
      ];
    }

    const pointList = editor.addEntity('IfcCartesianPointList3D', [coordList]);
    // (Coordinates, Normals, Closed, CoordIndex, PnIndex) — normals omitted
    // (consumers compute flat normals), Closed unknown (decimation may open
    // the shell).
    const faceSet = editor.addEntity('IfcTriangulatedFaceSet', [
      `#${pointList.expressId}`,
      null,
      null,
      coordIndex,
      null,
    ]);
    const shapeRep = editor.addEntity('IfcShapeRepresentation', [
      `#${contextId}`,
      'Body',
      'Tessellation',
      [`#${faceSet.expressId}`],
    ]);
    const pds = editor.addEntity('IfcProductDefinitionShape', [
      null,
      null,
      [`#${shapeRep.expressId}`],
    ]);
    editor.setPositionalAttribute(el.expressId, repAttrIndex, `#${pds.expressId}`);

    if (el.color && el.color.length >= 3) {
      const styleId = surfaceStyleFor(el.color);
      editor.addEntity('IfcStyledItem', [`#${faceSet.expressId}`, [`#${styleId}`], null]);
    }

    replacedOldRep.set(el.expressId, oldRep);
    report.replaced.push(el.expressId);
  }

  if (report.replaced.length === 0) {
    return report;
  }

  pruneReplacedSubgraphs(store, editor, replacedOldRep, options.stripOpenings !== false, report);
  return report;
}

/**
 * Global reverse-reference mark-and-sweep over the replaced products' old
 * geometry subgraphs (see the module doc). Also strips void relationships
 * for replaced hosts and filters `IfcPresentationLayerAssignment` item
 * lists that pointed at pruned geometry.
 */
function pruneReplacedSubgraphs(
  store: IfcDataStore,
  editor: DemeshEditorLike,
  replacedOldRep: Map<number, number | null>,
  stripOpenings: boolean,
  report: DemeshApplyReport,
): void {
  const source = store.source!;
  const byId = store.entityIndex.byId;
  const extractor = new EntityExtractor(source);
  const indexAdapter = {
    get: (id: number) => byId.get(id),
    has: (id: number) => byId.has(id),
  };

  // -- Roots: the detached representation subgraphs.
  const roots = new Set<number>();
  for (const oldRep of replacedOldRep.values()) {
    if (oldRep !== null && byId.has(oldRep)) roots.add(oldRep);
  }

  // -- Openings of replaced hosts: the rel is deleted outright (its cut is
  // baked into the new mesh); the opening element and its geometry join the
  // candidate closure and fall to the ordinary sweep.
  const deleted = new Set<number>();
  if (stripOpenings) {
    for (const [id, ref] of byId) {
      if (ref.type.toUpperCase() !== 'IFCRELVOIDSELEMENT') continue;
      const rel = extractor.extractEntity(ref);
      const relating = rel?.attributes?.[4];
      const opening = rel?.attributes?.[5];
      if (typeof relating !== 'number' || !replacedOldRep.has(relating)) continue;
      deleted.add(id);
      if (typeof opening === 'number' && byId.has(opening)) {
        roots.add(opening);
      }
    }
  }

  if (roots.size === 0 && deleted.size === 0) return;

  // -- Candidate closure: everything transitively reachable from the roots.
  const closure = collectReferencedEntityIds(roots, source, indexAdapter);

  // Style/annotation entities hang OFF the geometry (IfcStyledItem.Item →
  // geometry item), so forward reachability misses them; pull in styled
  // items whose target is in the closure, plus what they reference (shared
  // surface styles survive via their other referrers).
  const styledItemRoots = new Set<number>();
  for (const [id, ref] of byId) {
    if (closure.has(id) || ref.type.toUpperCase() !== 'IFCSTYLEDITEM') continue;
    const refs = collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
    if (refs.some((target) => target !== id && closure.has(target))) {
      styledItemRoots.add(id);
    }
  }
  if (styledItemRoots.size > 0) {
    for (const id of collectReferencedEntityIds(styledItemRoots, source, indexAdapter)) {
      closure.add(id);
    }
  }

  // -- Reverse-reference index, restricted to edges INTO the closure.
  const referrers = new Map<number, Set<number>>();
  for (const [id, ref] of byId) {
    const refs = collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
    for (const target of refs) {
      if (target === id || !closure.has(target)) continue;
      let set = referrers.get(target);
      if (!set) {
        set = new Set();
        referrers.set(target, set);
      }
      set.add(id);
    }
  }

  // The representation swap detached product → old-PDS: remove those edges
  // (the reverse index was built from the unmodified source bytes).
  for (const [productId, oldRep] of replacedOldRep) {
    if (oldRep !== null) referrers.get(oldRep)?.delete(productId);
  }

  // -- Sweep to fixpoint: tombstone an entity once every referrer is
  // tombstoned. Protected infrastructure never falls, even if orphaned.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of closure) {
      if (deleted.has(id)) continue;
      const ref = byId.get(id);
      if (!ref || PROTECTED_TYPES.has(ref.type.toUpperCase())) continue;
      const incoming = referrers.get(id);
      let live = false;
      if (incoming) {
        for (const from of incoming) {
          if (!deleted.has(from)) {
            live = true;
            break;
          }
        }
      }
      if (!live) {
        deleted.add(id);
        changed = true;
      }
    }
  }

  // -- Apply tombstones.
  let openingCount = 0;
  for (const id of deleted) {
    const type = byId.get(id)?.type.toUpperCase();
    if (type === 'IFCRELVOIDSELEMENT' || type === 'IFCOPENINGELEMENT') openingCount++;
    if (editor.removeEntity(id)) report.prunedEntityCount++;
  }
  report.strippedOpeningCount = openingCount;

  // -- Presentation layers: filter tombstoned items out of AssignedItems;
  // a layer left empty is tombstoned too (an empty list is schema-invalid).
  for (const [id, ref] of byId) {
    if (deleted.has(id) || ref.type.toUpperCase() !== 'IFCPRESENTATIONLAYERASSIGNMENT') continue;
    const layer = extractor.extractEntity(ref);
    const items = layer?.attributes?.[2];
    if (!Array.isArray(items)) continue;
    const kept = items.filter((item) => typeof item === 'number' && !deleted.has(item));
    if (kept.length === items.length) continue;
    if (kept.length === 0) {
      if (editor.removeEntity(id)) report.prunedEntityCount++;
    } else {
      editor.setPositionalAttribute(id, 2, kept.map((item) => `#${item as number}`));
    }
  }
}

/**
 * The file's 'Body' `IfcGeometricRepresentationSubContext` (the context
 * every authored Body representation should share), falling back to a
 * 'Model' `IfcGeometricRepresentationContext`, then to any geometric
 * context. `null` when the file has none (pathological).
 */
function findBodyContextId(
  byId: IfcDataStore['entityIndex']['byId'],
  getEntity: (id: number) => { attributes?: unknown[] } | null,
): number | null {
  let modelContext: number | null = null;
  let anyContext: number | null = null;
  for (const [id, ref] of byId) {
    const type = ref.type.toUpperCase();
    if (type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT') {
      const attrs = getEntity(id)?.attributes;
      if (typeof attrs?.[0] === 'string' && attrs[0].toUpperCase() === 'BODY') {
        return id;
      }
    } else if (type === 'IFCGEOMETRICREPRESENTATIONCONTEXT') {
      const attrs = getEntity(id)?.attributes;
      if (modelContext === null && typeof attrs?.[1] === 'string' && attrs[1].toUpperCase() === 'MODEL') {
        modelContext = id;
      }
      if (anyContext === null) anyContext = id;
    }
  }
  return modelContext ?? anyContext;
}

function findAttrIndex(typeName: string, attrName: string): number | null {
  const attrs = getAllAttributesForEntity(typeName);
  if (!attrs || attrs.length === 0) return null;
  const idx = attrs.findIndex((a) => a?.name === attrName);
  return idx >= 0 ? idx : null;
}

function valuesAreFinite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function indicesInRange(indices: ArrayLike<number>, vertexCount: number): boolean {
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0 || v >= vertexCount) return false;
  }
  return true;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

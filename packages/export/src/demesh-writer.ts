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
import { pruneReplacedSubgraphs } from './demesh-prune.js';
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
 * Apply simplified geometry to the store's editor overlay. The store buffer
 * itself is never mutated; changes materialize on the next
 * `StepExporter.export({ applyMutations: true })`.
 *
 * The store must have a COMPLETE `entityIndex.byId` — the prune's reverse
 * index walks it as the referrer universe. A store parsed with
 * `deferPropertyAtomIndex` keeps property atoms out of `byId`, so feed a
 * full reparse instead (`DemeshSession` always does).
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
    // A repeated id would author a second overlay chain and orphan the first
    // (bloat, not corruption) — replace once, skip the rest.
    if (replacedOldRep.has(el.expressId)) {
      report.skipped.push({ expressId: el.expressId, reason: 'duplicate-id' });
      continue;
    }
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

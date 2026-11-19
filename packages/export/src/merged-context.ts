/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared-infrastructure unify for {@link MergedExporter} — the entry point
 * `MergedExporter.planModel` delegates to (merge invariant lens passes 2 and
 * 3, item 1, combined).
 *
 * `MergedExporter` deduplicates each model's shared infrastructure —
 * `IfcUnitAssignment`, `IfcGeometricRepresentationContext` and its
 * subcontexts — onto the primary model's instance whenever the model is
 * unit-compatible. `IfcUnitAssignment` unifies unconditionally (a pure unit
 * declaration), but a representation context also carries a
 * `WorldCoordinateSystem`: the root frame (origin and orientation) every placement in that context
 * ultimately resolves against. Silently dropping a model's own context in
 * favour of the primary's — without checking the WCS frame matches — would
 * re-interpret every one of that model's untouched coordinates against the
 * WRONG origin: a wrong-place bug, not merely a duplicate-entity one. A
 * context whose WCS disagrees keeps its own root, exactly like the
 * pre-existing "incompatible unit" federation path already does.
 *
 * A subcontext ('Body', 'Axis', 'FootPrint', …) does not unify positionally
 * either: it goes through {@link planSubContextUnify} (`merged-subcontext.ts`),
 * matched by kind (`ContextIdentifier`/`TargetView`) rather than raw array
 * position, so two authoring tools that declared their subcontexts in a
 * different order never cross-wire a 'Body' representation onto an 'Axis'
 * context. That kind match is additionally gated on the parent context's WCS
 * compatibility: a subcontext inherits its frame from `ParentContext`, so
 * when the top-level context's frame disagrees with the primary's, this
 * model's subcontexts still reference its own (un-remapped) context, and
 * unifying them onto the primary's subcontexts would misplace them just the
 * same.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { COORDINATE_OPERATION_STEP_TYPES } from './georef-closure.js';
import { BARE_REF_RE } from './reference-collector.js';
import { getStepAttr, groupSubContextsByKey, planSubContextUnify } from './merged-subcontext.js';
import { PROJECT_REPRESENTATION_CONTEXTS_ATTR, refsIn } from './merged-project-contexts.js';

/** A resolved WorldCoordinateSystem frame: origin in metres and normalized axes. */
export interface WcsSignature {
  x: number;
  y: number;
  z: number;
  axis: [number, number, number];
  refDirection: [number, number, number];
}

/** Tolerance for WCS origins (metres) and normalized directions. */
const WCS_TOLERANCE_M = 1e-6;

/** 0-based attribute index of `IfcGeometricRepresentationSubContext.ParentContext`. */
const SUBCONTEXT_PARENT_CONTEXT_ATTR = 6;

/** A `#N` reference, with STEP trivia (a comment, #3789) tolerated around it. */
function refId(raw: string | null): number | null {
  const m = raw?.match(BARE_REF_RE);
  return m ? parseInt(m[1], 10) : null;
}

function parseCoord(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseVector(dataStore: IfcDataStore, directionId: number | null, fallback: [number, number, number]): [number, number, number] | null {
  if (directionId === null) return fallback;
  const raw = getStepAttr(dataStore, directionId, 0);
  const inner = raw?.replace(/^\(|\)$/g, '');
  const parts = inner === undefined ? null : splitTopLevelStepArguments(inner);
  if (!parts || parts.length < 2) return null;
  const x = parseCoord(parts[0]);
  const y = parseCoord(parts[1]);
  const z = parts.length > 2 ? parseCoord(parts[2]) : 0;
  if (x === null || y === null || z === null) return null;
  const magnitude = Math.hypot(x, y, z);
  if (magnitude === 0) return null;
  return [x / magnitude, y / magnitude, z / magnitude];
}

/**
 * Resolve the WorldCoordinateSystem frame of `contextId` (an
 * `IfcGeometricRepresentationContext`), in metres.
 *
 * Attr 4 is `WorldCoordinateSystem`, an `IfcAxis2Placement` (2D/3D) whose
 * attr 0 is `Location` (an `IfcCartesianPoint`), attrs 1/2 are `Axis` and
 * `RefDirection` — but tolerates a context
 * pointing straight at a point (no placement wrapper), the shape this
 * package's own test fixtures use. Returns null when any hop is
 * unresolvable (missing entity, `$`, non-numeric): callers must treat null
 * permissively (compatible), never as "known to differ", so an unusual but
 * harmless context shape never blocks a merge that used to work.
 */
export function resolveContextWcsMetres(
  dataStore: IfcDataStore,
  contextId: number,
  lengthUnitScale: number,
): WcsSignature | null {
  const wcsRef = refId(getStepAttr(dataStore, contextId, 4));
  if (wcsRef === null) return null;
  // @raw-entity-enumeration-ok point lookup for a source WCS atom in the baked merge input
  const wcsType = (dataStore.entityIndex.byId.get(wcsRef)?.type ?? '').toUpperCase();
  const pointId = wcsType.includes('CARTESIANPOINT') ? wcsRef : refId(getStepAttr(dataStore, wcsRef, 0));
  if (pointId === null) return null;

  const coordsRaw = getStepAttr(dataStore, pointId, 0);
  const inner = coordsRaw?.replace(/^\(|\)$/g, '');
  const parts = inner === undefined ? null : splitTopLevelStepArguments(inner);
  if (!parts || parts.length < 2) return null;

  const x = parseCoord(parts[0]);
  const y = parseCoord(parts[1]);
  const z = parts.length > 2 ? parseCoord(parts[2]) : 0;
  if (x === null || y === null || z === null) return null;

  const scale = Number.isFinite(lengthUnitScale) && lengthUnitScale > 0 ? lengthUnitScale : 1;
  // Axis2Placement defaults omitted Axis and RefDirection to +Z and +X.
  // Treat omitted and explicit defaults identically, not as an unknown shape.
  const isPoint = wcsType.includes('CARTESIANPOINT');
  const is2dPlacement = wcsType.includes('AXIS2PLACEMENT2D');
  // IFC2D places its sole RefDirection at attribute 1; treating that slot as
  // a 3D Axis loses rotations in the XY frame and can wrongly unify contexts.
  const axis = isPoint || is2dPlacement
    ? [0, 0, 1] as [number, number, number]
    : parseVector(dataStore, refId(getStepAttr(dataStore, wcsRef, 1)), [0, 0, 1]);
  const refDirection = isPoint
    ? [1, 0, 0] as [number, number, number]
    : parseVector(dataStore, refId(getStepAttr(dataStore, wcsRef, is2dPlacement ? 1 : 2)), [1, 0, 0]);
  if (axis === null || refDirection === null) return null;
  return { x: x * scale, y: y * scale, z: z * scale, axis, refDirection };
}

/** A model's first `IfcGeometricRepresentationContext`, the one the merge unifies. */
function firstContextId(dataStore: IfcDataStore): number | undefined {
  // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so this first source context is the merged input's current context
  return (dataStore.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])[0];
}

/** `resolveContextWcsMetres` for a model's first `IfcGeometricRepresentationContext`, or null if it has none. */
export function resolveModelContextWcs(dataStore: IfcDataStore, lengthUnitScale: number): WcsSignature | null {
  const contextId = firstContextId(dataStore);
  return contextId === undefined ? null : resolveContextWcsMetres(dataStore, contextId, lengthUnitScale);
}

/** Relative tolerance for comparing two length unit scale factors. */
const UNIT_SCALE_TOLERANCE = 1e-6;

/** True when two length unit scales are equal within {@link UNIT_SCALE_TOLERANCE}. */
export function unitScalesEqual(a: number, b: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  return a === b || max === 0 || Math.abs(a - b) <= max * UNIT_SCALE_TOLERANCE;
}

/**
 * A context's georeference as the values that place it on the map: `placement` the operation and CRS, `unitScale`
 * the map unit in metres, null when the parser cannot resolve it (then it matches no other).
 */
export interface GeorefSignature { placement: string; unitScale: number | null }

/**
 * The {@link GeorefSignature} of `dataStore`'s first representation context, or null when no coordinate operation
 * sits on it. It reads the parser's georeference, which resolves the map unit, and fills IFC defaults (scale 1, no
 * rotation), so two spellings of one georeference agree; a CRS without a map unit uses the project's length unit
 * (`lengthUnitScale`). An operation the parser does not read as the model's georeference, and a geographic CRS
 * (whose height unit it does not read), match no other. Two contexts in one frame with different georeferences
 * place the same coordinates at two places on the map, so they must not be unified (#10798).
 */
export function resolveModelContextGeorefSignature(dataStore: IfcDataStore, lengthUnitScale: number): GeorefSignature | null {
  const contextId = firstContextId(dataStore);
  if (contextId === undefined || contextOperation(dataStore, contextId) === null) return null;
  const { mapConversion: op, projectedCRS: crs } = extractGeoreferencingOnDemand(dataStore) ?? {};
  if (!op || op.sourceCRS !== contextId) return { placement: 'unread', unitScale: null };
  return {
    placement: JSON.stringify([op.operation ?? 'mapConversion', crs?.kind, crs?.name, crs?.geodeticDatum, crs?.verticalDatum,
      crs?.mapProjection, crs?.mapZone, crs?.wellKnownText, op.eastings, op.northings, op.orthogonalHeight,
      op.xAxisAbscissa ?? 1, op.xAxisOrdinate ?? 0, op.scale ?? 1, op.factorX ?? 1, op.factorY ?? 1, op.factorZ ?? 1]),
    unitScale: crs?.mapUnitResolved === false || crs?.kind === 'geographic' ? null : crs?.mapUnitScale ?? lengthUnitScale,
  };
}

/** A context's coordinate operation and its target CRS. */
export interface ContextOperation { operation: number; crs: number | null }

/** The first coordinate operation whose SourceCRS is `contextId`, with its TargetCRS, or null when none is. */
function contextOperation(dataStore: IfcDataStore, contextId: number): ContextOperation | null {
  for (const type of COORDINATE_OPERATION_STEP_TYPES) {
    // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current operations
    for (const id of dataStore.entityIndex.byType.get(type) ?? []) {
      if (refId(getStepAttr(dataStore, id, 0)) === contextId) return { operation: id, crs: refId(getStepAttr(dataStore, id, 1)) };
    }
  }
  return null;
}

/**
 * The primary model's context state {@link planInfrastructureUnify} matches
 * every later model against: its subcontexts grouped by kind key
 * (`merged-subcontext.ts`) and its top-level context's WCS frame, resolved at
 * the PRIMARY scale. Computed once per merge via
 * {@link resolvePrimaryContextState}, not per model.
 */
export interface PrimaryContextState {
  subContextsByKey: Map<string, number[]>;
  contextWcs: WcsSignature | null;
  /**
   * {@link resolveModelContextGeorefSignature} of the shared context so far: the primary model's, or, when it has
   * none, that of the first later model that unified onto it. {@link planInfrastructureUnify} updates it.
   */
  contextGeoref: GeorefSignature | null;
  /** The shared context's coordinate operation and CRS, as output ids, which a later model's identical one maps onto. */
  contextOperation: ContextOperation | null;
}

/** Build the {@link PrimaryContextState} for the primary model. */
export function resolvePrimaryContextState(
  dataStore: IfcDataStore,
  subContextIds: number[],
  primaryScale: number,
  offset: number,
): PrimaryContextState {
  const contextId = firstContextId(dataStore);
  return {
    subContextsByKey: groupSubContextsByKey(dataStore, subContextIds),
    contextWcs: resolveModelContextWcs(dataStore, primaryScale),
    contextGeoref: resolveModelContextGeorefSignature(dataStore, primaryScale),
    contextOperation: contextId === undefined ? null : offsetOperation(contextOperation(dataStore, contextId), offset),
  };
}

const offsetOperation = (operation: ContextOperation | null, offset: number): ContextOperation | null =>
  operation && { operation: operation.operation + offset, crs: operation.crs === null ? null : operation.crs + offset };

/**
 * True when two resolved WCS frames are the same within tolerance, OR
 * either is null (unresolvable — permissive: never block a merge on a
 * context shape this reader couldn't fully parse).
 */
function wcsSignaturesCompatible(a: WcsSignature | null, b: WcsSignature | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a.x - b.x) <= WCS_TOLERANCE_M
    && Math.abs(a.y - b.y) <= WCS_TOLERANCE_M
    && Math.abs(a.z - b.z) <= WCS_TOLERANCE_M
    && a.axis.every((value, index) => Math.abs(value - b.axis[index]) <= WCS_TOLERANCE_M)
    && a.refDirection.every((value, index) => Math.abs(value - b.refDirection[index]) <= WCS_TOLERANCE_M);
}

/** True when two georeferences agree, or either model declares none (one georeferences the shared frame). */
function georefSignaturesCompatible(a: GeorefSignature | null, b: GeorefSignature | null): boolean {
  if (a === null || b === null) return true;
  return a.placement === b.placement && a.unitScale !== null && b.unitScale !== null && unitScalesEqual(a.unitScale, b.unitScale);
}

/**
 * Plan the whole shared-infrastructure dedup for one model — `MergedExporter`
 * delegates its entire "remap and skip duplicate infrastructure" step here.
 *
 * `IfcUnitAssignment` unifies by position unconditionally. The representation
 * context (`IFCGEOMETRICREPRESENTATIONCONTEXT`) unifies only when its resolved
 * WCS frame agrees with the primary model's (origin in metres AND
 * axis/refDirection orientation, so a differing length unit or a rotated frame
 * doesn't produce a false match) and its georeference agrees with the one on
 * the shared context (#10798); a mismatch leaves it un-remapped — kept as
 * this model's own root — so its untouched coordinates are never
 * re-interpreted against the wrong frame.
 *
 * Its subcontexts (`IFCGEOMETRICREPRESENTATIONSUBCONTEXT`) go through
 * {@link planSubContextUnify} instead of positional matching — kind-matched by
 * `ContextIdentifier`/`TargetView` so a 'Body' subcontext never unifies onto an
 * 'Axis' one (merge invariant lens pass 3, item 1) — gated on the SAME
 * `contextsCompatible` computed once up front: a subcontext inherits its WCS
 * from `ParentContext`, so when the parent root's frame disagrees, retaining
 * the parent means every child must be retained too, not just remapped in
 * isolation. Mutates `sharedRemap`/`skipEntityIds`, and records a unified
 * model's georeference on `firstModelContext.contextGeoref` when it had none.
 * A unified model's coordinate operation, identical by then, maps onto the
 * shared context's. `modelOffset` is this model's output id offset. Returns
 * the top-level contexts it kept that one of the model's IfcProjects listed
 * (directly or through a subcontext), for {@link listKeptContexts}.
 *
 * `lengthUnitScale` is the scale THIS model's raw WCS coordinates resolve
 * under. Under assume-shared the caller asserts raw coordinates are already
 * in the primary's unit, and they are copied verbatim — so the caller must
 * pass the PRIMARY scale (matching how {@link PrimaryContextState.contextWcs}
 * was computed), not the model's own declared unit, or two frames that agree
 * raw-value-for-raw-value can compare unequal (and vice versa: differing raw
 * origins can collide once scaled). Under auto/normalize the caller passes
 * the model's own declared scale, comparing true metric frames.
 */
export function planInfrastructureUnify(
  dataStore: IfcDataStore,
  modelInfra: ReadonlyMap<string, number[]>,
  firstModelInfraMap: ReadonlyMap<string, number[]>,
  firstModelContext: PrimaryContextState,
  firstModelOffset: number,
  lengthUnitScale: number,
  sharedRemap: Map<number, number>,
  skipEntityIds: Set<number>,
  modelOffset: number,
): number[] {
  // Computed once, up front — not per type in the loop below — so its result
  // does not depend on `IFCGEOMETRICREPRESENTATIONCONTEXT` iterating before
  // `IFCGEOMETRICREPRESENTATIONSUBCONTEXT` in `firstModelInfraMap`.
  // Two georeferences that differ keep this model's context, and its conversion with it, as its own root (#10798).
  const georef = resolveModelContextGeorefSignature(dataStore, lengthUnitScale);
  const contextsCompatible = wcsSignaturesCompatible(firstModelContext.contextWcs,
    resolveModelContextWcs(dataStore, lengthUnitScale))
    && georefSignaturesCompatible(firstModelContext.contextGeoref, georef);
  // Only the model's FIRST top-level context is (positionally) unified below;
  // any later sibling context — a model with both a 'Model' and a 'Plan'
  // context, say — is always retained. A subcontext may therefore unify ONLY
  // when its own `ParentContext` is the context actually being remapped: a
  // child of a retained sibling must stay with its parent, or its shape
  // representations get re-anchored onto the primary's frame while the parent
  // keeps its own.
  const modelContextIds = modelInfra.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [];
  const firstContextIds = firstModelInfraMap.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [];
  const unifiedContextId = contextsCompatible && modelContextIds.length > 0 && firstContextIds.length > 0
    ? modelContextIds[0]
    : null;
  // This model's georeference now lands on the shared context, so a later model must agree with it too.
  if (unifiedContextId !== null) firstModelContext.contextGeoref ??= georef;
  // A context holds one coordinate operation (HasCoordinateOperation SET [0:1]): a later model's identical one maps
  // onto the shared context's, with its CRS, instead of becoming a second (#10873). The first one to arrive is shared.
  const own = unifiedContextId === null ? null : contextOperation(dataStore, unifiedContextId);
  const shared = firstModelContext.contextOperation;
  if (own && shared) {
    sharedRemap.set(own.operation, shared.operation);
    skipEntityIds.add(own.operation);
    if (own.crs !== null && shared.crs !== null) { sharedRemap.set(own.crs, shared.crs); skipEntityIds.add(own.crs); }
  } else if (own) firstModelContext.contextOperation = offsetOperation(own, modelOffset);
  for (const [type, firstIds] of firstModelInfraMap) {
    const thisIds = modelInfra.get(type);
    if (!thisIds || firstIds.length === 0 || thisIds.length === 0) continue;
    if (type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT') {
      if (unifiedContextId === null) continue;
      // An unreadable ParentContext stays permissive (treated as a child of
      // the unified context), matching this file's null-handling doctrine.
      const childIds = thisIds.filter((id) => {
        const parentId = refId(getStepAttr(dataStore, id, SUBCONTEXT_PARENT_CONTEXT_ATTR));
        return parentId === null || parentId === unifiedContextId;
      });
      if (childIds.length > 0) {
        planSubContextUnify(dataStore, childIds, firstModelContext.subContextsByKey, firstModelOffset, sharedRemap, skipEntityIds);
      }
      continue;
    }
    if (type === 'IFCGEOMETRICREPRESENTATIONCONTEXT' && !contextsCompatible) continue;
    sharedRemap.set(thisIds[0], firstIds[0] + firstModelOffset);
    skipEntityIds.add(thisIds[0]);
  }
  // One rule: a kept context follows its own project, which folds into the primary. Listed by one of this model's
  // IfcProjects, it joins the merged project (a library listing it too keeps it as well: IFC allows both); listed
  // only by a library, or by nothing, it stays as it was.
  // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current projects
  const projects = dataStore.entityIndex.byType.get('IFCPROJECT') ?? [];
  const listed = projects.flatMap(id => refsIn(getStepAttr(dataStore, id, PROJECT_REPRESENTATION_CONTEXTS_ATTR) ?? '')
    .map(ref => Number(ref.slice(1))));
  // A project that lists a subcontext lists its root too (a root context has no ParentContext slot, so reads null).
  const projectListed = new Set([...listed, ...listed.map(id => refId(getStepAttr(dataStore, id, SUBCONTEXT_PARENT_CONTEXT_ATTR)))]);
  return modelContextIds.filter(id => !sharedRemap.has(id) && projectListed.has(id));
}

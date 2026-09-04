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
import { asSourceBytes, STEP_TRIVIA } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { groupSubContextsByKey, planSubContextUnify } from './merged-subcontext.js';

/**
 * `#N=TYPE(...)` record, with STEP trivia (whitespace and/or a
 * `/* ... *​/` comment, #3789) tolerated between the type name and `(` —
 * same adjacency fix as `entity-extractor.ts`'s `extractEntity`. Without it
 * a wrapped record's attribute is silently unreadable here (`getStepAttr`
 * returns `null`), which reads identically to a genuinely-absent attribute.
 */
const RECORD_RE = new RegExp(`^#\\d+\\s*=\\s*\\w+${STEP_TRIVIA}\\(([\\s\\S]*)\\)\\s*;?\\s*$`);

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

function decodeEntity(dataStore: IfcDataStore, expressId: number): string | null {
  const source = dataStore.source;
  if (!source) return null;
  const ref = dataStore.entityIndex.byId.get(expressId);
  if (!ref) return null;
  return asSourceBytes(source).decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
}

/** Extract one 0-based STEP attribute of `expressId`'s entity, or null if unreadable. */
function getStepAttr(dataStore: IfcDataStore, expressId: number, index: number): string | null {
  const text = decodeEntity(dataStore, expressId);
  const match = text?.match(RECORD_RE);
  if (!match) return null;
  const args = splitTopLevelStepArguments(match[1]);
  const raw = args?.[index];
  return raw === undefined ? null : raw.trim();
}

function refId(raw: string | null): number | null {
  const m = raw?.match(/^#(\d+)$/);
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

/** `resolveContextWcsMetres` for a model's first `IfcGeometricRepresentationContext`, or null if it has none. */
export function resolveModelContextWcs(dataStore: IfcDataStore, lengthUnitScale: number): WcsSignature | null {
  const contextId = (dataStore.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])[0];
  return contextId === undefined ? null : resolveContextWcsMetres(dataStore, contextId, lengthUnitScale);
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
}

/** Build the {@link PrimaryContextState} for the primary model. */
export function resolvePrimaryContextState(
  dataStore: IfcDataStore,
  subContextIds: number[],
  primaryScale: number,
): PrimaryContextState {
  return {
    subContextsByKey: groupSubContextsByKey(dataStore, subContextIds),
    contextWcs: resolveModelContextWcs(dataStore, primaryScale),
  };
}

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

/**
 * Plan the whole shared-infrastructure dedup for one model — `MergedExporter`
 * delegates its entire "remap and skip duplicate infrastructure" step here.
 *
 * `IfcUnitAssignment` unifies by position unconditionally. The representation
 * context (`IFCGEOMETRICREPRESENTATIONCONTEXT`) unifies only when its resolved
 * WCS frame agrees with the primary model's (origin in metres AND
 * axis/refDirection orientation, so a differing length unit or a rotated frame
 * doesn't produce a false match); a mismatch leaves it un-remapped — kept as
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
 * isolation. Mutates `sharedRemap`/`skipEntityIds`.
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
): void {
  // Computed once, up front — not per type in the loop below — so its result
  // does not depend on `IFCGEOMETRICREPRESENTATIONCONTEXT` iterating before
  // `IFCGEOMETRICREPRESENTATIONSUBCONTEXT` in `firstModelInfraMap`.
  const contextsCompatible = wcsSignaturesCompatible(firstModelContext.contextWcs,
    resolveModelContextWcs(dataStore, lengthUnitScale));
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
}

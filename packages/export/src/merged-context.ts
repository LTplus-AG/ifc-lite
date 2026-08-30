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
 * `WorldCoordinateSystem`: the root anchor every placement in that context
 * ultimately resolves against. Silently dropping a model's own context in
 * favour of the primary's — without checking the WCS origin matches — would
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
 * compatibility: when the top-level context did not unify, this model's
 * subcontexts still reference its own (un-remapped) context, so unifying them
 * onto the primary's subcontexts would misplace them just the same.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { asSourceBytes } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { planSubContextUnify } from './merged-subcontext.js';

/** A resolved WorldCoordinateSystem origin, in metres. */
export interface WcsSignature {
  x: number;
  y: number;
  z: number;
}

/** Tolerance (metres) for two WCS origins to be considered the same. */
const WCS_TOLERANCE_M = 1e-6;

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
  const match = text?.match(/^#\d+\s*=\s*\w+\(([\s\S]*)\)\s*;?\s*$/);
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

/**
 * Resolve the WorldCoordinateSystem location of `contextId` (an
 * `IfcGeometricRepresentationContext`), in metres.
 *
 * Attr 4 is `WorldCoordinateSystem`, an `IfcAxis2Placement` (2D/3D) whose
 * attr 0 is `Location` (an `IfcCartesianPoint`) — but tolerates a context
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
  return { x: x * scale, y: y * scale, z: z * scale };
}

/** `resolveContextWcsMetres` for a model's first `IfcGeometricRepresentationContext`, or null if it has none. */
export function resolveModelContextWcs(dataStore: IfcDataStore, lengthUnitScale: number): WcsSignature | null {
  const contextId = (dataStore.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])[0];
  return contextId === undefined ? null : resolveContextWcsMetres(dataStore, contextId, lengthUnitScale);
}

/**
 * True when two resolved WCS origins are the same within tolerance, OR
 * either is null (unresolvable — permissive: never block a merge on a
 * context shape this reader couldn't fully parse).
 */
function wcsSignaturesCompatible(a: WcsSignature | null, b: WcsSignature | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a.x - b.x) <= WCS_TOLERANCE_M
    && Math.abs(a.y - b.y) <= WCS_TOLERANCE_M
    && Math.abs(a.z - b.z) <= WCS_TOLERANCE_M;
}

/**
 * Plan the whole shared-infrastructure dedup for one model — `MergedExporter`
 * delegates its entire "remap and skip duplicate infrastructure" step here.
 *
 * `IfcUnitAssignment` unifies by position unconditionally. The representation
 * context (`IFCGEOMETRICREPRESENTATIONCONTEXT`) unifies only when its resolved
 * WCS origin agrees with the primary model's (in metres, so a differing length
 * unit doesn't produce a false mismatch); a mismatch leaves it un-remapped —
 * kept as this model's own root — so its untouched coordinates are never
 * re-interpreted against the wrong origin.
 *
 * Its subcontexts (`IFCGEOMETRICREPRESENTATIONSUBCONTEXT`) go through
 * {@link planSubContextUnify} instead of positional matching — kind-matched by
 * `ContextIdentifier`/`TargetView` so a 'Body' subcontext never unifies onto an
 * 'Axis' one (merge invariant lens pass 3, item 1) — and inherit the parent
 * context's WCS gate: when the context itself did not unify, its subcontexts
 * reference THIS model's own (un-remapped) context, so unifying them onto the
 * primary's subcontexts would point them at the wrong origin's tree just the
 * same. Mutates `sharedRemap`/`skipEntityIds`.
 */
export function planInfrastructureUnify(
  dataStore: IfcDataStore,
  modelInfra: ReadonlyMap<string, number[]>,
  firstModelInfraMap: ReadonlyMap<string, number[]>,
  firstModelSubContextsByKey: ReadonlyMap<string, number[]>,
  firstModelOffset: number,
  firstModelContextWcs: WcsSignature | null,
  lengthUnitScale: number,
  sharedRemap: Map<number, number>,
  skipEntityIds: Set<number>,
): void {
  // Permissive default: if the primary model declares no representation
  // context at all, there is nothing for a subcontext's WCS to disagree
  // with, so subcontext kind-matching proceeds unhindered.
  let contextWcsCompatible = true;
  for (const [type, firstIds] of firstModelInfraMap) {
    const thisIds = modelInfra.get(type);
    if (!thisIds || firstIds.length === 0 || thisIds.length === 0) continue;
    if (type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT') {
      if (!contextWcsCompatible) continue;
      planSubContextUnify(dataStore, thisIds, firstModelSubContextsByKey, firstModelOffset, sharedRemap, skipEntityIds);
      continue;
    }
    if (type === 'IFCGEOMETRICREPRESENTATIONCONTEXT') {
      const thisWcs = resolveContextWcsMetres(dataStore, thisIds[0], lengthUnitScale);
      contextWcsCompatible = wcsSignaturesCompatible(firstModelContextWcs, thisWcs);
      if (!contextWcsCompatible) continue;
    }
    sharedRemap.set(thisIds[0], firstIds[0] + firstModelOffset);
    skipEntityIds.add(thisIds[0]);
  }
}

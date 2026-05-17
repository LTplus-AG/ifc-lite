/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When a wall is split, openings hosted on it (doors, windows,
 * generic voids) need to move to whichever half they geometrically
 * belong to — otherwise both halves carry the same void
 * relationship and the export double-counts.
 *
 * IFC structure:
 *
 *   IfcWall ──IfcRelVoidsElement──► IfcOpeningElement
 *                                    │
 *                                    └── (optional) IfcRelFillsElement
 *                                          ──► IfcDoor / IfcWindow
 *
 * The opening has its own `ObjectPlacement` whose `PlacementRelTo`
 * points back at the wall's placement (per IFC convention). Its
 * `RelativePlacement.Location.Coordinates` are in wall-local 3D,
 * with X = distance along the wall axis. That distance is what
 * decides the half:
 *
 *   if local-X < splitDistance ─► left half (no offset)
 *   else                       ─► right half (subtract splitDistance from local-X
 *                                              + repoint PlacementRelTo)
 *
 * Doors/windows hosted in an opening (via IfcRelFillsElement) are
 * positioned relative to the opening, so they move along with it
 * without any extra work.
 *
 * Source-wall openings whose placement does NOT match this
 * canonical shape (e.g. world-absolute openings, openings with
 * non-Cartesian placements, source-buffer entities with mapped
 * representations) are skipped with a returned `skippedReasons`
 * tally so the caller can surface a warning toast.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { asExpressIdRef, asCoordinateTriple, readAttributes, resolvePlacementChain } from './placement-core.js';

export interface OpeningReassignSummary {
  /** Openings successfully moved onto the left half. */
  toLeft: number;
  /** Openings successfully moved onto the right half. */
  toRight: number;
  /** Openings whose placement we couldn't interpret; left attached
   * to the (tombstoned) source. */
  skipped: number;
  /** Diagnostic reasons for the skips — small enum so the UI can
   * group them in a single toast rather than one per opening. */
  skipReasons: Map<string, number>;
}

function bumpReason(map: Map<string, number>, reason: string): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

/**
 * Rewrite `IfcRelVoidsElement.RelatingBuildingElement` to a new
 * wall id, preserving the reference's form (`#X` strings vs bare
 * numbers — the StoreEditor exports either; we don't want to
 * accidentally normalise overlay refs into numbers).
 */
function rewriteRelTarget(
  raw: unknown,
  newTargetId: number,
): IfcAttributeValue {
  if (typeof raw === 'string' && raw.startsWith('#')) {
    return `#${newTargetId}` as IfcAttributeValue;
  }
  return newTargetId as IfcAttributeValue;
}

/**
 * Walk every `IfcRelVoidsElement` whose RelatingBuildingElement is
 * `sourceWallId`. For each one:
 *
 *   1. Resolve the opening's wall-local X coord (= distance along
 *      the wall axis).
 *   2. Decide left / right by comparison to `splitDistance`.
 *   3. Rewrite the rel's RelatingBuildingElement (attr 4) to the
 *      chosen half.
 *   4. Rewrite the opening's IfcLocalPlacement.PlacementRelTo
 *      (attr 0) to the chosen half's placement.
 *   5. For right-half openings, subtract `splitDistance` from the
 *      opening's local-X coordinate so its world position stays
 *      the same after the placement reparent.
 *
 * The split distance is in metres along the source wall's axis,
 * measured from the source's start (matches
 * `computeWallSplitGeometry`'s `distance` parameter).
 */
export function reassignWallOpenings(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  sourceWallId: number,
  leftWallId: number,
  rightWallId: number,
  splitDistance: number,
  /** `IfcLocalPlacement` ids for the two halves — needed because
   * the opening's `PlacementRelTo` must point at the half's
   * placement, not the half's IfcWall entity. */
  leftPlacementId: number,
  rightPlacementId: number,
): OpeningReassignSummary {
  const summary: OpeningReassignSummary = {
    toLeft: 0,
    toRight: 0,
    skipped: 0,
    skipReasons: new Map(),
  };

  // Resolve the source wall's IfcLocalPlacement so we can verify
  // each opening was actually placed relative to it. Openings with
  // world-absolute placements (PlacementRelTo = null) or placements
  // relative to some other entity must NOT be reassigned — silently
  // rewriting their PlacementRelTo would teleport them.
  const sourceChain = resolvePlacementChain(dataStore, view, editor, sourceWallId);
  if (!sourceChain) {
    summary.skipped++;
    bumpReason(summary.skipReasons, 'source wall placement unresolvable');
    return summary;
  }
  const sourceWallPlacementId = sourceChain.localPlacementId;

  const relIds = dataStore.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? [];
  for (const relId of relIds) {
    const relAttrs = readAttributes(dataStore, view, editor, relId);
    if (!relAttrs) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'unreadable rel');
      continue;
    }
    // IfcRelVoidsElement attrs (IFC4): [GlobalId, OwnerHistory,
    // Name, Description, RelatingBuildingElement, RelatedOpeningElement]
    const relatingBuilding = asExpressIdRef(relAttrs[4]);
    if (relatingBuilding !== sourceWallId) continue;
    const openingId = asExpressIdRef(relAttrs[5]);
    if (openingId === null) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'missing opening ref');
      continue;
    }

    // Walk the opening's placement chain to its local-X coord.
    const openingAttrs = readAttributes(dataStore, view, editor, openingId);
    if (!openingAttrs) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'unreadable opening');
      continue;
    }
    const localPlacementId = asExpressIdRef(openingAttrs[5]); // ObjectPlacement
    if (localPlacementId === null) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'no ObjectPlacement');
      continue;
    }
    const localPlacementAttrs = readAttributes(dataStore, view, editor, localPlacementId);
    if (!localPlacementAttrs) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'unreadable IfcLocalPlacement');
      continue;
    }
    // Verify the opening's PlacementRelTo points at THIS source
    // wall. Openings placed absolutely (PlacementRelTo === null)
    // or relative to some other entity must be left alone —
    // rewriting their parent placement would teleport them.
    const placementRelTo = asExpressIdRef(localPlacementAttrs[0]);
    if (placementRelTo !== sourceWallPlacementId) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'opening not placed relative to source wall');
      continue;
    }
    const relativePlacementId = asExpressIdRef(localPlacementAttrs[1]);
    if (relativePlacementId === null) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'no RelativePlacement');
      continue;
    }
    const axisAttrs = readAttributes(dataStore, view, editor, relativePlacementId);
    if (!axisAttrs) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'unreadable IfcAxis2Placement3D');
      continue;
    }
    const cartesianId = asExpressIdRef(axisAttrs[0]);
    if (cartesianId === null) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'no Location');
      continue;
    }
    const pointAttrs = readAttributes(dataStore, view, editor, cartesianId);
    if (!pointAttrs) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'unreadable IfcCartesianPoint');
      continue;
    }
    const coords = asCoordinateTriple(pointAttrs[0]);
    if (!coords) {
      summary.skipped++;
      bumpReason(summary.skipReasons, 'invalid Coordinates');
      continue;
    }

    const localX = coords[0];
    const onLeft = localX < splitDistance;
    if (onLeft) {
      // Reassign to left half. Left's placement coincides with
      // source's, so the opening's local coords don't change.
      editor.setPositionalAttribute(relId, 4, rewriteRelTarget(relAttrs[4], leftWallId));
      editor.setPositionalAttribute(
        localPlacementId,
        0,
        rewriteRelTarget(localPlacementAttrs[0], leftPlacementId),
      );
      summary.toLeft++;
    } else {
      // Reassign to right half. Right's placement is offset along
      // the wall axis by `splitDistance` — so the opening's local-X
      // shifts by `-splitDistance` to keep its world position fixed.
      editor.setPositionalAttribute(relId, 4, rewriteRelTarget(relAttrs[4], rightWallId));
      editor.setPositionalAttribute(
        localPlacementId,
        0,
        rewriteRelTarget(localPlacementAttrs[0], rightPlacementId),
      );
      const newCoords: [number, number, number] = [
        localX - splitDistance,
        coords[1],
        coords[2],
      ];
      editor.setPositionalAttribute(cartesianId, 0, newCoords);
      summary.toRight++;
    }
  }

  return summary;
}

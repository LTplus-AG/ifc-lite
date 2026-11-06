/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Placement reads and writes shared by the storey edits (#9013).
 *
 * A vertical move is always written as a FRESH IfcCartesianPoint and
 * IfcAxis2Placement3D on the moved IfcLocalPlacement, keeping the original
 * Axis/RefDirection records: a point or axis placement that another
 * placement shares (a common origin in exported files) is never moved.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { GeometryEntityReader, Vec3 } from '../host-geometry-frame.js';
import { placementInAncestor, pointOf, refId } from '../host-geometry-frame.js';

export interface PlacementLeaf {
  readonly placementId: number;
  /** PlacementRelTo, or null for a world-rooted placement. */
  readonly parentId: number | null;
  readonly axisPlacementId: number;
  /** Location in the parent's frame, file units. */
  readonly location: Vec3;
  readonly axis: unknown;
  readonly refDirection: unknown;
}

/** An IfcLocalPlacement whose RelativePlacement is a readable IfcAxis2Placement3D, or null. */
export function readPlacementLeaf(reader: GeometryEntityReader, placementId: number): PlacementLeaf | null {
  const placement = reader.entity(placementId);
  if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return null;
  const rawParent = placement.attributes[0];
  const parentId = rawParent === null || rawParent === undefined ? null : refId(rawParent);
  if (parentId === null && rawParent !== null && rawParent !== undefined) return null;
  const axisPlacementId = refId(placement.attributes[1]);
  if (axisPlacementId === null) return null;
  const axis = reader.entity(axisPlacementId);
  if (axis?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D') return null;
  const location = pointOf(reader, axis.attributes[0]);
  if (!location) return null;
  return { placementId, parentId, axisPlacementId, location, axis: axis.attributes[1] ?? null, refDirection: axis.attributes[2] ?? null };
}

/**
 * The local-frame offset that moves a child of `parentId` by `dz` along WORLD
 * +Z (file units). A rotated or tilted parent is handled exactly; null when the
 * parent chain cannot be read.
 */
export function worldLiftInParent(reader: GeometryEntityReader, parentId: number | null, dz: number): Vec3 | null {
  if (parentId === null) return [0, 0, dz];
  const frame = placementInAncestor(reader, parentId, null);
  if (!frame) return null;
  // R·d = (0, 0, dz) with R = [x y z] orthonormal, so d = Rᵀ·(0, 0, dz).
  return [frame.x[2] * dz, frame.y[2] * dz, frame.z[2] * dz];
}

/** Write `leaf` moved by `offset` (its parent's frame, file units). Returns the new axis placement. */
export function writeShiftedPlacement(editor: StoreEditor, leaf: PlacementLeaf, offset: Vec3): number {
  const location: Vec3 = [leaf.location[0] + offset[0], leaf.location[1] + offset[1], leaf.location[2] + offset[2]];
  const point = editor.addEntity('IfcCartesianPoint', [location]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [
    `#${point}`,
    placementRef(leaf.axis),
    placementRef(leaf.refDirection),
  ]).expressId;
  editor.setPositionalAttribute(leaf.placementId, 1, `#${axis}`);
  return axis;
}

/** Re-emit a direction reference read from source (number) or overlay (`#id`). */
function placementRef(value: unknown): string | null {
  const id = refId(value);
  return id === null ? null : `#${id}`;
}

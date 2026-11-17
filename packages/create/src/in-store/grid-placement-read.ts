/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an IfcGridPlacement is, read by the same rules as the geometry reader
 * (`rust/geometry/src/placement/grid.rs`, `grid_frame.rs`), so a copy of an
 * element on a grid starts from where the element is drawn (#9199).
 *
 *   - The record's layout decides the frame. IFC4X3 has three attributes and
 *     `PlacementRelTo` names it, `$` being the world. IFC2X3 and IFC4 have two,
 *     and the frame is the ObjectPlacement of the IfcGrid owning the first axis.
 *   - The point is where the axes meet, each shifted to its left by its offset;
 *     the third offset is height. `PlacementRefDirection` turns the frame.
 *
 * Everything is in the file's native length unit. A placement that does not read
 * is null: its caller refuses, rather than copying from a guessed position.
 */

import { asRef } from './style-entity-reader.js';
import { IDENTITY_FRAME, applyRigid, composeRigid, type CopyVec3, type LiveRead, type RigidFrame } from './copy-frame.js';
import { authoredScalar } from './spatial-children.js';
import { readGridAxisEnds } from './extract-grids.js';
import { inverseFrame, num, placementInAncestor, placementRelativeTo, refId, unit, type Frame3 } from './host-geometry-frame.js';

const UPRIGHT_EPS = 1e-6;

export interface GridPlacementReading {
  readonly frame: RigidFrame;
  /** Where the axes meet with no offset applied, in the same frame. */
  readonly crossing: CopyVec3;
  /** The IfcGrid owning the location's first axis, when one lists it. */
  readonly gridId: number | null;
}

/** IfcGrid.ObjectPlacement, attribute 5. */
export const gridObjectPlacement = (read: LiveRead, gridId: number | null): number | null =>
  gridId === null ? null : asRef(read(gridId)?.attributes[5]);

function upright(frame: Frame3 | null): RigidFrame | null {
  if (!frame || Math.abs(frame.z[0]) > UPRIGHT_EPS || Math.abs(frame.z[1]) > UPRIGHT_EPS || frame.z[2] <= 0) return null;
  return { origin: frame.o, c: frame.x[0], s: frame.x[1] };
}

/** A placement, or the world for null, in a reference placement's frame or the world's. */
export function uprightFrameIn(read: LiveRead, placementId: number | null, referenceId: number | null): RigidFrame | null {
  const reader = { entity: read };
  if (placementId === null) {
    if (referenceId === null) return IDENTITY_FRAME;
    const reference = placementInAncestor(reader, referenceId, null);
    return reference ? upright(inverseFrame(reference)) : null;
  }
  return upright(referenceId === null ? placementInAncestor(reader, placementId, null) : placementRelativeTo(reader, placementId, referenceId));
}

/** An axis as a line in the grid plane. `SameSense = .F.` reverses it, and with it the side its offset is on. */
function axisLine(read: LiveRead, axisId: number): { o: [number, number]; d: [number, number] } | null {
  const axis = read(axisId);
  if (axis?.type.toUpperCase() !== 'IFCGRIDAXIS') return null;
  const ends = readGridAxisEnds(read, axis);
  if (!ends) return null;
  const direction = unit([ends[1][0] - ends[0][0], ends[1][1] - ends[0][1], 0]);
  return direction ? { o: ends[0], d: [direction[0], direction[1]] } : null;
}

function meet(a: { o: [number, number]; d: [number, number] }, b: { o: [number, number]; d: [number, number] }): [number, number] | null {
  const denominator = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((b.o[0] - a.o[0]) * b.d[1] - (b.o[1] - a.o[1]) * b.d[0]) / denominator;
  return [a.o[0] + t * a.d[0], a.o[1] + t * a.d[1]];
}

const leftShift = (line: { o: [number, number]; d: [number, number] }, by: number) =>
  ({ o: [line.o[0] - line.d[1] * by, line.o[1] + line.d[0] * by] as [number, number], d: line.d });

/** OffsetDistances: an absent list is no offset, an unreadable one is not. */
function offsetsOf(value: unknown): [number, number, number] | null {
  if (value === null || value === undefined) return [0, 0, 0];
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const read = value.map((v) => num(authoredScalar(v)));
  if (read.some((v) => v === null)) return null;
  return [read[0]!, read[1]!, read[2] ?? 0];
}

/** One IfcVirtualGridIntersection in the grid's own frame: `at` with its offsets, `crossing` without. */
function intersectionOf(read: LiveRead, id: number | null): { at: CopyVec3; crossing: [number, number]; firstAxis: number } | null {
  const record = id === null ? null : read(id);
  if (record?.type.toUpperCase() !== 'IFCVIRTUALGRIDINTERSECTION' || !Array.isArray(record.attributes[0]) || record.attributes[0].length !== 2) return null;
  const axisIds = record.attributes[0].map(refId);
  const offsets = offsetsOf(record.attributes[1]);
  if (axisIds[0] === null || axisIds[1] === null || !offsets) return null;
  const first = axisLine(read, axisIds[0]), second = axisLine(read, axisIds[1]);
  if (!first || !second) return null;
  const crossing = meet(first, second);
  const shifted = meet(leftShift(first, offsets[0]), leftShift(second, offsets[1]));
  return crossing && shifted ? { at: [shifted[0], shifted[1], offsets[2]], crossing, firstAxis: axisIds[0] } : null;
}

/** PlacementRefDirection: local +X, or null when it inherits the grid's. An unreadable one is `undefined`. */
function headingOf(read: LiveRead, value: unknown, at: CopyVec3): [number, number] | null | undefined {
  const id = asRef(value);
  if (id === null) return value === null || value === undefined ? null : undefined;
  const record = read(id);
  const type = record?.type.toUpperCase();
  let x: number, y: number;
  if (type === 'IFCDIRECTION') {
    const ratios = record!.attributes[0];
    if (!Array.isArray(ratios) || typeof ratios[0] !== 'number' || typeof ratios[1] !== 'number') return undefined;
    [x, y] = [ratios[0], ratios[1]];
  } else if (type === 'IFCVIRTUALGRIDINTERSECTION') {
    const target = intersectionOf(read, id);
    if (!target) return undefined;
    [x, y] = [target.at[0] - at[0], target.at[1] - at[1]];
  } else return undefined;
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length)) return undefined;
  return length >= 1e-9 ? [x / length, y / length] : null;
}

/**
 * An IfcGridPlacement in a reference placement's frame (the world's for null).
 * `gridOfAxis` is the owner lookup: the first grid in file order listing an axis.
 */
export function readGridPlacement(read: LiveRead, gridOfAxis: (axisId: number) => number | null, placementId: number, referenceId: number | null): GridPlacementReading | null {
  const record = read(placementId);
  if (record?.type.toUpperCase() !== 'IFCGRIDPLACEMENT') return null;
  const hasRelTo = record.attributes.length >= 3;
  const location = intersectionOf(read, asRef(record.attributes[hasRelTo ? 1 : 0]));
  if (!location) return null;
  const heading = headingOf(read, record.attributes[hasRelTo ? 2 : 1], location.at);
  if (heading === undefined) return null;
  const gridId = gridOfAxis(location.firstAxis);
  const relTo = record.attributes[0];
  if (hasRelTo && relTo !== null && relTo !== undefined && asRef(relTo) === null) return null;
  const parent = uprightFrameIn(read, hasRelTo ? asRef(relTo) : gridObjectPlacement(read, gridId), referenceId);
  if (!parent) return null;
  const local: RigidFrame = { origin: location.at, c: heading?.[0] ?? 1, s: heading?.[1] ?? 0 };
  return { frame: composeRigid(parent, local), crossing: applyRigid(parent, [location.crossing[0], location.crossing[1], 0]), gridId };
}

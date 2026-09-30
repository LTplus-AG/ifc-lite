/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The design-grid axes visible on a storey, in the storey's own frame
 * (metres): what a snap source needs to let walls, columns and curtain walls
 * land on grid lines and grid intersections (#6232).
 *
 * An IfcGrid is contained in a storey, or (very often) in the building or site
 * above it, so grids contained in any spatial ancestor of the storey count.
 * Both file grids and grids authored this session (`addGridToStore`) are read
 * through the same overlay-aware entity reader the wall extractor uses, so an
 * axis edited or deleted this session reads as it now is.
 *
 * Each axis curve is read as a straight segment: a two-point IfcPolyline (the
 * form `addGridToStore`, Revit and most exporters write), or an IfcTrimmedCurve
 * over an IfcLine trimmed by points or by parameters (ArchiCAD). Other curves
 * (arcs of a radial grid) are skipped and counted, never guessed at.
 * `IfcGridAxis.SameSense` is ignored, as everywhere else the grid is read.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { Vec2 } from './auto-space-detect.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import {
  AXIS_EPS,
  applyFrame,
  frameInStoreyFrame,
  numericAttr,
  readEntity,
  readVec3,
  storeyPlacementChain,
  type OverlayWallReader,
} from './placement-frame.js';
import {
  authoredScalar,
  buildRelatingChildrenIndex,
  createOverlayLookup,
  effectiveMemberType,
} from './spatial-children.js';

export interface GridAxisSegment {
  /** The IfcGrid this axis belongs to. */
  gridId: number;
  axisId: number;
  /** The IfcGridAxis.AxisTag ('1', 'A', ...). */
  AxisTag: string;
  family: 'U' | 'V' | 'W';
  /** Axis ends in storey-local metres. */
  a: Vec2;
  b: Vec2;
}

export interface StoreyGridAxes {
  axes: GridAxisSegment[];
  /** IfcGrid entities found. */
  gridIds: number[];
  /** Axes with unreadable placement frames or unsupported curves: not offered. */
  skippedAxes: number;
}

type Reader = (id: number) => { type?: string; attributes: readonly unknown[] } | null;

const refList = (value: unknown): number[] => (Array.isArray(value)
  ? value.map((v) => numericAttr(v as never)).filter((n): n is number => n !== null)
  : []);

/**
 * A trim value: a parameter (`IFCPARAMETERVALUE(2.5)` parses to
 * `['IFCPARAMETERVALUE', 2.5]`; an authored one is `{ typed }` or `{ real }`),
 * or a reference to a cartesian point. A bare number is a reference here: the
 * parser hands references over as numbers.
 */
function readTrim(read: Reader, value: unknown): { point: Vec2 } | { parameter: number } | null {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (Array.isArray(item) && typeof item[1] === 'number') return { parameter: item[1] };
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const scalar = authoredScalar(item as never);
      if (typeof scalar === 'number') return { parameter: scalar };
    }
    const id = numericAttr(item as never);
    const ent = id === null ? null : read(id);
    if (ent?.type?.toUpperCase() === 'IFCCARTESIANPOINT') {
      const p = readVec3(ent.attributes[0] as never);
      if (p) return { point: [p[0], p[1]] };
    }
  }
  return null;
}

function pointAt(read: Reader, id: number): Vec2 | null {
  const ent = read(id);
  if (ent?.type?.toUpperCase() !== 'IFCCARTESIANPOINT') return null;
  const p = readVec3(ent.attributes[0] as never);
  return p ? [p[0], p[1]] : null;
}

/** The two ends of a straight axis curve in the grid's own frame (raw units), or null. */
function readAxisEnds(read: Reader, curveId: number): [Vec2, Vec2] | null {
  const curve = read(curveId);
  const type = curve?.type?.toUpperCase();
  if (!curve) return null;
  if (type === 'IFCPOLYLINE') {
    const ids = refList(curve.attributes[0]);
    if (ids.length < 2) return null;
    const a = pointAt(read, ids[0]);
    const b = pointAt(read, ids[ids.length - 1]);
    if (!a || !b) return null;
    if (ids.length > 2) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length <= AXIS_EPS) return null;
      for (const id of ids.slice(1, -1)) {
        const point = pointAt(read, id);
        if (!point) return null;
        const px = point[0] - a[0], py = point[1] - a[1];
        const projection = px * dx + py * dy;
        // A bent or backtracking curve extending beyond the endpoints is
        // not this segment: never offer an invented diagonal snap target.
        if (Math.abs(px * dy - py * dx) > AXIS_EPS * length
          || projection < -AXIS_EPS * length
          || projection > length * length + AXIS_EPS * length) return null;
      }
    }
    return [a, b];
  }
  if (type !== 'IFCTRIMMEDCURVE') return null;
  const basisId = numericAttr(curve.attributes[0] as never);
  const basis = basisId === null ? null : read(basisId);
  if (basis?.type?.toUpperCase() !== 'IFCLINE') return null;
  const trims = [readTrim(read, curve.attributes[1]), readTrim(read, curve.attributes[2])];
  if (trims.every((t) => t && 'point' in t)) return [(trims[0] as { point: Vec2 }).point, (trims[1] as { point: Vec2 }).point];
  // Parameters run along the line's vector: Pnt + t * Orientation * Magnitude.
  const originId = numericAttr(basis.attributes[0] as never);
  const vectorId = numericAttr(basis.attributes[1] as never);
  const origin = originId === null ? null : pointAt(read, originId);
  const vector = vectorId === null ? null : read(vectorId);
  const dirId = vector ? numericAttr(vector.attributes[0] as never) : null;
  const dir = dirId === null ? null : read(dirId);
  const d = dir ? readVec3(dir.attributes[0] as never) : null;
  if (!origin || !d) return null;
  const magnitude = vector ? authoredScalar(vector.attributes[1] as never) : undefined;
  const len = Math.hypot(d[0], d[1]) || 1;
  const step = (typeof magnitude === 'number' ? magnitude : 1) / len;
  const at = (t: NonNullable<(typeof trims)[number]>): Vec2 => ('point' in t
    ? t.point
    : [origin[0] + t.parameter * d[0] * step, origin[1] + t.parameter * d[1] * step]);
  return trims[0] && trims[1] ? [at(trims[0]), at(trims[1])] : null;
}

/**
 * The grid axes that apply to `storeyId`, in storey-local metres. Empty (never
 * throwing) for a store without source bytes or a storey without a placement.
 */
export function extractGridAxesForStorey(
  store: IfcDataStore,
  storeyId: number,
  overlay?: OverlayWallReader,
): StoreyGridAxes {
  const out: StoreyGridAxes = { axes: [], gridIds: [], skippedAxes: 0 };
  if (!store.source) return out;
  const extractor = new EntityExtractor(store.source);
  const lookup = createOverlayLookup(overlay);
  const read: Reader = (id) => readEntity(store, extractor, overlay, id);
  const scale = store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, 'extractGridAxesForStorey') ?? 1
    : 1;

  const aggregated = buildRelatingChildrenIndex(store, extractor, lookup, 'IFCRELAGGREGATES', 4, 5);
  const contained = buildRelatingChildrenIndex(store, extractor, lookup, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 5, 4);
  const parentOf = new Map<number, number>();
  for (const [parent, children] of aggregated) for (const child of children) parentOf.set(child, parent);

  // The storey and every spatial ancestor (building, site, project), storey first.
  const hosts: number[] = [];
  for (let id: number | undefined = storeyId; id !== undefined && !hosts.includes(id); id = parentOf.get(id)) hosts.push(id);
  const gridIds = new Set<number>();
  for (const host of hosts) {
    for (const member of [...(contained.get(host) ?? []), ...(aggregated.get(host) ?? [])]) {
      if ((effectiveMemberType(store, lookup, member) ?? '').toUpperCase() === 'IFCGRID') gridIds.add(member);
    }
  }
  if (gridIds.size === 0) return out;

  const storeyChain = storeyPlacementChain(store, extractor, overlay, storeyId);
  for (const gridId of gridIds) {
    const grid = read(gridId);
    if (!grid) continue;
    out.gridIds.push(gridId);
    const placementId = numericAttr(grid.attributes[5] as never);
    const frame = placementId === null ? { origin: [0, 0] as Vec2, axisX: [1, 0] as Vec2 }
      : frameInStoreyFrame(store, extractor, overlay, placementId, storeyChain);
    const families: Array<['U' | 'V' | 'W', unknown]> = [['U', grid.attributes[7]], ['V', grid.attributes[8]], ['W', grid.attributes[9]]];
    if (!frame) {
      out.skippedAxes += families.reduce((count, [, list]) => count + refList(list).length, 0);
      continue;
    }
    for (const [family, list] of families) {
      for (const axisId of refList(list)) {
        const axis = read(axisId);
        const curveId = axis ? numericAttr(axis.attributes[1] as never) : null;
        const ends = curveId === null ? null : readAxisEnds(read, curveId);
        if (!axis || !ends) {
          out.skippedAxes += 1;
          continue;
        }
        const a = applyFrame(frame, ends[0]);
        const b = applyFrame(frame, ends[1]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= AXIS_EPS) {
          out.skippedAxes += 1;
          continue;
        }
        const tag = authoredScalar(axis.attributes[0] as never);
        out.axes.push({
          gridId, axisId, family, AxisTag: typeof tag === 'string' ? tag : String(tag ?? ''),
          a: [a[0] * scale, a[1] * scale], b: [b[0] * scale, b[1] * scale],
        });
      }
    }
  }
  return out;
}

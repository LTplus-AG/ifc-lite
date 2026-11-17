/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Guessed supports: which lowest-level nodes of a derivation plan bear on the ground. */

import { vecLen as length } from '../ifc-creator-math.js';
import { pointInPolygon } from './room-footprint-offset.js';
import { add, sub, scale, dot } from './structural-derive-idealise.js';
import { jointReachOf } from './structural-derive-joints.js';
import type { PhysicalElementFact, PlannedCurveMember, PlannedNode, PlannedSurfaceMember, Vec3 } from './structural-derive-types.js';

/** Point inside a planar polygon, in the plane's dominant projection: `clearance` inside its edges, or within -`clearance` of them. */
function insidePolygon(p: Vec3, polygon: Vec3[], normal: Vec3, clearance = 0): boolean {
  const drop = [0, 1, 2].reduce((m, k) => (Math.abs(normal[k]) > Math.abs(normal[m]) ? k : m), 0);
  const [i, j] = [0, 1, 2].filter((k) => k !== drop);
  const projected = sub(p, scale(normal, dot(sub(p, polygon[0]), normal)));
  const inside = pointInPolygon(projected[i], projected[j], polygon.map((q) => [q[i], q[j]]));
  // The edges matter only when the clearance could change the answer.
  if (clearance === 0 || inside !== clearance > 0) return inside;
  const edgeDistance = Math.min(...polygon.map((a, index) => {
    const edge = sub(polygon[(index + 1) % polygon.length], a);
    const t = dot(edge, edge) === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(projected, a), edge) / dot(edge, edge)));
    return length(sub(projected, add(a, scale(edge, t))));
  }));
  return clearance > 0 ? edgeDistance > clearance : edgeDistance <= -clearance;
}

export type PlannedSurface = { member: PlannedSurfaceMember; normal: Vec3 };

/** Distance from a point to the infinite line through `a` along `axis`. */
function distanceToLine(p: Vec3, a: Vec3, axis: Vec3): number {
  return length(sub(sub(p, a), scale(axis, dot(sub(p, a), axis) / dot(axis, axis))));
}

/** The lowest z of a surface member's body. */
function bottomOf(member: PlannedSurfaceMember, normal: Vec3): number {
  return Math.min(...member.boundary.map((q) => q[2])) - Math.abs(normal[2]) * member.thickness / 2;
}

/** The lowest z of an element's body, or null when it has none (an Axis-only element). */
export function bodyBottom({ prism }: PhysicalElementFact): number | null {
  return prism ? Math.min(...prism.outline.map((p) => p[2] + Math.min(0, prism.extrusion[2]))) : null;
}

/** The first surface member whose body, grown by the tolerance across (and by `grow` along), holds the point outside its openings. */
export function surfaceAt(p: Vec3, surfaces: readonly PlannedSurface[], tolerance: number, grow = 0): PlannedSurface | undefined {
  return surfaces.find(({ member, normal }) =>
    Math.abs(dot(sub(p, member.boundary[0]), normal)) <= tolerance + member.thickness / 2 && insidePolygon(p, member.boundary, normal, -grow)
    && !(member.openings ?? []).some(ring => insidePolygon(p, ring, normal, tolerance)));
}

export interface BearingContext {
  /** Lines of load-bearing curve members derived before, with their section. */
  idealised: ReadonlyArray<{ start: Vec3; end: Vec3; section: number | null }>;
  /** Walls and slabs, this plan's and those derived before. */
  surfaces: readonly PlannedSurface[];
  footings: ReadonlyArray<{ min: Vec3; max: Vec3 }>;
  level: number;
  tolerance: number;
  jointReach: number | null;
}

/**
 * The lowest-level nodes that bear on the ground. Members lying flat at the level join its nodes into runs.
 * A node bears where a member rises from it whose element is drawn down to the level, where a member
 * derived before rises from it (within its joint reach), or where it rests on a wall, slab or footing (up
 * to the flat member's underside below it); a member drawn above the level (a
 * post the joints moved down onto a tie) rests on the run instead. A run bears only at its bearing nodes
 * when they hold it: two or more, and not all on one line unless the run is on that line too. So a flat
 * end past them (an overhang) is a cantilever. Any other run bears at every node.
 */
export function lowestLevelBearings(
  nodes: PlannedNode[],
  members: ReadonlyArray<{ member: PlannedCurveMember; drawn: readonly [Vec3, Vec3]; bottom: number | null }>,
  { idealised, surfaces, footings, level, tolerance, jointReach }: BearingContext,
): number[] {
  const atLevel = (index: number) => nodes[index].position[2] <= level + tolerance;
  const parent = nodes.map((node) => node.index);
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const bearing = new Set<number>();
  /** The flat members ending at each node: their line, and their underside, where a wall or slab may stop. */
  const flatAt = new Map<number, Array<{ a: Vec3; b: Vec3; underside: number }>>();
  for (const { member: { startNode, endNode, start, end }, drawn, bottom } of members) {
    const startLow = atLevel(startNode);
    const endLow = atLevel(endNode);
    if (startLow && endLow) {
      parent[find(startNode)] = find(endNode);
      for (const n of [startNode, endNode]) {
        const z = nodes[n].position[2];
        const flats = flatAt.get(n) ?? [];
        flats.push({ a: start, b: end, underside: Math.min(bottom ?? z, z) });
        flatAt.set(n, flats);
      }
    } else if ((startLow || endLow) && Math.min(drawn[0][2], drawn[1][2]) <= level + tolerance) {
      bearing.add(startLow ? startNode : endNode);
    }
  }
  // Members derived before that rise from the level, with the reach the joint rule would join them over.
  const rising = idealised.flatMap(({ start, end, section }) => {
    const [foot, head] = start[2] <= end[2] ? [start, end] : [end, start];
    return foot[2] <= level + tolerance && head[2] > level + tolerance ? [{ foot, reach: jointReachOf(tolerance, jointReach, section) }] : [];
  });
  // Only a surface reaching below the level can hold a node at it.
  const low = surfaces.map((surface) => ({ surface, bottom: bottomOf(surface.member, surface.normal) }))
    .filter(({ bottom }) => bottom < level + tolerance);
  for (const node of nodes) {
    const flats = flatAt.get(node.index);
    if (!flats || bearing.has(node.index)) continue;
    const p = node.position;
    // On the line of a flat member ending here, within its reach: as the joint rule would join it.
    // Past this end, not along any flat member leaving it, so a member reaching on does not carry it here.
    const onRising = rising.some(({ foot, reach }) => length(sub(foot, p)) <= reach
      && flats.some(({ a, b }) => distanceToLine(foot, a, sub(b, a)) <= tolerance)
      && flats.every(({ a, b }) => {
        const away = sub(length(sub(a, p)) <= tolerance ? b : a, p);
        return dot(sub(foot, p), away) / length(away) <= tolerance;
      }));
    // At a flat member's underside, a wall or slab within the tolerance holds the node when its body reaches
    // below it (under the beam, a pocket, or a wall the beam frames into); one starting above stands on the run.
    // So does a footing whose top meets the underside, though the node itself is outside it.
    const held = () => flats.some(({ underside: z }) =>
      low.some(({ surface, bottom }) => bottom < z && surfaceAt([p[0], p[1], z], [surface], tolerance, tolerance) !== undefined)
      || footings.some(({ min, max }) => min[2] < z && max[2] >= z - tolerance
        && p[0] >= min[0] - tolerance && p[0] <= max[0] + tolerance && p[1] >= min[1] - tolerance && p[1] <= max[1] + tolerance));
    if (onRising || held()) bearing.add(node.index);
  }
  const runs = new Map<number, number[]>();
  for (const node of nodes) {
    if (!atLevel(node.index)) continue;
    const root = find(node.index);
    const run = runs.get(root) ?? [];
    run.push(node.index);
    runs.set(root, run);
  }
  return [...runs.values()].flatMap((run) => {
    const bearings = run.filter((i) => bearing.has(i));
    if (bearings.length < 2) return run;
    // Pinned bearings on one line leave a run off that line free to turn about it. The line runs between
    // two far-apart bearings (two sweeps), so noise between close ones is not magnified.
    const points = bearings.map((i) => nodes[i].position);
    const farthest = (from: Vec3) => points.reduce((far, p) => (length(sub(p, from)) > length(sub(far, from)) ? p : far));
    const a = farthest(points[0]);
    const axis = sub(farthest(a), a);
    if (length(axis) <= tolerance) return run;
    const offLine = (p: Vec3) => distanceToLine(p, a, axis) > tolerance;
    return points.some(offLine) || !run.some((i) => offLine(nodes[i].position)) ? bearings : run;
  });
}
